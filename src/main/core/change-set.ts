import { randomUUID } from "node:crypto";
import { ChangeEntrySchema, VersionTokenSchema, type ChangeEntry, type ChangeSetData, type ChangeSetStatus, type VersionToken } from "../../shared/contracts";
import { ChangeJournal, type JournalRecord } from "./change-journal";
import { ProjectError } from "./errors";
import { FileStore } from "./file-store";
import { digestBytes } from "./store-fs";

export interface StagedChangeSetOptions { taskId: string; id?: string }

export class StagedChangeSet {
  readonly id: string;
  readonly taskId: string;
  private readonly entries = new Map<string, ChangeEntry>();
  private readonly dependencies = new Map<string, { path: string; version: VersionToken }>();
  private status: ChangeSetStatus = "staged";
  private revision = 0;

  constructor(private readonly store: FileStore, options: StagedChangeSetOptions) {
    this.id = options.id ?? randomUUID();
    this.taskId = options.taskId;
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(this.id) || !this.taskId.trim()) throw new ProjectError("VALIDATION_FAILED", "Invalid change set identity");
  }

  stage(input: ChangeEntry): void {
    this.assertMutable();
    const parsed = ChangeEntrySchema.safeParse(input);
    if (!parsed.success) throw new ProjectError("VALIDATION_FAILED", "Invalid staged change entry");
    const entry = { ...parsed.data, path: this.store.normalizePath(parsed.data.path) };
    if (entry.operation !== "create" && entry.expectedVersion === "absent") throw new ProjectError("VERSION_CONFLICT", "Updates and deletes require an existing baseline", { path: entry.path });
    if (entry.nextContent !== undefined) this.store.validateContent(entry.nextContent);
    const key = this.store.pathIdentity(entry.path);
    const existing = this.entries.get(key);
    if (existing && existing.expectedVersion !== entry.expectedVersion) throw new ProjectError("VERSION_CONFLICT", "Restaging cannot replace the original baseline", { path: entry.path });
    const dependency = this.dependencies.get(key);
    if (dependency !== undefined && dependency.version !== entry.expectedVersion) throw new ProjectError("VERSION_CONFLICT", "Output baseline differs from the recorded read dependency", { path: entry.path });
    this.entries.set(key, { ...entry, path: existing?.path ?? dependency?.path ?? entry.path });
    this.invalidate();
  }

  addDependency(relative: string, version: VersionToken): void {
    this.assertMutable();
    const normalized = this.store.normalizePath(relative);
    const key = this.store.pathIdentity(normalized);
    if (!VersionTokenSchema.safeParse(version).success) throw new ProjectError("VALIDATION_FAILED", "Invalid read dependency version");
    const dependency = this.dependencies.get(key);
    const entry = this.entries.get(key);
    const existing = dependency?.version ?? entry?.expectedVersion;
    if (existing !== undefined && existing !== version) throw new ProjectError("VERSION_CONFLICT", "A dependency was read at incompatible versions", { path: normalized });
    if (dependency?.version !== version) {
      this.dependencies.set(key, { path: dependency?.path ?? entry?.path ?? normalized, version });
      this.invalidate();
    }
  }

  unstage(relative: string): void {
    this.assertMutable();
    if (this.entries.delete(this.store.pathIdentity(relative))) this.invalidate();
  }

  preview(): ChangeSetData {
    const entries = [...this.entries.values()].sort((a, b) => a.path.localeCompare(b.path)).map((entry) => Object.freeze(structuredClone(entry)));
    const dependencies = Object.fromEntries([...this.dependencies.values()].sort((a, b) => a.path.localeCompare(b.path)).map((dependency) => [dependency.path, dependency.version]));
    const digest = digestBytes(JSON.stringify({ id: this.id, taskId: this.taskId, revision: this.revision, entries, dependencies }));
    Object.freeze(entries);
    Object.freeze(dependencies);
    return Object.freeze({ id: this.id, taskId: this.taskId, entries, dependencies, digest, status: this.status });
  }

  markValidated(expectedDigest: string): ChangeSetData {
    this.assertMutable();
    this.assertDigest(expectedDigest);
    this.status = "validated";
    return this.preview();
  }

  reject(): ChangeSetData {
    this.assertMutable();
    this.status = "rejected";
    return this.preview();
  }

  async commit(expectedDigest: string, preflight?: () => Promise<void>): Promise<ChangeSetData> {
    this.assertMutable();
    this.assertDigest(expectedDigest);
    if (!this.entries.size) throw new ProjectError("VALIDATION_FAILED", "Cannot commit an empty change set");
    // Freeze staging before waiting for the shared root mutex; approval is bound to this exact preview.
    const preview = this.preview();
    this.status = "committing";
    try {
      return await this.store.withLock(async (access) => {
        const journal = new ChangeJournal(this.store);
        const unresolved = (await journal.inspect()).some((record) => ["committing", "recovery-conflict"].includes(record.status));
        if (unresolved) throw new ProjectError("VERSION_CONFLICT", "Recover pending change journals before committing another batch");
        await preflight?.();
        for (const entry of preview.entries) this.store.assertVersion(entry.path, (await this.store.listVersion(entry.path)).version, entry.expectedVersion);
        for (const [relative, expected] of Object.entries(preview.dependencies)) this.store.assertVersion(relative, (await this.store.listVersion(relative)).version, expected);
        const record = await journal.prepare(this.id, this.taskId, preview.digest, preview.entries);
        try {
          for (const operation of record.operations) {
            // Persist intent before touching a file. Recovery handles either preimage or postimage at restart.
            operation.state = "applying";
            await journal.write(record);
            if (operation.entry.operation === "delete") await access.remove(operation.entry.path, operation.entry.expectedVersion);
            else await access.write(operation.entry.path, operation.entry.nextContent!, operation.entry.expectedVersion);
            operation.state = "applied";
            await journal.write(record);
          }
          // Ordinary filesystem writes cannot form a multi-file transaction against external editors.
          // Rechecks and guarded recovery protect managed writes, but there is no atomic external CAS.
          record.status = "applied";
          await journal.write(record);
          this.status = "applied";
          return this.preview();
        } catch (error) {
          this.status = await journal.rollback(record, access);
          throw error;
        }
      });
    } catch (error) {
      if (this.status === "committing") this.status = error instanceof ProjectError && error.code === "VERSION_CONFLICT" ? "conflicted" : "failed";
      throw error;
    }
  }

  static async inspectHistory(store: FileStore): Promise<JournalRecord[]> {
    return store.withLock(() => new ChangeJournal(store).inspect());
  }

  static async recover(store: FileStore): Promise<JournalRecord[]> {
    return store.withLock((access) => new ChangeJournal(store).recover(access));
  }

  private assertMutable(): void {
    if (!["staged", "validated"].includes(this.status)) throw new ProjectError("VALIDATION_FAILED", "This change set cannot be modified or committed in its current state", { status: this.status });
  }

  private assertDigest(expected: string): void {
    if (this.preview().digest !== expected) throw new ProjectError("APPROVAL_REQUIRED", "Change preview changed; approval must reference its current digest");
  }

  private invalidate(): void { this.revision += 1; this.status = "staged"; }
}
