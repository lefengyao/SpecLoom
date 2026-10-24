import { readFields, type ComponentField } from "./project-materials";
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

function normalizeReference(value: string): string {
  return value.trim().replace(/^res:\/\//i, "").replaceAll("\\", "/").toLowerCase().replace(/\.md$/, "");
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

export function resolveComponentFields(definitions: readonly ComponentDefinition[], start: ComponentDefinition): ResolvedComponentFields {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const byPath = new Map(definitions.map((definition) => [normalizeReference(definition.path), definition]));
  const chain: ComponentDefinition[] = [];
  const visited = new Set<string>();
  let current: ComponentDefinition | undefined = start;
  while (current) {
    const identity = normalizeReference(current.path);
    if (visited.has(identity)) return { fields: mergeComponentFieldLists(chain.map((definition) => readFields(definition.data))), chain, cycle: true };
    visited.add(identity);
    chain.unshift(current);
    const reference = referenceId(current.data.extends);
    if (!reference) break;
    const base = byId.get(reference) ?? byPath.get(normalizeReference(reference));
    if (!base) return { fields: mergeComponentFieldLists(chain.map((definition) => readFields(definition.data))), chain, missing: reference };
    current = base;
  }
  return { fields: mergeComponentFieldLists(chain.map((definition) => readFields(definition.data))), chain };
}

/** Replace each component summary's fields with its inherited, effective field list. */
export function withInheritedComponentFields(items: MaterialSummary[]): MaterialSummary[] {
  const definitions = items
    .filter((item) => categoryForPath(item.path) === "component" && !item.invalid)
    .map((item): ComponentDefinition => ({ path: item.path, id: item.id, data: { extends: item.extends, fields: item.fields } }));
  const byPath = new Map(definitions.map((definition) => [normalizeReference(definition.path), definition]));
  return items.map((item) => {
    if (categoryForPath(item.path) !== "component" || item.invalid) return item;
    const definition = byPath.get(normalizeReference(item.path));
    return definition ? { ...item, fields: resolveComponentFields(definitions, definition).fields } : item;
  });
}
