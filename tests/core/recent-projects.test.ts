import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { RecentProjects } from "../../src/main/core/recent-projects";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function directory() {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-recent-"));
  roots.push(root);
  return root;
}

describe("recent project memory", () => {
  test("moves a reopened project to the front instead of duplicating it", async () => {
    const root = await directory();
    const first = path.join(root, "lantern");
    const second = path.join(root, "harbor");
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    const store = new RecentProjects(root);
    await store.remember({ path: first, name: "灯塔守望" });
    await store.remember({ path: second, name: "港口" });
    await store.remember({ path: first, name: "灯塔守望" });
    expect((await store.list()).map((entry) => entry.name)).toEqual(["灯塔守望", "港口"]);
    expect((await store.list()).every((entry) => entry.exists)).toBe(true);
  });

  test("flags entries whose directory disappeared without dropping them", async () => {
    const root = await directory();
    const gone = path.join(root, "deleted");
    const store = new RecentProjects(root);
    await store.remember({ path: gone, name: "已删除" });
    expect(await store.list()).toEqual([
      { path: gone, name: "已删除", openedAt: expect.any(String), exists: false },
    ]);
  });

  test("keeps the newest entries up to its limit", async () => {
    const root = await directory();
    const store = new RecentProjects(root, 3);
    for (const name of ["a", "b", "c", "d", "e"]) {
      await store.remember({ path: path.join(root, name), name });
    }
    expect((await store.list()).map((entry) => entry.name)).toEqual(["e", "d", "c"]);
  });

  test("forgets a single project and survives a corrupt store file", async () => {
    const root = await directory();
    const store = new RecentProjects(root);
    await store.remember({ path: path.join(root, "a"), name: "A" });
    await store.remember({ path: path.join(root, "b"), name: "B" });
    await store.forget(path.join(root, "a"));
    expect((await store.list()).map((entry) => entry.name)).toEqual(["B"]);

    await writeFile(path.join(root, "recent-projects.json"), "{ not json", "utf8");
    expect(await store.list()).toEqual([]);

    await writeFile(path.join(root, "recent-projects.json"), JSON.stringify([{ path: 7 }]), "utf8");
    expect(await store.list()).toEqual([]);
  });

  test("never writes outside its own directory and stores plain absolute paths", async () => {
    const root = await directory();
    const project = await directory();
    const store = new RecentProjects(root);
    await store.remember({ path: path.join(project, ".", "lantern"), name: "灯塔守望" });
    const stored = JSON.parse(await readFile(path.join(root, "recent-projects.json"), "utf8")) as { path: string }[];
    expect(stored).toHaveLength(1);
    expect(path.isAbsolute(stored[0]!.path)).toBe(true);
    expect(stored[0]!.path).toBe(path.join(project, "lantern"));
    expect(await store.list()).toHaveLength(1);
  });

  test.runIf(process.platform === "win32")("treats Windows paths case-insensitively", async () => {
    const root = await directory();
    const store = new RecentProjects(root);
    await store.remember({ path: path.join(root, "Lantern"), name: "A" });
    await store.remember({ path: path.join(root, "LANTERN"), name: "B" });
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe("B");
  });
});
