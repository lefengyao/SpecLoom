import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChangeEntry } from "../../src/shared/contracts";
import { ProjectError } from "../../src/main/core/errors";
import { FileStore } from "../../src/main/core/file-store";
import { SnapshotRunner, BASH_IMAGE, GODOT_IMAGE, type SnapshotSession } from "../../src/main/core/snapshot-runner";
import type { DockerExecutor } from "../../src/main/core/docker-process";
import { TaskScope } from "../../src/main/core/task-scope";

const roots: string[] = [];
const sessions: SnapshotSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; store: FileStore }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-snapshot-test-"));
  roots.push(root);
  await mkdir(path.join(root, "scripts"));
  await writeFile(path.join(root, "scripts/main.gd"), "old");
  return { root, store: new FileStore(root) };
}

function scope(overrides: Partial<ConstructorParameters<typeof TaskScope>[0]> = {}): TaskScope {
  return new TaskScope({ id: "task", title: "snapshot", readPaths: ["*"], writePaths: ["scripts/**"], allowDelete: true, mode: "manual", ...overrides });
}

function fakeDocker(action: (directory: string) => Promise<void> = async () => {}) {
  const calls: string[][] = [];
  let directory = "";
  const execute: DockerExecutor = async (args) => {
    calls.push(args);
    if (args[0] === "create") {
      const mount = args[args.indexOf("--mount") + 1]!;
      directory = mount.slice("type=bind,source=".length, mount.indexOf(",target=/workspace"));
    }
    if (args[0] === "start") await action(directory);
    return { stdout: "ok", stderr: "", exitCode: 0, durationMs: 1 };
  };
  return { execute, calls, directory: () => directory };
}

