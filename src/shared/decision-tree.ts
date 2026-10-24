/**
 * Decision trees describe behaviour choices as a single rooted structure.
 * They are engine-neutral: SpecLoom validates shape and references only, and
 * every implementation decides how to run a tree.
 */
export type DecisionNodeKind =
  | "selector" | "sequence" | "parallel" | "random"
  | "condition" | "action"
  | "invert" | "cooldown" | "retry";

export const COMPOSITE_KINDS = ["selector", "sequence", "parallel", "random"] as const;
export const DECORATOR_KINDS = ["invert", "cooldown", "retry"] as const;
export const LEAF_KINDS = ["condition", "action"] as const;
export const NODE_KINDS: DecisionNodeKind[] = [...COMPOSITE_KINDS, ...LEAF_KINDS, ...DECORATOR_KINDS];

export const NODE_KIND_LABELS: Record<DecisionNodeKind, string> = {
  selector: "选择", sequence: "顺序", parallel: "并行", random: "随机",
  condition: "条件", action: "动作",
  invert: "取反", cooldown: "冷却", retry: "重试",
};

export const COMPARATOR_OPERATORS = ["<=", ">=", "==", "!=", "<", ">"] as const;

export interface DecisionNode {
  id: string;
  kind: DecisionNodeKind;
  title?: string;
  children?: DecisionNode[];
  child?: DecisionNode;
  /** Condition only: the entity whose component is compared; empty means the tree host itself. */
  owner?: string;
  comparator?: string;
  event?: string;
  action?: string;
  params?: Record<string, unknown>;
  seconds?: number;
  count?: number;
}

export interface DecisionTreeIssue {
  path: string;
  code: string;
  message: string;
}

export interface FlatDecisionNode {
  node: DecisionNode;
  parent?: string;
  depth: number;
}

export function isComposite(kind: DecisionNodeKind): boolean {
  return (COMPOSITE_KINDS as readonly string[]).includes(kind);
}

export function isDecorator(kind: DecisionNodeKind): boolean {
  return (DECORATOR_KINDS as readonly string[]).includes(kind);
}

export function isLeaf(kind: DecisionNodeKind): boolean {
  return (LEAF_KINDS as readonly string[]).includes(kind);
}

export function isNodeKind(value: unknown): value is DecisionNodeKind {
  return typeof value === "string" && (NODE_KINDS as string[]).includes(value);
}

const NODE_ID = /^[a-z][a-z0-9_]*$/;
const EVENT_NAME = /^[a-z][a-z0-9_]*$/;

export function isNodeId(value: unknown): value is string {
  return typeof value === "string" && NODE_ID.test(value);
}

/** Build the canonical comparator text the editor and validator share. */
export function composeComparator(component: string, field: string, operator: string, literal: string | number | boolean): string {
  const value = typeof literal === "string" ? literal.trim() : String(literal);
  return `${component}.${field} ${operator} ${value}`;
}

