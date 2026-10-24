/**
 * Durable entity-workbench layout contract.
 *
 * Positions are keyed by entity id, then by mounted component id. The layout is
 * editor-only state: it never changes entity or component front matter.
 */
export interface EntityPoint {
  x: number;
  y: number;
}

export const ENTITY_ANCHOR_SIDES = ["top", "right", "bottom", "left"] as const;
export type EntityAnchorSide = typeof ENTITY_ANCHOR_SIDES[number];

/** Extra connection points a user added to a component card. */
export interface EntityAnchor {
  id: string;
  side: EntityAnchorSide;
  /** Percentage along the chosen side, clamped to 5..95. */
  offset: number;
}

/** Rendered card size in canvas pixels. `x`/`y` always describe the top-left corner. */
export interface EntitySize {
  width: number;
  height: number;
}

/** Layout row of the entity card itself; components use their binding id. */
export const ENTITY_SELF_LAYOUT_ID = "__entity__";

export interface EntityComponentLayout extends EntityPoint {
  size?: EntitySize;
  anchors?: EntityAnchor[];
  /** Entity-side anchor; absent means the nearest side is chosen automatically. */
  sourceAnchor?: EntityAnchorSide;
  /** Component-side anchor id; absent means automatic. */
  targetAnchor?: string;
}

export type EntityLayout = Record<string, Record<string, EntityComponentLayout>>;

/** Project-relative JSON file that stores the workbench layout. */
export const ENTITY_LAYOUT_RELATIVE_PATH = ".specloom/editor/entity-layouts.json";

function readPoint(value: unknown): EntityPoint | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.x !== "number" || typeof record.y !== "number") return undefined;
  if (!Number.isFinite(record.x) || !Number.isFinite(record.y)) return undefined;
  return { x: record.x, y: record.y };
}

function readSide(value: unknown): EntityAnchorSide | undefined {
  return (ENTITY_ANCHOR_SIDES as readonly unknown[]).includes(value) ? value as EntityAnchorSide : undefined;
}

function readAnchor(value: unknown): EntityAnchor | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const side = readSide(record.side);
  if (!side || typeof record.id !== "string" || !record.id.trim() || record.id.length > 80) return undefined;
  if ((ENTITY_ANCHOR_SIDES as readonly string[]).includes(record.id)) return undefined;
  if (typeof record.offset !== "number" || !Number.isFinite(record.offset)) return undefined;
  return { id: record.id, side, offset: Math.min(95, Math.max(5, record.offset)) };
}

function readSize(value: unknown): EntitySize | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const width = record.width;
  const height = record.height;
  if (typeof width !== "number" || typeof height !== "number") return undefined;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined;
  return { width: Math.min(2000, Math.max(40, Math.round(width))), height: Math.min(2000, Math.max(20, Math.round(height))) };
}

function readLayoutEntry(value: unknown): EntityComponentLayout | undefined {
  const point = readPoint(value);
  if (!point) return undefined;
  const record = value as Record<string, unknown>;
  const entry: EntityComponentLayout = { ...point };
  const size = readSize(record.size);
  if (size) entry.size = size;
  const sourceAnchor = readSide(record.sourceAnchor);
  if (sourceAnchor) entry.sourceAnchor = sourceAnchor;
  if (typeof record.targetAnchor === "string" && record.targetAnchor.trim() && record.targetAnchor.length <= 80) entry.targetAnchor = record.targetAnchor;
  if (Array.isArray(record.anchors)) {
    const seen = new Set<string>();
    const anchors = record.anchors.flatMap((raw) => {
      const anchor = readAnchor(raw);
      if (!anchor || seen.has(anchor.id)) return [];
      seen.add(anchor.id);
      return [anchor];
    }).slice(0, 16);
    if (anchors.length) entry.anchors = anchors;
  }
  return entry;
}

/** Accept only the documented shape; unknown or hostile JSON loads as an empty layout. */
export function validateEntityLayout(value: unknown): EntityLayout {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const layout: EntityLayout = {};
  for (const [entityId, components] of Object.entries(value as Record<string, unknown>)) {
    if (!entityId.trim() || !components || typeof components !== "object" || Array.isArray(components)) continue;
    const positions: Record<string, EntityComponentLayout> = {};
    for (const [componentId, position] of Object.entries(components as Record<string, unknown>)) {
      const entry = readLayoutEntry(position);
      if (componentId.trim() && entry) positions[componentId] = entry;
    }
    if (Object.keys(positions).length) layout[entityId] = positions;
  }
  return layout;
}
