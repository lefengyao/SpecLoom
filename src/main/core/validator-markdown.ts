import { parseDocument } from "yaml";
import { TaskScopeSpecSchema, type ValidationDiagnostic } from "../../shared/contracts";
import { StateMachineSchema } from "../../shared/state-machine";
import { TaskScope } from "./task-scope";

export type SpecData = Record<string, unknown>;
export interface ParsedSpec { path: string; data: SpecData }
export const ENTITY_TYPES = ["entity", "character", "enemy", "map", "system", "item", "event"] as const;
export const ENTITY_FOLDERS: Record<string, string> = {
  character: "characters",
  enemy: "enemies",
  map: "maps",
  system: "systems",
  item: "items",
  event: "events",
};
export const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
export const record = (value: unknown): value is SpecData => value !== null && typeof value === "object" && !Array.isArray(value);

export function validReference(value: unknown, componentBinding = false): boolean {
  if (nonempty(value)) return true;
  if (!record(value)) return false;
  const keys = ["id", "path", "type", "version", ...(componentBinding ? ["values", "notes"] : [])];
  return Object.keys(value).every((key) => keys.includes(key))
    && ((nonempty(value.id) && value.path === undefined) || (nonempty(value.path) && value.id === undefined))
    && (value.type === undefined || nonempty(value.type))
    && (!componentBinding || value.values === undefined || record(value.values))
    && (!componentBinding || value.notes === undefined || (Array.isArray(value.notes) && value.notes.length <= 32 && value.notes.every((note) => nonempty(note) && note.trim().length <= 2000)));
}

export function componentValueMatches(type: unknown, value: unknown): boolean {
  return type === "number" ? typeof value === "number" && Number.isFinite(value)
    : type === "string" ? typeof value === "string"
    : type === "boolean" && typeof value === "boolean";
}

export function validationPathIdentity(relative: string): string {
  return process.platform === "win32" ? relative.toLowerCase() : relative;
}

export function diagnostic(path: string, code: string, message: string): ValidationDiagnostic {
  return { path, code, message, severity: "error" };
}

export function parseSpec(relative: string, content: string, diagnostics: ValidationDiagnostic[]): ParsedSpec | undefined {
  const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!match) {
    diagnostics.push(diagnostic(relative, "FRONTMATTER_MISSING", "Specification requires YAML front matter"));
    return undefined;
  }
  try {
    const document = parseDocument(match[1]!, { uniqueKeys: true });
    if (document.errors.length) throw new Error(document.errors[0]!.message);
    const data: unknown = document.toJS({ maxAliasCount: 20 });
    if (!record(data)) throw new Error("Front matter must be a mapping");
    return { path: relative, data };
  } catch {
    diagnostics.push(diagnostic(relative, "FRONTMATTER_INVALID", "Front matter is not a valid YAML mapping"));
    return undefined;
  }
}

