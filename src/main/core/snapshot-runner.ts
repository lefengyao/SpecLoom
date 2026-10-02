import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ChangeEntrySchema, type ChangeEntry, type SkillSource, type VersionToken } from "../../shared/contracts";
import { executeDocker, type DockerExecutor, type DockerExecutionResult } from "./docker-process";
import { ProjectError } from "./errors";
import { FileStore } from "./file-store";
import { SnapshotRegistry, type SnapshotLease, type SnapshotLifecycleOptions, type SnapshotRecoveryDiagnostic } from "./snapshot-lifecycle";
import { decodeText, digestBytes, hasCode } from "./store-fs";
import { normalizeTaskPath, TaskScope } from "./task-scope";

export const BASH_IMAGE = "bash:5.3@sha256:61962062d969cb46dfc2bad061d36342406fa485f64f246aa7e95693ca07df1f";
export const GODOT_IMAGE = "barichello/godot-ci:4.4.1@sha256:274a9a1849ec64d0ce8577ccf698bd1b97f9994c150a8e9783e561533e568708";

export interface SnapshotRunnerOptions {
  maxFiles?: number;
  maxTotalBytes?: number;
  maxOutputBytes?: number;
  timeoutMs?: number;
  maxTimeoutMs?: number;
  docker?: DockerExecutor;
  lifecycle?: SnapshotLifecycleOptions;
}

export interface SnapshotCreateOptions {
  overlay?: ChangeEntry[];
  extraReadPaths?: string[];
}

export interface SnapshotCommandOptions { timeoutMs?: number; signal?: AbortSignal }
export interface SnapshotContainerOptions extends SnapshotCommandOptions {
  image: string;
  entrypoint: string;
  args: string[];
  readOnlyWorkspace?: boolean;
}
export interface SnapshotCommandResult extends DockerExecutionResult { command: string[] }

interface SnapshotLimits {
  maxFiles: number;
  maxTotalBytes: number;
  maxOutputBytes: number;
  timeoutMs: number;
  maxTimeoutMs: number;
}

function limitsFrom(options: SnapshotRunnerOptions): SnapshotLimits {
  const limits: SnapshotLimits = {
    maxFiles: options.maxFiles ?? 10_000,
    maxTotalBytes: options.maxTotalBytes ?? 64 * 1024 * 1024,
    maxOutputBytes: options.maxOutputBytes ?? 1024 * 1024,
    timeoutMs: options.timeoutMs ?? 30_000,
    maxTimeoutMs: options.maxTimeoutMs ?? 120_000,
  };
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1) || limits.timeoutMs > limits.maxTimeoutMs) {
    throw new ProjectError("VALIDATION_FAILED", "Snapshot limits must be positive bounded integers");
  }
  return limits;
}

function canRead(scope: TaskScope, relative: string, extra: Set<string>, store: FileStore): boolean {
  if (extra.has(store.pathIdentity(relative))) return true;
  try { scope.assertRead(relative); return true; } catch (error) {
    if (error instanceof ProjectError && error.code === "TASK_SCOPE_DENIED") return false;
    throw error;
  }
}

async function enumerate(store: FileStore, limits: SnapshotLimits, mode: "source" | "diff" | "runtime"): Promise<string[]> {
  await store.policy.validateRoot();
  const files: string[] = [];
  let visited = 0;
  const identities = new Set<string>();
  const visit = async (directory: string): Promise<void> => {
    await store.policy.assertSafe(path.join(store.root, directory));
    const entries = await store.fs.readdir(path.join(store.root, directory), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      visited += 1;
      if (visited > limits.maxFiles * 8) throw new ProjectError("VALIDATION_FAILED", "Snapshot tree exceeds the entry limit");
      if (mode === "source" && ([".git", ".godot"].includes(entry.name.toLowerCase()) || entry.name.includes(".specloom-tmp-"))) continue;
      const relative = path.posix.join(directory, entry.name);
      const target = path.join(store.root, relative);
      await store.policy.assertSafe(target);
      const stats = await store.fs.lstat(target);
      if (mode === "source" && relative.toLowerCase() === ".specloom") {
        if (!stats.isDirectory()) throw new ProjectError("PATH_ESCAPE", "Runtime state must be a regular directory");
        const skills = path.posix.join(relative, "skills");
        let skillsStats;
        try { skillsStats = await store.fs.lstat(path.join(store.root, skills)); } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
        if (skillsStats !== undefined) {
          await store.policy.assertSafe(path.join(store.root, skills));
          if (!skillsStats.isDirectory()) throw new ProjectError("PATH_ESCAPE", "Skills must be a regular directory");
          await visit(skills);
        }
        continue;
      }
      // The .specloom parent is permitted only to reach its public skills subtree.
      if (mode !== "runtime" && relative.toLowerCase() !== ".specloom") normalizeTaskPath(relative);
      const identity = process.platform === "win32" ? relative.toLowerCase() : relative;
      if (identities.has(identity)) throw new ProjectError("PATH_ESCAPE", "Snapshot contains ambiguous paths", { path: relative });
      identities.add(identity);
      if (stats.isDirectory()) await visit(relative);
      else if (stats.isFile()) files.push(relative);
      else throw new ProjectError("PATH_ESCAPE", "Snapshots accept only regular files and directories", { path: relative });
    }
  };
  await visit("");
  return files.sort((a, b) => a.localeCompare(b));
}

