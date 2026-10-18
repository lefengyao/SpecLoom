// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { MaterialHierarchyList } from "../../src/renderer/MaterialHierarchyList";
import { materialTree, projectMaterialTree, type MaterialSummary } from "../../src/renderer/materials-model";

afterEach(cleanup);

function material(id: string, title: string, extra: Partial<MaterialSummary> = {}): MaterialSummary {
  return { id, title, type: "entity", path: `specs/entities/${id}.md`, version: "1", content: "", fields: [], components: [], ...extra };
}

const root = material("patrol", "巡逻兵", { type: "enemy", description: "守卫城市", groupPath: "基础实体 / 敌人" });
const child = material("melee", "近战巡逻兵", { parent: root.id, type: "enemy", groupPath: "战斗 / 近战" });
const grandchild = material("elite", "精英巡逻兵", { parent: child.path, type: "enemy" });
const catalog = [root, child, grandchild];

test("shows parent rows, root labels, column headers and entity metadata", () => {
  render(<MaterialHierarchyList tree={materialTree(catalog)} materials={catalog} category="entity" onSelect={vi.fn()} />);
  const list = screen.getByRole("list", { name: "资料列表" });
  for (const label of ["名称与说明", "实体类型", "父级资料", "所属分组"]) expect(screen.getByText(label)).toBeVisible();
  const parentRow = within(list).getByRole("button", { name: "查看 巡逻兵" });
  expect(within(parentRow).getByText("根资料")).toBeVisible();
  expect(within(parentRow).getByText("守卫城市")).toBeVisible();
  expect(within(parentRow).getByText("敌人")).toBeVisible();
  expect(within(parentRow).getByText("基础实体 / 敌人")).toBeVisible();
  const childRow = within(list).getByRole("button", { name: "查看 近战巡逻兵" });
  expect(within(childRow).getByText(root.title)).toBeVisible();
  expect(within(childRow).getByText("战斗 / 近战")).toBeVisible();
  expect(within(screen.getByRole("list", { name: "巡逻兵的子资料" })).getByRole("button", { name: "查看 近战巡逻兵" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "查看 精英巡逻兵" })).not.toBeInTheDocument();
});

test("expands and collapses branches without selecting a material", () => {
  const onSelect = vi.fn();
  render(<MaterialHierarchyList tree={materialTree(catalog)} materials={catalog} onSelect={onSelect} />);
  fireEvent.click(screen.getByRole("button", { name: "展开 近战巡逻兵" }));
  expect(screen.getByRole("button", { name: "查看 精英巡逻兵" })).toBeVisible();
  expect(screen.getByRole("button", { name: "收起 近战巡逻兵" })).toHaveAttribute("aria-expanded", "true");
  fireEvent.click(screen.getByRole("button", { name: "收起 巡逻兵" }));
  expect(screen.queryByRole("button", { name: "查看 近战巡逻兵" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "展开 巡逻兵" })).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(screen.getByRole("button", { name: "展开 巡逻兵" }));
  expect(screen.getByRole("button", { name: "查看 精英巡逻兵" })).toBeVisible();
  expect(onSelect).not.toHaveBeenCalled();
});

test("selects through a native button and marks the selected row", () => {
  const onSelect = vi.fn();
  render(<MaterialHierarchyList tree={materialTree(catalog)} materials={catalog} selectedPath={child.path} onSelect={onSelect} />);
  const choice = screen.getByRole("button", { name: "查看 近战巡逻兵" });
  expect(choice.tagName).toBe("BUTTON");
  expect(choice).toHaveAttribute("type", "button");
  expect(choice).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "查看 巡逻兵" })).toHaveAttribute("aria-pressed", "false");
  choice.focus();
  expect(choice).toHaveFocus();
  // Verify native button semantics and its click callback. Browser keyboard activation
  // needs browser/Electron coverage; jsdom does not synthesize native clicks from key events.
  fireEvent.click(choice, { detail: 0 });
  expect(onSelect).toHaveBeenCalledExactlyOnceWith(child.path);
});

