import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DockerExecutionResult, DockerExecutor } from "../../src/main/core/docker-process";
import { ProjectError } from "../../src/main/core/errors";
import { FileStore } from "../../src/main/core/file-store";
import { SnapshotRegistry } from "../../src/main/core/snapshot-lifecycle";

interface SnapshotRecord {
  schemaVersion: 1;
  id: string;
  ownerPid: number;
  instanceId: string;
  directory: string;
  containers: string[];
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(): Promise<{ root: string; store: FileStore }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-registry-test-"));
  roots.push(root);
  return { root, store: new FileStore(root) };
}

function registryDirectory(root: string): string {
  return path.join(root, ".specloom", "runtime", "snapshots");
}

function recordPath(root: string, id: string): string {
  return path.join(registryDirectory(root), `${id}.json`);
}

async function abandoned(containers = [`specloom-${randomUUID()}`], location?: Awaited<ReturnType<typeof project>>) {
  const { root, store } = location ?? await project();
  const id = randomUUID();
  const directory = path.join(os.tmpdir(), `specloom-snapshot-${id}`);
  roots.push(directory);
  const record: SnapshotRecord = { schemaVersion: 1, id, ownerPid: 2_000_000_000, instanceId: randomUUID(), directory, containers };
  await mkdir(registryDirectory(root), { recursive: true });
  await writeFile(recordPath(root, id), JSON.stringify(record));
  await mkdir(directory);
  await writeFile(path.join(directory, "retained.txt"), "private snapshot");
  return { root, store, record, journal: recordPath(root, id) };
}

function labels(record: SnapshotRecord): Record<string, string> {
  return {
    "com.specloom.snapshot": record.id,
    "com.specloom.instance": record.instanceId,
    "com.specloom.owner-pid": String(record.ownerPid),
  };
}

function result(overrides: Partial<DockerExecutionResult> = {}): DockerExecutionResult {
  return { stdout: "", stderr: "", exitCode: 0, durationMs: 1, ...overrides };
}

function recoveryDocker(record: SnapshotRecord, action?: (args: string[]) => Promise<DockerExecutionResult>) {
  const calls: string[][] = [];
  const execute: DockerExecutor = async (args) => {
    calls.push(args);
    if (action !== undefined) return action(args);
    if (args[0] === "inspect") return result({ stdout: JSON.stringify(labels(record)) });
    if (args[0] === "rm") return result();
    throw new Error(`Unexpected Docker command: ${args[0]}`);
  };
  return { execute, calls };
}

async function expectRetained(journal: string, record: SnapshotRecord): Promise<void> {
  expect(JSON.parse(await readFile(journal, "utf8"))).toEqual(record);
  expect(await readFile(path.join(record.directory, "retained.txt"), "utf8")).toBe("private snapshot");
}

