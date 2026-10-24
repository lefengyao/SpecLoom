import type { DocumentCategory } from "./material-catalog";

export type MaterialGroupCategory = Exclude<DocumentCategory, "all">;

export interface MaterialGroup {
  id: string;
  name: string;
  parentId?: string;
  /** Original flat label, retained to resolve materials that still store `group`. */
  legacyName?: string;
  order: number;
}

export type MaterialGroupRegistry = Partial<Record<MaterialGroupCategory, MaterialGroup[]>>;

export const materialGroupCategories: MaterialGroupCategory[] = ["entity", "component", "setting", "map", "ui", "system", "feature", "decision", "spec"];
const categories = materialGroupCategories;

function stableLegacyId(category: MaterialGroupCategory, name: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (const character of name) {
    const point = character.codePointAt(0)!;
    first = Math.imul(first ^ point, 0x01000193);
    second = Math.imul(second ^ (point + (first >>> 16)), 0x85ebca6b);
  }
  const hash = `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
  return `legacy_${category}_${hash}`;
}

export function importLegacyGroups(category: MaterialGroupCategory, labels: string[]): MaterialGroup[] {
  const names = [...new Set(labels.map((label) => label.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
  return names.map((name, order) => ({ id: stableLegacyId(category, name), name, legacyName: name, order }));
}

/** Add legacy text labels as deterministic roots while preserving existing groups and IDs. */
export function importMissingLegacyGroups(
  registry: unknown,
  labels: Partial<Record<MaterialGroupCategory, string[]>>,
): MaterialGroupRegistry {
  const result = normalizeMaterialGroups(registry);
  for (const category of categories) {
    const current = result[category] ?? [];
    if (!Object.hasOwn(result, category) && !(labels[category]?.length)) continue;
    const rootLabels = new Set(current.filter((group) => !group.parentId).flatMap((group) => [group.name, group.legacyName].filter((label): label is string => Boolean(label))));
    const missing = (labels[category] ?? []).map((label) => label.trim()).filter((label) => label && !rootLabels.has(label));
    result[category] = [...current, ...importLegacyGroups(category, missing)];
  }
  return result;
}

/** Normalize parsed project front matter without sharing mutable arrays with the editor. */
export function normalizeMaterialGroups(value: unknown): MaterialGroupRegistry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: MaterialGroupRegistry = {};
  for (const category of categories) {
    const raw = (value as Record<string, unknown>)[category];
    if (!Array.isArray(raw)) continue;
    result[category] = raw.flatMap((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const group = entry as Record<string, unknown>;
      if (typeof group.id !== "string" || !group.id.trim() || typeof group.name !== "string") return [];
      return [{
        id: group.id,
        name: group.name,
        ...(typeof group.parentId === "string" && group.parentId ? { parentId: group.parentId } : {}),
        ...(typeof group.legacyName === "string" ? { legacyName: group.legacyName } : {}),
        order: typeof group.order === "number" && Number.isFinite(group.order) ? group.order : index,
      }];
    });
  }
  return result;
}

/** Validate raw front matter before normalization so malformed nodes cannot disappear silently. */
export function validateMaterialGroupRegistry(value: unknown): string[] {
  if (value === undefined) return [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["GROUP_REGISTRY_INVALID"];

  const errors = new Set<string>();
  const registry = value as Record<string, unknown>;
  for (const category of Object.keys(registry)) {
    if (!categories.includes(category as MaterialGroupCategory)) errors.add("GROUP_CATEGORY_INVALID");
  }
  for (const category of categories) {
    if (!Object.hasOwn(registry, category)) continue;
    const raw = registry[category];
    if (!Array.isArray(raw)) {
      errors.add("GROUP_CATEGORY_INVALID");
      continue;
    }
    const groups: MaterialGroup[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        errors.add("GROUP_NODE_INVALID");
        continue;
      }
      const group = entry as Record<string, unknown>;
      if (typeof group.id !== "string" || !group.id.trim() || typeof group.name !== "string"
        || (group.parentId !== undefined && typeof group.parentId !== "string")
        || (group.legacyName !== undefined && typeof group.legacyName !== "string")
        || typeof group.order !== "number" || !Number.isFinite(group.order)) {
        errors.add("GROUP_NODE_INVALID");
        continue;
      }
      groups.push({
        id: group.id,
        name: group.name,
        ...(group.parentId ? { parentId: group.parentId as string } : {}),
        ...(typeof group.legacyName === "string" ? { legacyName: group.legacyName } : {}),
        order: group.order,
      });
    }
    for (const error of validateMaterialGroups(groups)) errors.add(error);
  }
  return [...errors];
}

export function resolveLegacyGroup(groups: MaterialGroup[], label: string): MaterialGroup | undefined {
  return groups.find((group) => !group.parentId && (group.legacyName === label || (!group.legacyName && group.name === label)));
}

export function materialGroupPath(groups: MaterialGroup[], id: string): string {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const names: string[] = [];
  const visited = new Set<string>();
  let current = byId.get(id);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    names.unshift(current.name);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return names.join(" / ");
}

export function groupIncludes(groups: MaterialGroup[], selectedGroupId: string, candidateGroupId: string): boolean {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const visited = new Set<string>();
  let current = byId.get(candidateGroupId);
  while (current && !visited.has(current.id)) {
    if (current.id === selectedGroupId) return true;
    visited.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return false;
}

export function validateMaterialGroups(groups: MaterialGroup[]): string[] {
  const errors = new Set<string>();
  const byId = new Map<string, MaterialGroup>();
  for (const group of groups) {
    if (!group.id.trim() || byId.has(group.id)) errors.add("GROUP_ID_DUPLICATE");
    if (group.id.length > 200) errors.add("GROUP_ID_TOO_LONG");
    else byId.set(group.id, group);
    const name = group.name.trim();
    if (!name) errors.add("GROUP_NAME_EMPTY");
    if (name.length > 100) errors.add("GROUP_NAME_TOO_LONG");
    if ((name.includes("/") || name.includes("\\")) && group.legacyName !== name) errors.add("GROUP_NAME_SEPARATOR");
    if (!Number.isFinite(group.order)) errors.add("GROUP_ORDER_INVALID");
  }
  const siblings = new Set<string>();
  for (const group of groups) {
    if (group.parentId && !byId.has(group.parentId)) errors.add("GROUP_PARENT_MISSING");
    const parent = group.parentId ?? "";
    const name = group.name.trim().toLocaleLowerCase();
    const siblingKey = `${parent}\u0000${name}`;
    if (name && siblings.has(siblingKey)) errors.add("GROUP_DUPLICATE_SIBLING");
    siblings.add(siblingKey);
  }
  for (const group of groups) {
    const visited = new Set<string>();
    let current: MaterialGroup | undefined = group;
    while (current) {
      if (visited.has(current.id)) {
        errors.add("GROUP_CYCLE");
        break;
      }
      visited.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
  }
  return [...errors];
}
