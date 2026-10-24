import { Position } from "@xyflow/react";
import type { FileReadResult } from "../../shared/contracts";
import type { ComponentAnchor, ComponentBinding, ComponentField, ComponentMount, ComponentValue } from "../../shared/project-materials";
import { parseMaterial, writeMaterial } from "../../shared/project-materials";
import type { Translate } from "../i18n";
import { ENTITY_ANCHOR_SIDES, type EntityAnchor, type EntityAnchorSide, type EntityPoint } from "../entity-layout";

export const EMPTY_POSITIONS: Record<string, EntityPoint> = {};
export const fieldTypeLabels: Record<ComponentField["type"], string> = { number: "数值", string: "文本", boolean: "布尔" };
export const IMAGE_SETTINGS_PREFIX = "specloom.entity-workbench.images.";
export const IMAGE_SIZE_MIN = 80;
export const IMAGE_SIZE_MAX = 360;
export interface WorkbenchImageSettings { show: boolean; size: number }

/** Drop blank per-binding notes and trim the rest before the entity is saved. */
export function cleanBindingNotes(content: string): string {
  const parsed = parseMaterial(content);
  if (!parsed || !Array.isArray(parsed.data.components)) return content;
  let changed = false;
  const components = parsed.data.components.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const record = entry as Record<string, unknown>;
    const rawNotes = record.notes;
    if (!Array.isArray(rawNotes)) return entry;
    const notes = rawNotes.filter((note): note is string => typeof note === "string" && note.trim().length > 0).map((note) => note.trim()).slice(0, 32);
    if (notes.length === rawNotes.length && notes.every((note, index) => note === rawNotes[index])) return entry;
    changed = true;
    const next = { ...record };
    if (notes.length) next.notes = notes; else delete next.notes;
    return next;
  });
  return changed ? writeMaterial({ ...parsed.data, components }, parsed.body) : content;
}

export function loadImageSettings(projectPath: string): WorkbenchImageSettings {
  try {
    const raw = window.localStorage.getItem(`${IMAGE_SETTINGS_PREFIX}${projectPath.trim()}`);
    if (raw) {
      const value = JSON.parse(raw) as { show?: unknown; size?: unknown };
      const size = typeof value.size === "number" && Number.isFinite(value.size) ? clamp(Math.round(value.size), IMAGE_SIZE_MIN, IMAGE_SIZE_MAX) : 160;
      return { show: value.show !== false, size };
    }
  } catch { /* Storage can be unavailable; keep the defaults. */ }
  return { show: true, size: 160 };
}

export function saveImageSettings(projectPath: string, settings: WorkbenchImageSettings): void {
  try { window.localStorage.setItem(`${IMAGE_SETTINGS_PREFIX}${projectPath.trim()}`, JSON.stringify(settings)); }
  catch { /* The preference is best effort. */ }
}

export interface EntityEntry {
  path: string;
  version: FileReadResult["version"];
  id: string;
  title: string;
  extendsRef?: string;
  data: Record<string, unknown>;
  body: string;
  content: string;
  baseline: string;
  bindings: ComponentBinding[];
  anchors?: ComponentAnchor[];
}

export interface ComponentEntry {
  path: string;
  id: string;
  title: string;
  fields: ComponentField[];
  description?: string;
  notes?: string[];
  body?: string;
  scope: "system" | "user";
  group?: string;
  groupId?: string;
  extendsRef?: string;
  anchors?: ComponentAnchor[];
}

export interface ResolvedBinding {
  id: string;
  values: Record<string, ComponentValue>;
  notes: string[];
  own: boolean;
  component?: ComponentEntry;
  inheritedFrom?: string;
  mount?: ComponentMount;
}

export interface MaterialLookup {
  entitiesById: Map<string, EntityEntry>;
  entitiesByPath: Map<string, EntityEntry>;
  componentsById: Map<string, ComponentEntry>;
  componentsByPath: Map<string, ComponentEntry>;
}

