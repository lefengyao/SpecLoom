import { parseMaterial, readAnchors, readBindings, readFields, type ComponentAnchor, type ComponentBinding, type ComponentField } from "./project-materials";
import { materialGroupPath, normalizeMaterialGroups, resolveLegacyGroup, type MaterialGroupRegistry } from "./material-groups";

export type DocumentCategory = "all" | "entity" | "component" | "setting" | "map" | "ui" | "system" | "feature" | "decision" | "decision_tree" | "spec";
export interface MaterialSummary {
  id: string; title: string; type: string; path: string; version: string; content: string;
  description?: string; group?: string; groupId?: string; groupPath?: string; scope?: ComponentScope; image?: string; parent?: string; extends?: string;
  fields: ComponentField[]; components: ComponentBinding[]; anchors?: ComponentAnchor[]; invalid?: boolean;
  /** Instance bindings on a system, plus the reference lists used for reverse lookups. */
  mounts?: ComponentBinding[];
  uses?: string[];
  systems?: string[];
  affectedSystems?: string[];
  treeComponents?: string[];
  /** Signals an entity or system declares, so decision trees can wait on them. */
  signals?: string[];
  /** Signal source ids a decision tree listens to. */
  treeSignals?: string[];
}
export type ComponentScope = "system" | "user";
export const componentScopeLabels: Record<ComponentScope, string> = { system: "官方组件", user: "自定义组件" };

/** Built-in identity is independent of editable front matter and display groups. */
const builtinComponents = [{ id: "state_machine", path: "specs/components/state_machine.md" }, { id: "decision_tree", path: "specs/components/decision_tree.md" }] as const;

/**
 * Classify component definitions for the component library UI.
 *
 * Recognize the built-in file, including older projects without scope metadata.
 * An editable scope/group or a copied ID is not evidence of official origin.
 */
export function componentScope(item: Pick<MaterialSummary, "id" | "type" | "path" | "scope">): ComponentScope {
  const identity = item.path.replaceAll("\\", "/").toLowerCase();
  if (item.type === "component" && builtinComponents.some((builtin) => item.id === builtin.id && identity === builtin.path)) return "system";
  return "user";
}

/**
 * Official means the material is part of the shipped baseline. Components are
 * judged by their shipped path (a copied component may keep `scope: system`),
 * other kinds by their explicit scope.
 */
export function materialScope(item: Pick<MaterialSummary, "id" | "type" | "path" | "scope">): ComponentScope {
  if (item.type === "component") return componentScope(item);
  return item.scope === "system" ? "system" : "user";
}
export const categoryLabels: Record<DocumentCategory, string> = {
  all: "项目文件", entity: "实体", component: "组件", setting: "设定", map: "地图", ui: "UI",
  system: "系统", feature: "功能", decision: "架构决策", decision_tree: "决策树", spec: "规范",
};
export const categoryRoots: Record<Exclude<DocumentCategory, "all">, string[]> = {
  entity: ["specs/entities"], component: ["specs/components"], setting: ["specs/settings"],
  map: ["specs/maps", "specs/entities/maps"], ui: ["specs/ui"],
  system: ["specs/systems"], feature: ["specs/features"], decision: ["specs/decisions"], decision_tree: ["specs/decision_trees"],
  spec: ["specs"],
};
export function categoryForPath(path: string): Exclude<DocumentCategory, "all"> | undefined {
  const identity = path.replaceAll("\\", "/").toLowerCase();
  if (identity.startsWith("specs/maps/") || identity.startsWith("specs/entities/maps/")) return "map";
  if (identity.startsWith("specs/entities/")) return "entity";
  if (identity.startsWith("specs/components/")) return "component";
  if (identity.startsWith("specs/settings/")) return "setting";
  if (identity.startsWith("specs/ui/")) return "ui";
  if (identity.startsWith("specs/systems/")) return "system";
  if (identity.startsWith("specs/features/")) return "feature";
  if (identity.startsWith("specs/decisions/")) return "decision";
  if (identity.startsWith("specs/decision_trees/")) return "decision_tree";
  if (identity.startsWith("specs/")) return "spec";
  return undefined;
}
export function referenceId(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const reference = value as Record<string, unknown>;
    const target = reference.id ?? reference.path;
    if (typeof target === "string" && target.trim()) return target.trim();
  }
  return undefined;
}

function stringList(value: unknown[]): string[] {
  return value.map((item) => referenceId(item)).filter((item): item is string => Boolean(item));
}

