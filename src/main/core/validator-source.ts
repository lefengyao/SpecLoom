import type { ChangeEntry, FileVersion, VersionToken } from "../../shared/contracts";
import { ChangeEntrySchema } from "../../shared/contracts";
import { FileStore } from "./file-store";
import { ProjectError } from "./errors";
import { decodeText, digestBytes, hasCode } from "./store-fs";
import type { TaskScope } from "./task-scope";

export class ValidationSource {
  readonly dependencies: Record<string, VersionToken> = {};
  readonly inventory: string[];
  readonly paths: string[];
  private readonly originals: Map<string, FileVersion>;
  private readonly staged = new Map<string, ChangeEntry>();

  private constructor(private readonly store: FileStore, files: FileVersion[]) {
    this.originals = new Map(files.map((file) => [store.pathIdentity(file.path), file]));
    this.inventory = files.map((file) => file.path).sort();
    this.paths = [...this.inventory];
  }

  static async create(store: FileStore, overlay: ChangeEntry[] = [], scope?: TaskScope): Promise<ValidationSource> {
    const source = new ValidationSource(store, await store.listFiles());
    for (const candidate of overlay) {
      const entry = ChangeEntrySchema.parse(candidate);
      const relative = store.normalizePath(entry.path);
      scope?.assertWrite(relative, entry.operation);
      if (scope && entry.sourceTaskId !== scope.describe().id) throw new ProjectError("TASK_SCOPE_DENIED", "Staged changes belong to another task", { path: relative });
      const identity = store.pathIdentity(relative);
      if (source.staged.has(identity)) throw new ProjectError("VALIDATION_FAILED", "Duplicate staged path", { path: relative });
      const current = await source.version(relative);
      store.assertVersion(relative, current, entry.expectedVersion);
      if ((entry.operation === "create") !== (current === "absent")) throw new ProjectError("VERSION_CONFLICT", "Staged operation does not match its file baseline", { path: relative });
      if (entry.operation !== "delete") store.validateContent(entry.nextContent!);
      source.staged.set(identity, { ...entry, path: relative });
      const existing = source.paths.findIndex((file) => store.pathIdentity(file) === identity);
      if (existing >= 0) source.paths.splice(existing, 1);
      if (entry.operation !== "delete") source.paths.push(relative);
    }
    source.paths.sort();
    return source;
  }

  async version(relative: string): Promise<VersionToken> {
    const normalized = this.store.normalizePath(relative);
    const original = this.originals.get(this.store.pathIdentity(normalized));
    const version = original?.version ?? (await this.store.listVersion(normalized)).version;
    this.dependencies[original?.path ?? normalized] = version;
    return version;
  }

  async exists(relative: string): Promise<boolean> {
    const normalized = this.store.normalizePath(relative);
    const version = await this.version(normalized);
    const entry = this.staged.get(this.store.pathIdentity(normalized));
    if (entry) return entry.operation !== "delete";
    return version !== "absent";
  }

  async effectiveVersion(relative: string): Promise<VersionToken> {
    const normalized = this.store.normalizePath(relative);
    const version = await this.version(normalized);
    const entry = this.staged.get(this.store.pathIdentity(normalized));
    return entry ? entry.operation === "delete" ? "absent" : digestBytes(Buffer.from(entry.nextContent!, "utf8")) : version;
  }

  async read(relative: string): Promise<string | undefined> {
    const normalized = this.store.normalizePath(relative);
    const version = await this.version(normalized);
    const entry = this.staged.get(this.store.pathIdentity(normalized));
    if (entry) return entry.operation === "delete" ? undefined : entry.nextContent!;
    if (version === "absent") return undefined;
    return (await this.store.read(normalized, version)).content;
  }

  async readManifest(): Promise<string | undefined> {
    const relative = ".specloom/generated-manifest.json";
    const target = await this.store.policy.resolve(relative, true);
    let handle;
    try { handle = await this.store.fs.open(target, "r"); } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      this.dependencies[relative] = "absent";
      return undefined;
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > this.store.maxTextBytes) throw new ProjectError("VALIDATION_FAILED", "Generated manifest must be a bounded regular text file");
      const bytes = await handle.readFile();
      await this.store.policy.assertSafe(target);
      this.dependencies[relative] = digestBytes(bytes);
      return decodeText(bytes, this.store.maxTextBytes);
    } finally { await handle.close(); }
  }
}
