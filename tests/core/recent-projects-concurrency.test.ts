import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { RecentProjects } from "../../src/main/core/recent-projects";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
test("concurrent remembers and forgets persist in invocation order without temporary-file collisions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-recent-concurrency-")); roots.push(root);
  const recent = new RecentProjects(root);
  await recent.remember({ path: path.join(root, "old"), name: "old" });
  const outcomes = await Promise.allSettled([
    recent.remember({ path: path.join(root, "first"), name: "first" }),
    recent.remember({ path: path.join(root, "second"), name: "second" }),
    recent.forget(path.join(root, "old")),
    recent.remember({ path: path.join(root, "third"), name: "third" }),
  ]);
  expect(outcomes.map(outcome => outcome.status)).toEqual(["fulfilled", "fulfilled", "fulfilled", "fulfilled"]);
  expect((await recent.list()).map(project => project.name)).toEqual(["third", "second", "first"]);
});
