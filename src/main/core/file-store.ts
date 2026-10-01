import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { FileReadResult, FileVersion, TextPatch, VersionToken } from "../../shared/contracts";
import { ProjectError } from "./errors";
import { PathPolicy, normalizeProjectPath } from "./path-policy";
import { withRootMutex } from "./root-mutex";
import { defaultFileSystem, decodeText, digestBytes, encodeText, hasCode, removeTemporary, type StoreFileSystem } from "./store-fs";

export interface FileStoreOptions { maxTextBytes?: number; fs?: Partial<StoreFileSystem> }
export interface GuardedFileAccess {
  write(relative: string, content: string, expectedVersion: VersionToken): Promise<FileVersion>;
  remove(relative: string, expectedVersion: VersionToken): Promise<void>;
}

export class FileStore {
  readonly maxTextBytes: number;
  /** Internal filesystem transport for the reserved durable journal. Never expose through IPC/tools. */
  readonly fs: StoreFileSystem;
  readonly policy: PathPolicy;

  constructor(root: string, options: FileStoreOptions = {}) {
    this.fs = { ...defaultFileSystem, ...options.fs };
    this.policy = new PathPolicy(root, this.fs);
    this.maxTextBytes = options.maxTextBytes ?? 1024 * 1024;
    if (!Number.isSafeInteger(this.maxTextBytes) || this.maxTextBytes < 1) throw new ProjectError("VALIDATION_FAILED", "Invalid text byte limit");
  }

  get root(): string { return this.policy.root; }
  normalizePath(relative: string): string { return normalizeProjectPath(relative); }
  pathIdentity(relative: string): string { const normalized = this.normalizePath(relative); return process.platform === "win32" ? normalized.toLowerCase() : normalized; }
  validateContent(content: string): void { encodeText(content, this.maxTextBytes); }

  async listVersion(relative: string): Promise<FileVersion> {
    const normalized = this.normalizePath(relative);
    const target = await this.policy.resolve(normalized);
    try {
      const handle = await this.fs.open(target, "r");
      try {
        if (!(await handle.stat()).isFile()) throw new ProjectError("VALIDATION_FAILED", "Expected a regular file", { path: normalized });
        const hash = createHash("sha256");
        const chunk = Buffer.alloc(64 * 1024);
        let size = 0;
        while (true) {
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
          if (!bytesRead) break;
          size += bytesRead;
          hash.update(chunk.subarray(0, bytesRead));
        }
        await this.policy.assertSafe(target);
        return { path: normalized, exists: true, size, version: `sha256:${hash.digest("hex")}` };
      } finally { await handle.close(); }
    } catch (error) {
      if (hasCode(error, "ENOENT")) return { path: normalized, exists: false, size: 0, version: "absent" };
      throw error;
    }
  }

  async listVersions(paths: string[]): Promise<FileVersion[]> { return Promise.all(paths.map((relative) => this.listVersion(relative))); }

