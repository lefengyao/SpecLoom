/**
 * Canvas positions for the entity workbench.
 *
 * The workbench keeps one fixed entity card in the center and arranges the
 * mounted component cards around it. Only component positions belong to the
 * user: they are stored per project in localStorage, keyed by entity id and
 * then by component binding id.
 */

import { validateEntityLayout, type EntityLayout, type EntityPoint } from "../shared/entity-layout";
export { validateEntityLayout, type EntityLayout, type EntityPoint } from "../shared/entity-layout";

export const ENTITY_LAYOUT_STORAGE_PREFIX = "specloom.entity-layouts.";

/** Node id of the fixed entity card; component nodes use the "component:" prefix. */
export const ENTITY_NODE_ID = "__entity__";

/** Absolute canvas position of the entity card every component is arranged around. */
export const ENTITY_CENTER: EntityPoint = { x: 420, y: 280 };

const CIRCLE_X_RADIUS = 300;
const CIRCLE_Y_RADIUS = 220;
const GRID_COLUMN_SPACING = 230;
const GRID_ROW_SPACING = 160;
const MAX_RING_SIZE = 8;

function layoutKey(projectPath: string): string | undefined {
  const normalized = projectPath.trim();
  return normalized ? `${ENTITY_LAYOUT_STORAGE_PREFIX}${normalized}` : undefined;
}

export function loadEntityLayout(projectPath: string): EntityLayout {
  const key = layoutKey(projectPath);
  if (!key) return {};
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    return validateEntityLayout(JSON.parse(raw) as unknown);
  } catch {
    return {};
  }
}

export function saveEntityLayout(projectPath: string, layout: EntityLayout): void {
  const key = layoutKey(projectPath);
  if (!key) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(layout));
  } catch {
    // Storage can be full or unavailable; positions stay best effort.
  }
}

/** FNV-1a keeps the default ring rotation stable for one entity id. */
function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * Deterministic default positions for the components of one entity. Positions
 * are absolute canvas coordinates arranged around ENTITY_CENTER. The ring
 * rotation is derived from the entity id, so two entities do not stack exactly
 * the same way while one entity always renders the same layout.
 */
export function defaultEntityPositions(entityId: string, componentIds: string[]): Record<string, EntityPoint> {
  const ids = [...new Set(componentIds.filter((id) => id.trim()))];
  const positions: Record<string, EntityPoint> = {};
  if (!ids.length) return positions;
  if (ids.length === 1) {
    positions[ids[0]!] = { x: ENTITY_CENTER.x, y: ENTITY_CENTER.y - 140 };
    return positions;
  }
  if (ids.length === 2) {
    positions[ids[0]!] = { x: ENTITY_CENTER.x, y: ENTITY_CENTER.y - 160 };
    positions[ids[1]!] = { x: ENTITY_CENTER.x, y: ENTITY_CENTER.y + 180 };
    return positions;
  }
  if (ids.length <= MAX_RING_SIZE) {
    const start = ((stableHash(entityId) % 360) * Math.PI) / 180;
    ids.forEach((id, index) => {
      const angle = start + (index * Math.PI * 2) / ids.length;
      positions[id] = {
        x: Math.round(ENTITY_CENTER.x + Math.cos(angle) * CIRCLE_X_RADIUS),
        y: Math.round(ENTITY_CENTER.y + Math.sin(angle) * CIRCLE_Y_RADIUS),
      };
    });
    return positions;
  }
  const columns = Math.ceil(Math.sqrt(ids.length));
  const rows = Math.ceil(ids.length / columns);
  ids.forEach((id, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    positions[id] = {
      x: Math.round(ENTITY_CENTER.x + (column - (columns - 1) / 2) * GRID_COLUMN_SPACING),
      y: Math.round(ENTITY_CENTER.y + (row - (rows - 1) / 2) * GRID_ROW_SPACING),
    };
  });
  return positions;
}

/** Drop positions for components no longer mounted on this entity, leaving other entities untouched. */
export function pruneEntityLayout(layout: EntityLayout, entityId: string, activeComponentIds: string[]): EntityLayout {
  const active = new Set(activeComponentIds);
  const next: EntityLayout = {};
  for (const [id, components] of Object.entries(layout)) {
    if (id !== entityId) {
      next[id] = { ...components };
      continue;
    }
    const kept = Object.fromEntries(Object.entries(components).filter(([componentId]) => active.has(componentId)));
    if (Object.keys(kept).length) next[id] = kept;
  }
  return next;
}
