import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { executeDocker, type DockerExecutor } from "../../src/main/core/docker-process";
import { FileStore } from "../../src/main/core/file-store";
import { BASH_IMAGE, SnapshotRunner, type SnapshotSession } from "../../src/main/core/snapshot-runner";
import { TaskScope } from "../../src/main/core/task-scope";
import { dockerPrerequisites } from "./docker-prerequisites";

const prerequisites = await dockerPrerequisites("snapshot-docker", [BASH_IMAGE]);
const roots: string[] = [];
const sessions: SnapshotSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(options: ConstructorParameters<typeof SnapshotRunner>[1] = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-snapshot-docker-"));
  roots.push(root);
  await writeFile(path.join(root, "a.md"), "host");
  const session = await new SnapshotRunner(new FileStore(root), options).create(new TaskScope({ id: "docker", title: "isolation", readPaths: ["*"], writePaths: ["a.md"], allowDelete: false, mode: "manual" }));
  sessions.push(session);
  return { root, session };
}

it.skipIf(!prerequisites.available)("enforces isolation in the real Docker runtime", async () => {
  const { root, session } = await fixture();
  const result = await session.exec("printf isolated > a.md; touch /host-escape 2>/dev/null || printf readonly; printf ' network='; cat /proc/net/route");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("readonly");
  expect(result.stdout).not.toContain("eth0");
  expect(await readFile(path.join(root, "a.md"), "utf8")).toBe("host");
  expect((await session.collectChanges())[0]?.nextContent).toBe("isolated");
}, 30_000);

it.skipIf(!prerequisites.available).each(["timeout", "output", "abort"])("force-removes the real container after %s interruption", async (reason) => {
  let name = "";
  const controller = new AbortController();
  const docker: DockerExecutor = async (args, options) => {
    if (args[0] === "create") name = args[args.indexOf("--name") + 1]!;
    const execution = executeDocker(args, options);
    if (reason === "abort" && args[0] === "start") controller.abort();
    return execution;
  };
  const { session } = await fixture({ docker, maxOutputBytes: 1024 });
  const pending = session.exec(reason === "output" ? "while :; do printf '0123456789'; done" : "sleep 20", { timeoutMs: reason === "timeout" ? 200 : 10_000, signal: controller.signal });
  await expect(pending).rejects.toMatchObject({ code: "COMMAND_FAILED", ...(reason === "abort" ? { details: { reason: "aborted" } } : {}) });
  expect(name).toMatch(/^specloom-/);
  const result = await executeDocker(["ps", "--all", "--filter", `name=^/${name}$`, "--format", "{{.Names}}"], { timeoutMs: 10_000, maxOutputBytes: 1024 });
  expect(result.stdout.trim()).toBe("");
}, 30_000);
