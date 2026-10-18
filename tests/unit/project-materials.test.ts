import { describe, expect, it } from "vitest";
import { summarizeMaterial } from "../../src/shared/material-catalog";
import type { MaterialGroupRegistry } from "../../src/shared/material-groups";
import { createMaterialId, parseMaterial, readBindings, readFields, writeMaterial } from "../../src/shared/project-materials";

describe("project materials", () => {
  it("preserves unknown front matter and the complete Markdown body during edits", () => {
    const content = "---\nid: player\ncustom:\n  engine: godot\n---\n\n# 玩家\n\n保留末尾空行。\n\n";
    const material = parseMaterial(content)!;
    const updated = parseMaterial(writeMaterial({ ...material.data, title: "守灯人" }, material.body))!;
    expect(updated.data).toEqual({ id: "player", custom: { engine: "godot" }, title: "守灯人" });
    expect(updated.body).toBe("\n# 玩家\n\n保留末尾空行。\n\n");
  });

  it("rejects duplicate keys, non-mapping front matter, malformed YAML, and excessive aliases", () => {
    const headers = [
      "id: first\nid: second",
      "- item",
      "id: [unfinished",
      "value: &value hello\nrepeated: [" + Array.from({ length: 21 }, () => "*value").join(", ") + "]",
    ];
    for (const header of headers) expect(parseMaterial(`---\n${header}\n---\n# 内容`)).toBeUndefined();
    expect(parseMaterial("# 缺少资料头部")).toBeUndefined();
  });

  it("reads BOM and Windows newlines without trimming the document body", () => {
    expect(parseMaterial("\uFEFF---\r\nid: player\r\n---\r\n\r\n# 玩家\r\n")).toEqual({ data: { id: "player" }, body: "\r\n# 玩家\r\n" });
  });

  it("loads only valid typed component fields and keeps the first definition of each key", () => {
    expect(readFields({ fields: [
      { key: "max", label: "最大生命值", type: "number", default: 100 },
      { key: "name", type: "string", default: "角色" },
      { key: "enabled", type: "boolean", default: true },
      { key: "max", type: "number", default: 20 },
      { key: "bad", type: "number", default: "100" },
      { key: "infinite", type: "number", default: Infinity },
      { key: "", type: "boolean", default: false },
      null,
    ] })).toEqual([
      { key: "max", label: "最大生命值", type: "number", default: 100 },
      { key: "name", type: "string", default: "角色" },
      { key: "enabled", type: "boolean", default: true },
    ]);
    expect(readFields({ fields: "invalid" })).toEqual([]);
  });

  it("normalizes component references and discards invalid override values", () => {
    expect(readBindings({ components: [
      " health ",
      { id: "position", values: { x: 5, name: "出口", active: false, invalid: {}, missing: null, infinite: NaN } },
      { id: "health", values: { max: 20 } },
      { id: "speed", values: null },
      { id: "" },
      5,
    ] })).toEqual([
      { id: "health", values: {} },
      { id: "position", values: { x: 5, name: "出口", active: false } },
      { id: "speed", values: {} },
    ]);
    expect(readBindings({ components: null })).toEqual([]);
  });

  it("creates unique ASCII-safe identifiers for English, Chinese, and path-like names", () => {
    const first = createMaterialId("entity", "Fire Goblin");
    expect(first).toMatch(/^fire_goblin_[a-f0-9]{12}$/);
    expect(createMaterialId("entity", "Fire Goblin")).not.toBe(first);
    expect(createMaterialId("component", "生命值")).toMatch(/^component_[a-f0-9]{12}$/);
    expect(createMaterialId("entity", "../../Player")).toMatch(/^player_[a-f0-9]{12}$/);
  });

  it("resolves stable group IDs and legacy flat labels to category paths", () => {
    const registry: MaterialGroupRegistry = { entity: [
      { id: "basic", name: "基础实体", legacyName: "基础实体", order: 0 },
      { id: "characters", name: "角色", parentId: "basic", order: 0 },
    ] };
    const summarize = (data: Record<string, unknown>) => summarizeMaterial({
      path: "specs/entities/hero.md", version: "v1", content: writeMaterial(data, "# Hero"),
    }, registry);

    expect(summarize({ id: "hero", title: "守灯人", type: "character", groupId: "characters" })).toMatchObject({
      groupId: "characters", group: "角色", groupPath: "基础实体 / 角色",
    });
    expect(summarize({ id: "hero", title: "守灯人", type: "character", group: "基础实体" })).toMatchObject({
      groupId: "basic", group: "基础实体", groupPath: "基础实体",
    });
  });
});
