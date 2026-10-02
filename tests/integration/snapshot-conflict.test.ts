import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { StagedChangeSet } from "../../src/main/core/change-set";
import { FileStore } from "../../src/main/core/file-store";
import { BASH_IMAGE, SnapshotRunner, type SnapshotSession } from "../../src/main/core/snapshot-runner";
import { TaskScope } from "../../src/main/core/task-scope";
import { dockerPrerequisites } from "./docker-prerequisites";

const prerequisites = await dockerPrerequisites("snapshot-conflict", [BASH_IMAGE]);
const roots: string[] = [];
const sessions: SnapshotSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.skipIf(!prerequisites.available)("hands Docker snapshot changes to the version gate and rejects the whole stale batch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-snapshot-conflict-"));
  roots.push(root);
  await writeFile(path.join(root, "a.md"), "old");
  const store = new FileStore(root);
  const scope = new TaskScope({ id: "task", title: "Docker changes", readPaths: ["*"], writePaths: ["a.md", "b.md"], allowDelete: false, mode: "manual" });
  const session = await new SnapshotRunner(store).create(scope);
  sessions.push(session);
  expect((await session.exec("printf changed > a.md; printf created > b.md")).exitCode).toBe(0);
  expect(await readFile(path.join(root, "a.md"), "utf8")).toBe("old");
  const changes = new StagedChangeSet(store, { taskId: "task" });
  for (const entry of await session.collectChanges()) changes.stage(entry);
  for (const [relative, version] of Object.entries(session.dependencies())) changes.addDependency(relative, version);
  await writeFile(path.join(root, "a.md"), "external");
  await expect(changes.commit(changes.preview().digest)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  expect(await readFile(path.join(root, "a.md"), "utf8")).toBe("external");
  expect((await store.listVersion("b.md")).exists).toBe(false);
}, 30_000);