export function validateFields(spec: ParsedSpec, diagnostics: ValidationDiagnostic[]): void {
  const { path, data } = spec;
  const identity = validationPathIdentity(path);
  const field = (key: string, valid: boolean) => { if (!valid) diagnostics.push(diagnostic(path, "SPEC_FIELD_INVALID", `Field '${key}' is missing or invalid`)); };
  if (data.scope !== undefined && data.type !== "component") field("scope", false);
  field("id", nonempty(data.id));
  if (data.stateMachine !== undefined) {
    const allowed = identity.startsWith("specs/entities/") && data.type !== "map";
    const parsed = allowed ? StateMachineSchema.safeParse(data.stateMachine) : undefined;
    if (!parsed?.success) {
      const message = allowed
        ? parsed?.error.issues[0]?.message ?? "State machine configuration is invalid"
        : "State machine configuration is only allowed on entity specifications";
      diagnostics.push(diagnostic(path, "STATE_MACHINE_INVALID", message));
    }
  }
  if (data.parent !== undefined) field("parent", validReference(data.parent));
  const newMap = identity.startsWith("specs/maps/");
  if (identity.startsWith("specs/entities/") || newMap) {
    const validType = newMap ? data.type === "map" : ENTITY_TYPES.includes(data.type as typeof ENTITY_TYPES[number]);
    if (!validType) diagnostics.push(diagnostic(path, "ENTITY_TYPE_INVALID", newMap ? "Map type must be map" : `Entity type must be one of ${ENTITY_TYPES.join(", ")}`));
    if (nonempty(data.id)) {
      const segments = identity.split("/");
      const filenameId = segments[segments.length - 1]!.slice(0, -3);
      const validLayout = newMap
        ? segments.length === 3 && filenameId === validationPathIdentity(data.id)
        : segments.length >= 3 && filenameId === validationPathIdentity(data.id);
      if (!validLayout) {
        diagnostics.push(diagnostic(path, "ENTITY_LAYOUT_INVALID", newMap ? "Map specifications must use specs/maps/<id>.md" : "Entity specifications must use specs/entities/**/<id>.md"));
      }
    }
    if (data.type === "entity") {
      field("schemaVersion", data.schemaVersion === 1);
      field("title", nonempty(data.title));
      field("description", typeof data.description === "string");
    }
    if (data.type !== "entity" || data.status !== undefined) field("status", nonempty(data.status));
    if (data.type !== "entity" || data.version !== undefined) field("version", nonempty(data.version) || (typeof data.version === "number" && Number.isSafeInteger(data.version) && data.version > 0));
    if (data.type !== "entity" || data.relations !== undefined) field("relations", Array.isArray(data.relations) && data.relations.every((value) => validReference(value)));
    if (data.type !== "entity" || data.source !== undefined) field("source", nonempty(data.source) || (Array.isArray(data.source) && data.source.every((value) => validReference(value))) || validReference(data.source));
    if (data.extends !== undefined) field("extends", validReference(data.extends));
    if (data.components !== undefined) field("components", Array.isArray(data.components) && data.components.every((value) => validReference(value, true)));
  } else if (identity.startsWith("specs/components/")) {
    if (data.type !== "component") diagnostics.push(diagnostic(path, "SPEC_TYPE_INVALID", "Specification type must be component"));
    const segments = identity.split("/");
    if (segments.length !== 3 || !nonempty(data.id) || segments[2]!.slice(0, -3) !== validationPathIdentity(data.id)) {
      diagnostics.push(diagnostic(path, "SPEC_LAYOUT_INVALID", "Component specifications must use specs/components/<id>.md"));
    }
    field("schemaVersion", data.schemaVersion === 1);
    field("title", nonempty(data.title));
    field("description", typeof data.description === "string");
    if (data.notes !== undefined) field("notes", Array.isArray(data.notes) && data.notes.length <= 32 && data.notes.every((note) => typeof note === "string" && note.length <= 2000));
    if (data.scope !== undefined) field("scope", data.scope === "system" || data.scope === "user");
    if (data.extends !== undefined) field("extends", validReference(data.extends));
    field("fields", Array.isArray(data.fields));
    const keys = new Set<string>();
    for (const [index, value] of (Array.isArray(data.fields) ? data.fields : []).entries()) {
      const validKey = record(value) && nonempty(value.key) && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value.key) && !["__proto__", "prototype", "constructor"].includes(value.key);
      field(`fields[${index}]`, record(value) && validKey && (value.label === undefined || typeof value.label === "string") && componentValueMatches(value.type, value.default));
      if (validKey && record(value) && nonempty(value.key)) {
        if (keys.has(value.key)) diagnostics.push(diagnostic(path, "COMPONENT_FIELD_DUPLICATE", `Component field '${value.key}' is already defined`));
        keys.add(value.key);
      }
    }
  } else if (identity.startsWith("specs/settings/") || identity.startsWith("specs/ui/")) {
    const type = identity.startsWith("specs/settings/") ? "setting" : "ui";
    if (data.type !== type) diagnostics.push(diagnostic(path, "SPEC_TYPE_INVALID", `Specification type must be ${type}`));
    const segments = identity.split("/");
    const filenameId = segments[segments.length - 1]!.slice(0, -3);
    if (segments.length !== 3 || !nonempty(data.id) || filenameId !== validationPathIdentity(data.id)) {
      diagnostics.push(diagnostic(path, "SPEC_LAYOUT_INVALID", `Specification must use specs/${segments[1]}/<id>.md`));
    }
    field("schemaVersion", data.schemaVersion === 1);
    field("title", nonempty(data.title));
    field("description", typeof data.description === "string");
  } else if (/^specs\/[^/]+\.md$/i.test(identity)) {
    field("schemaVersion", data.schemaVersion === 1);
    field("title", nonempty(data.title));
    field("description", typeof data.description === "string");
  } else if (identity.startsWith("specs/tasks/")) {
    const candidate = {
      id: data.id, title: data.title, readPaths: data.readPaths, writePaths: data.writePaths,
      ...(data.allowDelete === undefined ? {} : { allowDelete: data.allowDelete }),
      ...(data.mode === undefined ? {} : { mode: data.mode }),
    };
    const parsed = TaskScopeSpecSchema.safeParse(candidate);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) field(String(issue.path[0] ?? "task"), false);
    } else {
      try { new TaskScope(parsed.data); } catch { diagnostics.push(diagnostic(path, "TASK_SCOPE_INVALID", "Task readPaths and writePaths must use safe project paths")); }
    }
    if (data.inputs !== undefined) field("inputs", Array.isArray(data.inputs));
    if (data.smokeScene !== undefined) field("smokeScene", nonempty(data.smokeScene));
  }
}

export function projectBudgets(project: ParsedSpec | undefined, diagnostics: ValidationDiagnostic[]): { maxScriptLines: number; maxSceneNodes: number } {
  const budgets = { maxScriptLines: 250, maxSceneNodes: 80 };
  if (project?.data.constraints === undefined) return budgets;
  if (!record(project.data.constraints)) {
    diagnostics.push(diagnostic(project.path, "PROJECT_CONSTRAINT_INVALID", "Project constraints must be a mapping"));
    return budgets;
  }
  for (const key of ["maxScriptLines", "maxSceneNodes"] as const) {
    const value = project.data.constraints[key];
    if (value === undefined) continue;
    const maximum = key === "maxScriptLines" ? 10000 : 1000;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
      diagnostics.push(diagnostic(project.path, "PROJECT_CONSTRAINT_INVALID", `${key} must be an integer between 1 and ${maximum}`));
    } else budgets[key] = value;
  }
  return budgets;
}
