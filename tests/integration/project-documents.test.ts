import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { ProjectCore } from "../../src/main/core/project-core";
import { parseMaterial, writeMaterial } from "../../src/shared/project-materials";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function project() {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-documents-"));
  roots.push(root);
  return ProjectCore.open(root);
}
const entity = (title: string, extra: Record<string, unknown> = {}) => writeMaterial({ schemaVersion: 1, id: "hero", type: "entity", title, description: "", components: [], ...extra }, `\n# ${title}\n`);
const stateMachine = { initialState: "idle", states: [{ id: "idle", title: "待机" }, { id: "run", title: "移动" }], transitions: [{ from: "idle", event: "move", to: "run" }] };

test("provides a reusable state-machine base component without replacing user edits on reopen", async () => {
  const core = await project(); const relative = "specs/components/state_machine.md";
  const content = await readFile(path.join(core.metadata.path, relative), "utf8");
  expect(parseMaterial(content)?.data).toMatchObject({ id: "state_machine", title: "状态机基类", type: "component", scope: "system", group: "基础组件", fields: expect.arrayContaining([{ key: "enabled", label: "启用", type: "boolean", default: true }]) });
  const edited = content.replace("状态机基类", "自定义状态机");
  await writeFile(path.join(core.metadata.path, relative), edited);
  await ProjectCore.open(core.metadata.path);
  expect(await readFile(path.join(core.metadata.path, relative), "utf8")).toBe(edited);
});

test("persists state-machine configuration and rejects broken states and transitions", async () => {
  const core = await project();
  const saved = await core.saveDocument("specs/entities/hero.md", entity("角色", { stateMachine }), "absent");
  const reopened = await ProjectCore.open(core.metadata.path);
  expect(parseMaterial((await reopened.readDocument(saved.path, saved.version)).content)?.data.stateMachine).toEqual(stateMachine);
  for (const invalid of [
    { ...stateMachine, initialState: "missing" },
    { ...stateMachine, states: [...stateMachine.states, { id: "idle", title: "重复" }] },
    { ...stateMachine, transitions: [{ from: "idle", event: "move", to: "missing" }] },
    { ...stateMachine, transitions: [...stateMachine.transitions, { from: "idle", event: "move", to: "idle" }] },
  ]) await expect(core.saveDocument(saved.path, entity("角色", { stateMachine: invalid }), saved.version)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  expect(await readFile(path.join(core.metadata.path, saved.path), "utf8")).toBe(saved.content);
  await expect(core.saveDocument("specs/components/invalid.md", writeMaterial({ schemaVersion: 1, id: "invalid", type: "component", title: "错误组件", description: "", fields: [], stateMachine }, ""), "absent")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
});

test("saves material creation and edits without tasks and survives reopening", async () => {
  const core = await project();
  const file = await core.saveDocument("specs/entities/hero.md", entity("角色", { group: "角色库" }), "absent");
  expect(file.version).toMatch(/^sha256:/);
  expect(core.listTasks()).toEqual([]);
  await expect((await ProjectCore.open(core.metadata.path)).readDocument(file.path, file.version)).resolves.toEqual(file);
  const updated = await core.saveDocument(file.path, entity("主角"), file.version);
  expect(updated.content).toContain("主角");
  expect(updated.version).not.toBe(file.version);
});

test("validates material group IDs against the project registry and category", async () => {
  const core = await project();
  const projectVersion = (await core.documents()).find((file) => file.path === "specs/project.md")!;
  const projectFile = await core.readDocument(projectVersion.path, projectVersion.version);
  const parsedProject = parseMaterial(projectFile.content)!;
  const materialGroups = {
    entity: [{ id: "entity-root", name: "基础实体", order: 0 }],
    setting: [{ id: "setting-root", name: "设定", order: 0 }],
  };
  const updatedProject = await core.saveDocument(projectFile.path, writeMaterial({ ...parsedProject.data, materialGroups }, parsedProject.body), projectFile.version);
  const assigned = await core.saveDocument("specs/entities/hero.md", entity("角色", { groupId: "entity-root" }), "absent");

  expect(parseMaterial(assigned.content)?.data.groupId).toBe("entity-root");
  await expect(core.saveDocument("specs/entities/invalid.md", writeMaterial({
    schemaVersion: 1, id: "invalid", type: "entity", title: "错误", description: "", groupId: "setting-root",
  }, "# 错误"), "absent")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  await expect(core.saveDocument("specs/entities/invalid.md", writeMaterial({
    schemaVersion: 1, id: "invalid", type: "entity", title: "错误", description: "", groupId: "missing",
  }, "# 错误"), "absent")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  expect(parseMaterial(updatedProject.content)?.data.materialGroups).toEqual(materialGroups);
});

test("rejects a malformed group tree without replacing the project document", async () => {
  const core = await project();
  const projectVersion = (await core.documents()).find((file) => file.path === "specs/project.md")!;
  const projectFile = await core.readDocument(projectVersion.path, projectVersion.version);
  const parsedProject = parseMaterial(projectFile.content)!;
  const invalidGroups = { entity: [
    { id: "first", name: "甲", parentId: "second", order: 0 },
    { id: "second", name: "乙", parentId: "first", order: 0 },
  ] };

  await expect(core.saveDocument(projectFile.path, writeMaterial({ ...parsedProject.data, materialGroups: invalidGroups }, parsedProject.body), projectFile.version))
    .rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  expect(await readFile(path.join(core.metadata.path, projectFile.path), "utf8")).toBe(projectFile.content);
});

test("preserves external edits and rejects duplicate creation", async () => {
  const core = await project();
  const file = await core.saveDocument("specs/entities/hero.md", entity("角色"), "absent");
  await expect(core.saveDocument(file.path, entity("重复"), "absent")).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  await writeFile(path.join(core.metadata.path, file.path), entity("外部编辑"));
  await expect(core.saveDocument(file.path, entity("本地编辑"), file.version)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  expect(await readFile(path.join(core.metadata.path, file.path), "utf8")).toContain("外部编辑");
});

test("limits manual saves to documents and rejects new invalid relationships", async () => {
  const core = await project();
  await expect(core.saveDocument("scripts/hero.gd", "bad", "absent")).rejects.toMatchObject({ code: "TASK_SCOPE_DENIED" });
  await expect(core.saveDocument("specs/entities/hero.md", entity("角色", { parent: "missing" }), "absent")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  await expect(core.saveDocument("specs/entities/hero.md", entity("角色", { components: [{ id: "missing" }] }), "absent")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  expect(core.listTasks()).toEqual([]);
});

test("copies images into the project, deduplicates them, and reads them after reopening", async () => {
  const core = await project();
  const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMw2pL3HwAExAJUkjHOGQAAAABJRU5ErkJggg==";
  const image = await core.importMaterialImage(dataUrl);
  expect(image).toMatch(/^assets\/specloom\/materials\/[a-f0-9]+\.png$/);
  expect(await core.importMaterialImage(dataUrl)).toBe(image);
  expect(await (await ProjectCore.open(core.metadata.path)).readMaterialImage(image)).toBe(dataUrl);
  await expect(core.readMaterialImage("../outside.png")).rejects.toBeDefined();
  await expect(core.importMaterialImage("data:image/png;base64,YmFk")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
});
