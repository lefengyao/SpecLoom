import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";
import type { DockerExecutor } from "./docker-process";
import { ProjectError } from "./errors";
import { FileStore } from "./file-store";
import { PathPolicy } from "./path-policy";
import { withRootMutex } from "./root-mutex";
import { defaultFileSystem, digestBytes, hasCode, removeTemporary } from "./store-fs";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const containerPattern = /^specloom-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const registryDirectory = ".specloom/runtime/snapshots";
const recordLimit = 64 * 1024;
const ownerSchema = z.object({ ownerPid: z.number().int().positive().max(2_147_483_647), instanceId: z.string().regex(uuidPattern) });
const recordSchema = ownerSchema.extend({ schemaVersion: z.literal(1), id: z.string().regex(uuidPattern), directory: z.string().max(4096), containers: z.array(z.string().regex(containerPattern)).max(128) }).strict();
type SnapshotRecord = z.infer<typeof recordSchema>;
type OwnerStatus = "alive" | "dead" | "unknown";

export interface SnapshotLifecycleOptions {
  ownerPid?: number;
  instanceId?: string;
  ownerStatus?: (pid: number) => OwnerStatus;
  recoveryTimeoutMs?: number;
  recoveryMaxRecords?: number;
}

export interface SnapshotRecoveryDiagnostic {
  code: string;
  message: string;
  path?: string;
  container?: string;
}

function processStatus(pid: number): OwnerStatus {
  try { process.kill(pid, 0); return "alive"; } catch (error) { return hasCode(error, "ESRCH") ? "dead" : "unknown"; }
}

function snapshotDirectory(id: string): string { return path.join(os.tmpdir(), `specloom-snapshot-${id}`); }

async function assertSnapshotDirectory(directory: string, id: string): Promise<void> {
  if (!uuidPattern.test(id) || directory !== snapshotDirectory(id)) throw new ProjectError("PATH_ESCAPE", "Snapshot directory does not match its registered UUID");
  await new PathPolicy(directory, defaultFileSystem).assertSafe(directory, true);
}

async function removeSnapshotDirectory(record: SnapshotRecord): Promise<void> {
  await assertSnapshotDirectory(record.directory, record.id);
  await rm(record.directory, { recursive: true, force: true });
}

export class SnapshotLease {
  private version: string;
  private disposed = false;
  constructor(private readonly registry: SnapshotRegistry, private record: SnapshotRecord, version: string) { this.version = version; }
  get id(): string { return this.record.id; }
  get directory(): string { return this.record.directory; }
  get instanceId(): string { return this.record.instanceId; }
  get ownerPid(): number { return this.record.ownerPid; }

  async registerContainer(name: string): Promise<void> {
    if (!containerPattern.test(name) || this.record.containers.includes(name)) throw new ProjectError("VALIDATION_FAILED", "Invalid snapshot container registration");
    const next = { ...this.record, containers: [...this.record.containers, name] };
    this.version = await this.registry.updateRecord(next, this.version);
    this.record = next;
  }

  async removeContainer(name: string): Promise<void> {
    const next = { ...this.record, containers: this.record.containers.filter((container) => container !== name) };
    this.version = await this.registry.updateRecord(next, this.version);
    this.record = next;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    if (this.record.containers.length) throw new ProjectError("COMMAND_FAILED", "Snapshot containers must be removed before its directory", { reason: "cleanup-failed" });
    await this.registry.assertRecordVersion(this.id, this.version);
    await removeSnapshotDirectory(this.record);
    await this.registry.removeRecord(this.id, this.version);
    this.disposed = true;
  }
}

export class SnapshotRegistry {
  private readonly owner: z.infer<typeof ownerSchema>;
  private readonly ownerStatus: (pid: number) => OwnerStatus;
  private readonly recoveryTimeoutMs: number;
  private readonly recoveryMaxRecords: number;
  constructor(private readonly store: FileStore, private readonly docker: DockerExecutor, options: SnapshotLifecycleOptions = {}) {
    this.owner = ownerSchema.parse({ ownerPid: options.ownerPid ?? process.pid, instanceId: options.instanceId ?? randomUUID() });
    this.ownerStatus = options.ownerStatus ?? processStatus;
    this.recoveryTimeoutMs = options.recoveryTimeoutMs ?? 10_000;
    this.recoveryMaxRecords = options.recoveryMaxRecords ?? 32;
    if (![this.recoveryTimeoutMs, this.recoveryMaxRecords].every((value) => Number.isSafeInteger(value) && value > 0)) throw new ProjectError("VALIDATION_FAILED", "Invalid snapshot recovery limits");
  }

  async create(): Promise<SnapshotLease> {
    const id = randomUUID();
    const record: SnapshotRecord = { schemaVersion: 1, id, ...this.owner, directory: snapshotDirectory(id), containers: [] };
    await assertSnapshotDirectory(record.directory, id);
    const target = await this.recordPath(id);
    await this.store.policy.ensureParent(target);
    const version = await this.writeExclusive(target, record);
    try {
      await mkdir(record.directory);
      await assertSnapshotDirectory(record.directory, id);
      return new SnapshotLease(this, record, version);
    } catch (error) {
      await this.removeRecord(id, version);
      throw error;
    }
  }

