import { parseDocument } from "yaml";
import { TaskScopeSpecSchema, type ValidationDiagnostic } from "../../shared/contracts";
import { TaskScope } from "./task-scope";

export type SpecData = Record<string, unknown>;
export interface ParsedSpec { path: string; data: SpecData }
export const ENTITY_TYPES = ["character", "map", "system", "item", "event"] as const;
export const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
export const record = (value: unknown): value is SpecData => value !== null && typeof value === "object" && !Array.isArray(value);

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
  const field = (key: string, valid: boolean) => { if (!valid) diagnostics.push(diagnostic(path, "SPEC_FIELD_INVALID", `Field '${key}' is missing or invalid`)); };
  field("id", nonempty(data.id));
  if (path.startsWith("specs/entities/")) {
    if (!ENTITY_TYPES.includes(data.type as typeof ENTITY_TYPES[number])) diagnostics.push(diagnostic(path, "ENTITY_TYPE_INVALID", `Entity type must be one of ${ENTITY_TYPES.join(", ")}`));
    field("status", nonempty(data.status));
    field("version", nonempty(data.version) || (typeof data.version === "number" && Number.isSafeInteger(data.version) && data.version > 0));
    field("relations", Array.isArray(data.relations));
    field("source", nonempty(data.source) || Array.isArray(data.source) || (record(data.source) && (nonempty(data.source.path) || nonempty(data.source.id))));
  } else if (path === "specs/project.md" || path === "specs/outline.md") {
    field("schemaVersion", data.schemaVersion === 1);
    field("title", nonempty(data.title));
    field("description", typeof data.description === "string");
  } else if (path.startsWith("specs/tasks/")) {
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
