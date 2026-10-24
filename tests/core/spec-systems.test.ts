import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { FileStore } from "../../src/main/core/file-store";
import { ProjectLayout } from "../../src/main/core/project-layout";
import { Validator } from "../../src/main/core/validator";
import { WorkMaterials } from "../../src/main/core/tools/materials";

const roots: string[] = [];
const md = (data: Record<string, unknown>, body = "\n# Doc\n") => `---\n${stringify(data)}---\n${body}`;
const doc = (id: string, type: string, extra: Record<string, unknown> = {}) =>
  md({ schemaVersion: 1, id, title: id, type, description: "", ...extra });
const component = (id: string) =>
  md({ schemaVersion: 1, id, title: id, type: "component", description: "", fields: [] });
const entity = (id: string) =>
  md({ schemaVersion: 1, id, title: id, type: "entity", description: "" });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-systems-"));
  roots.push(root);
  await new ProjectLayout().initialize(root);
  return { root, validator: new Validator(new FileStore(root)) };
}
async function put(root: string, relative: string, content: string) {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), content);
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("system, feature and decision specs", () => {
  async function project() {
    const context = await fixture();
    await put(context.root, "specs/components/vitality.md", component("vitality"));
    await put(context.root, "specs/entities/keeper.md", entity("keeper"));
    await put(context.root, "specs/systems/combat.md", doc("combat", "system", {
      components: ["vitality"], entities: ["keeper"], dependsOn: [],
    }));
    await put(context.root, "specs/systems/damage.md", doc("damage", "system", { dependsOn: ["combat"] }));
    await put(context.root, "specs/features/armor-slots.md", doc("armor-slots", "feature", {
      status: "planned", systems: ["combat"],
    }));
    await put(context.root, "specs/decisions/0001-shared-combat.md", doc("shared-combat", "decision", {
      status: "accepted", affectedSystems: ["combat"],
    }));
    return context;
  }

  it("accepts systems that reference components, entities and other systems", async () => {
    const { validator } = await project();
    expect((await validator.validate({ runGodot: false })).diagnostics).toEqual([]);
  });

  it("rejects unknown component, entity and system references", async () => {
    const { root, validator } = await fixture();
    await put(root, "specs/systems/orphan.md", doc("orphan", "system", {
      components: ["missing-component"], entities: ["missing-entity"], dependsOn: ["missing-system"],
    }));
    const result = await validator.validate({ runGodot: false });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "SYSTEM_COMPONENT_NOT_FOUND" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "SYSTEM_ENTITY_NOT_FOUND" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "SYSTEM_DEPENDENCY_NOT_FOUND" }));
  });

  it("rejects circular system dependencies", async () => {
    const { root, validator } = await fixture();
    await put(root, "specs/systems/a.md", doc("a", "system", { dependsOn: ["b"] }));
    await put(root, "specs/systems/b.md", doc("b", "system", { dependsOn: ["a"] }));
    expect((await validator.validate({ runGodot: false })).diagnostics)
      .toContainEqual(expect.objectContaining({ code: "SYSTEM_DEPENDENCY_CYCLE" }));
  });

  it("restricts feature status and requires feature systems to exist", async () => {
    const { root, validator } = await fixture();
    await put(root, "specs/features/broken.md", doc("broken", "feature", { status: "wip", systems: ["nope"] }));
    const result = await validator.validate({ runGodot: false });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ path: "specs/features/broken.md", code: "SPEC_FIELD_INVALID" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "FEATURE_SYSTEM_NOT_FOUND" }));
  });

  it("requires numbered decision files and resolvable supersedes targets", async () => {
    const { root, validator } = await fixture();
    await put(root, "specs/decisions/shared-combat.md", doc("shared-combat", "decision", { status: "accepted", supersedes: "missing" }));
    const result = await validator.validate({ runGodot: false });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ path: "specs/decisions/shared-combat.md", code: "SPEC_LAYOUT_INVALID" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "DECISION_SUPERSEDES_NOT_FOUND" }));
  });

  it("rejects a decision status outside the accepted vocabulary", async () => {
    const { root, validator } = await fixture();
    await put(root, "specs/decisions/0002-unknown-status.md", doc("unknown-status", "decision", { status: "draft" }));
    expect((await validator.validate({ runGodot: false })).diagnostics)
      .toContainEqual(expect.objectContaining({ path: "specs/decisions/0002-unknown-status.md", code: "SPEC_FIELD_INVALID" }));
  });

  it("rejects two decisions that share a number", async () => {
    const { root, validator } = await fixture();
    await put(root, "specs/decisions/0002-first.md", doc("first", "decision", { status: "accepted" }));
    await put(root, "specs/decisions/0002-second.md", doc("second", "decision", { status: "accepted" }));
    expect((await validator.validate({ runGodot: false })).diagnostics)
      .toContainEqual(expect.objectContaining({ code: "DECISION_NUMBER_DUPLICATE" }));
  });

  it("creates feature and decision documents with their default status", async () => {
    const { root, validator } = await fixture();
    const store = new FileStore(root);
    const materials = new WorkMaterials(store);
    const feature = await materials.create({ category: "feature", title: "防具槽功能" }) as { path: string };
    await materials.create({ category: "decision", title: "共享战斗实体", id: "0001-shared-combat" });
    const read = await store.read(feature.path, (await store.listVersion(feature.path)).version);
    expect(read.content).toContain("type: feature");
    expect(read.content).toContain("status: planned");
    expect((await validator.validate({ runGodot: false })).diagnostics).toEqual([]);
  });
});
