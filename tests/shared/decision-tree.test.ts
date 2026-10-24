import { describe, expect, it } from "vitest";
import {
  buildDecisionTree, findDecisionNode, flattenDecisionTree, insertDecisionNode, parseComparator,
  removeDecisionNode, reorderDecisionNode, updateDecisionNode, validateDecisionTree,
} from "../../src/shared/decision-tree";

const valid = {
  id: "root",
  kind: "selector",
  children: [
    { id: "flee", kind: "sequence", children: [
      { id: "low_hp", kind: "condition", comparator: "vitality.current <= 30" },
      { id: "run", kind: "action", action: "move_away", params: { speed: 1.5 } },
    ] },
    { id: "attack", kind: "cooldown", seconds: 2, child: { id: "in_range", kind: "condition", event: "enemy_in_range" } },
  ],
};

describe("decision tree model", () => {
  it("accepts a well-formed tree", () => {
    expect(validateDecisionTree(valid)).toEqual([]);
  });

  it("flattens and rebuilds the same structure", () => {
    const flat = flattenDecisionTree(valid);
    expect(flat.map((entry) => `${entry.node.id}:${entry.depth}`)).toEqual(["root:0", "flee:1", "low_hp:2", "run:2", "attack:1", "in_range:2"]);
    const rebuilt = buildDecisionTree(flat.map(({ node, parent }) => ({ node, ...(parent ? { parent } : {}) })));
    expect(validateDecisionTree(rebuilt)).toEqual([]);
    expect(flattenDecisionTree(rebuilt).map((entry) => entry.node.id)).toEqual(flat.map((entry) => entry.node.id));
  });

  it("requires a composite root", () => {
    expect(validateDecisionTree({ id: "root", kind: "action", action: "idle" })).toContainEqual(expect.objectContaining({ code: "TREE_ROOT_INVALID" }));
    expect(validateDecisionTree(undefined)).toContainEqual(expect.objectContaining({ code: "TREE_ROOT_INVALID" }));
  });

  it("reports duplicate ids, empty composites and malformed decorators", () => {
    const issues = validateDecisionTree({
      id: "root", kind: "selector", children: [
        { id: "same", kind: "action", action: "a" },
        { id: "same", kind: "action", action: "b" },
        { id: "empty", kind: "sequence", children: [] },
        { id: "cool", kind: "cooldown" },
      ],
    });
    expect(issues).toContainEqual(expect.objectContaining({ code: "TREE_NODE_DUPLICATE" }));
    expect(issues).toContainEqual(expect.objectContaining({ code: "TREE_CHILDREN_INVALID" }));
  });

  it("requires exactly one of comparator and event", () => {
    const both = validateDecisionTree({ id: "root", kind: "selector", children: [{ id: "c", kind: "condition", comparator: "vitality.current < 1", event: "hit" }] });
    const neither = validateDecisionTree({ id: "root", kind: "selector", children: [{ id: "c", kind: "condition" }] });
    expect(both).toContainEqual(expect.objectContaining({ code: "TREE_CONDITION_INVALID" }));
    expect(neither).toContainEqual(expect.objectContaining({ code: "TREE_CONDITION_INVALID" }));
  });

  it("parses comparators and rejects free-form text", () => {
    expect(parseComparator("vitality.current <= 30")).toEqual({ component: "vitality", field: "current", operator: "<=", literal: "30" });
    expect(parseComparator("vitality.current <=")).toBeUndefined();
    expect(parseComparator("just_a_name")).toBeUndefined();
  });

  it("validates decorator parameters and action names", () => {
    expect(validateDecisionTree({ id: "root", kind: "selector", children: [{ id: "c", kind: "cooldown", seconds: 0, child: { id: "a", kind: "action", action: "x" } }] }))
      .toContainEqual(expect.objectContaining({ code: "TREE_NODE_INVALID" }));
    expect(validateDecisionTree({ id: "root", kind: "selector", children: [{ id: "a", kind: "action", action: "Not Valid" }] }))
      .toContainEqual(expect.objectContaining({ code: "TREE_ACTION_INVALID" }));
  });

  it("inserts, updates, reorders and removes nodes without mutating the source", () => {
    const tree = buildDecisionTree(flattenDecisionTree(valid).map(({ node, parent }) => ({ node, ...(parent ? { parent } : {}) })))!;
    const withChild = insertDecisionNode(tree, "flee", { id: "extra", kind: "action", action: "shout" });
    expect(findDecisionNode(withChild, "extra")).toBeDefined();
    expect(findDecisionNode(tree, "extra")).toBeUndefined();
    expect(findDecisionNode(withChild, "flee")!.children?.map((child) => child.id)).toEqual(["low_hp", "run", "extra"]);

    const renamed = updateDecisionNode(withChild, "extra", { title: "喊话", action: "yell" });
    expect(findDecisionNode(renamed, "extra")).toMatchObject({ title: "喊话", action: "yell" });

    const switched = updateDecisionNode(renamed, "run", { kind: "condition", comparator: "vitality.current < 10" });
    expect(findDecisionNode(switched, "run")).toMatchObject({ kind: "condition", comparator: "vitality.current < 10" });
    expect(findDecisionNode(switched, "run")!.action).toBeUndefined();

    const reordered = reorderDecisionNode(switched, "attack", -1);
    expect(reordered.children?.map((child) => child.id)).toEqual(["attack", "flee"]);

    const removed = removeDecisionNode(reordered, "flee");
    expect(flattenDecisionTree(removed).map((entry) => entry.node.id)).toEqual(["root", "attack", "in_range"]);
    expect(validateDecisionTree(removed)).toEqual([]);
  });
});
