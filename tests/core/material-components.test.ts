import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { FileStore } from "../../src/main/core/file-store";
import { ProjectLayout } from "../../src/main/core/project-layout";
import { Validator } from "../../src/main/core/validator";

const roots: string[] = [];
const md = (data: Record<string, unknown>) => `---\n${stringify(data)}---\n\n# Material\n`;
const entity = (id: string, extra: Record<string, unknown> = {}) => md({ schemaVersion: 1, id, type: "entity", title: id, description: "", ...extra });
const component = (id = "health", extra: Record<string, unknown> = {}) => md({ schemaVersion: 1, id, type: "component", title: "生命值", description: "", fields: [{ key: "current", label: "当前生命", type: "number", default: 100 }, { key: "max", type: "number", default: 100 }], ...extra });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-materials-"));
  roots.push(root);
  await new ProjectLayout().initialize(root);
  const store = new FileStore(root);
  return { root, store, validator: new Validator(store) };
}
async function put(root: string, relative: string, content: string) {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), content);
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("component project materials", () => {
  it("initializes an independent editable component directory", async () => {
    const { root } = await fixture();
    expect((await lstat(path.join(root, "specs/components"))).isDirectory()).toBe(true);
  });

  it("accepts name-only generic entities at the root and within nested categories", async () => {
    const { root, validator } = await fixture();
    await put(root, "specs/entities/enemies.md", entity("enemies"));
    await put(root, "specs/entities/characters/enemies/goblin.md", entity("goblin", { parent: "enemies", extends: "enemies" }));
    const result = await validator.validate({ runGodot: false });
    expect(result.diagnostics).toEqual([]);
    expect(result.status).toBe("pass");
  });

  it("indexes independent components and validates all primitive field defaults", async () => {
    const { root, validator } = await fixture();
    await put(root, "specs/components/motion.md", component("motion", { fields: [{ key: "speed", type: "number", default: 180 }, { key: "mode", type: "string", default: "walking" }, { key: "enabled", type: "boolean", default: true }] }));
    const { result, dependencies } = await validator.validateWithDependencies({ runGodot: false });
    expect(result.diagnostics).toEqual([]);
    expect(dependencies["specs/components/motion.md"]).toMatch(/^sha256:/);
  });

  it.each([
    [{ type: "entity" }, "SPEC_TYPE_INVALID"],
    [{ fields: [{ key: "current", type: "vector2", default: 1 }] }, "SPEC_FIELD_INVALID"],
    [{ fields: [{ key: "current", type: "number", default: "100" }] }, "SPEC_FIELD_INVALID"],
    [{ fields: [{ key: "enabled", type: "boolean", default: 1 }] }, "SPEC_FIELD_INVALID"],
    [{ fields: [{ key: "name", type: "string", default: false }] }, "SPEC_FIELD_INVALID"],
    [{ fields: [{ key: "current", type: "number", default: 1 }, { key: "current", type: "number", default: 2 }] }, "COMPONENT_FIELD_DUPLICATE"],
    [{ fields: [{ key: "constructor", type: "number", default: 1 }] }, "SPEC_FIELD_INVALID"],
  ])("rejects malformed component definitions %j", async (extra, code) => {
    const { root, validator } = await fixture();
    await put(root, "specs/components/health.md", component("health", extra));
    const result = await validator.validate({ runGodot: false });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ path: "specs/components/health.md", code }));
  });

  it.each([
    "health",
    { id: "health" },
    { id: "health", values: { current: 200 } },
    { path: "specs/components/health.md", values: { current: 200 } },
    { id: "health", values: { current: 200 }, notes: ["当前生命不得低于 0", "死亡后从场上移除"] },
  ])("attaches components using their defaults or typed entity overrides %j", async (binding) => {
    const { root, validator } = await fixture();
    await put(root, "specs/components/health.md", component());
    await put(root, "specs/entities/hero.md", entity("hero", { components: [binding] }));
    expect((await validator.validate({ runGodot: false })).diagnostics).toEqual([]);
  });

  it.each([
    [{ id: "health", values: { current: "200" } }, "ENTITY_COMPONENT_VALUE_INVALID"],
    [{ id: "health", values: { unknown: 200 } }, "ENTITY_COMPONENT_FIELD_UNKNOWN"],
    [{ id: "health", values: [] }, "SPEC_FIELD_INVALID"],
    [{ id: "health", values: { current: { amount: 200 } } }, "ENTITY_COMPONENT_VALUE_INVALID"],
    [{ id: "health", notes: "说明" }, "SPEC_FIELD_INVALID"],
    [{ id: "health", notes: ["", "  "] }, "SPEC_FIELD_INVALID"],
  ])("rejects invalid entity component overrides %j", async (binding, code) => {
    const { root, validator } = await fixture();
    await put(root, "specs/components/health.md", component());
    await put(root, "specs/entities/hero.md", entity("hero", { components: [binding] }));
    const result = await validator.validate({ runGodot: false });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ path: "specs/entities/hero.md", code, ...(code === "SPEC_FIELD_INVALID" ? { message: expect.stringContaining("components") } : {}) }));
  });

  it("rejects repeated attachment even when one reference uses a file path", async () => {
    const { root, validator } = await fixture();
    await put(root, "specs/components/health.md", component());
    await put(root, "specs/entities/hero.md", entity("hero", { components: ["health", { path: "specs/components/health.md" }] }));
    const result = await validator.validate({ runGodot: false });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "ENTITY_COMPONENT_DUPLICATE" }));
  });

  it("requires component bindings to target component specifications", async () => {
    const { root, validator } = await fixture();
    await put(root, "specs/entities/base.md", entity("base"));
    await put(root, "specs/entities/hero.md", entity("hero", { components: ["base", "missing"] }));
    const result = await validator.validate({ runGodot: false });
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(expect.arrayContaining(["ENTITY_COMPONENT_TARGET_INVALID", "ENTITY_COMPONENT_NOT_FOUND"]));
  });

  it("checks versions for component, inheritance, parent, and general ID references", async () => {
    const { root, validator } = await fixture();
    const stale = `sha256:${"a".repeat(64)}`;
    await put(root, "specs/components/health.md", component());
    await put(root, "specs/entities/base.md", entity("base"));
    await put(root, "specs/entities/hero.md", entity("hero", { parent: { id: "base", version: stale }, extends: { id: "base", version: stale }, components: [{ id: "health", version: stale }], relations: [{ id: "base", version: stale }], source: { id: "base", version: stale } }));
    const result = await validator.validate({ runGodot: false });
    expect(result.diagnostics.filter((entry) => entry.code === "REFERENCE_VERSION_STALE")).toHaveLength(5);
  });

  it("accepts current versions in semantic reference objects", async () => {
    const { root, store, validator } = await fixture();
    await put(root, "specs/components/health.md", component());
    await put(root, "specs/entities/base.md", entity("base"));
    const health = await store.listVersion("specs/components/health.md");
    const base = await store.listVersion("specs/entities/base.md");
    await put(root, "specs/entities/hero.md", entity("hero", { parent: { id: "base", version: base.version }, extends: { path: base.path, version: base.version }, components: [{ id: "health", version: health.version, values: { current: 80 } }] }));
    expect((await validator.validate({ runGodot: false })).diagnostics).toEqual([]);
  });

  it("rejects implicit parent category slugs and parents in a different material category", async () => {
    const { root, validator } = await fixture();
    await put(root, "specs/settings/world.md", md({ schemaVersion: 1, id: "world", type: "setting", title: "World", description: "" }));
    await put(root, "specs/entities/hero.md", entity("hero", { parent: "enemies" }));
    await put(root, "specs/entities/npc.md", entity("npc", { parent: "world" }));
    const result = await validator.validate({ runGodot: false });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ path: "specs/entities/hero.md", code: "ENTITY_PARENT_NOT_FOUND" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ path: "specs/entities/npc.md", code: "ENTITY_PARENT_TARGET_INVALID" }));
  });

  it.each(["setting", "ui", "map", "spec"])("checks real %s parent references and hierarchy cycles", async (kind) => {
    const { root, validator } = await fixture();
    const relative = (id: string) => kind === "spec" ? `specs/${id}.md` : `specs/${kind === "setting" ? "settings" : kind === "map" ? "maps" : "ui"}/${id}.md`;
    const material = (id: string, parent: unknown) => kind === "map"
      ? md({ id, type: "map", status: "draft", version: 1, relations: [], source: "developer", parent })
      : md({ schemaVersion: 1, id, title: id, description: "", ...(kind === "spec" ? {} : { type: kind }), parent });
    await put(root, relative("first"), material("first", { path: relative("second") }));
    await put(root, relative("second"), material("second", "first"));
    const result = await validator.validate({ runGodot: false });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "MATERIAL_PARENT_CYCLE" }));
  });

  it("allows a single inheritance reference and rejects malformed link objects", async () => {
    const { root, validator } = await fixture();
    await put(root, "specs/entities/base.md", entity("base"));
    await put(root, "specs/entities/hero.md", entity("hero", { extends: ["base"], parent: {}, components: [{}] }));
    const result = await validator.validate({ runGodot: false });
    for (const field of ["extends", "parent", "components"]) {
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ path: "specs/entities/hero.md", code: "SPEC_FIELD_INVALID", message: expect.stringContaining(field) }));
    }
  });

  it("allows component definitions to inherit from another component", async () => {
    const { root, validator } = await fixture();
    await put(root, "specs/components/base.md", component("base", { fields: [{ key: "hp", type: "number", default: 100 }] }));
    await put(root, "specs/components/derived.md", component("derived", { extends: "base", fields: [{ key: "speed", type: "number", default: 200 }] }));
    await put(root, "specs/entities/hero.md", entity("hero", { components: [{ id: "derived", values: { hp: 50, speed: 300 } }] }));
    expect((await validator.validate({ runGodot: false })).diagnostics).toEqual([]);
  });

  it("validates component inheritance targets and cycles", async () => {
    const { root, validator } = await fixture();
    await put(root, "specs/components/missing_base.md", component("missing_base", { extends: "absent" }));
    await put(root, "specs/components/first.md", component("first", { extends: "second" }));
    await put(root, "specs/components/second.md", component("second", { extends: "first" }));
    const result = await validator.validate({ runGodot: false });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ path: "specs/components/missing_base.md", code: "COMPONENT_INHERIT_NOT_FOUND" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "COMPONENT_INHERIT_CYCLE" }));
  });

  it("accepts inherited component fields in entity bindings and still rejects unknown keys", async () => {
    const { root, validator } = await fixture();
    await put(root, "specs/components/base.md", component("base", { fields: [{ key: "hp", type: "number", default: 100 }] }));
    await put(root, "specs/components/derived.md", component("derived", { extends: "base", fields: [{ key: "speed", type: "number", default: 200 }] }));
    await put(root, "specs/entities/hero.md", entity("hero", { components: [{ id: "derived", values: { hp: 50 } }] }));
    await put(root, "specs/entities/npc.md", entity("npc", { components: [{ id: "derived", values: { typo: 1 } }] }));
    const result = await validator.validate({ runGodot: false });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ path: "specs/entities/npc.md", code: "ENTITY_COMPONENT_FIELD_UNKNOWN" }));
    expect(result.diagnostics.some((entry) => entry.path === "specs/entities/hero.md")).toBe(false);
  });

  it.each(["island", { path: "specs/maps/island.md" }])("rejects a map as an entity inheritance target %j", async (base) => {
    const { root, validator } = await fixture();
    await put(root, "specs/maps/island.md", md({ id: "island", type: "map", status: "draft", version: 1, relations: [], source: "developer" }));
    await put(root, "specs/entities/hero.md", entity("hero", { extends: base }));
    const result = await validator.validate({ runGodot: false });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ path: "specs/entities/hero.md", code: "ENTITY_INHERIT_TARGET_INVALID" }));
  });
});

