import { describe, expect, it } from "vitest";
import { materialTree, projectMaterialTree, type MaterialNode } from "../../src/renderer/materials-model";
import type { MaterialSummary } from "../../src/shared/material-catalog";

function material(path: string, parent?: string, invalid = false): MaterialSummary {
  return {
    id: path,
    title: path.split("/").at(-1)!,
    type: "entity",
    path,
    version: "v1",
    content: "",
    fields: [],
    components: [],
    ...(parent ? { parent } : {}),
    ...(invalid ? { invalid: true } : {}),
  };
}

function flatten(nodes: MaterialNode[]): MaterialNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

describe("projectMaterialTree", () => {
  it("keeps a non-matching parent as context for a matched child", () => {
    const tree = materialTree([material("root"), material("root/child", "root")]);
    const projected = projectMaterialTree(tree, new Set(["root/child"]));

    expect(flatten(projected).map(({ key, contextOnly }) => [key, contextOnly])).toEqual([
      ["root", true], ["root/child", undefined],
    ]);
  });

  it("shares one context ancestor across matching siblings", () => {
    const tree = materialTree([material("root"), material("root/a", "root"), material("root/b", "root")]);
    const projected = projectMaterialTree(tree, new Set(["root/a", "root/b"]));

    expect(projected).toHaveLength(1);
    expect(projected[0]?.contextOnly).toBe(true);
    expect(projected[0]?.children.map(({ key, contextOnly }) => [key, contextOnly])).toEqual([
      ["root/a", undefined], ["root/b", undefined],
    ]);
  });

  it("keeps matching parents normal and removes unrelated branches", () => {
    const tree = materialTree([
      material("matched"), material("matched/child", "matched"),
      material("unrelated"), material("unrelated/leaf", "unrelated"),
    ]);
    const projected = projectMaterialTree(tree, new Set(["matched", "matched/child"]));

    expect(flatten(projected).map(({ key, contextOnly }) => [key, contextOnly])).toEqual([
      ["matched", undefined], ["matched/child", undefined],
    ]);
  });

  it("retains matching materials under relation-error and unparsed buckets without treating buckets as parents or matches", () => {
    const missing = material("missing-child", "missing-parent");
    const left = material("cycle-left", "cycle-right");
    const right = material("cycle-right", "cycle-left");
    const invalid = material("invalid", undefined, true);
    const tree = materialTree([missing, left, right, invalid]);
    const projected = projectMaterialTree(tree, new Set(["missing-child", "cycle-left", "cycle-right", "invalid", "__relations__", "__unparsed__"]));

    const nodes = flatten(projected);
    expect(nodes.map(({ key, contextOnly }) => [key, contextOnly])).toEqual([
      ["__relations__", undefined], ["cycle-left", undefined], ["cycle-right", undefined],
      ["missing-child", undefined], ["__unparsed__", undefined], ["invalid", undefined],
    ]);
    expect(projectMaterialTree(tree, new Set(["__relations__", "__unparsed__"]))).toEqual([]);
  });

  it("does not mutate the full source tree", () => {
    const tree = materialTree([material("root"), material("root/child", "root")]);
    const before = structuredClone(tree);

    projectMaterialTree(tree, new Set(["root/child"]));

    expect(tree).toEqual(before);
  });
});
