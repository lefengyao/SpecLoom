import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import {
  OFFLINE_DOCUMENT_LIMITS,
  OfflineDocumentBundleSchema,
  OfflineDocumentReadOptionsSchema,
  type OfflineDocumentBundle,
  type OfflineDocumentImportOptions,
  type OfflineDocumentRead,
  type OfflineDocumentReadOptions,
  type OfflineDocumentVersion,
} from "../../shared/offline-documents";
import { ProjectError } from "./errors";
import { redactSecret } from "./agent-output";
import { offlineDocumentPage } from "./offline-document-pages";

type Index = { schemaVersion: 1; bundles: OfflineDocumentBundle[] };
type SourceFile = { bytes: Buffer; path: string; name: string; mimeType: string; size: number; hash: string };

const MIME_TYPES: Record<string, string> = {
  ".txt": "text/plain", ".md": "text/markdown", ".markdown": "text/markdown", ".json": "application/json",
  ".yaml": "application/yaml", ".yml": "application/yaml", ".toml": "application/toml", ".xml": "application/xml",
  ".csv": "text/csv", ".ts": "text/typescript", ".tsx": "text/tsx", ".js": "text/javascript", ".jsx": "text/jsx",
  ".css": "text/css", ".html": "text/html", ".htm": "text/html", ".gd": "text/x-gdscript", ".ini": "text/plain",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".pdf": "application/pdf", ".zip": "application/zip", ".wasm": "application/wasm",
};

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function asProjectError(error: unknown, message: string): never {
  if (error instanceof ProjectError) throw error;
  throw new ProjectError("VALIDATION_FAILED", message, error instanceof Error ? { cause: error.message } : undefined);
}

function digest(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function mimeType(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function safeDocumentPath(value: string): string {
  const candidate = value.replaceAll("\\", "/");
  if (!candidate || candidate.startsWith("/") || /^[a-zA-Z]:\//.test(candidate) || candidate.includes("\0")) {
    throw new ProjectError("PATH_ESCAPE", "Document path must be relative", { path: value });
  }
  const normalized = path.posix.normalize(candidate);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.includes("//")) {
    throw new ProjectError("PATH_ESCAPE", "Document path escapes its bundle", { path: value });
  }
  return normalized;
}

function cloneBundles(value: OfflineDocumentBundle[]): OfflineDocumentBundle[] {
  return value.map((bundle) => ({ ...bundle, versions: bundle.versions.map((version) => ({ ...version, files: version.files.map((file) => ({ ...file })) })) }));
}

function cloneIndex(index: Index): Index {
  return { schemaVersion: 1, bundles: cloneBundles(index.bundles) };
}

function canDecodeText(bytes: Buffer): boolean {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return !text.includes("\0");
  } catch {
    return false;
  }
}

/** Durable, global offline document repository. It never writes into projects. */
export class OfflineDocumentStore {
  private queue: Promise<unknown> = Promise.resolve();
  private cached?: Index;
  readonly root: string;

  constructor(userDataDirectory: string) {
    this.root = path.join(userDataDirectory, "offline-documents");
  }

  private get indexPath(): string { return path.join(this.root, "index.json"); }
  private get bundlesPath(): string { return path.join(this.root, "bundles"); }

  async list(): Promise<OfflineDocumentBundle[]> {
    const index = await this.readIndex();
    return cloneBundles(index.bundles);
  }

  async importFiles(paths: string[], name: string, version: string, enabled: boolean, options: OfflineDocumentImportOptions = {}): Promise<OfflineDocumentBundle> {
    if (!Array.isArray(paths) || paths.length < 1) throw new ProjectError("VALIDATION_FAILED", "Select at least one document file");
    return this.enqueue(() => this.importFromSources(paths, undefined, name, version, enabled, options));
  }

