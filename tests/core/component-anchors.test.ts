import { describe, expect, it } from "vitest";
import { mergeComponentAnchorLists, resolveComponentAnchors, withInheritedComponentFields, type ComponentDefinition } from "../../src/shared/component-inheritance";
import type { MaterialSummary } from "../../src/shared/material-catalog";

const definition = (id: string, data: Record<string, unknown>): ComponentDefinition => ({ path: `specs/components/${id}.md`, id, data });
const summary = (id: string, data: Record<string, unknown>) => ({
  id, title: id, type: "component", path: `specs/components/${id}.md`, version: "sha256:x", content: "", fields: [], components: [], ...data,
}) as unknown as MaterialSummary;

describe("component anchor inheritance", () => {
  it("merges base anchors first and lets a derived anchor replace one in place", () => {
    const base = definition("base", { anchors: [{ name: "slot_1", node: "Visual/Slot1" }, { name: "slot_2", node: "Visual/Slot2" }] });
    const derived = definition("derived", { extends: "base", anchors: [{ name: "slot_2", node: "Visual/Bigger" }, { name: "slot_3", node: "Visual/Slot3" }] });
    expect(resolveComponentAnchors([base, derived], derived).anchors)
      .toEqual([
        { name: "slot_1", node: "Visual/Slot1" },
        { name: "slot_2", node: "Visual/Bigger" },
        { name: "slot_3", node: "Visual/Slot3" },
      ]);
  });

  it("keeps inherited anchors visible to mount validation through summaries", () => {
    const items = withInheritedComponentFields([
      summary("base", { anchors: [{ name: "slot_1", node: "Visual/Slot1" }] }),
      summary("derived", { extends: "base", anchors: [] }),
    ]);
    const derived = items.find((item) => item.id === "derived");
    expect(derived?.anchors).toEqual([{ name: "slot_1", node: "Visual/Slot1" }]);
  });

  it("reports missing bases but still exposes the anchors it could read", () => {
    const orphan = definition("orphan", { extends: "gone", anchors: [{ name: "own", node: "Visual/Own" }] });
    const resolved = resolveComponentAnchors([orphan], orphan);
    expect(resolved.missing).toBe("gone");
    expect(resolved.anchors.map((anchor) => anchor.name)).toEqual(["own"]);
  });

  it("ignores duplicate anchor names from later lists only when they repeat", () => {
    expect(mergeComponentAnchorLists([
      [{ name: "a", node: "1" }],
      [{ name: "b", node: "2" }, { name: "a", node: "3" }],
    ])).toEqual([{ name: "a", node: "3" }, { name: "b", node: "2" }]);
  });
});
