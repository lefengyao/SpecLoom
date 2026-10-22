import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { beforeAll, expect, test } from "vitest";
import { PluginManager } from "../../src/main/core/plugins/plugin-manager";

const run = promisify(execFile);
let gitAvailable = true;
beforeAll(async () => {
  process.env.GIT_AUTHOR_NAME = "SpecLoom Test";
  process.env.GIT_AUTHOR_EMAIL = "test@example.invalid";
  process.env.GIT_COMMITTER_NAME = "SpecLoom Test";
  process.env.GIT_COMMITTER_EMAIL = "test@example.invalid";
  try { await run("git", ["--version"]); } catch { gitAvailable = false; }
});

test.skipIf(!gitAvailable)("built-in Git plugin initializes, stages, commits, branches, and reads history", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-git-plugin-"));
  const project = path.join(root, "project");
  const data = path.join(root, "data");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(project, { recursive: true }));
  const manager = new PluginManager({ builtinDirectory: path.resolve("resources/plugins"), userDataDirectory: data, getProjectPath: () => project });
  try {
    expect(await manager.invoke("specloom-git", "state")).toMatchObject({ state: "not-repository" });
    expect(await manager.invoke("specloom-git", "init")).toMatchObject({ state: "repository" });
    await writeFile(path.join(project, "hello.txt"), "hello\n", "utf8");
    let state = await manager.invoke("specloom-git", "state") as { files: Array<{ path: string; staged: boolean; unstaged: boolean }> };
    expect(state.files).toContainEqual(expect.objectContaining({ path: "hello.txt", staged: false, unstaged: true }));
    state = await manager.invoke("specloom-git", "stage", { paths: ["hello.txt"] }) as typeof state;
    expect(state.files).toContainEqual(expect.objectContaining({ path: "hello.txt", staged: true }));
    await manager.invoke("specloom-git", "commit", { message: "initial commit" });
    expect(((await manager.invoke("specloom-git", "history")) as { commits: Array<{ subject: string }> }).commits[0]).toMatchObject({ subject: "initial commit" });
    const branches = await manager.invoke("specloom-git", "branches") as { current: string; branches: string[] };
    expect(branches.branches.length).toBeGreaterThan(0);
    await manager.invoke("specloom-git", "createBranch", { name: "feature/test" });
    expect(((await manager.invoke("specloom-git", "branches")) as { current: string }).current).toBe("feature/test");
    expect((await manager.resolvePage("specloom-git", "git")).replaceAll("\\", "/")).toContain("renderer/index.html");
  } finally {
    await manager.close();
    await rm(root, { recursive: true, force: true });
  }
});
