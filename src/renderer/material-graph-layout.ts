import type { MaterialNode } from "./materials-model";

export interface MaterialGraphNode {
  key: string;
  node: MaterialNode;
  depth: number;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface MaterialGraphEdge {
  source: string;
  target: string;
  start: { x: number; y: number };
  end: { x: number; y: number };
}
export interface MaterialGraphLayout {
  nodes: MaterialGraphNode[];
  edges: MaterialGraphEdge[];
  repairGroups: { key: string; label: string; materials: MaterialNode[] }[];
  width: number;
  height: number;
}

/** Lay out the projected parent tree. Other material references never create edges. */
export function layoutMaterialGraph(tree: MaterialNode[], expandedKeys?: ReadonlySet<string>): MaterialGraphLayout {
  const width = 248;
  const height = 172;
  const columnGap = 88;
  const rowGap = 28;
  const padding = 24;
  const nodes: MaterialGraphNode[] = [];
  const edges: MaterialGraphEdge[] = [];
  const repairGroups: MaterialGraphLayout["repairGroups"] = [];
  let leaf = 0;

  function collectRepair(node: MaterialNode): MaterialNode[] {
    return [...(node.material ? [node] : []), ...node.children.flatMap(collectRepair)];
  }

  // Extract repair entries before collapse, so every editable file stays reachable.
  function graphTree(items: MaterialNode[]): MaterialNode[] {
    return items.flatMap((node) => {
      if (node.key === "__relations__" || node.key === "__unparsed__") {
        repairGroups.push({ key: node.key, label: node.label, materials: collectRepair(node) });
        return [];
      }
      const children = graphTree(node.children);
      if (!node.material) return children;
      return [{ ...node, children }];
    });
  }

  function place(node: MaterialNode, depth: number): { position: MaterialGraphNode; first: number; last: number } {
    const position: MaterialGraphNode = { key: node.key, node, depth, x: padding + depth * (width + columnGap), y: 0, width, height };
    nodes.push(position);
    const children = expandedKeys === undefined || expandedKeys.has(node.key) ? node.children.map((child) => place(child, depth + 1)) : [];
    const first = children[0]?.first ?? leaf;
    const last = children.at(-1)?.last ?? leaf;
    if (!children.length) leaf++;
    position.y = padding + ((first + last) / 2) * (height + rowGap);
    for (const child of children) edges.push({
      source: node.key,
      target: child.position.key,
      start: { x: position.x + width, y: position.y + height / 2 },
      end: { x: child.position.x, y: child.position.y + height / 2 },
    });
    return { position, first, last };
  }

  for (const root of graphTree(tree)) place(root, 0);
  return {
    nodes,
    edges,
    repairGroups,
    width: Math.max(padding * 2, ...nodes.map((node) => node.x + node.width + padding)),
    height: Math.max(padding * 2, ...nodes.map((node) => node.y + node.height + padding)),
  };
}
