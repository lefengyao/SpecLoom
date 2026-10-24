// @vitest-environment jsdom
import { beforeEach, describe, expect, test } from "vitest";
import {
  CARD_GAP, COMPONENT_CARD_SIZE, ENTITY_CARD_SIZE, ENTITY_ORIGIN, ENTITY_SELF_LAYOUT_ID, createLayoutSaver, facingSides, loadEntityLayout, migrateLegacyPositions,
  mountDepths, mountParentId, nearestFreePosition, packComponentPositions, packMountPositions, pruneEntityLayout, rectOf, rectsOverlap, saveEntityLayout,
} from "../../src/renderer/entity-layout";
import type { EntityLayout } from "../../src/shared/entity-layout";

const card = (id: string, width = COMPONENT_CARD_SIZE.width, height = COMPONENT_CARD_SIZE.height) => ({ id, size: { width, height } });

function overlapsAny(rect: ReturnType<typeof rectOf>, others: ReturnType<typeof rectOf>[]): boolean {
  return others.some((other) => rectsOverlap(rect, other));
}

describe("rectsOverlap", () => {
  test("keeps cards apart by the configured gap", () => {
    const left = { x: 0, y: 0, width: 100, height: 100 };
    expect(rectsOverlap(left, { x: 120, y: 0, width: 100, height: 100 })).toBe(true);
    expect(rectsOverlap(left, { x: 100 + CARD_GAP, y: 0, width: 100, height: 100 })).toBe(false);
    expect(rectsOverlap(left, { x: 0, y: 200, width: 100, height: 100 })).toBe(false);
  });
});

describe("packComponentPositions", () => {
  test("arranges every card without overlapping the entity or each other", () => {
    const cards = Array.from({ length: 9 }, (_, index) => card(`c${index}`));
    const positions = packComponentPositions(cards, ENTITY_CARD_SIZE);
    const entity = rectOf({ x: 0, y: 0 }, ENTITY_CARD_SIZE);
    const placed = cards.map((item) => rectOf(positions[item.id]!, item.size));
    for (const [index, rect] of placed.entries()) {
      expect(overlapsAny(rect, [entity, ...placed.filter((_, other) => other !== index)])).toBe(false);
    }
    expect(Object.keys(positions)).toHaveLength(9);
  });

  test("uses both sides of the entity and keeps the origin at its top-left", () => {
    const positions = packComponentPositions(Array.from({ length: 6 }, (_, index) => card(`c${index}`)), ENTITY_CARD_SIZE);
    const xs = Object.values(positions).map((position) => position.x);
    expect(xs.some((x) => x < 0)).toBe(true);
    expect(xs.some((x) => x >= ENTITY_CARD_SIZE.width + CARD_GAP)).toBe(true);
    // Cards on the left must end before the entity's left edge.
    for (const [id, position] of Object.entries(positions)) {
      if (position.x < 0) expect(position.x + COMPONENT_CARD_SIZE.width).toBeLessThanOrEqual(-CARD_GAP);
      expect(positions[id]!.y).toBeGreaterThanOrEqual(0);
    }
  });

  test("stacks taller cards without overlap", () => {
    const cards = [card("a", 240, 160), card("b", 200, 90), card("c", 300, 200)];
    const positions = packComponentPositions(cards, ENTITY_CARD_SIZE);
    const placed = cards.map((item) => rectOf(positions[item.id]!, item.size));
    expect(overlapsAny(placed[0]!, [placed[1]!, placed[2]!])).toBe(false);
    expect(overlapsAny(placed[1]!, [placed[2]!])).toBe(false);
  });
});

