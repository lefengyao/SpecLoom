import { describe, expect, it } from "vitest";
import { looksLikeScene, sceneNodePaths } from "../../src/shared/godot-scene";

const scene = `[gd_scene load_steps=2 format=3]

[ext_resource type="PackedScene" path="res://entities/combat_entity/armor_slot.tscn" id="1_armor"]

[node name="CombatEntity" type="Node2D"]
__meta__ = null

[node name="Visual" type="Node2D" parent="."]

[node name="ArmorSlot1" type="Marker2D" parent="Visual"]

[node name="ArmorSlot2" type="Marker2D" parent="Visual"]

[node name="Body" type="Sprite2D" parent="."]
`;

describe("godot scene reader", () => {
  it("collects node paths relative to the scene root", () => {
    expect([...sceneNodePaths(scene)].sort()).toEqual(["", "Body", "Visual", "Visual/ArmorSlot1", "Visual/ArmorSlot2"]);
  });

  it("decodes escaped quotes in node names", () => {
    expect(sceneNodePaths('[gd_scene]\n[node name="Visual \\"A\\"" type="Node2D" parent="."]\n').has('Visual "A"')).toBe(true);
  });

  it("ignores non-scene text", () => {
    expect(looksLikeScene("plain markdown")).toBe(false);
    expect(looksLikeScene(scene)).toBe(true);
  });
});
