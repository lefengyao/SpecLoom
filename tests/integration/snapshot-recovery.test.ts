import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { DockerExecutor } from "../../src/main/core/docker-process";
import { FileStore } from "../../src/main/core/file-store";
import { SnapshotRunner } from "../../src/main/core/snapshot-runner";
import { startSnapshotOwner, stopChild } from "../helpers/snapshot-owner";

it("preserves a live process snapshot and recovers it after its owner process dies", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-process-recovery-"));
  const id = randomUUID();
  const directory = path.join(os.tmpdir(), `specloom-snapshot-${id}`);
  const registry = path.join(root, ".specloom", "runtime", "snapshots");
  const journal = path.join(registry, `${id}.json`);
  await writeFile(path.join(root, "a.md"), "host original");
  const { child, ready } = startSnapshotOwner(root, id);
  try {
    const record = await ready;
    expect(record.ownerPid).toBe(child.pid);
    expect(record.directory).toBe(directory);
    expect(() => process.kill(record.ownerPid, 0)).not.toThrow();
    const calls: string[][] = [];
    const docker: DockerExecutor = async (args) => {
      calls.push(args);
      if (!["inspect", "rm"].includes(args[0]!)) throw new Error(`Unexpected Docker command: ${args[0]}`);
      const labels = { "com.specloom.snapshot": record.id, "com.specloom.instance": record.instanceId, "com.specloom.owner-pid": String(record.ownerPid) };
      return { stdout: args[0] === "inspect" ? JSON.stringify(labels) : "", stderr: "", exitCode: 0, durationMs: 1 };
    };
    const runner = new SnapshotRunner(new FileStore(root), { docker });
    expect(await runner.recoverAbandoned()).toEqual([]);
    expect(calls).toEqual([]);
    expect(JSON.parse(await readFile(journal, "utf8"))).toEqual(record);
    expect(await readFile(path.join(directory, "a.md"), "utf8")).toBe("private child change");
    expect(await readFile(path.join(root, "a.md"), "utf8")).toBe("host original");

    await stopChild(child);
    expect(() => process.kill(record.ownerPid, 0)).toThrow();
    expect(await runner.recoverAbandoned()).toEqual([]);
    expect(calls).toEqual([
      ["inspect", "--format", "{{json .Config.Labels}}", record.containers[0]],
      ["rm", "--force", record.containers[0]],
    ]);
    await expect(lstat(journal)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(registry)).toEqual([]);
    expect(await readFile(path.join(root, "a.md"), "utf8")).toBe("host original");
  } finally {
    try { await stopChild(child); } finally {
      await Promise.all([rm(directory, { recursive: true, force: true }), rm(root, { recursive: true, force: true })]);
    }
  }
}, 10_000);