describe("nearestFreePosition", () => {
  test("moves a dropped card clear of the entity and keeps it close", () => {
    const entity = rectOf({ x: 0, y: 0 }, ENTITY_CARD_SIZE);
    const desired = { x: 10, y: 10 };
    const placed = nearestFreePosition(desired, COMPONENT_CARD_SIZE, [entity]);
    const rect = rectOf(placed, COMPONENT_CARD_SIZE);
    expect(rectsOverlap(rect, entity)).toBe(false);
    expect(Math.hypot(placed.x - desired.x, placed.y - desired.y)).toBeLessThan(320);
  });

  test("keeps the requested point when it is already free", () => {
    const entity = rectOf({ x: 0, y: 0 }, ENTITY_CARD_SIZE);
    expect(nearestFreePosition({ x: 600, y: 600 }, COMPONENT_CARD_SIZE, [entity])).toEqual({ x: 600, y: 600 });
  });
});

describe("migrateLegacyPositions", () => {
  test("shifts centred legacy coordinates to the entity origin and marks the layout", () => {
    const legacy = { keeper: { health: { x: 720, y: 140 } } } as EntityLayout;
    const migrated = migrateLegacyPositions(legacy);
    expect(migrated.keeper?.health).toMatchObject({ x: 300, y: -140 });
    expect(migrated.keeper?.[ENTITY_SELF_LAYOUT_ID]).toMatchObject({ x: 0, y: 0 });
  });

  test("leaves an already migrated layout untouched", () => {
    const layout = { keeper: { health: { x: 300, y: -140 }, [ENTITY_SELF_LAYOUT_ID]: { x: 0, y: 0 } } } as EntityLayout;
    expect(migrateLegacyPositions(layout)).toEqual(layout);
  });
});

describe("facingSides", () => {
  const source = { x: 0, y: 0, width: 200, height: 120 };

  test("connects through the dominant axis", () => {
    expect(facingSides(source, { x: 400, y: 0, width: 200, height: 120 })).toEqual({ source: "right", target: "left" });
    expect(facingSides(source, { x: -400, y: 0, width: 200, height: 120 })).toEqual({ source: "left", target: "right" });
    expect(facingSides(source, { x: 0, y: 300, width: 200, height: 120 })).toEqual({ source: "bottom", target: "top" });
    expect(facingSides(source, { x: 0, y: -300, width: 200, height: 120 })).toEqual({ source: "top", target: "bottom" });
  });
});

describe("mountParentId", () => {
  const bound = new Set(["armor_slot", "armor_class_1"]);

  test("resolves a bound component and falls back to the entity otherwise", () => {
    expect(mountParentId("armor_class_1", "armor_slot", bound)).toBe("armor_slot");
    expect(mountParentId("armor_class_1", undefined, bound)).toBeUndefined();
    expect(mountParentId("armor_class_1", "__entity__", bound)).toBeUndefined();
    expect(mountParentId("armor_class_1", "missing", bound)).toBeUndefined();
    expect(mountParentId("armor_class_1", "armor_class_1", bound)).toBeUndefined();
  });
});

describe("packMountPositions", () => {
  const card = (id: string, parent?: string) => ({ id, size: COMPONENT_CARD_SIZE, ...(parent ? { parent } : {}) });

  test("keeps nested mounts outward from their parent on the same side", () => {
    const positions = packMountPositions([card("armor_slot"), card("armor_class_1", "armor_slot"), card("armor_class_2", "armor_slot")]);
    const root = positions.armor_slot!;
    expect(positions.armor_class_1!.x).toBeGreaterThan(root.x);
    expect(positions.armor_class_2!.x).toBeGreaterThan(root.x);
    const entity = rectOf(ENTITY_ORIGIN, ENTITY_CARD_SIZE);
    for (const position of Object.values(positions)) {
      expect(rectsOverlap(rectOf(position, COMPONENT_CARD_SIZE), entity)).toBe(false);
    }
  });

  test("centres columns on the entity and each child group on its parent", () => {
    const positions = packMountPositions([card("root"), card("child", "root")]);
    const entityCenter = ENTITY_CARD_SIZE.height / 2;
    expect(positions.root!.y + COMPONENT_CARD_SIZE.height / 2).toBeCloseTo(entityCenter, 0);
    expect(positions.child!.y + COMPONENT_CARD_SIZE.height / 2).toBeCloseTo(positions.root!.y + COMPONENT_CARD_SIZE.height / 2, 0);
  });

  test("never overlaps cards across depths", () => {
    const cards = [card("a"), card("b", "a"), card("c", "b"), card("d")];
    const positions = packMountPositions(cards);
    const rects = cards.map((item) => rectOf(positions[item.id]!, item.size));
    for (const [index, rect] of rects.entries()) {
      for (const [other, otherRect] of rects.entries()) {
        if (index !== other) expect(rectsOverlap(rect, otherRect)).toBe(false);
      }
    }
  });

  test("treats unknown parents and cycles as roots", () => {
    expect(packMountPositions([card("x", "missing")]).x).toBeDefined();
    const depths = mountDepths([card("left", "right"), card("right", "left")]);
    expect(depths.get("left")).toBeGreaterThanOrEqual(0);
    expect(depths.get("right")).toBeGreaterThanOrEqual(0);
    expect(packMountPositions([card("left", "right"), card("right", "left")])).toHaveProperty("left");
  });
});

