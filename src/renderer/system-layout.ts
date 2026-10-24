import { packMountPositions, type EntityPoint, type PackedCard } from "./entity-layout";

/** Layout for the system workbench, stored per project and per system path. */
export const SYSTEM_NODE_ID = "__system__";
export const SYSTEM_CARD_SIZE = { width: 260, height: 180 };
const PREFIX = "specloom.system-layouts.";

export type SystemLayout = Record<string, Record<string, EntityPoint>>;

function storageKey(projectPath: string): string {
  return `${PREFIX}${projectPath}`;
}

export function loadSystemLayout(projectPath: string): SystemLayout {
  try {
    const raw = window.localStorage.getItem(storageKey(projectPath));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { systems?: SystemLayout };
    const systems = parsed?.systems;
    if (!systems || typeof systems !== "object") return {};
    const result: SystemLayout = {};
    for (const [path, entry] of Object.entries(systems)) {
      if (!entry || typeof entry !== "object") continue;
      const points: Record<string, EntityPoint> = {};
      for (const [id, point] of Object.entries(entry as Record<string, EntityPoint>)) {
        if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) points[id] = { x: point.x, y: point.y };
      }
      result[path] = points;
    }
    return result;
  } catch { return {}; }
}

export function saveSystemLayout(projectPath: string, layout: SystemLayout): void {
  try { window.localStorage.setItem(storageKey(projectPath), JSON.stringify({ version: 1, systems: layout })); } catch { /* best effort */ }
}

export function autoSystemPositions(cards: PackedCard[]): Record<string, EntityPoint> {
  return packMountPositions(cards, SYSTEM_CARD_SIZE);
}