describe("private snapshot runner", () => {
  it("runs only in a hardened Docker snapshot and preserves original versions", async () => {
    const { root, store } = await fixture();
    const old = await store.listVersion("scripts/main.gd");
    const docker = fakeDocker(async (directory) => {
      await writeFile(path.join(directory, "scripts/main.gd"), "updated");
      await writeFile(path.join(directory, "scripts/new.gd"), "new");
    });
    const session = await new SnapshotRunner(store, { docker: docker.execute }).create(scope());
    sessions.push(session);
    const result = await session.exec("printf updated > scripts/main.gd");
    expect(result.command).toEqual(["bash", "-lc", "printf updated > scripts/main.gd"]);
    const create = docker.calls.find((args) => args[0] === "create")!;
    expect(create).toEqual(expect.arrayContaining(["--read-only", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "64", "--memory", "512m", "--cpus", "1", "--cpuset-cpus", "0", "--pull=never", BASH_IMAGE]));
    expect(create.filter((argument) => argument === "--mount")).toHaveLength(1);
    expect(docker.directory()).not.toBe(root);
    expect(await session.collectChanges()).toEqual([
      { path: "scripts/main.gd", operation: "update", expectedVersion: old.version, nextContent: "updated", sourceTaskId: "task", sourceTool: "bash.exec" },
      { path: "scripts/new.gd", operation: "create", expectedVersion: "absent", nextContent: "new", sourceTaskId: "task", sourceTool: "bash.exec" },
    ]);
    expect(await readFile(path.join(root, "scripts/main.gd"), "utf8")).toBe("old");
    expect((await store.listVersion("scripts/new.gd")).exists).toBe(false);
    expect(session.dependencies()["scripts/main.gd"]).toBe(old.version);
    expect(docker.calls.at(-1)?.slice(0, 2)).toEqual(["rm", "--force"]);
  });

  it("copies only readable paths and rejects any out-of-scope changed output", async () => {
    const { root, store } = await fixture();
    await writeFile(path.join(root, "secret.md"), "private");
    const docker = fakeDocker(async (directory) => {
      expect(await readFile(path.join(directory, "scripts/main.gd"), "utf8")).toBe("old");
      await expect(readFile(path.join(directory, "secret.md"))).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(path.join(directory, "secret.md"), "attempt");
    });
    const session = await new SnapshotRunner(store, { docker: docker.execute }).create(scope({ readPaths: ["scripts/**"] }));
    sessions.push(session);
    await session.exec("ignored");
    await expect(session.collectChanges()).rejects.toMatchObject({ code: "TASK_SCOPE_DENIED" });
    expect(await readFile(path.join(root, "secret.md"), "utf8")).toBe("private");
  });

  it("applies a staged overlay without replacing the real-project baseline", async () => {
    const { store } = await fixture();
    const version = (await store.listVersion("scripts/main.gd")).version;
    const entry: ChangeEntry = { path: "scripts/main.gd", operation: "update", expectedVersion: version, nextContent: "staged", sourceTaskId: "task", sourceTool: "files.write" };
    const docker = fakeDocker(async (directory) => {
      expect(await readFile(path.join(directory, "scripts/main.gd"), "utf8")).toBe("staged");
      await writeFile(path.join(directory, "scripts/main.gd"), "bash");
    });
    const session = await new SnapshotRunner(store, { docker: docker.execute }).create(scope(), { overlay: [entry] });
    sessions.push(session);
    await session.exec("ignored");
    expect(await session.collectChanges()).toEqual([{ ...entry, nextContent: "bash", sourceTool: "bash.exec" }]);
    expect(session.baseline.get("scripts/main.gd")).toBe(version);
    await expect(new SnapshotRunner(store).create(scope(), { overlay: [{ ...entry, expectedVersion: "absent" }] })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });

  it("removes containers on timeout, abort and output overflow and refuses their partial diff", async () => {
    const { store } = await fixture();
    for (const reason of ["timeout", "aborted", "output-limit"]) {
      const docker = fakeDocker();
      const execute: DockerExecutor = async (args, options) => {
        if (args[0] === "start") throw new ProjectError("COMMAND_FAILED", "Interrupted container", { reason, timeoutMs: options.timeoutMs });
        return docker.execute(args, options);
      };
      const session = await new SnapshotRunner(store, { docker: execute }).create(scope());
      sessions.push(session);
      await expect(session.exec("sleep 20", { timeoutMs: 10 })).rejects.toMatchObject({ code: "COMMAND_FAILED", details: { reason } });
      expect(docker.calls.at(-1)?.slice(0, 2)).toEqual(["rm", "--force"]);
      await expect(session.collectChanges()).rejects.toMatchObject({ code: "COMMAND_FAILED" });
    }
  });

  it("rejects project links and newly produced snapshot junctions", async () => {
    const { root, store } = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), "specloom-snapshot-outside-"));
    roots.push(outside);
    await symlink(outside, path.join(root, "linked"), "junction");
    await expect(new SnapshotRunner(store).create(scope())).rejects.toMatchObject({ code: "PATH_ESCAPE" });
    await rm(path.join(root, "linked"));
    const docker = fakeDocker(async (directory) => { await symlink(outside, path.join(directory, "scripts/linked"), "junction"); });
    const session = await new SnapshotRunner(store, { docker: docker.execute }).create(scope());
    sessions.push(session);
    await session.exec("ignored");
    await expect(session.collectChanges()).rejects.toMatchObject({ code: "PATH_ESCAPE" });
  });

  it("excludes runtime state, bounds copies, and detects copy races", async () => {
    const { root, store } = await fixture();
    await mkdir(path.join(root, ".specloom/skills/test"), { recursive: true });
    await mkdir(path.join(root, ".specloom/history"), { recursive: true });
    await writeFile(path.join(root, ".specloom/skills/test/SKILL.md"), "skill");
    await writeFile(path.join(root, ".specloom/history/a.json"), "runtime");
    const session = await new SnapshotRunner(store).create(scope());
    sessions.push(session);
    expect(session.sources().map((source) => source.path)).toEqual([".specloom/skills/test/SKILL.md", "scripts/main.gd"]);
    await expect(new SnapshotRunner(store, { maxFiles: 1 }).create(scope())).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(new SnapshotRunner(store, { maxTotalBytes: 2 }).create(scope())).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    class RacingStore extends FileStore {
      override async listVersion(relative: string) {
        const result = await super.listVersion(relative);
        if (relative === "scripts/main.gd") await writeFile(path.join(root, relative), "external");
        return result;
      }
    }
    await expect(new SnapshotRunner(new RacingStore(root)).create(scope())).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });

  it("copies binary assets but refuses edited binary files and reserved outputs", async () => {
    const { root, store } = await fixture();
    await writeFile(path.join(root, "scripts/asset.png"), Buffer.from([0xff, 0, 0x01]));
    const docker = fakeDocker(async (directory) => { await writeFile(path.join(directory, "scripts/asset.png"), Buffer.from([0xff, 0x02])); });
    const session = await new SnapshotRunner(store, { docker: docker.execute }).create(scope());
    sessions.push(session);
    expect(await session.collectChanges()).toEqual([]);
    await session.exec("ignored");
    await expect(session.collectChanges()).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const reserved = fakeDocker(async (directory) => {
      await mkdir(path.join(directory, ".specloom/history"), { recursive: true });
      await writeFile(path.join(directory, ".specloom/history/a.json"), "no");
    });
    const other = await new SnapshotRunner(store, { docker: reserved.execute }).create(scope());
    sessions.push(other);
    await other.exec("ignored");
    await expect(other.collectChanges()).rejects.toMatchObject({ code: "TASK_SCOPE_DENIED" });
  });

  it("allows only the pinned runtime images and fixes their entrypoints", async () => {
    const { store } = await fixture();
    const docker = fakeDocker();
    const session = await new SnapshotRunner(store, { docker: docker.execute }).create(scope());
    sessions.push(session);
    await expect(session.runContainer({ image: "bash:latest", entrypoint: "bash", args: [] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(session.runContainer({ image: BASH_IMAGE, entrypoint: "sh", args: [] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await session.runContainer({ image: GODOT_IMAGE, entrypoint: "godot", args: ["--version"], readOnlyWorkspace: true });
    expect(docker.calls[0]).toContain(GODOT_IMAGE);
    expect(docker.calls[0]).toEqual(expect.arrayContaining(["--memory", "1536m", "--memory-swap", "1536m", "--pids-limit", "128"]));
    expect(docker.calls[0]?.find((argument) => argument.includes("target=/workspace"))).toContain(",readonly");
  });

  it("reports failed cleanup and retries removal before deleting the private snapshot", async () => {
    const { store } = await fixture();
    const docker = fakeDocker();
    let cleanupFails = true;
    const execute: DockerExecutor = async (args, options) => {
      if (args[0] === "start") throw new ProjectError("COMMAND_FAILED", "Timed out", { reason: "timeout" });
      if (args[0] === "rm" && cleanupFails) return { stdout: "", stderr: "daemon unavailable", exitCode: 1, durationMs: 1 };
      return docker.execute(args, options);
    };
    const session = await new SnapshotRunner(store, { docker: execute }).create(scope());
    sessions.push(session);
    await expect(session.exec("ignored")).rejects.toMatchObject({ code: "COMMAND_FAILED", details: { reason: "cleanup-failed" }, cause: { details: { reason: "timeout" } } });
    await expect(session.dispose()).rejects.toMatchObject({ code: "COMMAND_FAILED", details: { reason: "cleanup-failed" } });
    expect(await readFile(path.join(docker.directory(), "scripts/main.gd"), "utf8")).toBe("old");
    cleanupFails = false;
    await session.dispose();
    await expect(readFile(path.join(docker.directory(), "scripts/main.gd"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats extra context as read-only and detects links before a second container run", async () => {
    const { root, store } = await fixture();
    await writeFile(path.join(root, "context.md"), "context");
    const extra = fakeDocker(async (directory) => { await writeFile(path.join(directory, "context.md"), "changed"); });
    const session = await new SnapshotRunner(store, { docker: extra.execute }).create(scope({ readPaths: ["scripts/**"], writePaths: ["scripts/**", "context.md"] }), { extraReadPaths: ["context.md"] });
    sessions.push(session);
    await session.exec("ignored");
    await expect(session.collectChanges()).rejects.toMatchObject({ code: "TASK_SCOPE_DENIED" });
    const linked = fakeDocker(async (directory) => { await symlink(root, path.join(directory, "scripts/link"), "junction"); });
    const other = await new SnapshotRunner(store, { docker: linked.execute }).create(scope());
    sessions.push(other);
    await other.exec("ignored");
    await expect(other.exec("ignored again")).rejects.toMatchObject({ code: "PATH_ESCAPE" });
    expect(linked.calls.filter((args) => args[0] === "create")).toHaveLength(1);
  });

  it("collects permitted deletes with their original token after a nonzero command", async () => {
    const { root, store } = await fixture();
    const version = (await store.listVersion("scripts/main.gd")).version;
    const docker = fakeDocker(async (directory) => { await rm(path.join(directory, "scripts/main.gd")); });
    const execute: DockerExecutor = async (args, options) => ({ ...await docker.execute(args, options), exitCode: args[0] === "start" ? 17 : 0 });
    const session = await new SnapshotRunner(store, { docker: execute }).create(scope());
    sessions.push(session);
    expect((await session.exec("ignored")).exitCode).toBe(17);
    expect(await session.collectChanges()).toEqual([{ path: "scripts/main.gd", operation: "delete", expectedVersion: version, sourceTaskId: "task", sourceTool: "bash.exec" }]);
    expect(await readFile(path.join(root, "scripts/main.gd"), "utf8")).toBe("old");
  });

  it("reports unavailable Docker images without starting a container or touching the project", async () => {
    const { root, store } = await fixture();
    const docker = fakeDocker();
    const execute: DockerExecutor = async (args, options) => ({ ...await docker.execute(args, options), ...(args[0] === "create" ? { exitCode: 125, stderr: "pinned image unavailable" } : {}) });
    const session = await new SnapshotRunner(store, { docker: execute }).create(scope());
    sessions.push(session);
    await expect(session.exec("printf changed > scripts/main.gd")).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
    expect(docker.calls.some((args) => args[0] === "start")).toBe(false);
    expect(await readFile(path.join(root, "scripts/main.gd"), "utf8")).toBe("old");
  });
});