async function readBytes(store: FileStore, relative: string, limit: number, expectedVersion: VersionToken): Promise<Buffer> {
  const target = await store.policy.resolve(relative);
  const handle = await store.fs.open(target, "r");
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new ProjectError("PATH_ESCAPE", "Snapshot source is not a regular file", { path: relative });
    if (stats.size > limit) throw new ProjectError("VALIDATION_FAILED", "Snapshot exceeds its total byte limit", { path: relative });
    const chunks: Buffer[] = [];
    let size = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, limit + 1 - size));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > limit) throw new ProjectError("VALIDATION_FAILED", "Snapshot exceeds its total byte limit", { path: relative });
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const bytes = Buffer.concat(chunks);
    store.assertVersion(relative, digestBytes(bytes), expectedVersion);
    await store.policy.assertSafe(target);
    store.assertVersion(relative, (await store.listVersion(relative)).version, expectedVersion);
    return bytes;
  } finally { await handle.close(); }
}

export class SnapshotRunner {
  private readonly limits: SnapshotLimits;
  private readonly docker: DockerExecutor;
  private readonly registry: SnapshotRegistry;

  constructor(private readonly store: FileStore, options: SnapshotRunnerOptions = {}) {
    this.limits = limitsFrom(options);
    this.docker = options.docker ?? executeDocker;
    this.registry = new SnapshotRegistry(this.store, this.docker, options.lifecycle);
  }

  async recoverAbandoned(): Promise<SnapshotRecoveryDiagnostic[]> { return this.registry.recoverAbandoned(); }

