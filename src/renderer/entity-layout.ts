/**
 * Canvas geometry for the entity workbench.
 *
 * Every card is an axis-aligned rectangle whose `x`/`y` is its top-left corner.
 * The entity card sits at the canvas origin (0, 0); components are arranged
 * around it. Sizes are measured from the rendered cards and stored back into the
 * layout so overlap can be detected without reading card internals.
 */

import { validateEntityLayout, type EntityAnchorSide, type EntityComponentLayout, type EntityLayout, type EntityPoint, type EntitySize } from "../shared/entity-layout";
export { ENTITY_ANCHOR_SIDES, ENTITY_SELF_LAYOUT_ID, validateEntityLayout, type EntityAnchor, type EntityAnchorSide, type EntityComponentLayout, type EntityLayout, type EntityPoint, type EntitySize } from "../shared/entity-layout";
import { ENTITY_SELF_LAYOUT_ID } from "../shared/entity-layout";

export const ENTITY_LAYOUT_STORAGE_PREFIX = "specloom.entity-layouts.";

/** Node id of the fixed entity card; component nodes use the "component:" prefix. */
export const ENTITY_NODE_ID = ENTITY_SELF_LAYOUT_ID;

/** The entity card's top-left corner is the canvas origin. */
export const ENTITY_ORIGIN: EntityPoint = { x: 0, y: 0 };

/** Minimum free space between two cards. */
export const CARD_GAP = 24;

export const ENTITY_CARD_SIZE: EntitySize = { width: 220, height: 170 };
export const COMPONENT_CARD_SIZE: EntitySize = { width: 196, height: 120 };

/** Layouts saved before sizes existed were positioned around this centred card. */
const LEGACY_ORIGIN: EntityPoint = { x: 420, y: 280 };

/** Payload marker so only genuinely old layouts get shifted. */
const LAYOUT_PAYLOAD_VERSION = 2;

export interface EntityRect extends EntityPoint, EntitySize {}

function layoutKey(projectPath: string): string | undefined {
  const normalized = projectPath.trim();
  return normalized ? `${ENTITY_LAYOUT_STORAGE_PREFIX}${normalized}` : undefined;
}

/** Stored size, falling back to the card's design size until it has been measured. */
export function layoutSize(entry: EntityComponentLayout | undefined, fallback: EntitySize): EntitySize {
  const size = entry?.size;
  return size && size.width > 0 && size.height > 0 ? size : fallback;
}

export function rectOf(point: EntityPoint, size: EntitySize): EntityRect {
  return { x: point.x, y: point.y, width: size.width, height: size.height };
}

/**
 * Which sides two cards should connect through: the source side faces the target
 * card and the target side faces back. Used for entity→component and for
 * component→component mount edges.
 */
export function facingSides(source: EntityRect, target: EntityRect): { source: EntityAnchorSide; target: EntityAnchorSide } {
  const dx = target.x + target.width / 2 - (source.x + source.width / 2);
  const dy = target.y + target.height / 2 - (source.y + source.height / 2);
  const horizontal = Math.abs(dx) > Math.abs(dy);
  return horizontal
    ? { source: dx >= 0 ? "right" : "left", target: dx >= 0 ? "left" : "right" }
    : { source: dy >= 0 ? "bottom" : "top", target: dy >= 0 ? "top" : "bottom" };
}

/**
 * Component that owns a binding's mount anchor. `__entity__`, missing parents and
 * self-references fall back to the entity card so a broken mount still renders.
 */
export function mountParentId(bindingId: string, parent: string | undefined, boundIds: ReadonlySet<string>): string | undefined {
  if (!parent || parent === "__entity__" || parent === bindingId) return undefined;
  return boundIds.has(parent) ? parent : undefined;
}

/** True when two cards touch or sit closer than `gap` on both axes. */
export function rectsOverlap(a: EntityRect, b: EntityRect, gap = CARD_GAP): boolean {
  return a.x < b.x + b.width + gap && b.x < a.x + a.width + gap && a.y < b.y + b.height + gap && b.y < a.y + a.height + gap;
}

/**
 * Closest top-left that keeps `size` clear of every obstacle, searched in rings
 * around the drop point. Falls back to the requested point when the canvas is full.
 */
export function nearestFreePosition(desired: EntityPoint, size: EntitySize, obstacles: EntityRect[], gap = CARD_GAP): EntityPoint {
  const start = { x: Math.round(desired.x), y: Math.round(desired.y) };
  const fits = (point: EntityPoint) => !obstacles.some((obstacle) => rectsOverlap(rectOf(point, size), obstacle, gap));
  if (fits(start)) return start;
  const step = 20;
  for (let radius = step; radius <= 600; radius += step) {
    for (let index = 0; index < 16; index++) {
      const angle = (index * Math.PI) / 8;
      const candidate = { x: Math.round(start.x + Math.cos(angle) * radius), y: Math.round(start.y + Math.sin(angle) * radius) };
      if (fits(candidate)) return candidate;
    }
  }
  return start;
}

