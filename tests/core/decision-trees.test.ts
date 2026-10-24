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

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-trees-"));
  roots.push(root);
  await new ProjectLayout().initialize(root);
  return { root, validator: new Validator(new FileStore(root)) };
}
async function put(root: string, relative: string, content: string) {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), content);
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const tree = (id: string, comparator = "vitality.current <= 30") => md({
  schemaVersion: 1, id, title: id, type: "decision_tree", description: "",
  root: {
    id: "root", kind: "selector", children: [
      { id: "flee", kind: "sequence", children: [
        { id: "low_hp", kind: "condition", comparator },
        { id: "run", kind: "action", action: "move_away" },
      ] },
    ],
  },
});

const decisionTreeComponent = md({
  schemaVersion: 1, id: "decision_tree", title: "决策树", type: "component", scope: "system", description: "",
  fields: [
    { key: "enabled", label: "启用", type: "boolean", default: true },
    { key: "tree", label: "决策树", type: "string", default: "" },
  ],
});

async function project() {
  const context = await fixture();
  await put(context.root, "specs/components/decision_tree.md", decisionTreeComponent);
  await put(context.root, "specs/components/vitality.md", md({
    schemaVersion: 1, id: "vitality", title: "生命", type: "component", description: "",
    fields: [{ key: "current", label: "当前", type: "number", default: 100 }],
  }));
  await put(context.root, "specs/decision_trees/combat.md", tree("combat"));
  return context;
}

