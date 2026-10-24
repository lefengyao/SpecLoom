import { parseDocument, stringify } from "yaml";

export type ComponentValue = number | string | boolean;
export interface ComponentField {
  key: string;
  label?: string;
  type: "number" | "string" | "boolean";
  default: ComponentValue;
}
/** Physical attach point declared by a component or entity spec. */
export interface ComponentAnchor {
  name: string;
  label?: string;
  /** Scene node path relative to the owning scene root; absent means a logical-only anchor. */
  node?: string;
  /** How many components may mount here at once. */
  capacity?: number;
}
/** Where a bound component attaches: another component's anchor, or the entity's own anchor. */
export interface ComponentMount {
  parent: string;
  anchor: string;
}
export interface ComponentBinding {
  id: string;
  values: Record<string, ComponentValue>;
  notes?: string[];
  mount?: ComponentMount;
}
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

/** Normalize anchor declarations; undeclared or malformed entries are ignored. */
export function readAnchors(data: Record<string, unknown>): ComponentAnchor[] {
  if (!Array.isArray(data.anchors)) return [];
  const anchors: ComponentAnchor[] = [];
  const seen = new Set<string>();
  for (const value of data.anchors) {
    if (!record(value) || typeof value.name !== "string" || !value.name.trim()) continue;
    const name = value.name.trim();
    if (seen.has(name) || name.length > 80) continue;
    const anchor: ComponentAnchor = { name };
    if (typeof value.label === "string" && value.label.trim()) anchor.label = value.label.trim();
    if (typeof value.node === "string" && value.node.trim()) anchor.node = value.node.trim().replaceAll("\\", "/");
    if (typeof value.capacity === "number" && Number.isFinite(value.capacity)) anchor.capacity = Math.min(64, Math.max(1, Math.round(value.capacity)));
    anchors.push(anchor);
    seen.add(name);
  }
  return anchors.slice(0, 64);
}

/** Normalize a binding's mount target; incomplete declarations are dropped rather than guessed. */
function readMount(value: unknown): ComponentMount | undefined {
  if (!record(value)) return undefined;
  const parent = typeof value.parent === "string" ? value.parent.trim() : "";
  const anchor = typeof value.anchor === "string" ? value.anchor.trim() : "";
  if (!parent || !anchor || parent.length > 200 || anchor.length > 80) return undefined;
  return { parent: parent === "__entity__" ? "__entity__" : parent, anchor };
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
    const notes = record(value) && Array.isArray(value.notes)
      ? value.notes.filter((note): note is string => typeof note === "string").map((note) => note.trim()).slice(0, 32)
      : [];
    const mount = record(value) ? readMount(value.mount) : undefined;
    bindings.push({ id, values, ...(notes.length ? { notes } : {}), ...(mount ? { mount } : {}) });
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