export interface PackedCard {
  id: string;
  size: EntitySize;
  /** Component this card is mounted on; absent or "__entity__" places it beside the entity. */
  parent?: string;
}

/**
 * Flat size-aware arrangement: alternating columns to the right and left of the
 * entity card, each stacking downwards. Used when no mount hierarchy is known.
 */
export function packComponentPositions(cards: PackedCard[], entitySize: EntitySize = ENTITY_CARD_SIZE, gap = CARD_GAP): Record<string, EntityPoint> {
  const positions: Record<string, EntityPoint> = {};
  if (!cards.length) return positions;
  const columnWidth = Math.max(...cards.map((card) => card.size.width)) + gap;
  const rowHeight = Math.max(...cards.map((card) => card.size.height)) + gap;
  const columnHeight = Math.max(entitySize.height, rowHeight * 4);
  const capacity = Math.max(1, Math.floor((columnHeight + gap) / rowHeight));
  let column = 0;
  let row = 0;
  for (const card of cards) {
    if (row >= capacity) { column += 1; row = 0; }
    const onRight = column % 2 === 0;
    const depth = Math.floor(column / 2);
    const x = onRight ? entitySize.width + gap + depth * columnWidth : -(gap + columnWidth * (depth + 1));
    positions[card.id] = { x: Math.round(x), y: Math.round(row * rowHeight) };
    row += 1;
  }
  return positions;
}

/** Depth of every card in the mount tree; cycles and unknown parents stay at depth 0. */
export function mountDepths(cards: PackedCard[]): Map<string, number> {
  const ids = new Set(cards.map((card) => card.id));
  const parentOf = new Map<string, string | undefined>();
  for (const card of cards) {
    const parent = card.parent && card.parent !== card.id && ids.has(card.parent) ? card.parent : undefined;
    parentOf.set(card.id, parent);
  }
  const depths = new Map<string, number>();
  const resolve = (id: string, seen: Set<string>): number => {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id) || seen.size > 16) return 0;
    seen.add(id);
    const parent = parentOf.get(id);
    const value = parent ? Math.min(8, resolve(parent, seen) + 1) : 0;
    depths.set(id, value);
    return value;
  };
  for (const card of cards) resolve(card.id, new Set());
  return depths;
}

/**
 * Hierarchical default layout: the entity sits at the origin, its direct mounts
 * alternate left and right, and nested mounts continue outward on the same side.
 * Cards keep the column of their root so a mounted child lands next to its parent
 * instead of wherever the flat binding order put it.
 */
