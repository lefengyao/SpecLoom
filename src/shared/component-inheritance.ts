import { readAnchors, readFields, type ComponentAnchor, type ComponentField } from "./project-materials";
import { categoryForPath, referenceId, type MaterialSummary } from "./material-catalog";

/** One component specification, used to resolve definition-level inheritance. */
export interface ComponentDefinition {
  path: string;
  id: string;
  data: Record<string, unknown>;
}

export interface ResolvedComponentFields {
  fields: ComponentField[];
  chain: ComponentDefinition[];
  cycle?: boolean;
  missing?: string;
}

export interface ResolvedComponentAnchors {
  anchors: ComponentAnchor[];
  chain: ComponentDefinition[];
  cycle?: boolean;
  missing?: string;
}

interface ComponentChain {
  chain: ComponentDefinition[];
  cycle?: boolean;
  missing?: string;
}

function normalizeReference(value: string): string {
  return value.trim().replace(/^res:\/\//i, "").replaceAll("\\", "/").toLowerCase().replace(/\.md$/, "");
}

/** Base-first chain from the root definition down to `start`; cycles and missing bases are flagged. */
function componentChain(definitions: readonly ComponentDefinition[], start: ComponentDefinition): ComponentChain {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const byPath = new Map(definitions.map((definition) => [normalizeReference(definition.path), definition]));
  const chain: ComponentDefinition[] = [];
  const visited = new Set<string>();
  let current: ComponentDefinition | undefined = start;
  while (current) {
    const identity = normalizeReference(current.path);
    if (visited.has(identity)) return { chain, cycle: true };
    visited.add(identity);
    chain.unshift(current);
    const reference = referenceId(current.data.extends);
    if (!reference) break;
    const base = byId.get(reference) ?? byPath.get(normalizeReference(reference));
    if (!base) return { chain, missing: reference };
    current = base;
  }
  return { chain };
}

/** Base-first merge; a derived field with the same key replaces the base field in place. */
export function mergeComponentFieldLists(lists: readonly (readonly ComponentField[])[]): ComponentField[] {
  const order: string[] = [];
  const byKey = new Map<string, ComponentField>();
  for (const fields of lists) for (const field of fields) {
    if (!byKey.has(field.key)) order.push(field.key);
    byKey.set(field.key, field);
  }
  return order.map((key) => byKey.get(key)!);
}

/** Base-first merge; a derived anchor with the same name replaces the base anchor in place. */
export function mergeComponentAnchorLists(lists: readonly (readonly ComponentAnchor[])[]): ComponentAnchor[] {
  const order: string[] = [];
  const byName = new Map<string, ComponentAnchor>();
  for (const anchors of lists) for (const anchor of anchors) {
    if (!byName.has(anchor.name)) order.push(anchor.name);
    byName.set(anchor.name, anchor);
  }
  return order.map((name) => byName.get(name)!);
}

export function resolveComponentFields(definitions: readonly ComponentDefinition[], start: ComponentDefinition): ResolvedComponentFields {
  const { chain, cycle, missing } = componentChain(definitions, start);
  const fields = mergeComponentFieldLists(chain.map((definition) => readFields(definition.data)));
  return { fields, chain, ...(cycle ? { cycle } : {}), ...(missing ? { missing } : {}) };
}

/** Anchors are part of the component contract, so they inherit along `extends` just like fields. */
export function resolveComponentAnchors(definitions: readonly ComponentDefinition[], start: ComponentDefinition): ResolvedComponentAnchors {
  const { chain, cycle, missing } = componentChain(definitions, start);
  const anchors = mergeComponentAnchorLists(chain.map((definition) => readAnchors(definition.data)));
  return { anchors, chain, ...(cycle ? { cycle } : {}), ...(missing ? { missing } : {}) };
}

/** Replace each component summary's fields and anchors with the inherited, effective lists. */
export function withInheritedComponentFields(items: MaterialSummary[]): MaterialSummary[] {
  const definitions = items
    .filter((item) => categoryForPath(item.path) === "component" && !item.invalid)
    .map((item): ComponentDefinition => ({ path: item.path, id: item.id, data: { extends: item.extends, fields: item.fields, anchors: item.anchors } }));
  const byPath = new Map(definitions.map((definition) => [normalizeReference(definition.path), definition]));
  return items.map((item) => {
    if (categoryForPath(item.path) !== "component" || item.invalid) return item;
    const definition = byPath.get(normalizeReference(item.path));
    if (!definition) return item;
    return { ...item, fields: resolveComponentFields(definitions, definition).fields, anchors: resolveComponentAnchors(definitions, definition).anchors };
  });
}
