import { parseMaterial, readAnchors, readBindings, readFields, type ComponentAnchor, type ComponentBinding, type ComponentField } from "./project-materials";
import { materialGroupPath, normalizeMaterialGroups, resolveLegacyGroup, type MaterialGroupRegistry } from "./material-groups";

export type DocumentCategory = "all" | "entity" | "component" | "setting" | "map" | "ui" | "spec";
export interface MaterialSummary {
  id: string; title: string; type: string; path: string; version: string; content: string;
  description?: string; group?: string; groupId?: string; groupPath?: string; scope?: ComponentScope; image?: string; parent?: string; extends?: string;
  fields: ComponentField[]; components: ComponentBinding[]; anchors?: ComponentAnchor[]; invalid?: boolean;
}
export type ComponentScope = "system" | "user";
export const componentScopeLabels: Record<ComponentScope, string> = { system: "官方组件", user: "自定义组件" };

/** Built-in identity is independent of editable front matter and display groups. */
const builtinComponents = [{ id: "state_machine", path: "specs/components/state_machine.md" }] as const;

/**
 * Classify component definitions for the component library UI.
 *
 * Recognize the built-in file, including older projects without scope metadata.
 * An editable scope/group or a copied ID is not evidence of official origin.
 */
export function componentScope(item: Pick<MaterialSummary, "id" | "type" | "path">): ComponentScope {
  const identity = item.path.replaceAll("\\", "/").toLowerCase();
  if (item.type === "component" && builtinComponents.some((builtin) => item.id === builtin.id && identity === builtin.path)) return "system";
  return "user";
}
export const categoryLabels: Record<DocumentCategory, string> = {
  all: "项目文件", entity: "实体", component: "组件", setting: "设定", map: "地图", ui: "UI", spec: "规范",
};
export const categoryRoots: Record<Exclude<DocumentCategory, "all">, string[]> = {
  entity: ["specs/entities"], component: ["specs/components"], setting: ["specs/settings"],
  map: ["specs/maps", "specs/entities/maps"], ui: ["specs/ui"], spec: ["specs"],
};
export function categoryForPath(path: string): Exclude<DocumentCategory, "all"> | undefined {
  const identity = path.replaceAll("\\", "/").toLowerCase();
  if (identity.startsWith("specs/maps/") || identity.startsWith("specs/entities/maps/")) return "map";
  if (identity.startsWith("specs/entities/")) return "entity";
  if (identity.startsWith("specs/components/")) return "component";
  if (identity.startsWith("specs/settings/")) return "setting";
  if (identity.startsWith("specs/ui/")) return "ui";
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
    }) : [] }), ...(!valid ? { invalid: true } : {}),
  };
}