/** `component.field <= literal` — the only condition form SpecLoom can check. */
export function parseComparator(text: unknown): { component: string; field: string; operator: string; literal: string } | undefined {
  if (typeof text !== "string") return undefined;
  const match = /^([a-z][a-z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)\s*(<=|>=|==|!=|<|>)\s*(.+)$/.exec(text.trim());
  if (!match) return undefined;
  const literal = match[4]!.trim();
  // `a.b <=` backtracks to operator `<` with literal `=`; that is not a comparison.
  if (!literal || /^[<>=!]+$/.test(literal)) return undefined;
  return { component: match[1]!, field: match[2]!, operator: match[3]!, literal };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read `root` from a decision-tree spec without trusting its shape. */
export function readDecisionRoot(data: Record<string, unknown>): unknown {
  return data.root;
}

/** Structural validation: single composite root, unique ids, kind-specific fields. */
export function validateDecisionTree(root: unknown): DecisionTreeIssue[] {
  const issues: DecisionTreeIssue[] = [];
  if (!record(root) || !isNodeKind(root.kind) || !isComposite(root.kind)) {
    issues.push({ path: "root", code: "TREE_ROOT_INVALID", message: "Decision tree needs a composite root node" });
    return issues;
  }
  const ids = new Set<string>();
  const visit = (value: unknown, at: string, depth: number): void => {
    if (depth > 32) {
      issues.push({ path: at, code: "TREE_NODE_INVALID", message: "Decision tree is nested too deeply" });
      return;
    }
    if (!record(value)) {
      issues.push({ path: at, code: "TREE_NODE_INVALID", message: "Decision node must be a mapping" });
      return;
    }
    const kind = value.kind;
    if (!isNodeKind(kind)) {
      issues.push({ path: at, code: "TREE_NODE_INVALID", message: `Unknown decision node kind '${String(kind)}'` });
      return;
    }
    if (!isNodeId(value.id)) {
      issues.push({ path: at, code: "TREE_NODE_INVALID", message: "Decision node id must match [a-z][a-z0-9_]*" });
    } else if (ids.has(value.id)) {
      issues.push({ path: at, code: "TREE_NODE_DUPLICATE", message: `Decision node id '${value.id}' is used twice` });
    } else {
      ids.add(value.id);
    }
    if (value.title !== undefined && typeof value.title !== "string") {
      issues.push({ path: at, code: "TREE_NODE_INVALID", message: "Decision node title must be text" });
    }
    if (isComposite(kind)) {
      if (!Array.isArray(value.children) || value.children.length === 0) {
        issues.push({ path: at, code: "TREE_CHILDREN_INVALID", message: `Composite '${kind}' needs at least one child` });
      } else {
        value.children.forEach((child, index) => visit(child, `${at}.children[${index}]`, depth + 1));
      }
      return;
    }
    if (isDecorator(kind)) {
      if (!record(value.child)) {
        issues.push({ path: at, code: "TREE_CHILDREN_INVALID", message: `Decorator '${kind}' needs exactly one child` });
      } else {
        visit(value.child, `${at}.child`, depth + 1);
      }
      if (kind === "cooldown" && !(typeof value.seconds === "number" && Number.isFinite(value.seconds) && value.seconds > 0)) {
        issues.push({ path: at, code: "TREE_NODE_INVALID", message: "cooldown needs a positive seconds value" });
      }
      if (kind === "retry" && !(typeof value.count === "number" && Number.isInteger(value.count) && value.count >= 1)) {
        issues.push({ path: at, code: "TREE_NODE_INVALID", message: "retry needs an integer count >= 1" });
      }
      return;
    }
    if (kind === "condition") {
      if (value.owner !== undefined && !(typeof value.owner === "string" && NODE_ID.test(value.owner))) {
        issues.push({ path: at, code: "TREE_CONDITION_INVALID", message: "Condition owner must be an entity id" });
      }
      const hasComparator = value.comparator !== undefined;
      const hasEvent = value.event !== undefined;
      if (hasComparator === hasEvent) {
        issues.push({ path: at, code: "TREE_CONDITION_INVALID", message: "Condition needs exactly one of comparator or event" });
      } else if (hasEvent && value.owner !== undefined) {
        issues.push({ path: at, code: "TREE_CONDITION_INVALID", message: "Only comparator conditions can name an owner entity" });
      } else if (hasComparator && !parseComparator(value.comparator)) {
        issues.push({ path: at, code: "TREE_CONDITION_INVALID", message: "Comparator must look like component.field <= value" });
      } else if (hasEvent && !(typeof value.event === "string" && EVENT_NAME.test(value.event))) {
        issues.push({ path: at, code: "TREE_CONDITION_INVALID", message: "Event name must match [a-z][a-z0-9_]*" });
      }
      return;
    }
    if (kind === "action") {
      if (!(typeof value.action === "string" && EVENT_NAME.test(value.action))) {
        issues.push({ path: at, code: "TREE_ACTION_INVALID", message: "Action name must match [a-z][a-z0-9_]*" });
      }
      if (value.params !== undefined && !record(value.params)) {
        issues.push({ path: at, code: "TREE_NODE_INVALID", message: "Action params must be a mapping" });
      }
    }
  };
  visit(root, "root", 0);
  return issues;
}

/** Depth-first flatten used by the workspace; parents stay explicit. */
export function flattenDecisionTree(root: unknown): FlatDecisionNode[] {
  const flat: FlatDecisionNode[] = [];
  const visit = (value: unknown, parent: string | undefined, depth: number): void => {
    if (!record(value) || !isNodeKind(value.kind)) return;
    const node = value as unknown as DecisionNode;
    flat.push({ node, ...(parent ? { parent } : {}), depth });
    if (isComposite(node.kind)) for (const child of node.children ?? []) visit(child, node.id, depth + 1);
    else if (isDecorator(node.kind)) visit(node.child, node.id, depth + 1);
  };
  visit(root, undefined, 0);
  return flat;
}

/** Rebuild the nested structure from flattened nodes (workspace save path). */
export function buildDecisionTree(flat: { node: DecisionNode; parent?: string }[]): DecisionNode | undefined {
  const byId = new Map<string, DecisionNode>();
  for (const { node } of flat) {
    const copy: DecisionNode = { ...node };
    delete copy.children;
    delete copy.child;
    byId.set(node.id, copy);
  }
  let root: DecisionNode | undefined;
  for (const item of flat) {
    const node = byId.get(item.node.id);
    if (!node) continue;
    if (!item.parent || !byId.has(item.parent)) {
      if (!root) root = node;
      continue;
    }
    const parent = byId.get(item.parent)!;
    if (isComposite(parent.kind)) parent.children = [...(parent.children ?? []), node];
    else if (isDecorator(parent.kind) && !parent.child) parent.child = node;
  }
  for (const node of byId.values()) {
    if (isComposite(node.kind) && !node.children?.length) node.children = [];
    if (isDecorator(node.kind) && !node.child) { /* invalid trees are reported by validation */ }
  }
  return root;
}

/** Deep copy so workspace edits never mutate the parsed spec by accident. */
export function cloneDecisionNode(node: DecisionNode): DecisionNode {
  return {
    ...node,
    ...(node.children ? { children: node.children.map(cloneDecisionNode) } : {}),
    ...(node.child ? { child: cloneDecisionNode(node.child) } : {}),
    ...(node.params ? { params: { ...node.params } } : {}),
  };
}

export function findDecisionNode(root: DecisionNode, id: string): DecisionNode | undefined {
  if (root.id === id) return root;
  if (root.children) for (const child of root.children) { const found = findDecisionNode(child, id); if (found) return found; }
  if (root.child) return findDecisionNode(root.child, id);
  return undefined;
}

/** Insert a child under a composite or as the single child of a decorator. */
export function insertDecisionNode(root: DecisionNode, parentId: string, node: DecisionNode): DecisionNode {
  const next = cloneDecisionNode(root);
  const parent = findDecisionNode(next, parentId);
  if (!parent) return next;
  if (isComposite(parent.kind)) parent.children = [...(parent.children ?? []), cloneDecisionNode(node)];
  else if (isDecorator(parent.kind) && !parent.child) parent.child = cloneDecisionNode(node);
  return next;
}

/** Remove a node (and its subtree); the root itself cannot be removed. */
export function removeDecisionNode(root: DecisionNode, id: string): DecisionNode {
  const next = cloneDecisionNode(root);
  if (next.id === id) return next;
  const strip = (node: DecisionNode): void => {
    if (node.children) {
      node.children = node.children.filter((child) => child.id !== id);
      node.children.forEach(strip);
    }
    if (node.child && node.child.id === id) delete node.child;
    else if (node.child) strip(node.child);
  };
  strip(next);
  return next;
}

/** Patch one node; kind changes also clear fields the new kind cannot hold. */
export function updateDecisionNode(root: DecisionNode, id: string, patch: Partial<DecisionNode>): DecisionNode {
  const next = cloneDecisionNode(root);
  const node = findDecisionNode(next, id);
  if (!node) return next;
  Object.assign(node, patch);
  // comparator and event are mutually exclusive; an empty string clears the field.
  if (patch.comparator !== undefined) { delete node.event; if (!node.comparator) delete node.comparator; }
  if (patch.event !== undefined) { delete node.comparator; if (!node.event) delete node.event; }
  if (patch.owner !== undefined && !node.owner) delete node.owner;
  if (patch.kind !== undefined) {
    if (isComposite(node.kind)) {
      delete node.child;
      node.children = node.children ?? [];
    } else if (isDecorator(node.kind)) {
      delete node.children;
      delete node.comparator;
      delete node.event;
      delete node.action;
      delete node.params;
    } else if (isLeaf(node.kind)) {
      delete node.children;
      delete node.child;
      if (node.kind === "action") { delete node.comparator; delete node.event; }
      else { delete node.action; delete node.params; delete node.seconds; delete node.count; }
    }
  }
  return next;
}

/** Move a node among its siblings; `-1` moves up, `1` moves down. */
export function reorderDecisionNode(root: DecisionNode, id: string, direction: -1 | 1): DecisionNode {
  const next = cloneDecisionNode(root);
  const move = (node: DecisionNode): boolean => {
    if (node.children) {
      const index = node.children.findIndex((child) => child.id === id);
      if (index >= 0) {
        const target = index + direction;
        if (target < 0 || target >= node.children.length) return true;
        const [moved] = node.children.splice(index, 1);
        node.children.splice(target, 0, moved!);
        return true;
      }
      for (const child of node.children) if (move(child)) return true;
    }
    return Boolean(node.child && move(node.child));
  };
  move(next);
  return next;
}