  async recoverAbandoned(): Promise<SnapshotRecoveryDiagnostic[]> {
    const diagnostics: SnapshotRecoveryDiagnostic[] = [];
    const deadline = performance.now() + this.recoveryTimeoutMs;
    let directory: string;
    try {
      directory = await this.store.policy.resolve(registryDirectory, true);
      if (!(await this.store.fs.lstat(directory)).isDirectory()) throw new ProjectError("PATH_ESCAPE", "Snapshot registry must be a regular directory");
    } catch (error) {
      if (hasCode(error, "ENOENT")) return diagnostics;
      return [{ code: "SNAPSHOT_RECOVERY_FAILED", message: this.message(error), path: registryDirectory }];
    }
    let entries;
    try { entries = await this.store.fs.readdir(directory, { withFileTypes: true }); } catch (error) { return [{ code: "SNAPSHOT_RECOVERY_FAILED", message: this.message(error), path: registryDirectory }]; }
    let processed = 0;
    for (const entry of entries) {
      if (!entry.name.endsWith(".json")) continue;
      if (processed >= this.recoveryMaxRecords || performance.now() >= deadline) {
        diagnostics.push({ code: "SNAPSHOT_RECOVERY_DEFERRED", message: "Snapshot recovery reached its startup limit; remaining records are retained for the next project open", path: registryDirectory });
        break;
      }
      processed += 1;
      const id = entry.name.slice(0, -5);
      const relative = `${registryDirectory}/${entry.name}`;
      let claim: { release: () => Promise<void>; assertHeld: () => void } | undefined;
      let capturedRecord = false;
      try {
        if (!uuidPattern.test(id)) throw new ProjectError("VALIDATION_FAILED", "Invalid snapshot recovery record filename");
        const target = await this.recordPath(id);
        const captured = await this.read(target);
        capturedRecord = true;
        const record = recordSchema.parse(JSON.parse(captured.content));
        if (record.id !== id) throw new ProjectError("VALIDATION_FAILED", "Snapshot recovery record UUID does not match its filename");
        await assertSnapshotDirectory(record.directory, record.id);
        if (this.ownerStatus(record.ownerPid) !== "dead") continue;
        claim = await this.claim(record.id);
        for (const name of record.containers) {
          claim.assertHeld();
          await this.assertRecordVersion(id, captured.version);
          await assertSnapshotDirectory(record.directory, id);
          await this.removeAbandonedContainer(record, name, captured.version, deadline, claim.assertHeld);
        }
        claim.assertHeld();
        this.remainingTime(deadline);
        await this.assertRecordVersion(id, captured.version);
        if (this.ownerStatus(record.ownerPid) !== "dead") throw new ProjectError("COMMAND_FAILED", "Snapshot owner is no longer confirmed dead; cleanup was stopped");
        await removeSnapshotDirectory(record);
        await this.removeRecord(id, captured.version);
      } catch (error) {
        if (!capturedRecord && hasCode(error, "ENOENT")) continue;
        diagnostics.push(hasCode(error, "ELOCKED")
          ? { code: "SNAPSHOT_RECOVERY_DEFERRED", message: "Snapshot recovery is already in progress or its recent crash lock has not expired; reopen the project after five seconds to retry", path: relative }
          : { code: "SNAPSHOT_RECOVERY_FAILED", message: this.message(error), path: relative });
      } finally {
        if (claim !== undefined) {
          try { await claim.release(); } catch (error) { diagnostics.push({ code: "SNAPSHOT_RECOVERY_FAILED", message: this.message(error), path: relative }); }
        }
      }
    }
    return diagnostics;
  }

  async updateRecord(record: SnapshotRecord, version: string): Promise<string> {
    recordSchema.parse(record);
    return withRootMutex(this.store.root, async () => {
      const target = await this.recordPath(record.id);
      await this.assertRecordVersion(record.id, version);
      const temporary = path.join(path.dirname(target), `.specloom-tmp-${randomUUID()}`);
      try {
        const nextVersion = await this.writeExclusive(temporary, record);
        await this.assertRecordVersion(record.id, version);
        await this.store.fs.rename(temporary, target);
        await this.syncDirectory(path.dirname(target));
        return nextVersion;
      } finally { await removeTemporary(this.store.fs, temporary); }
    });
  }

  async assertRecordVersion(id: string, expected: string): Promise<void> {
    if ((await this.read(await this.recordPath(id))).version !== expected) throw new ProjectError("VERSION_CONFLICT", "Snapshot recovery record changed; cleanup was stopped");
  }

