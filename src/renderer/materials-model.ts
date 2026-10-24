import type { MaterialSummary } from "../shared/material-catalog";
export { categoryForPath, categoryLabels, categoryRoots, componentScope, componentScopeLabels, materialScope, referenceId, summarizeMaterial, type ComponentScope, type DocumentCategory, type MaterialSummary } from "../shared/material-catalog";

export interface MaterialNode {
  key: string;
  label: string;
  material?: MaterialSummary;
  contextOnly?: boolean;
  children: MaterialNode[];
}
export function resolveMaterial(catalog: MaterialSummary[], reference: string | undefined): MaterialSummary | undefined {
  if (!reference) return undefined;
  const identity = reference.replace(/^res:\/\//, "").replaceAll("\\", "/").toLowerCase();
  return catalog.find((item) => item.id === reference || item.path.toLowerCase() === identity);
}
export function wouldCycle(catalog: MaterialSummary[], owner: MaterialSummary, candidate: MaterialSummary, field: "parent" | "extends"): boolean {
  const seen = new Set<string>();
  let cursor: MaterialSummary | undefined = candidate;
  while (cursor) {
    if (cursor.path === owner.path || seen.has(cursor.path)) return true;
    seen.add(cursor.path);
    cursor = resolveMaterial(catalog, cursor[field]);
  }
  return false;
}
export function materialTree(materials: MaterialSummary[]): MaterialNode[] {
  // Index by file identity so duplicate/malformed IDs never hide an editable file.
  const nodes = new Map(materials.map((item) => [item.path, { key: item.path, label: item.title, material: item, children: [] } as MaterialNode]));
  const roots: MaterialNode[] = [];
  const errors: MaterialNode = { key: "__relations__", label: "关系错误", children: [] };
  const unparsed: MaterialNode = { key: "__unparsed__", label: "未归类", children: [] };
  for (const item of materials) {
    const node = nodes.get(item.path)!;
    if (item.invalid) { unparsed.children.push(node); continue; }
    if (!item.parent) { roots.push(node); continue; }
    const parent = resolveMaterial(materials, item.parent);
    if (!parent || wouldCycle(materials, item, parent, "parent")) { errors.children.push(node); continue; }
    nodes.get(parent.path)!.children.push(node);
  }
  if (errors.children.length) roots.push(errors);
  if (unparsed.children.length) roots.push(unparsed);
  const sort = (items: MaterialNode[]): void => {
    items.sort((left, right) => left.label.localeCompare(right.label));
    for (const item of items) sort(item.children);
  };
  sort(roots);
  return roots;
}

/** Keep matched materials and their parent path, marking unmatched material ancestors as context. */
export function projectMaterialTree(tree: MaterialNode[], matchedPaths: ReadonlySet<string>): MaterialNode[] {
  const project = (node: MaterialNode): MaterialNode | undefined => {
    const children = node.children.map(project).filter((child): child is MaterialNode => child !== undefined);
    const matched = Boolean(node.material && matchedPaths.has(node.material.path));
    if (!matched && children.length === 0) return undefined;
    return {
      ...node,
      ...(node.material && !matched ? { contextOnly: true } : {}),
      children,
    };
  };

  return tree.map(project).filter((node): node is MaterialNode => node !== undefined);
}