describe("component mount anchors", () => {
  const armor = (id: string, extra: Record<string, unknown> = {}) =>
    component(id, { title: id, fields: [{ key: "enabled", type: "boolean", default: true }], ...extra });

  async function armorProject() {
    const context = await fixture();
    await put(context.root, "specs/components/armor_slot.md", armor("armor_slot", {
      anchors: [
        { name: "slot_1", label: "一类防具槽", node: "Visual/ArmorSlot1", capacity: 1 },
        { name: "slot_2", label: "二类防具槽", node: "Visual/ArmorSlot2", capacity: 1 },
      ],
    }));
    await put(context.root, "specs/components/armor_class_1.md", armor("armor_class_1"));
    await put(context.root, "specs/components/armor_class_2.md", armor("armor_class_2"));
    return context;
  }

  it("accepts mounts that name a declared anchor of an attached component", async () => {
    const { root, validator } = await armorProject();
    await put(root, "specs/entities/keeper.md", entity("keeper", { components: [
      { id: "armor_slot" },
      { id: "armor_class_1", mount: { parent: "armor_slot", anchor: "slot_1" } },
      { id: "armor_class_2", mount: { parent: "armor_slot", anchor: "slot_2" } },
    ] }));
    expect((await validator.validate({ runGodot: false })).diagnostics).toEqual([]);
  });

  it("rejects unknown mount parents and undeclared anchors", async () => {
    const { root, validator } = await armorProject();
    await put(root, "specs/entities/keeper.md", entity("keeper", { components: [
      { id: "armor_slot" },
      { id: "armor_class_1", mount: { parent: "missing_component", anchor: "slot_1" } },
      { id: "armor_class_2", mount: { parent: "armor_slot", anchor: "slot_9" } },
    ] }));
    const result = await validator.validate({ runGodot: false });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ path: "specs/entities/keeper.md", code: "MOUNT_PARENT_UNKNOWN" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ path: "specs/entities/keeper.md", code: "MOUNT_ANCHOR_UNKNOWN" }));
  });

  it("lets a derived component mount on an anchor it inherits from its base", async () => {
    const { root, validator } = await fixture();
    await put(root, "specs/components/slot_contract.md", armor("slot_contract", {
      anchors: [{ name: "slot_1", label: "一类防具槽", node: "Visual/ArmorSlot1" }],
    }));
    await put(root, "specs/components/armor_slot.md", armor("armor_slot", { extends: "slot_contract" }));
    await put(root, "specs/components/armor_class_1.md", armor("armor_class_1"));
    await put(root, "specs/entities/keeper.md", entity("keeper", { components: [
      { id: "armor_slot" },
      { id: "armor_class_1", mount: { parent: "armor_slot", anchor: "slot_1" } },
    ] }));
    expect((await validator.validate({ runGodot: false })).diagnostics).toEqual([]);
  });

  it("rejects two components on one anchor unless the anchor allows it", async () => {
    const { root, validator } = await armorProject();
    await put(root, "specs/entities/keeper.md", entity("keeper", { components: [
      { id: "armor_slot" },
      { id: "armor_class_1", mount: { parent: "armor_slot", anchor: "slot_1" } },
      { id: "armor_class_2", mount: { parent: "armor_slot", anchor: "slot_1" } },
    ] }));
    expect((await validator.validate({ runGodot: false })).diagnostics)
      .toContainEqual(expect.objectContaining({ path: "specs/entities/keeper.md", code: "MOUNT_ANCHOR_OCCUPIED" }));
  });

  it("supports entity-level anchors for components mounted on the entity itself", async () => {
    const { root, validator } = await armorProject();
    await put(root, "specs/entities/keeper.md", entity("keeper", {
      anchors: [{ name: "head", node: "Visual/Head" }],
      components: [{ id: "armor_class_1", mount: { parent: "__entity__", anchor: "head" } }],
    }));
    expect((await validator.validate({ runGodot: false })).diagnostics).toEqual([]);
  });

  it("rejects anchor declarations that escape the scene root", async () => {
    const { root, validator } = await armorProject();
    await put(root, "specs/components/armor_class_1.md", armor("armor_class_1", { anchors: [{ name: "slot", node: "../Outside" }] }));
    const result = await validator.validate({ runGodot: false });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "ANCHOR_NODE_INVALID" }));
  });

  it("keeps mount targets through binding normalization", async () => {
    const { readAnchors, readBindings } = await import("../../src/shared/project-materials");
    expect(readBindings({ components: [{ id: "armor_class_1", mount: { parent: "armor_slot", anchor: "slot_1" } }] }))
      .toEqual([{ id: "armor_class_1", values: {}, mount: { parent: "armor_slot", anchor: "slot_1" } }]);
    expect(readBindings({ components: [{ id: "broken", mount: { parent: "", anchor: "slot_1" } }] }))
      .toEqual([{ id: "broken", values: {} }]);
    expect(readAnchors({ anchors: [{ name: "slot_1", node: "Visual\\ArmorSlot1", capacity: 99 }, { name: "slot_1" }, { name: "" }] }))
      .toEqual([{ name: "slot_1", node: "Visual/ArmorSlot1", capacity: 64 }]);
  });
});