describe("durable snapshot lifecycle", () => {
  it("syncs the durable record before creating the private snapshot directory", async () => {
    const { root } = await project();
    let syncedRecord: SnapshotRecord | undefined;
    const store = new FileStore(root, { fs: { open: async (target, flags, mode) => {
      const handle = await open(target, flags, mode);
      if (flags === "wx") {
        const originalSync = handle.sync.bind(handle);
        handle.sync = async () => {
          await originalSync();
          syncedRecord = JSON.parse(await readFile(target, "utf8")) as SnapshotRecord;
          roots.push(syncedRecord.directory);
          await expect(lstat(syncedRecord.directory)).rejects.toMatchObject({ code: "ENOENT" });
        };
      }
      return handle;
    } } });
    const docker: DockerExecutor = async () => { throw new Error("Creating a lease must not invoke Docker"); };
    const lease = await new SnapshotRegistry(store, docker).create();
    expect(syncedRecord).toEqual({ schemaVersion: 1, id: lease.id, ownerPid: lease.ownerPid, instanceId: lease.instanceId, directory: lease.directory, containers: [] });
    expect((await lstat(lease.directory)).isDirectory()).toBe(true);
    await lease.dispose();
  });

  it("persists ownership and pending containers until a normal disposal removes the record", async () => {
    const { root, store } = await project();
    const instanceId = randomUUID();
    const docker: DockerExecutor = async () => { throw new Error("Creating a lease must not invoke Docker"); };
    const registry = new SnapshotRegistry(store, docker, { ownerPid: process.pid, instanceId });
    const lease = await registry.create();
    roots.push(lease.directory);
    expect(lease.directory).toBe(path.join(os.tmpdir(), `specloom-snapshot-${lease.id}`));
    expect((await lstat(lease.directory)).isDirectory()).toBe(true);
    expect(lease.instanceId).toBe(instanceId);
    expect(lease.ownerPid).toBe(process.pid);
    const journal = recordPath(root, lease.id);
    const record = { schemaVersion: 1, id: lease.id, ownerPid: process.pid, instanceId, directory: lease.directory, containers: [] };
    expect(JSON.parse(await readFile(journal, "utf8"))).toEqual(record);
    const container = `specloom-${randomUUID()}`;
    await lease.registerContainer(container);
    expect(JSON.parse(await readFile(journal, "utf8"))).toEqual({ ...record, containers: [container] });
    await expect(lease.dispose()).rejects.toMatchObject({ code: "COMMAND_FAILED" });
    expect((await lstat(lease.directory)).isDirectory()).toBe(true);
    expect(JSON.parse(await readFile(journal, "utf8"))).toEqual({ ...record, containers: [container] });
    await lease.removeContainer(container);
    await lease.dispose();
    await lease.dispose();
    await expect(lstat(lease.directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(registryDirectory(root))).toEqual([]);
  });

  it("recovers dead owners only after verifying all container ownership labels", async () => {
    const { root, store, record, journal } = await abandoned();
    const docker = recoveryDocker(record);
    const registry = new SnapshotRegistry(store, docker.execute, { ownerStatus: () => "dead" });
    expect(await registry.recoverAbandoned()).toEqual([]);
    expect(docker.calls).toEqual([
      ["inspect", "--format", "{{json .Config.Labels}}", record.containers[0]],
      ["rm", "--force", record.containers[0]],
    ]);
    await expect(lstat(record.directory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(journal)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(registryDirectory(root))).toEqual([]);
  });

  it("recovers a dead owner with no containers without calling Docker", async () => {
    const { store, record, journal } = await abandoned([]);
    const docker = recoveryDocker(record);
    expect(await new SnapshotRegistry(store, docker.execute, { ownerStatus: () => "dead" }).recoverAbandoned()).toEqual([]);
    expect(docker.calls).toEqual([]);
    await expect(lstat(record.directory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(journal)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["alive", "unknown"] as const)("preserves a snapshot whose owner is %s", async (status) => {
    const { store, record, journal } = await abandoned();
    const docker = recoveryDocker(record);
    expect(await new SnapshotRegistry(store, docker.execute, { ownerStatus: () => status }).recoverAbandoned()).toEqual([]);
    expect(docker.calls).toEqual([]);
    await expectRetained(journal, record);
  });

  it.each(["No such container", "No such object"])("treats an inspect result of %s as confirmed absence", async (message) => {
    const { store, record, journal } = await abandoned();
    const docker = recoveryDocker(record, async () => result({ stderr: `Error: ${message}: ${record.containers[0]}`, exitCode: 1 }));
    expect(await new SnapshotRegistry(store, docker.execute, { ownerStatus: () => "dead" }).recoverAbandoned()).toEqual([]);
    expect(docker.calls).toEqual([["inspect", "--format", "{{json .Config.Labels}}", record.containers[0]]]);
    await expect(lstat(record.directory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(journal)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["offline", "missing-executable", "removal-failed"])("retains recovery evidence when Docker is %s", async (failure) => {
    const { store, record, journal } = await abandoned();
    const docker = recoveryDocker(record, async (args) => {
      if (failure === "missing-executable") throw new ProjectError("BACKEND_UNAVAILABLE", "Docker could not be started");
      if (failure === "offline" || args[0] === "rm") return result({ stderr: "daemon unavailable", exitCode: 1 });
      return result({ stdout: JSON.stringify(labels(record)) });
    });
    const diagnostics = await new SnapshotRegistry(store, docker.execute, { ownerStatus: () => "dead" }).recoverAbandoned();
    expect(diagnostics).toEqual([expect.objectContaining({ code: "SNAPSHOT_RECOVERY_FAILED", message: expect.any(String) })]);
    expect(docker.calls.filter((args) => args[0] === "rm")).toHaveLength(failure === "removal-failed" ? 1 : 0);
    await expectRetained(journal, record);
  });

  it.each(["com.specloom.snapshot", "com.specloom.instance", "com.specloom.owner-pid"])("refuses a container with a mismatched %s label", async (label) => {
    const { store, record, journal } = await abandoned();
    const docker = recoveryDocker(record, async () => result({ stdout: JSON.stringify({ ...labels(record), [label]: "different-owner" }) }));
    const diagnostics = await new SnapshotRegistry(store, docker.execute, { ownerStatus: () => "dead" }).recoverAbandoned();
    expect(diagnostics).toHaveLength(1);
    expect(docker.calls.filter((args) => args[0] === "rm")).toEqual([]);
    await expectRetained(journal, record);
  });

  it.each(["null", "{", "{}"])("refuses missing or malformed Docker ownership labels: %s", async (stdout) => {
    const { store, record, journal } = await abandoned();
    const docker = recoveryDocker(record, async () => result({ stdout }));
    expect(await new SnapshotRegistry(store, docker.execute, { ownerStatus: () => "dead" }).recoverAbandoned()).toHaveLength(1);
    expect(docker.calls.filter((args) => args[0] === "rm")).toEqual([]);
    await expectRetained(journal, record);
  });

  it("stops cleanup when the recovery record changes during Docker inspection", async () => {
    const { store, record, journal } = await abandoned();
    const changed = { ...record, instanceId: randomUUID() };
    const docker = recoveryDocker(record, async (args) => {
      if (args[0] === "inspect") await writeFile(journal, JSON.stringify(changed));
      return result({ stdout: JSON.stringify(labels(record)) });
    });
    expect(await new SnapshotRegistry(store, docker.execute, { ownerStatus: () => "dead" }).recoverAbandoned()).toHaveLength(1);
    expect(docker.calls.filter((args) => args[0] === "rm")).toEqual([]);
    await expectRetained(journal, changed);
  });

  it.each(["schema-version", "record-id", "owner-pid", "instance-id", "container-name", "directory", "extra-field"])("retains an invalid %s record without invoking Docker", async (invalid) => {
    const { store, record, journal } = await abandoned();
    const changed: Record<string, unknown> = { ...record };
    if (invalid === "schema-version") changed.schemaVersion = 2;
    if (invalid === "record-id") changed.id = randomUUID();
    if (invalid === "owner-pid") changed.ownerPid = 0;
    if (invalid === "instance-id") changed.instanceId = "untrusted";
    if (invalid === "container-name") changed.containers = ["--force"];
    if (invalid === "directory") changed.directory = path.dirname(record.directory);
    if (invalid === "extra-field") changed.unrecognized = "unexpected";
    const contents = JSON.stringify(changed);
    await writeFile(journal, contents);
    const docker = recoveryDocker(record);
    expect(await new SnapshotRegistry(store, docker.execute, { ownerStatus: () => "dead" }).recoverAbandoned()).toHaveLength(1);
    expect(docker.calls).toEqual([]);
    expect(await readFile(journal, "utf8")).toBe(contents);
    expect(await readFile(path.join(record.directory, "retained.txt"), "utf8")).toBe("private snapshot");
  });

  it("returns a diagnostic when the registry cannot be read", async () => {
    const { root, record, journal } = await abandoned();
    const docker = recoveryDocker(record);
    const store = new FileStore(root, { fs: { readdir: async () => { throw Object.assign(new Error("Registry is unreadable"), { code: "EACCES" }); } } });
    const diagnostics = await new SnapshotRegistry(store, docker.execute, { ownerStatus: () => "dead" }).recoverAbandoned();
    expect(diagnostics).toEqual([expect.objectContaining({ code: "SNAPSHOT_RECOVERY_FAILED", message: expect.any(String) })]);
    expect(docker.calls).toEqual([]);
    await expectRetained(journal, record);
  });

  it("leaves excess records for later recovery when its record budget is exhausted", async () => {
    const location = await project();
    const first = await abandoned([], location);
    const second = await abandoned([], location);
    const docker = recoveryDocker(first.record);
    const diagnostics = await new SnapshotRegistry(location.store, docker.execute, { ownerStatus: () => "dead", recoveryMaxRecords: 1 }).recoverAbandoned();
    expect(diagnostics).toHaveLength(1);
    expect(docker.calls).toEqual([]);
    const remaining = await readdir(registryDirectory(location.root));
    expect(remaining).toHaveLength(1);
    const retained = remaining[0] === `${first.record.id}.json` ? first : second;
    const recovered = retained === first ? second : first;
    expect(remaining).toEqual([`${retained.record.id}.json`]);
    await expectRetained(retained.journal, retained.record);
    await expect(lstat(recovered.record.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stops recovery after inspection exhausts its time budget", async () => {
    const { store, record, journal } = await abandoned();
    const calls: string[][] = [];
    const docker: DockerExecutor = async (args, options) => {
      calls.push(args);
      expect(options.timeoutMs).toBeLessThanOrEqual(200);
      if (args[0] === "inspect") await new Promise((resolve) => setTimeout(resolve, 250));
      return result({ stdout: JSON.stringify(labels(record)) });
    };
    expect(await new SnapshotRegistry(store, docker, { ownerStatus: () => "dead", recoveryTimeoutMs: 200 }).recoverAbandoned()).toHaveLength(1);
    expect(calls).toEqual([["inspect", "--format", "{{json .Config.Labels}}", record.containers[0]]]);
    await expectRetained(journal, record);
  });

  it("can retry failed container removal without leaving a live recovery lock", async () => {
    const { root, store, record, journal } = await abandoned();
    let removalFails = true;
    const docker = recoveryDocker(record, async (args) => args[0] === "inspect"
      ? result({ stdout: JSON.stringify(labels(record)) })
      : result(removalFails ? { stderr: "daemon unavailable", exitCode: 1 } : {}));
    const registry = new SnapshotRegistry(store, docker.execute, { ownerStatus: (pid) => pid === record.ownerPid ? "dead" : "alive" });
    expect(await registry.recoverAbandoned()).toHaveLength(1);
    await expectRetained(journal, record);
    expect(await readdir(registryDirectory(root))).toEqual([`${record.id}.json`]);
    removalFails = false;
    expect(await registry.recoverAbandoned()).toEqual([]);
    await expect(lstat(record.directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(registryDirectory(root))).toEqual([]);
  });

  it("preserves a snapshot path that has been replaced by a junction", async () => {
    const { store, record, journal } = await abandoned();
    const outside = (await project()).root;
    await writeFile(path.join(outside, "retained.txt"), "outside project");
    await rm(record.directory, { recursive: true });
    await symlink(outside, record.directory, "junction");
    const docker = recoveryDocker(record);
    expect(await new SnapshotRegistry(store, docker.execute, { ownerStatus: () => "dead" }).recoverAbandoned()).toHaveLength(1);
    expect(docker.calls).toEqual([]);
    expect((await lstat(record.directory)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(journal, "utf8"))).toEqual(record);
    expect(await readFile(path.join(outside, "retained.txt"), "utf8")).toBe("outside project");
  });

  it("refuses to recover records through a registry junction", async () => {
    const { root, store, record } = await abandoned();
    const outside = (await project()).root;
    const moved = path.join(outside, "snapshots");
    await rename(registryDirectory(root), moved);
    await symlink(moved, registryDirectory(root), "junction");
    const docker = recoveryDocker(record);
    expect(await new SnapshotRegistry(store, docker.execute, { ownerStatus: () => "dead" }).recoverAbandoned()).toHaveLength(1);
    expect(docker.calls).toEqual([]);
    await expectRetained(path.join(moved, `${record.id}.json`), record);
  });

  it("allows only one concurrent recovery to remove an abandoned container", async () => {
    const { root, store, record, journal } = await abandoned();
    const docker = recoveryDocker(record);
    const ownerStatus = (pid: number) => pid === record.ownerPid ? "dead" : "alive";
    const first = new SnapshotRegistry(store, docker.execute, { ownerStatus });
    const second = new SnapshotRegistry(new FileStore(root), docker.execute, { ownerStatus });
    await Promise.all([first.recoverAbandoned(), second.recoverAbandoned()]);
    expect(docker.calls.filter((args) => args[0] === "rm")).toEqual([["rm", "--force", record.containers[0]]]);
    await expect(lstat(record.directory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(journal)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(registryDirectory(root))).toEqual([]);
  });
});
