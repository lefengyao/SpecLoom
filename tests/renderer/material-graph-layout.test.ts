import { describe, expect, test } from "vitest";
import { layoutMaterialGraph } from "../../src/renderer/material-graph-layout";
import type { MaterialNode, MaterialSummary } from "../../src/renderer/materials-model";

function node(key: string, children: MaterialNode[] = [], extra: Partial<MaterialSummary> = {}): MaterialNode {
  return { key, label: key, material: { id: key, title: key, path: `${key}.md`, type: "entity", version: "1", content: "", fields: [], components: [], ...extra }, children };
}

describe("horizontal material graph layout", () => {
  test("places deterministic depth columns from left to right without changing sibling order", () => {
    const tree = [node("root", [node("z-first", [node("grandchild")]), node("a-second")]), node("other")];
    const layout = layoutMaterialGraph(tree);
    const positions = Object.fromEntries(layout.nodes.map((item) => [item.key, item]));
    expect(layoutMaterialGraph(tree)).toEqual(layout);
    expect(positions.root!.x).toBe(positions.other!.x);
    expect(positions["z-first"]!.x).toBe(positions["a-second"]!.x);
    expect(positions["z-first"]!.x).toBeGreaterThan(positions.root!.x + positions.root!.width);
    expect(positions.grandchild!.x).toBeGreaterThan(positions["z-first"]!.x);
    expect(positions["z-first"]!.y).toBeLessThan(positions["a-second"]!.y);
    expect(positions.other!.y).toBeGreaterThan(positions["a-second"]!.y);
    expect(positions.grandchild!.depth).toBe(2);
  });

  test("centers every parent over the vertical span of its visible descendants", () => {
    const layout = layoutMaterialGraph([node("root", [node("first", [node("one"), node("two")]), node("last")])]);
    const positions = Object.fromEntries(layout.nodes.map((item) => [item.key, item]));
    expect(positions.first!.y).toBe((positions.one!.y + positions.two!.y) / 2);
    expect(positions.root!.y).toBe((positions.one!.y + positions.last!.y) / 2);
    expect(layout.height).toBeGreaterThan(positions.last!.y + positions.last!.height);
    expect(layout.width).toBeGreaterThan(positions.one!.x + positions.one!.width);
  });

  test("emits only tree parent edges, with connector endpoints on node borders", () => {
    const root = node("root", [node("child", [], { extends: "unrelated", group: "folder", components: [{ id: "component", values: {} }] })]);
    const layout = layoutMaterialGraph([root, node("unrelated"), node("component")]);
    expect(layout.edges.map(({ source, target }) => [source, target])).toEqual([["root", "child"]]);
    const parent = layout.nodes.find((item) => item.key === "root")!;
    const child = layout.nodes.find((item) => item.key === "child")!;
    expect(layout.edges[0]!.start).toEqual({ x: parent.x + parent.width, y: parent.y + parent.height / 2 });
    expect(layout.edges[0]!.end).toEqual({ x: child.x, y: child.y + child.height / 2 });
  });

  test("keeps synthetic repair buckets and all their materials outside graph nodes and edges", () => {
    const broken = node("broken", [node("broken-child")], { parent: "missing" });
    const tree = [node("normal"), { key: "__relations__", label: "关系错误", children: [broken] }, { key: "__unparsed__", label: "未归类", children: [node("unparsed", [], { invalid: true })] }];
    const layout = layoutMaterialGraph(tree);
    expect(layout.nodes.map((item) => item.key)).toEqual(["normal"]);
    expect(layout.edges).toEqual([]);
    expect(layout.repairGroups.map((group) => [group.key, group.materials.map((item) => item.key)])).toEqual([
      ["__relations__", ["broken", "broken-child"]], ["__unparsed__", ["unparsed"]],
    ]);
  });

  test("collapsing uses node keys and excludes hidden children from connectors and bounds", () => {
    const tree = [node("root", [node("child", [node("deep")])])];
    const collapsed = layoutMaterialGraph(tree, new Set());
    const expanded = layoutMaterialGraph(tree, new Set(["root"]));
    expect(collapsed.nodes.map((item) => item.key)).toEqual(["root"]);
    expect(collapsed.edges).toHaveLength(0);
    expect(expanded.nodes.map((item) => item.key)).toEqual(["root", "child"]);
    expect(expanded.edges).toHaveLength(1);
    expect(collapsed.width).toBeLessThan(expanded.width);
  });
});
