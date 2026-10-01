import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { ChangeEntrySchema, ChangeSetStatusSchema, VersionTokenSchema, type ChangeEntry, type ChangeSetStatus } from "../../shared/contracts";
import { ProjectError } from "./errors";
import { FileStore, type GuardedFileAccess } from "./file-store";
import { decodeText, digestBytes, hasCode, removeTemporary } from "./store-fs";

const maxJournalBytes = 64 * 1024 * 1024;

const OperationSchema = z.object({
  entry: ChangeEntrySchema,
  preimage: z.string().nullable(),
  postimageVersion: VersionTokenSchema,
  state: z.enum(["pending", "applying", "applied", "restored"]),
}).strict();
const JournalSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), taskId: z.string().min(1),
  digest: z.string(), status: ChangeSetStatusSchema, createdAt: z.string(),
  operations: z.array(OperationSchema), recoveryConflicts: z.array(z.string()),
}).strict();
export type JournalOperation = z.infer<typeof OperationSchema>;
export type JournalRecord = z.infer<typeof JournalSchema>;

export class ChangeJournal {
  private readonly directory = ".specloom/history/changes";
  constructor(private readonly store: FileStore) {}

  async write(record: JournalRecord): Promise<void> {
    const validated = JournalSchema.parse(record);
    const serialized = `${JSON.stringify(validated, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > maxJournalBytes) throw new ProjectError("VALIDATION_FAILED", "Change journal exceeds the byte limit", { limit: maxJournalBytes });
    const target = await this.store.policy.resolve(`${this.directory}/${validated.id}.json`, true);
    await this.store.policy.ensureParent(target);
    const temporary = path.join(path.dirname(target), `.specloom-tmp-${randomUUID()}`);
    try {
      await this.store.policy.assertSafe(temporary, true);
      const handle = await this.store.fs.open(temporary, "wx");
      try { await handle.writeFile(serialized, "utf8"); await handle.sync(); } finally { await handle.close(); }
      await this.store.policy.assertSafe(target, true);
      await this.store.fs.rename(temporary, target);
    } finally { await removeTemporary(this.store.fs, temporary); }
  }

  async inspect(): Promise<JournalRecord[]> {
    const target = await this.store.policy.resolve(this.directory, true);
    let names: string[];
    try { names = await this.store.fs.readdir(target); } catch (error) { if (hasCode(error, "ENOENT")) return []; throw error; }
    const records: JournalRecord[] = [];
    for (const name of names.filter((value) => value.endsWith(".json")).sort()) {
      const filename = await this.store.policy.resolve(`${this.directory}/${name}`, true);
      const handle = await this.store.fs.open(filename, "r");
      try {
        const stats = await handle.stat();
        if (!stats.isFile() || stats.size > maxJournalBytes) throw new ProjectError("VALIDATION_FAILED", "Invalid or oversized change journal", { path: name });
        let parsed: unknown;
        try { parsed = JSON.parse(decodeText(await handle.readFile(), maxJournalBytes)); }
        catch { throw new ProjectError("VALIDATION_FAILED", "Change journal is not valid UTF-8 JSON", { path: name }); }
        const validated = JournalSchema.safeParse(parsed);
        if (!validated.success || validated.data.id + ".json" !== name) throw new ProjectError("VALIDATION_FAILED", "Invalid change journal", { path: name });
        this.validatePreimages(validated.data);
        await this.store.policy.assertSafe(filename);
        records.push(validated.data);
      } finally { await handle.close(); }
    }
    return records;
  }

  private validatePreimages(record: JournalRecord): void {
    const paths = new Set<string>();
    for (const operation of record.operations) {
      const normalized = this.store.normalizePath(operation.entry.path);
      const identity = this.store.pathIdentity(normalized);
      const before = operation.preimage === null ? "absent" : digestBytes(operation.preimage);
      const after = operation.entry.operation === "delete" ? "absent" : digestBytes(operation.entry.nextContent!);
      if (normalized !== operation.entry.path || paths.has(identity) || before !== operation.entry.expectedVersion || after !== operation.postimageVersion
        || (operation.entry.operation === "create") !== (operation.entry.expectedVersion === "absent")) {
        throw new ProjectError("VALIDATION_FAILED", "Change journal preimage or postimage integrity check failed", { path: normalized });
      }
      if (operation.preimage !== null) this.store.validateContent(operation.preimage);
      if (operation.entry.nextContent !== undefined) this.store.validateContent(operation.entry.nextContent);
      paths.add(identity);
    }
  }

  async prepare(id: string, taskId: string, digest: string, entries: ChangeEntry[]): Promise<JournalRecord> {
    const target = await this.store.policy.resolve(`${this.directory}/${JournalSchema.shape.id.parse(id)}.json`, true);
    try {
      await this.store.fs.lstat(target);
      throw new ProjectError("VERSION_CONFLICT", "A change journal already uses this ID", { id });
    } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
    const operations: JournalOperation[] = [];
    for (const entry of entries) {
      const preimage = entry.expectedVersion === "absent" ? null : (await this.store.read(entry.path, entry.expectedVersion)).content;
      operations.push({ entry: structuredClone(entry), preimage, postimageVersion: entry.operation === "delete" ? "absent" : digestBytes(entry.nextContent!), state: "pending" });
    }
    const record: JournalRecord = { schemaVersion: 1, id, taskId, digest, createdAt: new Date().toISOString(), status: "committing", operations, recoveryConflicts: [] };
    await this.write(record);
    return record;
  }

  async rollback(record: JournalRecord, access: GuardedFileAccess): Promise<ChangeSetStatus> {
    record.recoveryConflicts = [];
    for (const operation of [...record.operations].reverse()) {
      if (operation.state === "pending" || operation.state === "restored") continue;
      try {
        const current = (await this.store.listVersion(operation.entry.path)).version;
        if (current === operation.entry.expectedVersion) {
          operation.state = "restored";
        } else if (current === operation.postimageVersion) {
          // Recovery is guarded by the managed postimage hash, so an external edit is never replaced.
          if (operation.preimage === null) await access.remove(operation.entry.path, operation.postimageVersion);
          else await access.write(operation.entry.path, operation.preimage, operation.postimageVersion);
          operation.state = "restored";
        } else {
          record.recoveryConflicts.push(operation.entry.path);
        }
      } catch {
        record.recoveryConflicts.push(operation.entry.path);
      }
      // Persist each restoration, so another interruption can resume from the last recorded state.
      await this.write(record);
    }
    record.status = record.recoveryConflicts.length ? "recovery-conflict" : "failed";
    await this.write(record);
    return record.status;
  }

  async recover(access: GuardedFileAccess): Promise<JournalRecord[]> {
    const pending = (await this.inspect()).filter((record) => ["committing", "recovery-conflict"].includes(record.status));
    for (const record of pending) await this.rollback(record, access);
    return pending;
  }
}
