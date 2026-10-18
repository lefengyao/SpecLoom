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

  it.each(["island", { path: "specs/maps/island.md" }])("rejects a map as an entity inheritance target %j", async (base) => {
    const { root, validator } = await fixture();
    await put(root, "specs/maps/island.md", md({ id: "island", type: "map", status: "draft", version: 1, relations: [], source: "developer" }));
    await put(root, "specs/entities/hero.md", entity("hero", { extends: base }));
    const result = await validator.validate({ runGodot: false });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ path: "specs/entities/hero.md", code: "ENTITY_INHERIT_TARGET_INVALID" }));
  });
});
