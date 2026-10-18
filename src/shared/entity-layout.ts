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

export type EntityLayout = Record<string, Record<string, EntityPoint>>;

/** Project-relative JSON file that stores the workbench layout. */
export const ENTITY_LAYOUT_RELATIVE_PATH = ".specloom/editor/entity-layouts.json";

function readPoint(value: unknown): EntityPoint | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.x !== "number" || typeof record.y !== "number") return undefined;
  if (!Number.isFinite(record.x) || !Number.isFinite(record.y)) return undefined;
  return { x: record.x, y: record.y };
}

/** Accept only the documented shape; unknown or hostile JSON loads as an empty layout. */
export function validateEntityLayout(value: unknown): EntityLayout {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const layout: EntityLayout = {};
  for (const [entityId, components] of Object.entries(value as Record<string, unknown>)) {
    if (!entityId.trim() || !components || typeof components !== "object" || Array.isArray(components)) continue;
    const positions: Record<string, EntityPoint> = {};
    for (const [componentId, position] of Object.entries(components as Record<string, unknown>)) {
      const point = readPoint(position);
      if (componentId.trim() && point) positions[componentId] = point;
    }
    if (Object.keys(positions).length) layout[entityId] = positions;
  }
  return layout;
}