test("expands the selected material's ancestor path on initial selection and later changes", () => {
  const tree = materialTree(catalog);
  const props = { tree, materials: catalog, onSelect: vi.fn() };
  const { rerender } = render(<MaterialHierarchyList {...props} selectedPath={grandchild.path} />);
  expect(screen.getByRole("button", { name: "查看 精英巡逻兵" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "收起 巡逻兵" }));
  expect(screen.queryByRole("button", { name: "查看 精英巡逻兵" })).not.toBeInTheDocument();
  rerender(<MaterialHierarchyList {...props} selectedPath={root.path} />);
  rerender(<MaterialHierarchyList {...props} selectedPath={grandchild.path} />);
  expect(screen.getByRole("button", { name: "查看 精英巡逻兵" })).toBeVisible();
});

test("keeps context ancestors navigable and explicitly identifies them as path context", () => {
  const tree = projectMaterialTree(materialTree(catalog), new Set([child.path]));
  const onSelect = vi.fn();
  render(<MaterialHierarchyList tree={tree} materials={catalog} onSelect={onSelect} />);
  const contextChoice = screen.getByRole("button", { name: "查看 巡逻兵" });
  expect(contextChoice).toHaveAccessibleDescription(/说明：守卫城市.*类型：敌人.*父级资料：根资料.*所属分组：基础实体 \/ 敌人.*路径上下文/);
  expect(contextChoice.closest(".material-hierarchy-row")).toHaveClass("context-only");
  expect(within(contextChoice).getByText("路径上下文")).toBeVisible();
  expect(contextChoice).toBeEnabled();
  fireEvent.click(contextChoice);
  expect(onSelect).toHaveBeenCalledExactlyOnceWith(root.path);
  expect(screen.getByRole("button", { name: "查看 近战巡逻兵" }).closest(".material-hierarchy-row")).not.toHaveClass("context-only");
});

test("shows official and custom source metadata across a continuous component hierarchy", () => {
  const official = material("state_machine", "状态机", { type: "component", path: "specs/components/state_machine.md" });
  const custom = material("custom_state", "自定义状态机", { type: "component", path: "specs/components/custom_state.md", parent: official.id, scope: "system" });
  const materials = [official, custom];
  render(<MaterialHierarchyList tree={materialTree(materials)} materials={materials} category="component" onSelect={vi.fn()} />);
  expect(screen.getByText("组件来源")).toBeVisible();
  expect(within(screen.getByRole("button", { name: "查看 状态机" })).getByText("官方组件")).toBeVisible();
  const customChoice = screen.getByRole("button", { name: "查看 自定义状态机" });
  expect(within(customChoice).getByText("自定义组件")).toBeVisible();
  expect(within(customChoice).getByText("状态机")).toBeVisible();
  expect(within(screen.getByRole("list", { name: "状态机的子资料" })).getByRole("button", { name: "查看 自定义状态机" })).toBeVisible();
});

test("uses parent only and keeps relationship errors and unparsed files reachable", () => {
  const inherited = material("inherited", "继承实体", { extends: root.id, groupId: root.id, components: [{ id: root.id, values: {} }] });
  const orphan = material("orphan", "失联实体", { parent: "missing" });
  const invalid = material("invalid", "无法解析", { invalid: true });
  const materials = [root, inherited, orphan, invalid];
  const onSelect = vi.fn();
  render(<MaterialHierarchyList tree={materialTree(materials)} materials={materials} onSelect={onSelect} />);
  expect(within(screen.getByRole("button", { name: "查看 继承实体" })).getByText("根资料")).toBeVisible();
  expect(screen.queryByRole("button", { name: "收起 巡逻兵" })).not.toBeInTheDocument();
  expect(screen.getByText("关系错误")).toBeVisible();
  expect(screen.getByText("未归类")).toBeVisible();
  expect(within(screen.getByRole("button", { name: "查看 失联实体" })).getByText("缺失父级：missing")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "查看 无法解析" }));
  expect(onSelect).toHaveBeenCalledExactlyOnceWith(invalid.path);
});

