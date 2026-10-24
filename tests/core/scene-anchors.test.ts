import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { FileStore } from "../../src/main/core/file-store";
import { ProjectLayout } from "../../src/main/core/project-layout";
import { Validator } from "../../src/main/core/validator";

const roots: string[] = [];
const md = (data: Record<string, unknown>, body = "\n# Doc\n") => `---\n${stringify(data)}---\n${body}`;
const scene = (nodes: string[]) => `[gd_scene load_steps=1 format=3]\n\n[node name="Keeper" type="Node2D"]\n${nodes.map((node) => {
  const parts = node.split("/");
  const name = parts[parts.length - 1];
  const parent = parts.length === 1 ? "." : parts.slice(0, -1).join("/");
  return `\n[node name="${name}" type="Node2D" parent="${parent}"]\n`;
}).join("")}`;

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-scene-"));
  roots.push(root);
  await new ProjectLayout().initialize(root);
  return { root, validator: new Validator(new FileStore(root)) };
}
async function put(root: string, relative: string, content: string) {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), content);
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("anchor node paths against the entity scene", () => {
  async function project(anchorNode: string, sceneNodes: string[]) {
    const context = await fixture();
    await put(context.root, "entities/keeper.tscn", scene(sceneNodes));
    await put(context.root, "specs/components/vitality.md", md({ schemaVersion: 1, id: "vitality", title: "生命", type: "component", description: "", fields: [] }));
    await put(context.root, "specs/entities/keeper.md", md({
      schemaVersion: 1, id: "keeper", title: "守灯人", type: "entity", description: "",
      scene: "entities/keeper.tscn",
      anchors: [{ name: "head", node: anchorNode }],
      components: [{ id: "vitality" }],
    }));
    return context;
  }

  it("accepts anchors that exist in the scene", async () => {
    const { validator } = await project("Visual/Head", ["Visual", "Visual/Head"]);
    expect((await validator.validate({ runGodot: false })).diagnostics).toEqual([]);
  });

  it("reports anchors whose node path the scene does not define", async () => {
    const { validator } = await project("Visual/Missing", ["Visual", "Visual/Head"]);
    expect((await validator.validate({ runGodot: false })).diagnostics)
      .toContainEqual(expect.objectContaining({ path: "specs/entities/keeper.md", code: "ANCHOR_NODE_MISSING" }));
  });

  it("reports a scene that is named but missing", async () => {
    const context = await fixture();
    await put(context.root, "specs/entities/keeper.md", md({
      schemaVersion: 1, id: "keeper", title: "守灯人", type: "entity", description: "",
      scene: "entities/keeper.tscn",
      anchors: [{ name: "head", node: "Visual/Head" }],
    }));
    expect((await context.validator.validate({ runGodot: false })).diagnostics)
      .toContainEqual(expect.objectContaining({ code: "SCENE_NOT_FOUND" }));
  });

  it("checks anchors declared by mounted components too", async () => {
    const { root, validator } = await fixture();
    await put(root, "entities/keeper.tscn", scene(["Visual"]));
    await put(root, "specs/components/armor_slot.md", md({
      schemaVersion: 1, id: "armor_slot", title: "防具槽", type: "component", description: "",
      fields: [], anchors: [{ name: "slot_1", node: "Visual/ArmorSlot1" }],
    }));
    await put(root, "specs/entities/keeper.md", md({
      schemaVersion: 1, id: "keeper", title: "守灯人", type: "entity", description: "",
      scene: "entities/keeper.tscn",
      components: [{ id: "armor_slot" }],
    }));
    expect((await validator.validate({ runGodot: false })).diagnostics)
      .toContainEqual(expect.objectContaining({ path: "specs/components/armor_slot.md", code: "ANCHOR_NODE_MISSING" }));
  });

  it("stays silent when the entity declares no scene", async () => {
    const { root, validator } = await fixture();
    await put(root, "specs/entities/keeper.md", md({
      schemaVersion: 1, id: "keeper", title: "守灯人", type: "entity", description: "",
      anchors: [{ name: "head", node: "Visual/Head" }],
    }));
    expect((await validator.validate({ runGodot: false })).diagnostics).toEqual([]);
  });
});
