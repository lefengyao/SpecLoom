import { parseDocument, stringify } from "yaml";

export type ComponentValue = number | string | boolean;
export interface ComponentField {
  key: string;
  label?: string;
  type: "number" | "string" | "boolean";
  default: ComponentValue;
}
export interface ComponentBinding { id: string; values: Record<string, ComponentValue> }
export interface MaterialDocument { data: Record<string, unknown>; body: string }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function componentValue(value: unknown): value is ComponentValue {
  return typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

export function parseMaterial(content: string): MaterialDocument | undefined {
  const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!match) return undefined;
  try {
    const document = parseDocument(match[1]!, { uniqueKeys: true });
    if (document.errors.length) return undefined;
    const data: unknown = document.toJS({ maxAliasCount: 20 });
    return record(data) ? { data, body: content.slice(match[0].length) } : undefined;
  } catch {
    return undefined;
  }
}

export function writeMaterial(data: Record<string, unknown>, body: string): string {
  return `---\n${stringify(data)}---\n${body}`;
}

/** Normalize valid definitions for display; the source data remains available for validation. */
export function readFields(data: Record<string, unknown>): ComponentField[] {
  if (!Array.isArray(data.fields)) return [];
  const fields: ComponentField[] = [];
  const seen = new Set<string>();
  for (const value of data.fields) {
    if (!record(value) || typeof value.key !== "string" || !value.key.trim()) continue;
    const key = value.key.trim();
    if (seen.has(key) || !componentValue(value.default)) continue;
    if (value.type !== "number" && value.type !== "string" && value.type !== "boolean") continue;
    if (typeof value.default !== value.type) continue;
    fields.push({ key, type: value.type, default: value.default, ...(typeof value.label === "string" ? { label: value.label } : {}) });
    seen.add(key);
  }
  return fields;
}

/** Normalize component references for display without mutating the original front matter. */
export function readBindings(data: Record<string, unknown>): ComponentBinding[] {
  if (!Array.isArray(data.components)) return [];
  const bindings: ComponentBinding[] = [];
  const seen = new Set<string>();
  for (const value of data.components) {
    const id = typeof value === "string" ? value.trim() : record(value) && typeof value.id === "string" ? value.id.trim() : "";
    if (!id || seen.has(id)) continue;
    const values = record(value) && record(value.values)
      ? Object.fromEntries(Object.entries(value.values).filter((entry): entry is [string, ComponentValue] => componentValue(entry[1])))
      : {};
    bindings.push({ id, values });
    seen.add(id);
  }
  return bindings;
}

export function createMaterialId(prefix: string, name: string): string {
  const safePrefix = /^[a-z][a-z0-9_]*$/.test(prefix) ? prefix : "material";
  const slug = name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48).replace(/_+$/g, "");
  const base = slug ? /^[a-z]/.test(slug) ? slug : `${safePrefix}_${slug}` : safePrefix;
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return `${base}_${suffix}`;
}
