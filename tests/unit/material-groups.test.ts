import { expect, test } from "vitest";
import {
  groupIncludes,
  importLegacyGroups,
  importMissingLegacyGroups,
  materialGroupPath,
  validateMaterialGroupRegistry,
  validateMaterialGroups,
  type MaterialGroup,
} from "../../src/shared/material-groups";

const groups: MaterialGroup[] = [
  { id: "basic", name: "基础实体", order: 0 },
  { id: "plants", name: "植物", parentId: "basic", order: 0 },
  { id: "shooters", name: "射手", parentId: "plants", order: 0 },
  { id: "front-yard", name: "前院", order: 1 },
];

test("imports legacy labels as stable category-specific root groups", () => {
  const imported = importLegacyGroups("entity", ["基础实体", "前院", "基础实体"]);
  const repeated = importLegacyGroups("entity", ["基础实体", "前院", "基础实体"]);
  const otherCategory = importLegacyGroups("setting", ["基础实体"]);

  expect(imported.map((group) => group.name)).toEqual(["基础实体", "前院"]);
  expect(imported.map((group) => group.id)).toEqual(repeated.map((group) => group.id));
  expect(imported[0]?.parentId).toBeUndefined();
  expect(imported[0]?.legacyName).toBe("基础实体");
  expect(imported[0]?.id).not.toBe(otherCategory[0]?.id);
});

test("resolves a full path and includes descendant groups", () => {
  expect(materialGroupPath(groups, "shooters")).toBe("基础实体 / 植物 / 射手");
  expect(groupIncludes(groups, "basic", "shooters")).toBe(true);
  expect(groupIncludes(groups, "plants", "shooters")).toBe(true);
  expect(groupIncludes(groups, "plants", "front-yard")).toBe(false);
  expect(groupIncludes(groups, "missing", "shooters")).toBe(false);
});

test("imports missing legacy labels without duplicating registered roots", () => {
  const merged = importMissingLegacyGroups({ entity: groups }, { entity: ["基础实体", "旧标签"] });
  expect(merged.entity?.map((group) => group.name)).toEqual(["基础实体", "植物", "射手", "前院", "旧标签"]);
  expect(merged.entity?.find((group) => group.legacyName === "旧标签")?.parentId).toBeUndefined();
});

test("keeps stable legacy IDs bounded for long Unicode labels", () => {
  const imported = importLegacyGroups("entity", ["界".repeat(100)]);
  expect(imported[0]?.id.length).toBeLessThan(100);
});

test("reports invalid sibling names, missing parents, and cycles", () => {
  const invalid: MaterialGroup[] = [
    { id: "root-a", name: "根组", order: 0 },
    { id: "root-b", name: "根组", order: 1 },
    { id: "orphan", name: "孤儿", parentId: "missing", order: 0 },
    { id: "cycle-a", name: "循环甲", parentId: "cycle-b", order: 0 },
    { id: "cycle-b", name: "循环乙", parentId: "cycle-a", order: 0 },
  ];

  expect(validateMaterialGroups(invalid)).toEqual(expect.arrayContaining(["GROUP_DUPLICATE_SIBLING", "GROUP_PARENT_MISSING", "GROUP_CYCLE"]));
});

test("rejects empty names and separators on user-created groups", () => {
  expect(validateMaterialGroups([
    { id: "blank", name: "   ", order: 0 },
    { id: "path", name: "装备/远程", order: 1 },
    { id: "slash", name: "装备\\近战", order: 2 },
  ])).toEqual(expect.arrayContaining(["GROUP_NAME_EMPTY", "GROUP_NAME_SEPARATOR"]));
});

test("validates the registry shape and each category tree", () => {
  expect(validateMaterialGroupRegistry({ entity: groups })).toEqual([]);
  expect(validateMaterialGroupRegistry({ entity: "not-a-list" })).toContain("GROUP_CATEGORY_INVALID");
  expect(validateMaterialGroupRegistry({ entity: [{ id: 3, name: "坏组", order: 0 }] })).toContain("GROUP_NODE_INVALID");
  expect(validateMaterialGroupRegistry({ entity: [
    { id: "a", name: "甲", parentId: "b", order: 0 },
    { id: "b", name: "乙", parentId: "a", order: 0 },
  ] })).toContain("GROUP_CYCLE");
});