export function packMountPositions(cards: PackedCard[], entitySize: EntitySize = ENTITY_CARD_SIZE, gap = CARD_GAP): Record<string, EntityPoint> {
  const positions: Record<string, EntityPoint> = {};
  if (!cards.length) return positions;
  const depths = mountDepths(cards);
  const byId = new Map(cards.map((card) => [card.id, card]));
  const columnWidth = Math.max(...cards.map((card) => card.size.width)) + gap;
  const rowHeight = Math.max(...cards.map((card) => card.size.height)) + gap;
  const order = new Map(cards.map((card, index) => [card.id, index]));
  const rootOf = (id: string): string => {
    let cursor = id;
    for (let step = 0; step < 9; step++) {
      const card = byId.get(cursor);
      const parent = card?.parent && card.parent !== cursor && byId.has(card.parent) ? card.parent : undefined;
      if (!parent) return cursor;
      cursor = parent;
    }
    return cursor;
  };
  // Roots alternate sides so the entity stays visually centred.
  const side = new Map<string, 1 | -1>();
  const roots = cards.filter((card) => depths.get(card.id) === 0).map((card) => card.id);
  roots.forEach((id, index) => side.set(id, index % 2 === 0 ? 1 : -1));
  const buckets = new Map<string, string[]>();
  for (const card of cards) {
    const depth = depths.get(card.id) ?? 0;
    const facing = side.get(rootOf(card.id)) ?? 1;
    const key = `${facing}:${depth}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(card.id); else buckets.set(key, [card.id]);
  }
  const placedY = new Map<string, number>();
  for (const [key, ids] of buckets) {
    const [facingText, depthText] = key.split(":");
    const facing = Number(facingText) as 1 | -1;
    const depth = Number(depthText);
    const x = facing === 1
      ? entitySize.width + gap + depth * columnWidth
      : -(gap + columnWidth * (depth + 1));
    // Children sort by their parent's row so subtrees stay together.
    const sorted = [...ids].sort((left, right) => {
      const leftParent = byId.get(left)?.parent;
      const rightParent = byId.get(right)?.parent;
      const leftY = leftParent ? placedY.get(leftParent) ?? 0 : 0;
      const rightY = rightParent ? placedY.get(rightParent) ?? 0 : 0;
      return (leftY - rightY) || ((order.get(left) ?? 0) - (order.get(right) ?? 0));
    });
    sorted.forEach((id, index) => {
      const y = index * rowHeight;
      positions[id] = { x: Math.round(x), y: Math.round(y) };
      placedY.set(id, y);
    });
  }
  return positions;
}

/** Default positions for the components of one entity, packed without overlap. */
export function defaultEntityPositions(componentIds: string[], sizes?: Record<string, EntitySize>, entitySize: EntitySize = ENTITY_CARD_SIZE): Record<string, EntityPoint> {
  const ids = [...new Set(componentIds.filter((id) => id.trim()))];
  const cards = ids.map((id) => ({ id, size: sizes?.[id] ?? COMPONENT_CARD_SIZE }));
  return packComponentPositions(cards, entitySize);
}

/**
 * Layouts saved before sizes and the origin existed were centred on a card at
 * (420, 280). Shift them so the entity corner becomes the origin; the presence
 * of the entity's own row marks an already-migrated layout.
 */
export function migrateLegacyPositions(layout: EntityLayout): EntityLayout {
  const next: EntityLayout = {};
  for (const [entityId, components] of Object.entries(layout)) {
    if (components[ENTITY_SELF_LAYOUT_ID]) {
      next[entityId] = { ...components };
      continue;
    }
    const shifted: Record<string, EntityComponentLayout> = {};
    for (const [id, entry] of Object.entries(components)) {
      shifted[id] = { ...entry, x: Math.round(entry.x - LEGACY_ORIGIN.x), y: Math.round(entry.y - LEGACY_ORIGIN.y) };
    }
    shifted[ENTITY_SELF_LAYOUT_ID] = { x: 0, y: 0, size: ENTITY_CARD_SIZE };
    next[entityId] = shifted;
  }
  return next;
}

export function loadEntityLayout(projectPath: string): EntityLayout {
  const key = layoutKey(projectPath);
  if (!key) return {};
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    // Layouts written before sizes and the origin existed stored the entity map directly,
    // so only those are shifted; a versioned payload is already in canvas coordinates.
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && (parsed as { version?: unknown }).version === LAYOUT_PAYLOAD_VERSION) {
      return validateEntityLayout((parsed as { entities?: unknown }).entities);
    }
    return migrateLegacyPositions(validateEntityLayout(parsed));
  } catch {
    return {};
  }
}

export function saveEntityLayout(projectPath: string, layout: EntityLayout): void {
  const key = layoutKey(projectPath);
  if (!key) return;
  try {
    window.localStorage.setItem(key, JSON.stringify({ version: LAYOUT_PAYLOAD_VERSION, entities: layout }));
  } catch {
    // Storage can be full or unavailable; positions stay best effort.
  }
}

/** Drop positions for components no longer mounted on this entity, keeping the entity's own row. */
export function pruneEntityLayout(layout: EntityLayout, entityId: string, activeComponentIds: string[]): EntityLayout {
  const active = new Set(activeComponentIds);
  const next: EntityLayout = {};
  for (const [id, components] of Object.entries(layout)) {
    if (id !== entityId) {
      next[id] = { ...components };
      continue;
    }
    const kept = Object.fromEntries(Object.entries(components).filter(([componentId]) => componentId === ENTITY_SELF_LAYOUT_ID || active.has(componentId)));
    if (Object.keys(kept).length) next[id] = kept;
  }
  return next;
}

/**
 * Coalesce layout saves: the workbench persists on every measurement and drop, and a
 * burst of overlapping writes to one sidecar fails intermittently on Windows. At most
 * one save is in flight; the newest layout is sent once it finishes.
 */
export function createLayoutSaver(
  save: (layout: EntityLayout) => Promise<unknown>,
  onError?: ((error: unknown) => void) | undefined,
): (layout: EntityLayout) => void {
  let pending: EntityLayout | undefined;
  let inFlight = false;
  const flush = () => {
    const next = pending;
    if (!next) { inFlight = false; return; }
    pending = undefined;
    void save(next).catch((error: unknown) => { onError?.(error); }).finally(() => { flush(); });
  };
  return (layout: EntityLayout) => {
    pending = layout;
    if (inFlight) return;
    inFlight = true;
    flush();
  };
}