describe("createLayoutSaver", () => {
  const layout = (x: number) => ({ keeper: { health: { x, y: x } } }) as EntityLayout;
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  test("keeps one save in flight and drops intermediate layouts", async () => {
    const calls: EntityLayout[] = [];
    const releases: Array<() => void> = [];
    const saver = createLayoutSaver((next) => { calls.push(next); return new Promise<void>((resolve) => { releases.push(resolve); }); });
    const [a, b, c] = [layout(1), layout(2), layout(3)];
    saver(a); saver(b); saver(c);
    expect(calls).toEqual([a]);
    releases.shift()!();
    await tick();
    expect(calls).toEqual([a, c]);
    releases.shift()!();
    await tick();
    expect(calls).toEqual([a, c]);
  });

  test("reports a failed save and still sends the newest layout", async () => {
    const errors: unknown[] = [];
    const saved: EntityLayout[] = [];
    const saver = createLayoutSaver(async (next) => {
      saved.push(next);
      if (saved.length === 1) throw new Error("写入失败");
    }, (error) => errors.push(error));
    const [a, b] = [layout(1), layout(2)];
    saver(a); saver(b);
    await tick();
    await tick();
    expect(errors).toHaveLength(1);
    expect(saved).toEqual([a, b]);
  });
});

describe("layout storage", () => {
  beforeEach(() => { window.localStorage.clear(); });

  test("round-trips positions and sizes, migrating older data on read", () => {
    window.localStorage.setItem("specloom.entity-layouts.E:\\project", JSON.stringify({ keeper: { health: { x: 720, y: 140 } } }));
    const loaded = loadEntityLayout("E:\\project");
    expect(loaded.keeper?.health).toMatchObject({ x: 300, y: -140 });
    saveEntityLayout("E:\\project", { ...loaded, keeper: { ...loaded.keeper!, health: { ...loaded.keeper!.health!, size: { width: 240, height: 130 } } } });
    expect(loadEntityLayout("E:\\project").keeper?.health?.size).toEqual({ width: 240, height: 130 });
  });

  test("does not shift a versioned layout that has no entity row yet", () => {
    window.localStorage.setItem("specloom.entity-layouts.fresh", JSON.stringify({ version: 2, entities: { keeper: { health: { x: -410, y: -260 } } } }));
    expect(loadEntityLayout("fresh")).toEqual({ keeper: { health: { x: -410, y: -260 } } });
  });

  test("prune keeps the entity row while dropping unmounted components", () => {
    const layout = { keeper: { [ENTITY_SELF_LAYOUT_ID]: { x: 0, y: 0, size: ENTITY_CARD_SIZE }, health: { x: 10, y: 10 }, gone: { x: 20, y: 20 } } } as EntityLayout;
    const pruned = pruneEntityLayout(layout, "keeper", ["health"]);
    expect(Object.keys(pruned.keeper!)).toEqual([ENTITY_SELF_LAYOUT_ID, "health"]);
  });
});