  async removeRecord(id: string, version: string): Promise<void> {
    await withRootMutex(this.store.root, async () => {
      await this.assertRecordVersion(id, version);
      await this.store.fs.unlink(await this.recordPath(id));
      await this.syncDirectory(path.dirname(await this.recordPath(id)));
    });
  }

  private async recordPath(id: string): Promise<string> {
    if (!uuidPattern.test(id)) throw new ProjectError("PATH_ESCAPE", "Invalid snapshot registry UUID");
    return this.store.policy.resolve(`${registryDirectory}/${id}.json`, true);
  }

  private async read(target: string): Promise<{ content: string; version: string }> {
    await this.store.policy.assertSafe(target, true);
    const handle = await this.store.fs.open(target, "r");
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > recordLimit) throw new ProjectError("VALIDATION_FAILED", "Snapshot recovery records must be bounded regular files");
      const buffer = Buffer.alloc(recordLimit + 1);
      let size = 0;
      while (size < buffer.length) {
        const result = await handle.read(buffer, size, buffer.length - size, null);
        if (!result.bytesRead) break;
        size += result.bytesRead;
      }
      if (size > recordLimit) throw new ProjectError("VALIDATION_FAILED", "Snapshot recovery record exceeds its limit");
      await this.store.policy.assertSafe(target);
      const bytes = buffer.subarray(0, size);
      return { content: bytes.toString("utf8"), version: digestBytes(bytes) };
    } finally { await handle.close(); }
  }

  private async writeExclusive(target: string, value: unknown): Promise<string> {
    await this.store.policy.assertSafe(target, true);
    const content = JSON.stringify(value);
    const handle = await this.store.fs.open(target, "wx");
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await this.syncDirectory(path.dirname(target));
    return digestBytes(content);
  }

  private async syncDirectory(directory: string): Promise<void> {
    try {
      const handle = await this.store.fs.open(directory, "r");
      try { await handle.sync(); } finally { await handle.close(); }
    } catch (error) {
      // Windows does not expose directory fsync through Node's regular file handles.
      if (process.platform !== "win32" || !["EISDIR", "EPERM", "EACCES", "EINVAL", "ENOTSUP"].some((code) => hasCode(error, code))) throw error;
    }
  }

  private async claim(id: string): Promise<{ release: () => Promise<void>; assertHeld: () => void }> {
    const target = await this.recordPath(id);
    const lockPath = await this.store.policy.resolve(`${registryDirectory}/${id}.recovery-lock`, true);
    let compromised: Error | undefined;
    // proper-lockfile uses atomic directory acquisition and updates its stale-lock heartbeat.
    const release = await lockfile.lock(target, { realpath: false, lockfilePath: lockPath, stale: 5_000, update: 1_000, retries: 0, onCompromised: (error) => { compromised = error; } });
    return { release, assertHeld: () => { if (compromised !== undefined) throw new ProjectError("COMMAND_FAILED", "Snapshot recovery lock was compromised; cleanup was stopped", undefined, { cause: compromised }); } };
  }

  private async removeAbandonedContainer(record: SnapshotRecord, name: string, version: string, deadline: number, assertHeld: () => void): Promise<void> {
    const options = { timeoutMs: this.remainingTime(deadline), maxOutputBytes: 64 * 1024 };
    const inspected = await this.docker(["inspect", "--format", "{{json .Config.Labels}}", name], options);
    if (inspected.exitCode !== 0) {
      if (/No such (?:container|object):/.test(inspected.stderr)) return;
      throw new ProjectError("COMMAND_FAILED", "Docker could not verify an abandoned snapshot container; its snapshot is retained", { container: name, stderr: inspected.stderr });
    }
    const labels = JSON.parse(inspected.stdout) as Record<string, unknown>;
    if (labels["com.specloom.snapshot"] !== record.id || labels["com.specloom.instance"] !== record.instanceId || labels["com.specloom.owner-pid"] !== String(record.ownerPid)) {
      throw new ProjectError("COMMAND_FAILED", "Snapshot container ownership does not match its recovery record; its snapshot is retained", { container: name });
    }
    assertHeld();
    await this.assertRecordVersion(record.id, version);
    await assertSnapshotDirectory(record.directory, record.id);
    if (this.ownerStatus(record.ownerPid) !== "dead") throw new ProjectError("COMMAND_FAILED", "Snapshot owner is no longer confirmed dead; cleanup was stopped");
    const removed = await this.docker(["rm", "--force", name], { ...options, timeoutMs: this.remainingTime(deadline) });
    if (removed.exitCode !== 0 && !/No such container:/.test(removed.stderr)) throw new ProjectError("COMMAND_FAILED", "Docker container recovery failed; its snapshot is retained", { container: name, stderr: removed.stderr });
  }

  private remainingTime(deadline: number): number {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining < 1) throw new ProjectError("COMMAND_FAILED", "Snapshot recovery reached its startup time limit; its record is retained");
    return Math.min(10_000, remaining);
  }

  private message(error: unknown): string { return error instanceof Error ? error.message : "Snapshot recovery could not complete; its record is retained"; }
}