  async listFiles(prefix?: string): Promise<FileVersion[]> {
    await this.policy.validateRoot();
    const normalized = prefix === undefined ? "" : this.normalizePath(prefix);
    const target = normalized ? await this.policy.resolve(normalized) : this.root;
    let stats;
    try { stats = await this.fs.lstat(target); } catch (error) { if (hasCode(error, "ENOENT")) return []; throw error; }
    if (stats.isFile()) return [await this.listVersion(normalized)];
    const versions: FileVersion[] = [];
    const visit = async (directory: string): Promise<void> => {
      await this.policy.assertSafe(path.join(this.root, directory));
      const entries = await this.fs.readdir(path.join(this.root, directory), { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if ([".git", ".godot"].includes(entry.name.toLowerCase()) || entry.name.includes(".specloom-tmp-")) continue;
        const relative = path.posix.join(directory, entry.name);
        if (relative.toLowerCase() === ".specloom") {
          await this.policy.assertSafe(path.join(this.root, relative));
          const skills = path.posix.join(relative, "skills");
          try { await this.fs.lstat(path.join(this.root, skills)); await visit(skills); } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
          continue;
        }
        this.normalizePath(relative);
        await this.policy.assertSafe(path.join(this.root, relative));
        if (entry.isDirectory()) await visit(relative);
        else if (entry.isFile()) versions.push(await this.listVersion(relative));
        else throw new ProjectError("PATH_ESCAPE", "Only regular files and directories are allowed", { path: relative });
      }
    };
    await visit(normalized);
    return versions.sort((a, b) => a.path.localeCompare(b.path));
  }

  async read(relative: string, expectedVersion: VersionToken): Promise<FileReadResult> {
    const normalized = this.normalizePath(relative);
    const target = await this.policy.resolve(normalized);
    let handle;
    try { handle = await this.fs.open(target, "r"); } catch (error) {
      if (hasCode(error, "ENOENT")) {
        this.assertVersion(normalized, "absent", expectedVersion);
        throw new ProjectError("FILE_NOT_FOUND", "The project file does not exist", { path: normalized });
      }
      throw error;
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) throw new ProjectError("VALIDATION_FAILED", "Expected a regular text file", { path: normalized });
      if (stats.size > this.maxTextBytes) throw new ProjectError("VALIDATION_FAILED", "Text file exceeds the configured byte limit");
      const chunks: Buffer[] = [];
      let size = 0;
      while (true) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, this.maxTextBytes + 1 - size));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        size += bytesRead;
        if (size > this.maxTextBytes) throw new ProjectError("VALIDATION_FAILED", "Text file exceeds the configured byte limit");
        chunks.push(chunk.subarray(0, bytesRead));
      }
      const bytes = Buffer.concat(chunks);
      const version = digestBytes(bytes);
      this.assertVersion(normalized, version, expectedVersion);
      await this.policy.assertSafe(target);
      return { path: normalized, version, content: decodeText(bytes, this.maxTextBytes) };
    } finally { await handle.close(); }
  }

  assertVersion(relative: string, actual: VersionToken, expected: VersionToken): void {
    if (actual !== expected) throw new ProjectError("VERSION_CONFLICT", "Project file changed since its version was captured", { path: relative, expectedVersion: expected, actualVersion: actual });
  }

  async withLock<T>(operation: (access: GuardedFileAccess) => Promise<T>): Promise<T> {
    const canonicalRoot = await this.policy.validateRoot();
    return withRootMutex(canonicalRoot, () => operation({ write: this.writeUnlocked.bind(this), remove: this.removeUnlocked.bind(this) }));
  }

  async write(relative: string, content: string, expectedVersion: VersionToken): Promise<FileVersion> {
    return this.withLock((access) => access.write(relative, content, expectedVersion));
  }

  async patch(relative: string, patch: TextPatch, expectedVersion: VersionToken): Promise<FileVersion> {
    return this.withLock(async (access) => {
      const { content } = await this.read(relative, expectedVersion);
      const offset = content.indexOf(patch.search);
      if (!patch.search || offset < 0 || content.indexOf(patch.search, offset + 1) >= 0) throw new ProjectError("INVALID_PATCH", "Patch search must match exactly one occurrence", { path: relative });
      return access.write(relative, content.slice(0, offset) + patch.replace + content.slice(offset + patch.search.length), expectedVersion);
    });
  }

  async remove(relative: string, expectedVersion: VersionToken): Promise<void> { return this.withLock((access) => access.remove(relative, expectedVersion)); }

  private async writeUnlocked(relative: string, content: string, expectedVersion: VersionToken): Promise<FileVersion> {
    const normalized = this.normalizePath(relative);
    const bytes = encodeText(content, this.maxTextBytes);
    const target = await this.policy.resolve(normalized);
    this.assertVersion(normalized, (await this.listVersion(normalized)).version, expectedVersion);
    if (expectedVersion !== "absent") await this.read(normalized, expectedVersion);
    await this.policy.ensureParent(target);
    if (expectedVersion === "absent") {
      await this.policy.assertSafe(target, true);
      let handle;
      try { handle = await this.fs.open(target, "wx"); } catch (error) {
        if (hasCode(error, "EEXIST")) throw new ProjectError("VERSION_CONFLICT", "A file appeared before exclusive creation", { path: normalized });
        throw error;
      }
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    } else {
      const temporary = path.join(path.dirname(target), `.specloom-tmp-${randomUUID()}`);
      try {
        await this.policy.assertSafe(temporary, true);
        const handle = await this.fs.open(temporary, "wx");
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        await this.policy.assertSafe(target);
        this.assertVersion(normalized, (await this.listVersion(normalized)).version, expectedVersion);
        // External editors are not covered by our mutex; rename is atomic but not a filesystem CAS.
        await this.fs.rename(temporary, target);
      } finally { await removeTemporary(this.fs, temporary); }
    }
    return { path: normalized, exists: true, size: bytes.length, version: digestBytes(bytes) };
  }

  private async removeUnlocked(relative: string, expectedVersion: VersionToken): Promise<void> {
    const normalized = this.normalizePath(relative);
    const target = await this.policy.resolve(normalized);
    const current = await this.listVersion(normalized);
    this.assertVersion(normalized, current.version, expectedVersion);
    if (!current.exists) throw new ProjectError("FILE_NOT_FOUND", "Cannot delete an absent project file", { path: normalized });
    await this.policy.assertSafe(target);
    this.assertVersion(normalized, (await this.listVersion(normalized)).version, expectedVersion);
    await this.fs.unlink(target);
  }
}