describe("decision tree specs and mounts", () => {
  it("accepts a tree whose comparator resolves", async () => {
    const { validator } = await project();
    expect((await validator.validate({ runGodot: false })).diagnostics).toEqual([]);
  });

  it("rejects unknown comparator components and fields", async () => {
    const { root, validator } = await fixture();
    await put(root, "specs/components/decision_tree.md", decisionTreeComponent);
    await put(root, "specs/components/vitality.md", md({ schemaVersion: 1, id: "vitality", title: "生命", type: "component", description: "", fields: [{ key: "current", type: "number", default: 1 }] }));
    await put(root, "specs/decision_trees/missing_component.md", tree("missing_component", "nope.current < 3"));
    await put(root, "specs/decision_trees/missing_field.md", tree("missing_field", "vitality.mana < 3"));
    const result = await validator.validate({ runGodot: false });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "TREE_COMPARATOR_UNKNOWN_COMPONENT" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "TREE_COMPARATOR_UNKNOWN_FIELD" }));
  });

  it("rejects comparators whose literal does not match the field type", async () => {
    const { validator } = await project();
    await put((await fixture()).root, "unused", "");
    const mismatch = await fixture();
    await put(mismatch.root, "specs/components/vitality.md", md({ schemaVersion: 1, id: "vitality", title: "生命", type: "component", description: "", fields: [{ key: "current", type: "number", default: 1 }] }));
    await put(mismatch.root, "specs/decision_trees/bad.md", tree("bad", "vitality.current <= many"));
    expect((await mismatch.validator.validate({ runGodot: false })).diagnostics)
      .toContainEqual(expect.objectContaining({ code: "TREE_COMPARATOR_TYPE_MISMATCH" }));
    expect(validator).toBeDefined();
  });

  it("lets an entity mount one decision tree instance", async () => {
    const { root, validator } = await project();
    await put(root, "specs/entities/keeper.md", md({
      schemaVersion: 1, id: "keeper", title: "守灯人", type: "entity", description: "",
      components: [{ id: "decision_tree", key: "combat_ai", values: { tree: "combat" } }],
    }));
    expect((await validator.validate({ runGodot: false })).diagnostics).toEqual([]);
  });

  it("reports a mount whose tree does not exist", async () => {
    const { root, validator } = await project();
    await put(root, "specs/entities/keeper.md", md({
      schemaVersion: 1, id: "keeper", title: "守灯人", type: "entity", description: "",
      components: [{ id: "decision_tree", key: "combat_ai", values: { tree: "ghost" } }],
    }));
    expect((await validator.validate({ runGodot: false })).diagnostics)
      .toContainEqual(expect.objectContaining({ path: "specs/entities/keeper.md", code: "DECISION_TREE_MISSING" }));
  });

  it("requires distinct keys when one component is mounted several times", async () => {
    const { root, validator } = await project();
    await put(root, "specs/decision_trees/patrol.md", tree("patrol"));
    await put(root, "specs/entities/keeper.md", md({
      schemaVersion: 1, id: "keeper", title: "守灯人", type: "entity", description: "",
      components: [
        { id: "decision_tree", values: { tree: "combat" } },
        { id: "decision_tree", values: { tree: "patrol" } },
      ],
    }));
    expect((await validator.validate({ runGodot: false })).diagnostics)
      .toContainEqual(expect.objectContaining({ code: "BINDING_KEY_REQUIRED" }));
  });

  it("rejects duplicate keys but accepts distinct ones", async () => {
    const { root, validator } = await project();
    await put(root, "specs/decision_trees/patrol.md", tree("patrol"));
    await put(root, "specs/entities/keeper.md", md({
      schemaVersion: 1, id: "keeper", title: "守灯人", type: "entity", description: "",
      components: [
        { id: "decision_tree", key: "ai", values: { tree: "combat" } },
        { id: "decision_tree", key: "ai", values: { tree: "patrol" } },
      ],
    }));
    expect((await validator.validate({ runGodot: false })).diagnostics)
      .toContainEqual(expect.objectContaining({ code: "BINDING_KEY_DUPLICATE" }));

    await put(root, "specs/entities/keeper.md", md({
      schemaVersion: 1, id: "keeper", title: "守灯人", type: "entity", description: "",
      components: [
        { id: "decision_tree", key: "combat_ai", values: { tree: "combat" } },
        { id: "decision_tree", key: "patrol_ai", values: { tree: "patrol" } },
      ],
    }));
    expect((await validator.validate({ runGodot: false })).diagnostics).toEqual([]);
  });

  it("mounts decision trees on systems through mounts", async () => {
    const { root, validator } = await project();
    await put(root, "specs/systems/ai.md", md({
      schemaVersion: 1, id: "ai", title: "AI 系统", type: "system", description: "",
      mounts: [{ id: "decision_tree", key: "combat_ai", values: { tree: "combat" } }],
    }));
    expect((await validator.validate({ runGodot: false })).diagnostics).toEqual([]);
  });

  it("checks signals against the entity or system that declares them", async () => {
    const signaling = (from: string, name: string) => md({
      schemaVersion: 1, id: "signals", title: "signals", type: "decision_tree", description: "",
      root: { id: "root", kind: "selector", children: [{ id: "c", kind: "condition", signal: { from, name } }] },
    });

    const unknownSource = await project();
    await put(unknownSource.root, "specs/decision_trees/signals.md", signaling("ghost", "hp_low"));
    expect((await unknownSource.validator.validate({ runGodot: false })).diagnostics)
      .toContainEqual(expect.objectContaining({ code: "TREE_SIGNAL_UNKNOWN_SOURCE" }));

    const unknownName = await project();
    await put(unknownName.root, "specs/entities/keeper.md", md({
      schemaVersion: 1, id: "keeper", title: "守灯人", type: "entity", description: "", signals: ["hp_low"],
    }));
    await put(unknownName.root, "specs/decision_trees/signals.md", signaling("keeper", "alarm"));
    expect((await unknownName.validator.validate({ runGodot: false })).diagnostics)
      .toContainEqual(expect.objectContaining({ code: "TREE_SIGNAL_UNKNOWN_NAME" }));

    const systemSignal = await project();
    await put(systemSignal.root, "specs/systems/alarm.md", md({
      schemaVersion: 1, id: "alarm", title: "警报系统", type: "system", description: "", signals: ["alarm_raised"],
    }));
    await put(systemSignal.root, "specs/decision_trees/signals.md", signaling("alarm", "alarm_raised"));
    expect((await systemSignal.validator.validate({ runGodot: false })).diagnostics).toEqual([]);
  });

  it("rejects malformed signal declarations on entities", async () => {
    const { root, validator } = await project();
    await put(root, "specs/entities/keeper.md", md({
      schemaVersion: 1, id: "keeper", title: "守灯人", type: "entity", description: "", signals: ["Not Valid"],
    }));
    expect((await validator.validate({ runGodot: false })).diagnostics)
      .toContainEqual(expect.objectContaining({ path: "specs/entities/keeper.md", code: "SPEC_FIELD_INVALID" }));
  });

  it("checks the entity a condition reads its component from", async () => {
    const owned = (owner: string) => md({
      schemaVersion: 1, id: "owned", title: "owned", type: "decision_tree", description: "",
      root: { id: "root", kind: "selector", children: [{ id: "c", kind: "condition", owner, comparator: "vitality.current <= 30" }] },
    });

    const missing = await project();
    await put(missing.root, "specs/decision_trees/owned.md", owned("ghost"));
    expect((await missing.validator.validate({ runGodot: false })).diagnostics)
      .toContainEqual(expect.objectContaining({ code: "TREE_OWNER_UNKNOWN" }));

    const unattached = await project();
    await put(unattached.root, "specs/entities/keeper.md", md({ schemaVersion: 1, id: "keeper", title: "守灯人", type: "entity", description: "" }));
    await put(unattached.root, "specs/decision_trees/owned.md", owned("keeper"));
    expect((await unattached.validator.validate({ runGodot: false })).diagnostics)
      .toContainEqual(expect.objectContaining({ code: "TREE_OWNER_COMPONENT_MISSING" }));

    const accepted = await project();
    await put(accepted.root, "specs/entities/keeper.md", md({
      schemaVersion: 1, id: "keeper", title: "守灯人", type: "entity", description: "",
      components: [{ id: "vitality", values: { current: 100 } }],
    }));
    await put(accepted.root, "specs/decision_trees/owned.md", owned("keeper"));
    expect((await accepted.validator.validate({ runGodot: false })).diagnostics).toEqual([]);
  });
});
