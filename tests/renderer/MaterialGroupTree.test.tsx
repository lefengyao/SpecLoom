// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { MaterialGroupTree } from "../../src/renderer/MaterialGroupTree";
import type { MaterialSummary } from "../../src/renderer/materials-model";

afterEach(cleanup);

const material = (path: string, title: string, groupId?: string) => ({
  id: path, title, type: "entity", path, version: "sha256:x", content: "", fields: [], components: [],
  ...(groupId ? { groupId } : {}),
}) as unknown as MaterialSummary;

const renderTree = (groups: { id: string; name: string; order: number; scope?: "system" | "user" }[], materials: MaterialSummary[], onSelectMaterial = vi.fn()) => {
  render(<MaterialGroupTree
    groups={groups}
    materials={materials}
    selection={{ kind: "all" }}
    onSelect={() => undefined}
    selectedPath={undefined}
    onSelectMaterial={onSelectMaterial}
    groupsSaving={false}
    onGroupsChange={async () => undefined}
  />);
  return { onSelectMaterial };
};

test("collapses and expands a group to reveal its materials", () => {
  const { onSelectMaterial } = renderTree([{ id: "combat", name: "战斗实体", order: 0 }], [material("specs/entities/keeper.md", "守灯人", "combat")]);
  expect(screen.queryByRole("treeitem", { name: "守灯人" })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "展开 战斗实体" }));
  fireEvent.click(screen.getByRole("treeitem", { name: "守灯人" }));
  expect(onSelectMaterial).toHaveBeenCalledWith("specs/entities/keeper.md");

  fireEvent.click(screen.getByRole("button", { name: "收起 战斗实体" }));
  expect(screen.queryByRole("treeitem", { name: "守灯人" })).not.toBeInTheDocument();
});

test("keeps nested groups collapsible together with their own materials", () => {
  renderTree(
    [{ id: "combat", name: "战斗实体", order: 0 }, { id: "armor", name: "防具", order: 0, parentId: "combat" } as never],
    [material("specs/entities/a.md", "护甲", "armor")],
  );
  expect(screen.getByRole("button", { name: "收起 战斗实体" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "展开 防具" }));
  expect(screen.getByRole("treeitem", { name: "护甲" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "收起 战斗实体" }));
  expect(screen.queryByRole("treeitem", { name: "护甲" })).not.toBeInTheDocument();
});

test("lets the ungrouped bucket collapse its own materials", () => {
  renderTree([], [material("specs/entities/orphan.md", "散落资料")]);
  fireEvent.click(screen.getByRole("button", { name: "展开 未分组" }));
  expect(screen.getByRole("treeitem", { name: "散落资料" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "收起 未分组" }));
  expect(screen.queryByRole("treeitem", { name: "散落资料" })).not.toBeInTheDocument();
});

test("labels official groups and refuses to rename them", () => {
  renderTree([{ id: "basic", name: "基础组件", order: 0, scope: "system" }], []);
  expect(screen.getByText("官方")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "管理 基础组件" }));
  expect(screen.getByRole("button", { name: "重命名" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "删除" })).toBeDisabled();
});