export function normalizeReference(value: string): string {
  return value.trim().replace(/^res:\/\//i, "").replaceAll("\\", "/").toLowerCase();
}

export function describeError(error: unknown, fallback: string): string {
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

export function formatValue(value: ComponentValue, tr: Translate): string {
  if (typeof value === "boolean") return value ? tr("是") : tr("否");
  if (value === "") return tr("（空）");
  return String(value);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function isAnchorSide(value: unknown): value is EntityAnchorSide {
  return (ENTITY_ANCHOR_SIDES as readonly unknown[]).includes(value);
}

export function anchorPosition(side: EntityAnchorSide): Position {
  return side === "top" ? Position.Top : side === "right" ? Position.Right : side === "bottom" ? Position.Bottom : Position.Left;
}

export function anchorOffsetStyle(anchor: EntityAnchor): { left?: string; top?: string } {
  return anchor.side === "top" || anchor.side === "bottom" ? { left: `${anchor.offset}%` } : { top: `${anchor.offset}%` };
}

export const anchorSideLabels: Record<EntityAnchorSide, string> = { top: "上", right: "右", bottom: "下", left: "左" };
export function newAnchorId(): string {
  const suffix = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `custom-${suffix}`;
}

/** A stored value only counts when it matches the declared field type. */
export function readFieldValue(binding: ResolvedBinding, field: ComponentField): ComponentValue {
  const value = binding.values[field.key];
  switch (field.type) {
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? value : typeof field.default === "number" ? field.default : 0;
    case "boolean":
      return typeof value === "boolean" ? value : field.default === true;
    case "string":
      return typeof value === "string" ? value : typeof field.default === "string" ? field.default : "";
  }
}

export function bindingSummary(binding: ResolvedBinding, tr: Translate): string {
  const component = binding.component;
  if (!component) return tr("组件定义缺失");
  const fields = component.fields.slice(0, 3).map((field) => `${field.label ?? field.key} ${formatValue(readFieldValue(binding, field), tr)}`);
  return fields.length ? fields.join(" · ") : tr("没有字段");
}

export function resolveEntityReference(reference: string | undefined, lookup: MaterialLookup): EntityEntry | undefined {
  if (!reference) return undefined;
  const direct = lookup.entitiesById.get(reference.trim());
  if (direct) return direct;
  const normalized = normalizeReference(reference);
  return lookup.entitiesByPath.get(normalized) ?? lookup.entitiesByPath.get(normalized.replace(/\.md$/, ""));
}

export function resolveComponentReference(reference: string, lookup: MaterialLookup): ComponentEntry | undefined {
  const trimmed = reference.trim();
  if (!trimmed) return undefined;
  const direct = lookup.componentsById.get(trimmed);
  if (direct) return direct;
  const normalized = normalizeReference(reference);
  return lookup.componentsByPath.get(normalized) ?? lookup.componentsByPath.get(normalized.replace(/\.md$/, ""));
}

/** Ancestors of one entity, base-first and cycle safe. */
export function entityAncestors(entity: EntityEntry, lookup: MaterialLookup): EntityEntry[] {
  const chain: EntityEntry[] = [];
  const seen = new Set<string>([entity.path]);
  let cursor = resolveEntityReference(entity.extendsRef, lookup);
  while (cursor && !seen.has(cursor.path)) {
    seen.add(cursor.path);
    chain.unshift(cursor);
    cursor = resolveEntityReference(cursor.extendsRef, lookup);
  }
  return chain;
}

/**
 * Merge bindings down the extends chain, base-first. A child binding overrides
 * inherited values for the same component and always wins the binding kind.
 */
export function resolveEntityBindings(entity: EntityEntry, lookup: MaterialLookup): ResolvedBinding[] {
  const ancestors = entityAncestors(entity, lookup);
  const identify = (reference: string): string => resolveComponentReference(reference, lookup)?.id ?? normalizeReference(reference);
  const order: string[] = [];
  const ids = new Map<string, string>();
  const values = new Map<string, Record<string, ComponentValue>>();
  const notes = new Map<string, string[]>();
  const inheritedFrom = new Map<string, string>();
  const mounts = new Map<string, ComponentMount>();
  const ownIdentities = new Set(entity.bindings.map((binding) => identify(binding.id)));
  for (const source of [...ancestors, entity]) {
    for (const binding of source.bindings) {
      const identity = identify(binding.id);
      if (!values.has(identity)) order.push(identity);
      ids.set(identity, binding.id);
      values.set(identity, { ...values.get(identity), ...binding.values });
      if (binding.mount) mounts.set(identity, binding.mount);
      if (source === entity) {
        inheritedFrom.delete(identity);
        notes.set(identity, binding.notes ?? []);
      } else inheritedFrom.set(identity, source.title);
    }
  }
  return order.map((identity) => {
    const id = ids.get(identity) ?? identity;
    const component = resolveComponentReference(id, lookup);
    const inheritedTitle = ownIdentities.has(identity) ? undefined : inheritedFrom.get(identity);
    const mount = mounts.get(identity);
    return {
      id,
      values: values.get(identity) ?? {},
      notes: notes.get(identity) ?? [],
      own: ownIdentities.has(identity),
      ...(component ? { component } : {}),
      ...(inheritedTitle ? { inheritedFrom: inheritedTitle } : {}),
      ...(mount ? { mount } : {}),
    };
  });
}


export function matchesQuery(query: string, values: string[]): boolean {
  const needle = query.trim().toLocaleLowerCase();
  return !needle || values.some((value) => value.toLocaleLowerCase().includes(needle));
}


