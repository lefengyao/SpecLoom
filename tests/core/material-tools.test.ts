import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkspaceTools } from "../../src/main/core/tools/workspace-tools";
import { ProjectCore } from "../../src/main/core/project-core";
import type { FileReadResult } from "../../src/shared/contracts";
import { parseMaterial, writeMaterial } from "../../src/shared/project-materials";

let root: string;
let tools: WorkspaceTools;
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMw2pL3HwAExAJUkjHOGQAAAABJRU5ErkJggg==";
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "specloom-material-tools-")); tools = new WorkspaceTools(root, "materials"); });
afterEach(async () => { await tools.close(); await rm(root, { recursive: true, force: true }); });
const execute = (name: string, input: Record<string, unknown>) => tools.execute(name, input);
async function create(category = "entity", id = "hero", properties: Record<string, unknown> = {}) {
  return await execute("MaterialCreate", { category, id, title: id, properties }) as FileReadResult;
}

test("allows agents to create, update and clear entity state machines with shared validation", async () => {
  const stateMachine = { initialState: "idle", states: [{ id: "idle", title: "待机" }, { id: "attack", title: "攻击" }], transitions: [{ from: "idle", event: "target_seen", to: "attack" }] };
  const hero = await create("entity", "hero", { stateMachine });
  expect(parseMaterial(hero.content)?.data.stateMachine).toEqual(stateMachine);
  const updated = await execute("MaterialUpdate", { path: hero.path, expectedVersion: hero.version, changes: { stateMachine: { ...stateMachine, initialState: "attack" } } }) as FileReadResult;
  await expect(execute("MaterialUpdate", { path: hero.path, expectedVersion: updated.version, changes: { stateMachine: { ...stateMachine, initialState: "missing" } } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  const cleared = await execute("MaterialUpdate", { path: hero.path, expectedVersion: updated.version, changes: { stateMachine: null } }) as FileReadResult;
  expect(parseMaterial(cleared.content)?.data.stateMachine).toBeUndefined();
  await expect(create("component", "invalid", { stateMachine })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
});

test("discovers material tools and persists all six categories without tasks", async () => {
  expect(tools.catalog.providerTools().map(t => t.function.name)).toContain("MaterialsList");
  expect(await execute("ToolSearch", { query: "MaterialCreate" })).toMatchObject({ tools: [{ name: "MaterialCreate" }] });
  for (const category of ["entity", "component", "map", "setting", "ui", "spec"]) {
    const saved = await create(category, category);
    const core = await ProjectCore.open(root);
    expect(core.listTasks()).toEqual([]);
    expect(await core.readDocument(saved.path, saved.version)).toMatchObject(saved);
    expect(await execute("MaterialRead", { path: saved.path })).toMatchObject({ version: saved.version, data: { id: category, title: category, type: category } });
  }
  const generated = await execute("MaterialCreate", { category: "entity", title: "火焰哥布林" }) as FileReadResult;
  expect(generated.path).toMatch(/^specs\/entities\/entity_[a-f0-9]{12}\.md$/);
});

test("marks created components with explicit user or system scope", async () => {
  const user = await create("component", "health");
  const system = await create("component", "state_machine", { scope: "system", group: "基础组件" });
  expect(parseMaterial(user.content)?.data).toMatchObject({ type: "component", scope: "user" });
  expect(parseMaterial(system.content)?.data).toMatchObject({ type: "component", scope: "system", group: "基础组件" });
  await expect(create("entity", "invalid_scope", { scope: "system" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
});

test("lists metadata with category, independent group, search and pagination", async () => {
  await create("entity", "hero", { description: "火焰生物", group: "敌人" });
  await create("entity", "ally", { group: "伙伴" });
  await create("component", "health");
  expect(await execute("MaterialsList", { category: "entity", query: "火焰", group: "敌人" })).toMatchObject({ total: 1, items: [{ path: "specs/entities/hero.md", title: "hero", group: "敌人" }], groups: expect.arrayContaining(["伙伴", "敌人"]) });
  expect(await execute("MaterialsList", { limit: 1, offset: 1 })).toMatchObject({ total: 3, items: [expect.objectContaining({ version: expect.stringMatching(/^sha256:/) })] });
});

test("lists hierarchical groups including empty nodes and intersects descendant and entity-type filters", async () => {
  await mkdir(path.join(root, "specs"), { recursive: true });
  await writeFile(path.join(root, "specs/project.md"), writeMaterial({ id: "project", title: "项目", materialGroups: { entity: [
    { id: "basic", name: "基础实体", order: 0 },
    { id: "forest", name: "森林", parentId: "basic", order: 0 },
    { id: "empty", name: "空分组", parentId: "basic", order: 1 },
  ] } }, "# 项目"));
  await create("entity", "forest_guard", { type: "enemy", groupId: "forest", description: "森林守卫" });
  await create("entity", "forest_hero", { type: "character", groupId: "forest", description: "森林角色" });
  const result = await execute("MaterialsList", { category: "entity", groupId: "basic", entityType: "enemy" }) as {
    total: number;
    groupTree: Array<{ id: string; children: Array<{ id: string }> }>;
    items: Array<{ id: string; groupId?: string; groupPath?: string }>;
  };

  expect(result).toMatchObject({ total: 1, groupTree: expect.arrayContaining([
    expect.objectContaining({ id: "basic", path: "基础实体", children: expect.arrayContaining([
      expect.objectContaining({ id: "forest", path: "基础实体 / 森林" }),
      expect.objectContaining({ id: "empty", name: "空分组", children: [] }),
    ]) }),
  ]), items: [expect.objectContaining({ id: "forest_guard", groupId: "forest", groupPath: "基础实体 / 森林" })] });
});

test("edits the project material group registry through MaterialUpdate", async () => {
  await mkdir(path.join(root, "specs"), { recursive: true });
  await writeFile(path.join(root, "specs/project.md"), writeMaterial({ schemaVersion: 1, id: "project", title: "项目", description: "项目", materialGroups: {
    entity: [{ id: "basic", name: "基础", order: 0 }],
    setting: [{ id: "world", name: "世界", order: 0 }],
  } }, "# 项目"));
  const project = await execute("MaterialRead", { path: "specs/project.md" }) as FileReadResult;
  const updated = await execute("MaterialUpdate", { path: "specs/project.md", expectedVersion: project.version, changes: { materialGroups: { entity: [
    { id: "basic", name: "基础", order: 0 },
    { name: "模板", order: 1 },
    { name: "黄金裔", order: 2 },
    { name: "敌人", order: 3 },
    { name: "悬峰城", order: 4 },
  ] } } }) as FileReadResult;
  const registry = parseMaterial(updated.content)?.data.materialGroups as { entity: { id: string; name: string; order: number }[]; setting: { id: string }[] };
  expect(registry.entity.map((group) => group.name)).toEqual(["基础", "模板", "黄金裔", "敌人", "悬峰城"]);
  expect(registry.entity[1]!.id).toMatch(/^group_entity_[a-f0-9]{10}$/);
  expect(registry.setting).toEqual([{ id: "world", name: "世界", order: 0 }]);
  const hero = await create("entity", "hero");
  await expect(execute("MaterialUpdate", { path: hero.path, expectedVersion: hero.version, changes: { materialGroups: { entity: [] } } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
});

test("validates group IDs for agent create and update and clears legacy text on assignment", async () => {
  await mkdir(path.join(root, "specs"), { recursive: true });
  await writeFile(path.join(root, "specs/project.md"), writeMaterial({ id: "project", title: "项目", materialGroups: {
    entity: [{ id: "entity-group", name: "角色", order: 0 }],
    setting: [{ id: "setting-group", name: "世界", order: 0 }],
  } }, "# 项目"));
  const created = await create("entity", "hero", { group: "旧文本", groupId: "entity-group" });
  expect(parseMaterial(created.content)?.data).toMatchObject({ groupId: "entity-group" });
  expect(parseMaterial(created.content)?.data.group).toBeUndefined();
  await expect(create("entity", "wrong_category", { groupId: "setting-group" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  await expect(create("entity", "missing", { groupId: "missing-group" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  const moved = await execute("MaterialUpdate", { path: created.path, expectedVersion: created.version, changes: { groupId: null } }) as FileReadResult;
  expect(parseMaterial(moved.content)?.data.groupId).toBeUndefined();
});

test("updates details and relationships while preserving body and conflict receipts", async () => {
  const parent = await create("entity", "parent");
  const saved = await create();
  const updated = await execute("MaterialUpdate", { path: saved.path, expectedVersion: saved.version, changes: { title: "主角", group: "角色", parent: "parent", extends: "parent" }, body: "\n# 编辑后的正文\n" }) as FileReadResult;
  expect(parseMaterial(updated.content)).toMatchObject({ data: { title: "主角", group: "角色", parent: "parent", extends: "parent" }, body: "\n# 编辑后的正文\n" });
  await expect(execute("MaterialUpdate", { path: saved.path, expectedVersion: saved.version, changes: { title: "过期修改" } })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  await expect(execute("MaterialUpdate", { path: parent.path, expectedVersion: parent.version, changes: { parent: "hero" } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  await expect(execute("MaterialUpdate", { path: saved.path, changes: { title: "无版本" } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  const cleared = await execute("MaterialUpdate", { path: saved.path, expectedVersion: updated.version, changes: { group: null, parent: null, extends: null } }) as FileReadResult;
  expect(parseMaterial(cleared.content)?.data.group).toBeUndefined();
  expect(parseMaterial(cleared.content)?.body).toBe("\n# 编辑后的正文\n");
});

test("binds component defaults, merges values, and removes bindings without hiding invalid fields", async () => {
  const component = await create("component", "health", { fields: [{ key: "current", type: "number", default: 100 }, { key: "alive", type: "boolean", default: true }] });
  const hero = await create();
  const bound = await execute("MaterialBindComponent", { path: hero.path, expectedVersion: hero.version, componentPath: component.path, values: { current: 80 } }) as FileReadResult;
  expect(parseMaterial(bound.content)?.data.components).toEqual([{ id: "health", values: { current: 80, alive: true } }]);
  const updated = await execute("MaterialBindComponent", { path: hero.path, expectedVersion: bound.version, componentPath: component.path, values: { alive: false } }) as FileReadResult;
  expect(parseMaterial(updated.content)?.data.components).toEqual([{ id: "health", values: { current: 80, alive: false } }]);
  await expect(execute("MaterialBindComponent", { path: hero.path, expectedVersion: updated.version, componentPath: component.path, values: { current: "错误类型" } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  await expect(execute("MaterialBindComponent", { path: hero.path, expectedVersion: updated.version, componentPath: component.path, values: { typo: 10 } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  const removed = await execute("MaterialUnbindComponent", { path: hero.path, expectedVersion: updated.version, componentId: "health" }) as FileReadResult;
  expect(parseMaterial(removed.content)?.data.components).toEqual([]);
});

test("imports, deduplicates, reuses and clears bounded project images", async () => {
  await mkdir(path.join(root, "art")); await writeFile(path.join(root, "art/hero.png"), Buffer.from(png, "base64"));
  const hero = await create();
  const illustrated = await execute("MaterialSetImage", { path: hero.path, expectedVersion: hero.version, sourcePath: "art/hero.png" }) as FileReadResult;
  const image = parseMaterial(illustrated.content)?.data.image as string;
  expect(image).toMatch(/^assets\/specloom\/materials\/[a-f0-9]{64}\.png$/);
  expect(await (await ProjectCore.open(root)).readMaterialImage(image)).toBe(`data:image/png;base64,${png}`);
  const reused = await execute("MaterialSetImage", { path: hero.path, expectedVersion: illustrated.version, imagePath: image }) as FileReadResult;
  expect(parseMaterial(reused.content)?.data.image).toBe(image);
  await expect(execute("MaterialSetImage", { path: hero.path, expectedVersion: reused.version, sourcePath: "../outside.png" })).rejects.toMatchObject({ code: "PATH_ESCAPE" });
  const cleared = await execute("MaterialSetImage", { path: hero.path, expectedVersion: reused.version, remove: true }) as FileReadResult;
  expect(parseMaterial(cleared.content)?.data.image).toBeUndefined();
});

test("resolves inherited component fields when reading and binding, and rejects inheritance cycles", async () => {
  const base = await create("component", "base", { fields: [{ key: "hp", label: "生命", type: "number", default: 100 }, { key: "speed", type: "number", default: 100 }] });
  const derived = await create("component", "derived", { extends: base.path, fields: [{ key: "speed", type: "number", default: 260 }] });
  const read = await execute("MaterialRead", { path: derived.path }) as FileReadResult & { fields: unknown };
  expect(read.fields).toEqual([{ key: "hp", label: "生命", type: "number", default: 100 }, { key: "speed", type: "number", default: 260 }]);
  await expect(execute("MaterialUpdate", { path: base.path, expectedVersion: base.version, changes: { extends: derived.path } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  await expect(execute("MaterialUpdate", { path: derived.path, expectedVersion: derived.version, changes: { extends: "missing_component" } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  const cleared = await execute("MaterialUpdate", { path: derived.path, expectedVersion: derived.version, changes: { extends: null } }) as FileReadResult;
  expect(parseMaterial(cleared.content)?.data.extends).toBeUndefined();
  const restored = await execute("MaterialUpdate", { path: derived.path, expectedVersion: cleared.version, changes: { extends: base.path } }) as FileReadResult;
  const hero = await create();
  const bound = await execute("MaterialBindComponent", { path: hero.path, expectedVersion: hero.version, componentPath: restored.path, values: { hp: 30 } }) as FileReadResult;
  expect(parseMaterial(bound.content)?.data.components).toEqual([{ id: "derived", values: { hp: 30, speed: 260 } }]);
});

test("rejects crop rectangles outside the image and crop combined with removal", async () => {
  await mkdir(path.join(root, "art")); await writeFile(path.join(root, "art/hero.png"), Buffer.from(png, "base64"));
  const hero = await create();
  await expect(execute("MaterialSetImage", { path: hero.path, expectedVersion: hero.version, sourcePath: "art/hero.png", crop: { x: 0.8, y: 0, width: 0.5, height: 1 } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  await expect(execute("MaterialSetImage", { path: hero.path, expectedVersion: hero.version, remove: true, crop: { x: 0, y: 0, width: 1, height: 1 } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  expect(await readFile(path.join(root, hero.path), "utf8")).toBe(hero.content);
});

test("generic file writes to materials share schema and relationship validation", async () => {
  const hero = await create();
  await tools.execute("Read", { path: hero.path });
  await expect(tools.execute("Edit", { path: hero.path, old_string: "components: []", new_string: "components: [missing]" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  expect(await readFile(path.join(root, hero.path), "utf8")).toBe(hero.content);
  await expect(execute("MaterialRead", { path: "scripts/hero.gd" })).rejects.toMatchObject({ code: "TASK_SCOPE_DENIED" });
  await expect(create("component", "bad", { fields: [{ key: "count", type: "number", default: "wrong" }] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
});

test("component operations resolve existing path references without creating duplicate bindings", async () => {
  const component = await create("component", "health", { fields: [{ key: "current", type: "number", default: 100 }] });
  const hero = await create("entity", "hero", { components: [{ id: `res://${component.path}`, values: { current: 80 } }] });
  const updated = await execute("MaterialBindComponent", { path: hero.path, expectedVersion: hero.version, componentPath: component.path, values: { current: 70 } }) as FileReadResult;
  expect(parseMaterial(updated.content)?.data.components).toEqual([{ id: "health", values: { current: 70 } }]);
  const byPath = await execute("MaterialUpdate", { path: hero.path, expectedVersion: updated.version, changes: { components: [{ id: component.path, values: { current: 60 } }] } }) as FileReadResult;
  const removed = await execute("MaterialUnbindComponent", { path: hero.path, expectedVersion: byPath.version, componentId: "health" }) as FileReadResult;
  expect(parseMaterial(removed.content)?.data.components).toEqual([]);
});

test("failed saves do not change data and image inputs reject bad or oversized sources", async () => {
  const hero = await create();
  await expect(execute("MaterialCreate", { category: "entity", id: "hero", title: "重复" })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  await expect(execute("MaterialCreate", { category: "entity", id: "../escape", title: "越界" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  await expect(execute("MaterialUpdate", { path: hero.path, expectedVersion: hero.version, changes: { parent: "missing" } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  await expect(execute("MaterialUpdate", { path: hero.path, expectedVersion: hero.version, changes: { fields: [] } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  await writeFile(path.join(root, "bad.png"), "bad"); await writeFile(path.join(root, "large.png"), Buffer.alloc(2 * 1024 * 1024 + 1));
  for (const sourcePath of ["bad.png", "large.png"]) await expect(execute("MaterialSetImage", { path: hero.path, expectedVersion: hero.version, sourcePath })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  await expect(execute("MaterialSetImage", { path: hero.path, expectedVersion: hero.version, sourcePath: "bad.png", remove: true })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  expect(await readFile(path.join(root, hero.path), "utf8")).toBe(hero.content);
});