/** Component ids a decision tree compares against, so components can list the trees using them. */
function treeComponentReferences(root: unknown): string[] {
  const ids = new Set<string>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    const record = node as Record<string, unknown>;
    if (typeof record.comparator === "string") {
      const match = /^([a-z][a-z0-9_]*)\./.exec(record.comparator.trim());
      if (match) ids.add(match[1]!);
    }
    if (Array.isArray(record.children)) for (const child of record.children) visit(child);
    visit(record.child);
  };
  visit(root);
  return [...ids];
}

/** Signal sources a decision tree waits on, so entities and systems can list their listeners. */
function treeSignalSources(root: unknown): string[] {
  const ids = new Set<string>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    const record = node as Record<string, unknown>;
    const signal = record.signal;
    if (signal && typeof signal === "object" && !Array.isArray(signal) && typeof (signal as { from?: unknown }).from === "string") {
      ids.add(String((signal as { from: string }).from));
    }
    if (Array.isArray(record.children)) for (const child of record.children) visit(child);
    visit(record.child);
  };
  visit(root);
  return [...ids];
}
export function summarizeMaterial(file: { path: string; version: string; content: string }, registry?: MaterialGroupRegistry): MaterialSummary {
  const parsed = parseMaterial(file.content); const data = parsed?.data;
  const valid = typeof data?.id === "string" && data.id.trim();
  const parent = referenceId(data?.parent); const base = referenceId(data?.extends);
  const heading = /^#\s+(.+)$/m.exec(parsed?.body ?? file.content)?.[1];
  const category = categoryForPath(file.path);
  const categoryGroups = category && registry ? normalizeMaterialGroups(registry)[category] ?? [] : [];
  const storedGroupId = typeof data?.groupId === "string" ? data.groupId : undefined;
  const storedGroup = typeof data?.group === "string" && data.group.trim() ? data.group.trim() : undefined;
  const resolvedGroupId = storedGroupId && categoryGroups.some((group) => group.id === storedGroupId)
    ? storedGroupId
    : storedGroup ? resolveLegacyGroup(categoryGroups, storedGroup)?.id : undefined;
  const groupPath = resolvedGroupId ? materialGroupPath(categoryGroups, resolvedGroupId) : "";
  const group = groupPath ? categoryGroups.find((item) => item.id === resolvedGroupId)?.name : storedGroup;
  return {
    ...file, id: valid ? String(data.id) : file.path,
    title: !valid ? file.path.split("/").pop() ?? file.path : typeof data?.title === "string" && data.title.trim() ? data.title : heading ?? file.path.split("/").pop() ?? file.path,
    type: typeof data?.type === "string" ? data.type : categoryForPath(file.path) ?? "spec",
    ...(typeof data?.description === "string" ? { description: data.description } : {}),
    ...(group ? { group } : {}),
    ...(resolvedGroupId ? { groupId: resolvedGroupId } : {}),
    ...(groupPath ? { groupPath } : {}),
    ...(data?.scope === "system" || data?.scope === "user" ? { scope: data.scope } : {}),
    ...(typeof data?.image === "string" ? { image: data.image } : {}),
    ...(parent ? { parent } : {}), ...(base ? { extends: base } : {}),
    fields: readFields(data ?? {}), anchors: readAnchors(data ?? {}), components: readBindings({ components: Array.isArray(data?.components) ? data.components.map((item) => {
      const id = referenceId(item);
      return item && typeof item === "object" && !Array.isArray(item) ? { ...item, id } : item;
    }) : [] }),
    ...(category === "system" ? { mounts: readBindings({ components: Array.isArray(data?.mounts) ? data.mounts : [] }) } : {}),
    ...(category === "system" && Array.isArray(data?.components) ? { uses: stringList(data.components) } : {}),
    ...(category === "feature" && Array.isArray(data?.systems) ? { systems: stringList(data.systems) } : {}),
    ...(category === "decision" && Array.isArray(data?.affectedSystems) ? { affectedSystems: stringList(data.affectedSystems) } : {}),
    ...(category === "decision_tree" ? { treeComponents: treeComponentReferences(data?.root), treeSignals: treeSignalSources(data?.root) } : {}),
    ...((category === "entity" || category === "system") && Array.isArray(data?.signals) ? { signals: stringList(data.signals) } : {}),
    ...(!valid ? { invalid: true } : {}),
  };
}