  async create(scope: TaskScope, options: SnapshotCreateOptions = {}): Promise<SnapshotSession> {
    const extra = new Set((options.extraReadPaths ?? []).map((relative) => this.store.pathIdentity(normalizeTaskPath(relative))));
    const lease = await this.registry.create();
    const directory = lease.directory;
    const snapshotStore = new FileStore(directory, { maxTextBytes: this.store.maxTextBytes });
    const baseline = new Map<string, VersionToken>();
    const editable = new Set<string>();
    const sizes = new Map<string, number>();
    let total = 0;
    try {
      for (const relative of await enumerate(this.store, this.limits, "source")) {
        if (!canRead(scope, relative, extra, this.store)) continue;
        if (baseline.size >= this.limits.maxFiles) throw new ProjectError("VALIDATION_FAILED", "Snapshot exceeds its file count limit");
        const stats = await this.store.fs.lstat(await this.store.policy.resolve(relative));
        if (stats.size > this.limits.maxTotalBytes - total) throw new ProjectError("VALIDATION_FAILED", "Snapshot exceeds its total byte limit");
        const original = await this.store.listVersion(relative);
        const bytes = await readBytes(this.store, relative, this.limits.maxTotalBytes - total, original.version);
        const target = await snapshotStore.policy.resolve(relative);
        await snapshotStore.policy.ensureParent(target);
        await writeFile(target, bytes, { flag: "wx" });
        baseline.set(relative, original.version);
        sizes.set(relative, bytes.length);
        total += bytes.length;
        try { decodeText(bytes, this.store.maxTextBytes); editable.add(this.store.pathIdentity(relative)); } catch (error) {
          if (!(error instanceof ProjectError && error.code === "VALIDATION_FAILED")) throw error;
        }
      }
      const seen = new Set<string>();
      for (const input of options.overlay ?? []) {
        const parsed = ChangeEntrySchema.safeParse(input);
        if (!parsed.success) throw new ProjectError("VALIDATION_FAILED", "Invalid snapshot overlay entry");
        const entry = parsed.data;
        const relative = scope.assertRead(entry.path);
        scope.assertWrite(relative, entry.operation);
        if (entry.sourceTaskId !== scope.describe().id) throw new ProjectError("TASK_SCOPE_DENIED", "Overlay belongs to another task");
        const identity = this.store.pathIdentity(relative);
        if (seen.has(identity)) throw new ProjectError("VALIDATION_FAILED", "Snapshot overlay contains duplicate paths", { path: relative });
        seen.add(identity);
        const captured = [...baseline.keys()].find((key) => this.store.pathIdentity(key) === identity);
        const original = captured === undefined ? (await this.store.listVersion(relative)).version : baseline.get(captured)!;
        this.store.assertVersion(relative, original, entry.expectedVersion);
        this.store.assertVersion(relative, (await this.store.listVersion(relative)).version, entry.expectedVersion);
        if ((entry.operation === "create") !== (original === "absent")) throw new ProjectError("VERSION_CONFLICT", "Overlay operation differs from its baseline", { path: relative });
        if (original !== "absent" && !editable.has(identity)) throw new ProjectError("VALIDATION_FAILED", "Binary and oversized files cannot be changed in an overlay", { path: relative });
        const canonical = captured ?? relative;
        if (captured === undefined && baseline.size >= this.limits.maxFiles) throw new ProjectError("VALIDATION_FAILED", "Snapshot exceeds its file count limit");
        baseline.set(canonical, original);
        editable.add(identity);
        const target = await snapshotStore.policy.resolve(canonical);
        if (entry.operation === "delete") {
          await rm(target);
          total -= sizes.get(canonical) ?? 0;
          sizes.delete(canonical);
        } else {
          this.store.validateContent(entry.nextContent!);
          const bytes = Buffer.from(entry.nextContent!, "utf8");
          total += bytes.length - (sizes.get(canonical) ?? 0);
          if (total > this.limits.maxTotalBytes) throw new ProjectError("VALIDATION_FAILED", "Snapshot overlay exceeds its total byte limit");
          await snapshotStore.policy.ensureParent(target);
          await writeFile(target, bytes);
          sizes.set(canonical, bytes.length);
        }
      }
      return new SnapshotSession(snapshotStore, scope, baseline, editable, this.limits, this.docker, lease);
    } catch (error) {
      await lease.dispose();
      throw error;
    }
  }
}

export class SnapshotSession {
  readonly #store: FileStore;
  readonly #scope: TaskScope;
  readonly #versions: Map<string, VersionToken>;
  readonly #editable: Set<string>;
  readonly #limits: SnapshotLimits;
  readonly #docker: DockerExecutor;
  readonly #lease: SnapshotLease;
  readonly #containers = new Set<string>();
  #disposed = false;
  #cleaned = false;
  #disposal: Promise<void> | undefined;
  #interrupted = false;
  #active: { controller: AbortController; operation: Promise<SnapshotCommandResult> } | undefined;

  constructor(store: FileStore, scope: TaskScope, baseline: Map<string, VersionToken>, editable: Set<string>, limits: SnapshotLimits, docker: DockerExecutor, lease: SnapshotLease) {
    this.#store = store;
    this.#scope = scope;
    this.#versions = baseline;
    this.#editable = editable;
    this.#limits = limits;
    this.#docker = docker;
    this.#lease = lease;
  }