test("supports controlled expansion and reports node keys without mutating the input set", () => {
  const tree = materialTree(catalog);
  const initial = new Set<string>();
  const onExpandedKeysChange = vi.fn();
  function ControlledList() {
    const [expandedKeys, setExpandedKeys] = useState(initial);
    return <MaterialHierarchyList tree={tree} materials={catalog} expandedKeys={expandedKeys} onExpandedKeysChange={(next) => { onExpandedKeysChange(next); setExpandedKeys(next); }} onSelect={vi.fn()} />;
  }
  render(<ControlledList />);
  expect(screen.queryByRole("button", { name: "查看 近战巡逻兵" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "展开 巡逻兵" }));
  expect(screen.getByRole("button", { name: "查看 近战巡逻兵" })).toBeVisible();
  expect(onExpandedKeysChange).toHaveBeenCalledExactlyOnceWith(new Set([root.path]));
  expect(initial.size).toBe(0);
});

test("reports ancestor expansion through the controlled callback for a selected descendant", () => {
  const onExpandedKeysChange = vi.fn();
  render(<MaterialHierarchyList tree={materialTree(catalog)} materials={catalog} selectedPath={grandchild.path} expandedKeys={new Set()} onExpandedKeysChange={onExpandedKeysChange} onSelect={vi.fn()} />);
  expect(onExpandedKeysChange).toHaveBeenCalledExactlyOnceWith(new Set([root.path, child.path]));
});

test("opens newly loaded root branches while retaining a user's collapsed branch", () => {
  const props = { materials: catalog, onSelect: vi.fn() };
  const { rerender } = render(<MaterialHierarchyList {...props} tree={[]} />);
  rerender(<MaterialHierarchyList {...props} tree={materialTree(catalog)} />);
  expect(screen.getByRole("button", { name: "查看 近战巡逻兵" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "收起 巡逻兵" }));
  rerender(<MaterialHierarchyList {...props} tree={materialTree(catalog)} />);
  expect(screen.queryByRole("button", { name: "查看 近战巡逻兵" })).not.toBeInTheDocument();
});

test("announces column names and complete entity row metadata without lengthening the button name", () => {
  render(<MaterialHierarchyList tree={materialTree(catalog)} materials={catalog} category="entity" onSelect={vi.fn()} />);
  expect(screen.getByRole("group", { name: "资料列说明" })).toBeVisible();
  expect(screen.getByRole("list", { name: "资料列表" })).toHaveAccessibleDescription(/名称与说明.*实体类型.*父级资料.*所属分组/);
  const parentChoice = screen.getByRole("button", { name: "查看 巡逻兵" });
  expect(parentChoice).toHaveAccessibleDescription(/说明：守卫城市.*实体类型：敌人.*父级资料：根资料.*所属分组：基础实体 \/ 敌人/);
  const childChoice = screen.getByRole("button", { name: "查看 近战巡逻兵" });
  expect(childChoice).toHaveAccessibleDescription(/实体类型：敌人.*父级资料：巡逻兵.*所属分组：战斗 \/ 近战/);
});

test("announces official and custom component sources together with parent and group metadata", () => {
  const official = material("state_machine", "状态机", { type: "component", path: "specs/components/state_machine.md" });
  const custom = material("custom_state", "自定义状态机", { type: "component", path: "specs/components/custom_state.md", parent: official.id, groupPath: "逻辑 / 状态" });
  const materials = [official, custom];
  const tree = projectMaterialTree(materialTree(materials), new Set([custom.path]));
  render(<MaterialHierarchyList tree={tree} materials={materials} category="component" onSelect={vi.fn()} />);
  expect(screen.getByRole("button", { name: "查看 状态机" })).toHaveAccessibleDescription(/组件来源：官方组件.*父级资料：根资料.*所属分组：未分组.*路径上下文/);
  expect(screen.getByRole("button", { name: "查看 自定义状态机" })).toHaveAccessibleDescription(/组件来源：自定义组件.*父级资料：状态机.*所属分组：逻辑 \/ 状态/);
});
