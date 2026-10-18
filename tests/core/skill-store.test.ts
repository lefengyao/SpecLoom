import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillStore } from "../../src/main/core/skill-store";

const temporary: string[] = [];
async function fixture(): Promise<{ root: string; source: string; project: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-skill-test-"));
  temporary.push(root);
  const source = path.join(root, "source", "demo-skill");
  const project = path.join(root, "project");
  await mkdir(path.join(source, "references"), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), "---\nid: demo-skill\nname: Demo\npurpose: Test skill\nallowedSources: [references/**]\n---\n\n# Instructions\n\nUse the reference.\n", "utf8");
  await writeFile(path.join(source, "references", "notes.md"), "notes", "utf8");
  return { root, source, project };
}

afterEach(async () => { await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("SkillStore", () => {
  it("finishes a project skill copy before another window can remove its source", async () => {
    const { root, source, project } = await fixture();
    const store = new SkillStore(path.join(root, "user-data"));
    await store.importDirectory(source);
    let entered!: () => void; let finish!: () => void;
    const copying = new Promise<void>(resolve => { entered = resolve; });
    const barrier = new Promise<void>(resolve => { finish = resolve; });
    const copier = store as unknown as { copyTree(source: string, target: string): Promise<void> };
    const original = copier.copyTree.bind(store);
    const copy = vi.spyOn(copier, "copyTree").mockImplementationOnce(async (source, target) => { entered(); await barrier; return original(source, target); });
    const sync = store.syncToProject(project);
    // Observe rejection immediately so the intentionally failing implementation
    // does not create an unhandled rejection during cleanup.
    void sync.catch(() => undefined);
    await copying;
    const removal = store.remove("demo-skill");
    try {
      const removedEarly = await Promise.race([removal.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 50))]);
      expect(removedEarly).toBe(false);
      finish(); await Promise.all([sync, removal]);
      expect(await readFile(path.join(project, ".specloom/skills/demo-skill/references/notes.md"), "utf8")).toBe("notes");
      expect(await store.list()).toEqual([]);
    } finally { finish(); await Promise.allSettled([sync, removal]); copy.mockRestore(); }
  });

  it("imports, lists, toggles and removes a global Skill", async () => {
    const { root, source } = await fixture();
    const store = new SkillStore(path.join(root, "user-data"));
    const installed = await store.importDirectory(source);
    expect(installed.id).toBe("demo-skill");
    expect((await store.list()).map((skill) => skill.id)).toEqual(["demo-skill"]);
    expect((await store.setEnabled("demo-skill", false)).enabled).toBe(false);
    expect((await store.list())[0]?.enabled).toBe(false);
    await store.remove("demo-skill");
    expect(await store.list()).toEqual([]);
  });

  it("supports project-local installation and rejects symlinks", async () => {
    const { root, source, project } = await fixture();
    const store = new SkillStore(path.join(root, "user-data"));
    const installed = await store.importProjectDirectory(source, project);
    expect((await store.listProject(project)).map((skill) => skill.id)).toEqual(["demo-skill"]);
    expect((await store.setProjectEnabled("demo-skill", false, project)).enabled).toBe(false);
    expect((await store.listProject(project))[0]?.enabled).toBe(false);
    await store.removeProject("demo-skill", project);
    expect(await store.listProject(project)).toEqual([]);
    const bad = path.join(root, "bad");
    await mkdir(bad, { recursive: true });
    await writeFile(path.join(bad, "SKILL.md"), "not front matter", "utf8");
    await expect(store.importDirectory(bad)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(installed.source).toBe("directory");
  });
});