  get baseline(): ReadonlyMap<string, VersionToken> { return new Map(this.#versions); }
  dependencies(): Record<string, VersionToken> { return Object.fromEntries(this.#versions); }
  sources(): SkillSource[] { return [...this.#versions].map(([relative, version]) => ({ path: relative, version })); }

  async exec(command: string, options: SnapshotCommandOptions = {}): Promise<SnapshotCommandResult> {
    if (typeof command !== "string" || !command.trim() || Buffer.byteLength(command, "utf8") > 64 * 1024 || command.includes("\0")) {
      throw new ProjectError("VALIDATION_FAILED", "Bash requires a nonempty bounded command");
    }
    return this.runContainer({ image: BASH_IMAGE, entrypoint: "bash", args: ["-lc", command], ...options });
  }

  async runContainer(options: SnapshotContainerOptions): Promise<SnapshotCommandResult> {
    this.assertIdle();
    if (!((options.image === BASH_IMAGE && options.entrypoint === "bash") || (options.image === GODOT_IMAGE && options.entrypoint === "godot"))
      || !Array.isArray(options.args) || options.args.some((argument) => typeof argument !== "string" || argument.includes("\0"))
      || Buffer.byteLength(JSON.stringify(options.args), "utf8") > 64 * 1024) {
      throw new ProjectError("VALIDATION_FAILED", "Only pinned Bash and Godot runtimes with bounded arguments are allowed");
    }
    const timeoutMs = options.timeoutMs ?? this.#limits.timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > this.#limits.maxTimeoutMs) throw new ProjectError("VALIDATION_FAILED", "Invalid container timeout");
    if (options.signal?.aborted) throw new ProjectError("COMMAND_FAILED", "Container command was cancelled", { reason: "aborted" });
    const controller = new AbortController();
    const signal = options.signal === undefined ? controller.signal : AbortSignal.any([options.signal, controller.signal]);
    const operation = this.executeContainer(options, timeoutMs, signal);
    this.#active = { controller, operation };
    try { return await operation; } finally { this.#active = undefined; }
  }

  private async executeContainer(options: SnapshotContainerOptions, timeoutMs: number, signal: AbortSignal): Promise<SnapshotCommandResult> {
    const name = `specloom-${randomUUID()}`;
    const command = [options.entrypoint, ...options.args];
    const user = process.platform === "win32" ? "65534:65534" : `${process.getuid!()}:${process.getgid!()}`;
    // The Godot editor needs more memory and worker threads than arbitrary Bash commands.
    const memory = options.image === GODOT_IMAGE ? "1536m" : "512m";
    const pids = options.image === GODOT_IMAGE ? "128" : "64";
    const createArgs = [
      "create", "--name", name, "--pull=never", "--read-only", "--network", "none",
      "--label", `com.specloom.snapshot=${this.#lease.id}`, "--label", `com.specloom.instance=${this.#lease.instanceId}`, "--label", `com.specloom.owner-pid=${this.#lease.ownerPid}`,
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", pids,
      "--memory", memory, "--memory-swap", memory, "--cpus", "1", "--cpuset-cpus", "0", "--user", user,
      "--workdir", "/workspace", "--env", "HOME=/tmp", "--env", "TMPDIR=/tmp",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m", "--mount",
      `type=bind,source=${this.#store.root},target=/workspace${options.readOnlyWorkspace ? ",readonly" : ""}`,
      "--entrypoint", options.entrypoint, options.image, ...options.args,
    ];
    let failure: unknown;
    try {
      await enumerate(this.#store, this.#limits, "runtime");
      await this.assertBackendAvailable(options.image, signal);
      // A create attempt can leave a container behind even if the CLI is interrupted.
      await this.#lease.registerContainer(name);
      this.#containers.add(name);
      const created = await this.#docker(createArgs, { timeoutMs: Math.min(10_000, this.#limits.maxTimeoutMs), maxOutputBytes: this.#limits.maxOutputBytes, signal });
      if (created.exitCode !== 0) throw new ProjectError("BACKEND_UNAVAILABLE", "Docker or the pinned container image is unavailable", { stderr: created.stderr, exitCode: created.exitCode });
      return { ...await this.#docker(["start", "--attach", name], { timeoutMs, maxOutputBytes: this.#limits.maxOutputBytes, signal }), command };
    } catch (error) {
      this.#interrupted = true;
      failure = error;
      throw error;
    } finally {
      // Killing the Docker CLI does not stop its container; removal is a separate uncancelled call.
      if (this.#containers.has(name)) await this.removeContainer(name, failure);
    }
  }

  private async assertBackendAvailable(image: string, signal: AbortSignal): Promise<void> {
    const options = { timeoutMs: Math.min(10_000, this.#limits.maxTimeoutMs), maxOutputBytes: 64 * 1024, signal };
    try {
      const backend = await this.#docker(["info", "--format", "{{.OSType}}"], options);
      if (backend.exitCode !== 0) throw new ProjectError("BACKEND_UNAVAILABLE", "Docker's Linux container backend is unavailable", { stderr: backend.stderr, exitCode: backend.exitCode });
      if (backend.stdout.trim() !== "linux") throw new ProjectError("BACKEND_UNAVAILABLE", "Docker must use its Linux container backend", { osType: backend.stdout.trim() });
      const inspected = await this.#docker(["image", "inspect", "--format", "{{.Id}}", image], options);
      if (inspected.exitCode !== 0) throw new ProjectError("BACKEND_UNAVAILABLE", "The pinned container image is unavailable", { image, stderr: inspected.stderr, exitCode: inspected.exitCode });
    } catch (error) {
      if (error instanceof ProjectError && (error.code === "BACKEND_UNAVAILABLE" || error.details?.reason === "aborted")) throw error;
      throw new ProjectError("BACKEND_UNAVAILABLE", "Docker runtime prerequisites could not be checked", { image }, { cause: error });
    }
  }

  async collectChanges(): Promise<ChangeEntry[]> {
    this.assertIdle();
    if (this.#interrupted) throw new ProjectError("COMMAND_FAILED", "An interrupted snapshot cannot produce staged changes");
    const current = new Map<string, { path: string; version: VersionToken }>();
    let total = 0;
    for (const relative of await enumerate(this.#store, this.#limits, "diff")) {
      if (current.size >= this.#limits.maxFiles) throw new ProjectError("VALIDATION_FAILED", "Snapshot exceeds its file count limit");
      const target = await this.#store.policy.resolve(relative);
      const stats = await this.#store.fs.lstat(target);
      total += stats.size;
      if (total > this.#limits.maxTotalBytes) throw new ProjectError("VALIDATION_FAILED", "Snapshot exceeds its total byte limit");
      const version = await this.#store.listVersion(relative);
      current.set(this.#store.pathIdentity(relative), { path: relative, version: version.version });
    }
    const original = new Map([...this.#versions].map(([relative, version]) => [this.#store.pathIdentity(relative), { path: relative, version }]));
    const entries: ChangeEntry[] = [];
    for (const identity of new Set([...original.keys(), ...current.keys()])) {
      const before = original.get(identity);
      const after = current.get(identity);
      const expectedVersion = before?.version ?? "absent";
      if ((after?.version ?? "absent") === expectedVersion) continue;
      const relative = before?.path ?? after!.path;
      this.#scope.assertRead(relative);
      const operation = after === undefined ? "delete" : expectedVersion === "absent" ? "create" : "update";
      this.#scope.assertWrite(relative, operation);
      if (expectedVersion !== "absent" && !this.#editable.has(identity)) throw new ProjectError("VALIDATION_FAILED", "Binary and oversized snapshot files cannot be edited", { path: relative });
      const entry: ChangeEntry = { path: relative, operation, expectedVersion, sourceTaskId: this.#scope.describe().id, sourceTool: "bash.exec" };
      if (after !== undefined) entry.nextContent = (await this.#store.read(after.path, after.version)).content;
      entries.push(entry);
    }
    for (const entry of entries) if (!this.#versions.has(entry.path)) this.#versions.set(entry.path, "absent");
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }

  async dispose(): Promise<void> {
    if (this.#cleaned) return;
    if (this.#disposal !== undefined) return this.#disposal;
    this.#disposed = true;
    const operation = this.cleanupSnapshot();
    this.#disposal = operation;
    try { await operation; } finally { this.#disposal = undefined; }
  }

  private async cleanupSnapshot(): Promise<void> {
    const active = this.#active;
    if (active !== undefined) {
      active.controller.abort();
      await active.operation.catch(() => {});
    }
    for (const name of this.#containers) await this.removeContainer(name);
    await this.#lease.dispose();
    this.#cleaned = true;
  }

  private async removeContainer(name: string, commandFailure?: unknown): Promise<void> {
    try {
      const removed = await this.#docker(["rm", "--force", name], { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 });
      if (removed.exitCode !== 0 && !removed.stderr.includes("No such container")) throw new Error(removed.stderr);
      await this.#lease.removeContainer(name);
      this.#containers.delete(name);
    } catch (error) {
      this.#interrupted = true;
      throw new ProjectError("COMMAND_FAILED", "Docker container cleanup failed; the private snapshot is retained", { reason: "cleanup-failed", container: name }, { cause: commandFailure ?? error });
    }
  }

  private assertIdle(): void {
    if (this.#disposed) throw new ProjectError("COMMAND_FAILED", "Snapshot was disposed");
    if (this.#active !== undefined) throw new ProjectError("COMMAND_FAILED", "Snapshot already has a running command");
  }
}