  async importDirectory(directory: string, name: string, version: string, enabled: boolean, options: OfflineDocumentImportOptions = {}): Promise<OfflineDocumentBundle> {
    return this.enqueue(async () => {
      const root = await this.ensureDirectory(directory);
      const sources: string[] = [];
      await this.walkSource(root, root, sources);
      if (!sources.length) throw new ProjectError("VALIDATION_FAILED", "The selected directory contains no regular files");
      return this.importFromSources(sources, root, name, version, enabled, options);
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<OfflineDocumentBundle> {
    return this.enqueue(async () => {
      const index = cloneIndex(await this.readIndex());
      const bundle = this.findBundle(index, id);
      bundle.enabled = enabled;
      bundle.updatedAt = new Date().toISOString();
      await this.writeIndex(index);
      return structuredClone(bundle);
    });
  }

  async setVersion(id: string, versionId: string): Promise<OfflineDocumentBundle> {
    return this.enqueue(async () => {
      const index = cloneIndex(await this.readIndex());
      const bundle = this.findBundle(index, id);
      if (!bundle.versions.some((version) => version.id === versionId)) throw new ProjectError("FILE_NOT_FOUND", "Offline document version not found", { id, versionId });
      bundle.activeVersionId = versionId;
      bundle.updatedAt = new Date().toISOString();
      await this.writeIndex(index);
      return structuredClone(bundle);
    });
  }

  async read(id: string, versionId: string | undefined, filePath: string, options?: OfflineDocumentReadOptions, redactText: (text: string) => string = redactSecret): Promise<OfflineDocumentRead> {
    const parsed = options === undefined ? undefined : OfflineDocumentReadOptionsSchema.safeParse(options);
    if (parsed && !parsed.success) throw new ProjectError("VALIDATION_FAILED", "Invalid document page options");
    const index = await this.readIndex();
    const bundle = this.findBundle(index, id);
    if (!bundle.enabled) throw new ProjectError("TASK_SCOPE_DENIED", "Offline document bundle is disabled", { id });
    const selectedVersionId = versionId ?? bundle.activeVersionId;
    const version = bundle.versions.find((item) => item.id === selectedVersionId);
    if (!version) throw new ProjectError("FILE_NOT_FOUND", "Offline document version not found", { id, versionId: selectedVersionId });
    const relative = safeDocumentPath(filePath);
    const entry = version.files.find((item) => item.path === relative);
    if (!entry) throw new ProjectError("FILE_NOT_FOUND", "Offline document file not found", { id, versionId, path: relative });
    const target = path.join(this.bundlesPath, bundle.id, "versions", version.id, "files", ...relative.split("/"));
    let bytes: Buffer;
    try {
      const stats = await lstat(target);
      if (!stats.isFile() || stats.isSymbolicLink()) throw new ProjectError("PATH_ESCAPE", "Offline document file is not a regular file", { path: relative });
      bytes = await readFile(target);
    } catch (error) {
      if (error instanceof ProjectError) throw error;
      if (isMissing(error)) throw new ProjectError("FILE_NOT_FOUND", "Offline document file is missing", { path: relative });
      asProjectError(error, "Unable to read offline document file");
    }
    if (digest(bytes) !== entry.hash) throw new ProjectError("VERSION_CONFLICT", "Offline document file changed unexpectedly", { path: relative });
    const text = bytes.byteLength <= OFFLINE_DOCUMENT_LIMITS.maxReadTextBytes && canDecodeText(bytes)
      ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
      : undefined;
    const document: OfflineDocumentRead = { bundleId: bundle.id, versionId: version.id, path: relative, name: entry.name, mimeType: entry.mimeType, size: entry.size, kind: text === undefined ? "binary" : "text", ...(text === undefined ? {} : { content: text }) };
    return parsed?.success && text !== undefined ? offlineDocumentPage(document, redactText(text), parsed.data) : document;
  }

  async listEnabled(): Promise<OfflineDocumentBundle[]> {
    return (await this.list()).filter((bundle) => bundle.enabled);
  }

  async remove(id: string, versionId?: string): Promise<void> {
    return this.enqueue(async () => {
      const index = await this.readIndex();
      const nextIndex = cloneIndex(index);
      const bundle = this.findBundle(nextIndex, id);
      let removedPath: string;
      if (versionId === undefined) {
        nextIndex.bundles = nextIndex.bundles.filter((item) => item.id !== id);
        removedPath = path.join(this.bundlesPath, id);
      } else {
        const version = bundle.versions.find((item) => item.id === versionId);
        if (!version) throw new ProjectError("FILE_NOT_FOUND", "Offline document version not found", { id, versionId });
        bundle.versions = bundle.versions.filter((item) => item.id !== versionId);
        if (bundle.activeVersionId === versionId) bundle.activeVersionId = bundle.versions[0]?.id;
        bundle.updatedAt = new Date().toISOString();
        removedPath = path.join(this.bundlesPath, id, "versions", versionId);
      }
      await this.writeIndex(nextIndex);
      await rm(removedPath, { recursive: true, force: true });
    });
  }

  private async importFromSources(paths: string[], directoryRoot: string | undefined, nameInput: string, versionInput: string, enabled: boolean, options: OfflineDocumentImportOptions): Promise<OfflineDocumentBundle> {
    const name = nameInput.trim();
    const label = versionInput.trim();
    if (!name || name.length > 256 || !label || label.length > 128) throw new ProjectError("VALIDATION_FAILED", "Document bundle name and version are required");
    if (typeof enabled !== "boolean") throw new ProjectError("VALIDATION_FAILED", "Document bundle enabled state is invalid");
    const files = await this.readSources(paths, directoryRoot);
    if (files.length > OFFLINE_DOCUMENT_LIMITS.maxFilesPerVersion) throw new ProjectError("VALIDATION_FAILED", "Too many files in one offline document version");
    const totalSize = files.reduce((sum, file) => sum + file.size, 0);
    if (totalSize > OFFLINE_DOCUMENT_LIMITS.maxVersionBytes) throw new ProjectError("VALIDATION_FAILED", "Offline document version exceeds the size limit");
    const aggregate = createHash("sha256");
    for (const file of files) aggregate.update(`${file.path}\0${file.hash}\0`, "utf8");
    const versionHash = `sha256:${aggregate.digest("hex")}`;
    const index = await this.readIndex();
    const nextIndex = cloneIndex(index);
    let bundle = nextIndex.bundles.find((item) => item.name === name);
    if (!bundle) {
      if (nextIndex.bundles.length >= OFFLINE_DOCUMENT_LIMITS.maxBundles) throw new ProjectError("VALIDATION_FAILED", "Too many offline document bundles");
      const now = new Date().toISOString();
      bundle = { id: randomUUID(), name, enabled, createdAt: now, updatedAt: now, versions: [] };
      nextIndex.bundles.push(bundle);
    }
    const existing = bundle.versions.find((item) => item.hash === versionHash);
    if (existing) {
      if (enabled !== bundle.enabled) bundle.enabled = enabled;
      if (options.setCurrent) bundle.activeVersionId = existing.id;
      bundle.updatedAt = new Date().toISOString();
      await this.writeIndex(nextIndex);
      return structuredClone(bundle);
    }
    if (bundle.versions.some((item) => item.label === label)) throw new ProjectError("VALIDATION_FAILED", "This document version label already exists with different content", { name, version: label });
    if (bundle.versions.length >= OFFLINE_DOCUMENT_LIMITS.maxVersionsPerBundle) throw new ProjectError("VALIDATION_FAILED", "Too many versions in one offline document bundle");
    const versionRecord: OfflineDocumentVersion = {
      id: randomUUID(), label, fileCount: files.length, size: totalSize, hash: versionHash,
      importedAt: new Date().toISOString(),
      files: files.map((file) => ({ path: file.path, name: file.name, mimeType: file.mimeType, size: file.size, hash: file.hash })),
    };
    const versionRoot = path.join(this.bundlesPath, bundle.id, "versions", versionRecord.id);
    const temporaryRoot = `${versionRoot}.tmp-${randomUUID()}`;
    let versionInstalled = false;
    try {
      await mkdir(path.join(temporaryRoot, "files"), { recursive: true });
      for (const file of files) {
        const target = path.join(temporaryRoot, "files", ...file.path.split("/"));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.bytes, { flag: "wx" });
      }
      await mkdir(path.dirname(versionRoot), { recursive: true });
      await rename(temporaryRoot, versionRoot);
      versionInstalled = true;
      bundle.versions.push(versionRecord);
      if (!bundle.activeVersionId || options.setCurrent) bundle.activeVersionId = versionRecord.id;
      bundle.enabled = enabled;
      bundle.updatedAt = new Date().toISOString();
      await this.writeIndex(nextIndex);
      return structuredClone(bundle);
    } catch (error) {
      await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
      if (versionInstalled) await rm(versionRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async readSources(paths: string[], directoryRoot: string | undefined): Promise<SourceFile[]> {
    const seen = new Set<string>();
    const files: SourceFile[] = [];
    for (const source of paths) {
      let stats;
      try { stats = await lstat(source); } catch (error) { if (isMissing(error)) throw new ProjectError("FILE_NOT_FOUND", "Offline document source does not exist", { path: source }); throw error; }
      if (!stats.isFile() || stats.isSymbolicLink()) throw new ProjectError("PATH_ESCAPE", "Offline document sources must be regular files", { path: source });
      if (stats.size > OFFLINE_DOCUMENT_LIMITS.maxFileBytes) throw new ProjectError("VALIDATION_FAILED", "Offline document file exceeds the size limit", { path: source });
      const relative = directoryRoot ? safeDocumentPath(path.relative(directoryRoot, source).replaceAll("\\", "/")) : safeDocumentPath(path.basename(source));
      if (seen.has(relative)) throw new ProjectError("VALIDATION_FAILED", "Offline document contains duplicate paths", { path: relative });
      seen.add(relative);
      const bytes = await readFile(source);
      if (bytes.byteLength > OFFLINE_DOCUMENT_LIMITS.maxFileBytes) throw new ProjectError("VALIDATION_FAILED", "Offline document file exceeds the size limit", { path: source });
      files.push({ bytes, path: relative, name: path.basename(relative), mimeType: mimeType(relative), size: bytes.byteLength, hash: digest(bytes) });
    }
    return files.sort((left, right) => left.path.localeCompare(right.path));
  }

  private async ensureDirectory(directory: string): Promise<string> {
    try {
      const resolved = await realpath(directory);
      const stats = await lstat(resolved);
      if (!stats.isDirectory()) throw new ProjectError("VALIDATION_FAILED", "Offline document source must be a directory");
      return resolved;
    } catch (error) {
      if (error instanceof ProjectError) throw error;
      if (isMissing(error)) throw new ProjectError("FILE_NOT_FOUND", "Offline document directory does not exist", { path: directory });
      asProjectError(error, "Unable to read offline document directory");
    }
  }

  private async walkSource(root: string, directory: string, output: string[]): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new ProjectError("PATH_ESCAPE", "Offline document directories cannot contain symbolic links", { path: target });
      if (entry.isDirectory()) await this.walkSource(root, target, output);
      else if (entry.isFile()) output.push(target);
      else throw new ProjectError("PATH_ESCAPE", "Only regular files and directories can be imported", { path: target });
    }
  }

  private findBundle(index: Index, id: string): OfflineDocumentBundle {
    const bundle = index.bundles.find((item) => item.id === id);
    if (!bundle) throw new ProjectError("FILE_NOT_FOUND", "Offline document bundle not found", { id });
    return bundle;
  }

  private async readIndex(): Promise<Index> {
    if (this.cached) return cloneIndex(this.cached);
    let value: unknown;
    try { value = JSON.parse(await readFile(this.indexPath, "utf8")); } catch (error) {
      if (isMissing(error)) {
        this.cached = { schemaVersion: 1, bundles: [] };
        return cloneIndex(this.cached);
      }
      this.cached = { schemaVersion: 1, bundles: [] };
      return cloneIndex(this.cached);
    }
    const parsed = (value && typeof value === "object" && "bundles" in value)
      ? { schemaVersion: 1 as const, bundles: (value as { bundles?: unknown }).bundles }
      : undefined;
    if (!parsed || !Array.isArray(parsed.bundles)) {
      this.cached = { schemaVersion: 1, bundles: [] };
      return cloneIndex(this.cached);
    }
    const valid = parsed.bundles.flatMap((item) => { const result = OfflineDocumentBundleSchema.safeParse(item); return result.success ? [result.data] : []; });
    this.cached = { schemaVersion: 1, bundles: valid };
    return cloneIndex(this.cached);
  }

  private async writeIndex(index: Index): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(this.bundlesPath, { recursive: true });
    const temporary = `${this.indexPath}.tmp-${randomUUID()}`;
    try {
      await writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, "utf8");
      await rename(temporary, this.indexPath);
      this.cached = index;
    } finally { await rm(temporary, { force: true }).catch(() => undefined); }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
