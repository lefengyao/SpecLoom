// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { DocumentsView } from "../../src/renderer/DocumentsView";
import { MaterialExplorer } from "../../src/renderer/MaterialExplorer";
import type { DocumentCategory, MaterialSummary } from "../../src/renderer/materials-model";
import { parseMaterial, writeMaterial } from "../../src/shared/project-materials";
import { fixture, version } from "./fixtures";
const materialsCss = readFileSync(join(process.cwd(), "src", "renderer", "materials.css"), "utf8");
const navigationMaterialsCss = readFileSync(join(process.cwd(), "src", "renderer", "navigation-materials.css"), "utf8");

afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });
function library(extraFiles: Record<string, string> = {}) {
  const f = fixture({ project: true });
  const files: Record<string, string> = {
    "specs/project.md": writeMaterial({ id: "project", title: "项目", materialGroups: { entity: [
      { id: "characters", name: "角色", legacyName: "角色", order: 0 },
      { id: "equipment", name: "装备", legacyName: "装备", order: 1 },
      { id: "empty", name: "空分类", order: 2 },
      { id: "yard", name: "前院", order: 3 },
    ] } }, "# 项目"),
    "specs/entities/hero.md": writeMaterial({ id: "hero", title: "主角", type: "entity", description: "移动和交互", group: "角色", components: [] }, "# 主角"),
    "specs/entities/sword.md": writeMaterial({ id: "sword", title: "长剑", type: "entity", description: "近战武器", group: "装备", components: [] }, "# 长剑"),
    ...extraFiles,
  };
  const fileVersion = (content: string) => createHash("sha256").update(content).digest("hex");
  f.api.documents.mockImplementation(async () => Object.entries(files).map(([path, content]) => ({ path, version: fileVersion(content), size: content.length })));
  f.api.readDocument.mockImplementation(async (path) => ({ path, content: files[path]!, version: fileVersion(files[path]!) }));
  f.api.saveDocument.mockImplementation(async (_root, path, content) => { files[path] = content; return { path, content, version: fileVersion(content) }; });
  const onError = vi.fn();
  const listeners = new Set<(event: { projectPath: string; path: string; version: string }) => void>();
  const api = { ...f.api, onMaterialChanged: vi.fn((listener: (event: { projectPath: string; path: string; version: string }) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }) };
  const view = render(<DocumentsView api={api} projectPath="C:/Godot/lantern" onError={onError} busy={false} revision={0} category="entity" />);
  return { ...f, ...view, api, files, onError, emit(projectPath = "C:/Godot/lantern") { act(() => { for (const listener of listeners) listener({ projectPath, path: "specs/entities/hero.md", version: fileVersion(files["specs/entities/hero.md"]!) }); }); } };
}

function summary(id: string, extra: Partial<MaterialSummary> = {}): MaterialSummary {
  return { id, title: id, type: "entity", path: `specs/entities/${id}.md`, content: "", version, fields: [], components: [], ...extra };
}
function explorer(category: Exclude<DocumentCategory, "all">, materials: MaterialSummary[] = [summary("资料", { type: category })], selectedPath?: string) {
  const f = fixture({ project: true });
  const onSelect = vi.fn();
  const props = { api: f.api, projectPath: "C:/Godot/lantern", category, materials, selectedPath, onSelect, loading: false, groupsSaving: false, onGroupsChange: vi.fn(async () => undefined), groups: [
    { id: "root", name: "总组", order: 0 }, { id: "child", name: "子组", parentId: "root", order: 0 }, { id: "empty", name: "空组", order: 1 },
  ] };
  return { ...f, ...render(<MaterialExplorer {...props} />), onSelect, props };
}

test("uses only the application main landmark when embedded in its content", () => {
  const f = explorer("entity");
  f.rerender(<main aria-label="应用内容"><MaterialExplorer {...f.props} /></main>);
  expect(screen.getAllByRole("main")).toHaveLength(1);
  expect(within(screen.getByRole("region", { name: "资料浏览器" })).queryByRole("main")).not.toBeInTheDocument();
});

test.each(["entity", "component", "setting", "map", "ui", "spec"] as const)("%s shares all three modes and defaults to a hierarchy list", (category) => {
  const f = explorer(category);
  expect(screen.getByRole("button", { name: "列表显示" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("group", { name: "资料列说明" })).toBeVisible();
  for (const [label, value] of [["图标显示", "icons"], ["关系图显示", "graph"], ["列表显示", "list"]] as const) {
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(screen.getByRole("button", { name: label })).toHaveAttribute("aria-pressed", "true");
    expect(localStorage.getItem("specloom.materials.view")).toBe(value);
    fireEvent.click(screen.getByRole("button", { name: "查看 资料" }));
    expect(f.onSelect).toHaveBeenLastCalledWith(f.props.materials[0]!.path);
  }
  expect(screen.queryByLabelText("筛选实体类型") !== null).toBe(category === "entity");
  expect(screen.queryByLabelText("组件来源") !== null).toBe(category === "component");
  expect(f.api.documents).not.toHaveBeenCalled();
  expect(f.api.projectTree).not.toHaveBeenCalled();
  expect(f.api.readDocument).not.toHaveBeenCalled();
});

test("retains an explicitly collapsed selected branch when switching hierarchy modes", () => {
  const parent = summary("祖先");
  const child = summary("子项", { parent: parent.id });
  explorer("entity", [parent, child], child.path);
  fireEvent.click(screen.getByRole("button", { name: "收起 祖先" }));
  for (const label of ["关系图显示", "图标显示", "列表显示"]) {
    fireEvent.click(screen.getByRole("button", { name: label }));
    if (label !== "图标显示") {
      expect(screen.getByRole("button", { name: "展开 祖先" })).toBeVisible();
      expect(screen.queryByRole("button", { name: "查看 子项" })).not.toBeInTheDocument();
    }
  }
});

test("retains group expansion and selection when hiding and reopening the group pane", () => {
  explorer("setting");
  fireEvent.click(screen.getByRole("treeitem", { name: /^总组/ }));
  fireEvent.click(screen.getByRole("button", { name: "收起 总组" }));
  fireEvent.click(screen.getByRole("button", { name: "收起分组栏" }));
  expect(screen.queryByRole("tree", { name: "分组列表" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "展开分组栏" }));
  expect(screen.getByRole("treeitem", { name: /^总组/ })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("button", { name: "展开 总组" })).toBeVisible();
  expect(screen.queryByRole("treeitem", { name: /^子组/ })).not.toBeInTheDocument();
});

test.each([true, false])("initializes the group pane for a narrow viewport: %s, then preserves manual toggles", (narrow) => {
  const matchMedia = vi.fn(() => ({ matches: narrow }));
  vi.stubGlobal("matchMedia", matchMedia);
  const f = explorer("setting");
  expect(screen.getByRole("button", { name: narrow ? "展开分组栏" : "收起分组栏" })).toHaveAttribute("aria-expanded", String(!narrow));
  expect(screen.queryByRole("tree", { name: "分组列表" }) !== null).toBe(!narrow);
  fireEvent.click(screen.getByRole("button", { name: narrow ? "展开分组栏" : "收起分组栏" }));
  matchMedia.mockReturnValue({ matches: !narrow });
  f.rerender(<MaterialExplorer {...f.props} />);
  fireEvent.click(screen.getByRole("button", { name: "关系图显示" }));
  expect(screen.getByRole("button", { name: narrow ? "收起分组栏" : "展开分组栏" })).toHaveAttribute("aria-expanded", String(narrow));
  expect(screen.queryByRole("tree", { name: "分组列表" }) !== null).toBe(narrow);
  fireEvent.click(screen.getByRole("button", { name: narrow ? "收起分组栏" : "展开分组栏" }));
  expect(screen.getByRole("button", { name: narrow ? "展开分组栏" : "收起分组栏" })).toBeVisible();
});

test.each([["icons", "图标显示"], ["list", "列表显示"], ["graph", "关系图显示"], ["invalid", "列表显示"]])("restores %s view preference safely", (stored, label) => {
  localStorage.setItem("specloom.materials.view", stored!);
  explorer("setting");
  expect(screen.getByRole("button", { name: label })).toHaveAttribute("aria-pressed", "true");
});

test("preserves search, entity type, group choice, expansion and selected path across modes", () => {
  const parent = summary("祖先", { groupId: "root" });
  const child = summary("子项", { type: "enemy", parent: parent.id, description: "命中词", groupId: "child", groupPath: "总组 / 子组" });
  const f = explorer("entity", [parent, child, summary("无关")], child.path);
  fireEvent.click(screen.getByRole("treeitem", { name: /^总组/ }));
  fireEvent.change(screen.getByLabelText("搜索资料"), { target: { value: "命中词" } });
  fireEvent.change(screen.getByLabelText("筛选实体类型"), { target: { value: "enemy" } });
  fireEvent.click(screen.getByRole("button", { name: "收起 总组" }));
  for (const label of ["关系图显示", "图标显示", "列表显示"]) {
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(screen.getByLabelText("搜索资料")).toHaveValue("命中词");
    expect(screen.getByLabelText("筛选实体类型")).toHaveValue("enemy");
    expect(screen.getByRole("treeitem", { name: /^总组/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "展开 总组" })).toBeVisible();
    expect(screen.queryByRole("treeitem", { name: /^子组/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看 子项" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("1 项 / 共 3 项")).toBeVisible();
    expect(screen.queryByRole("button", { name: "查看 无关" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看 祖先" }).closest(".context-only")).not.toBeNull();
  }
  expect(f.api.documents).not.toHaveBeenCalled();
  expect(f.api.projectTree).not.toHaveBeenCalled();
  expect(f.api.readDocument).not.toHaveBeenCalled();
});

test("preserves collapsed material branches and auto-expands a newly selected descendant", () => {
  const parent = summary("祖先");
  const child = summary("子项", { parent: parent.id });
  const f = explorer("entity", [parent, child]);
  fireEvent.click(screen.getByRole("button", { name: "收起 祖先" }));
  for (const label of ["关系图显示", "图标显示", "列表显示"]) {
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(screen.getByRole("button", { name: "展开 祖先" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "查看 子项" })).not.toBeInTheDocument();
  }
  f.rerender(<MaterialExplorer {...f.props} selectedPath={child.path} />);
  expect(screen.getByRole("button", { name: "查看 子项" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "关系图显示" }));
  fireEvent.click(screen.getByRole("button", { name: "查看 子项" }));
  expect(f.onSelect).toHaveBeenCalledWith(child.path);
});

test("filters component sources across modes with context ancestors and consistent badges", () => {
  const parent = summary("state_machine", { title: "官方父级", path: "specs/components/state_machine.md", type: "component" });
  const child = summary("自定义子级", { path: "specs/components/child.md", type: "component", parent: parent.id });
  explorer("component", [parent, child]);
  fireEvent.change(screen.getByLabelText("组件来源"), { target: { value: "user" } });
  for (const label of ["列表显示", "关系图显示", "图标显示"]) {
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(screen.getByLabelText("组件来源")).toHaveValue("user");
    expect(screen.getByText("1 项 / 共 2 项")).toBeVisible();
    expect(screen.getByRole("button", { name: "查看 自定义子级" })).toHaveTextContent("自定义组件");
    const context = screen.getByRole("button", { name: "查看 官方父级" });
    expect(context).toHaveTextContent("官方组件");
    expect(context.closest(".context-only")).not.toBeNull();
  }
});

test("nests icon cards under their parent and labels context ancestors", () => {
  const parent = summary("祖先", { type: "character" });
  const child = summary("子项", { type: "enemy", parent: parent.id });
  explorer("entity", [parent, child]);
  fireEvent.change(screen.getByLabelText("筛选实体类型"), { target: { value: "enemy" } });
  fireEvent.click(screen.getByRole("button", { name: "图标显示" }));

  const iconTree = screen.getByRole("list", { name: "资料图标层级" });
  const parentCard = within(iconTree).getByRole("button", { name: "查看 祖先" });
  const childCard = within(iconTree).getByRole("button", { name: "查看 子项" });
  expect(parentCard).toHaveTextContent("路径上下文");
  expect(within(childCard).getByText("敌人", { selector: ".material-type-badge" })).toBeVisible();
  expect(parentCard.closest(".material-icon-node")).toContainElement(childCard);
  expect(childCard).toHaveTextContent("父级：祖先");
  expect(screen.getByText("1 项 / 共 2 项")).toBeVisible();

  fireEvent.click(within(iconTree).getByRole("button", { name: "收起 祖先" }));
  expect(within(iconTree).queryByRole("button", { name: "查看 子项" })).not.toBeInTheDocument();
  fireEvent.click(within(iconTree).getByRole("button", { name: "展开 祖先" }));
  expect(within(iconTree).getByRole("button", { name: "查看 子项" })).toBeVisible();
});

test("keeps group empty, ungrouped and no-match messages distinct across all modes", () => {
  explorer("setting", [summary("分组资料", { type: "setting", groupId: "child" })]);
  for (const label of ["列表显示", "关系图显示", "图标显示"]) {
    fireEvent.click(screen.getByRole("button", { name: label }));
    fireEvent.click(screen.getByRole("treeitem", { name: /^空组/ }));
    expect(screen.getByText(/这是一个空分组/)).toBeVisible();
    fireEvent.click(screen.getByRole("treeitem", { name: /^未分组/ }));
    expect(screen.getByText("目前没有未分组资料。")).toBeVisible();
    fireEvent.click(screen.getByRole("treeitem", { name: /^总组/ }));
    fireEvent.change(screen.getByLabelText("搜索资料"), { target: { value: "无匹配" } });
    expect(screen.getByText("没有符合条件的资料，可调整搜索或筛选条件。")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "清除其他筛选" }));
    expect(screen.getByRole("button", { name: "查看 分组资料" })).toBeVisible();
  }
});

test("browses without opening the tree, searches descriptions and filters independent groups", async () => {
  const f = library();
  const list = screen.getByRole("list", { name: "资料列表" });
  await within(list).findByRole("button", { name: "查看 主角" });
  fireEvent.change(screen.getByLabelText("搜索资料"), { target: { value: "近战" } });
  expect(within(list).getAllByRole("listitem")).toHaveLength(1);
  expect(within(list).getByRole("button", { name: "查看 长剑" })).toBeVisible();
  fireEvent.change(screen.getByLabelText("搜索资料"), { target: { value: "" } });
  fireEvent.click(screen.getByRole("treeitem", { name: /角色/ }));
  expect(within(list).getAllByRole("listitem")).toHaveLength(1);
  fireEvent.click(within(list).getByRole("button", { name: "查看 主角" }));
  expect(await screen.findByLabelText("分组", { exact: true })).toHaveValue("characters");
  expect(screen.getByLabelText("父级资料")).toHaveValue("");
  fireEvent.click(screen.getByRole("button", { name: "列表显示" }));
  expect(screen.getByRole("button", { name: "列表显示" })).toHaveAttribute("aria-pressed", "true");
  expect(localStorage.getItem("specloom.materials.view")).toBe("list");
  expect(f.api.projectTree).toHaveBeenCalled();
});

test("filters entities by type and parent groups include descendants while empty groups remain visible", async () => {
  const f = library({
    "specs/project.md": writeMaterial({ id: "project", title: "项目", materialGroups: { entity: [
      { id: "basic", name: "基础实体", order: 0 },
      { id: "characters", name: "角色", parentId: "basic", order: 0 },
      { id: "equipment", name: "装备", parentId: "basic", order: 1 },
      { id: "yard-group", name: "可交互物", parentId: "basic", order: 2 },
      { id: "empty", name: "空分类", parentId: "basic", order: 3 },
      { id: "yard", name: "前院", order: 1 },
    ] } }, "# 项目"),
    "specs/entities/hero.md": writeMaterial({ id: "hero", title: "主角", type: "character", description: "移动和交互", groupId: "characters", components: [] }, "# 主角"),
    "specs/entities/sword.md": writeMaterial({ id: "sword", title: "长剑", type: "item", description: "近战武器", groupId: "equipment", components: [] }, "# 长剑"),
    "specs/entities/yard_guard.md": writeMaterial({ id: "yard_guard", title: "前院守卫", type: "enemy", description: "守卫", groupId: "yard-group", components: [] }, "# 前院守卫"),
  });
  const explorer = await screen.findByRole("region", { name: "资料浏览器" });
  await within(explorer).findByRole("button", { name: "查看 前院守卫" });
  fireEvent.click(within(explorer).getByRole("treeitem", { name: /基础实体/ }));
  expect(within(explorer).getByRole("button", { name: "查看 主角" })).toBeVisible();
  expect(within(explorer).getByRole("button", { name: "查看 长剑" })).toBeVisible();
  fireEvent.change(within(explorer).getByLabelText("筛选实体类型"), { target: { value: "enemy" } });
  expect(within(explorer).getByRole("button", { name: "查看 前院守卫" })).toBeVisible();
  expect(within(explorer).queryByRole("button", { name: "查看 主角" })).not.toBeInTheDocument();
  expect(within(explorer).queryByRole("button", { name: "查看 长剑" })).not.toBeInTheDocument();
  expect(within(explorer).getByRole("treeitem", { name: /空分类/ })).toBeVisible();
  fireEvent.click(within(explorer).getByRole("treeitem", { name: /空分类/ }));
  expect(within(explorer).getByText(/这是一个空分组/)).toBeVisible();
  expect(f.api.documents).toHaveBeenCalled();
});

test("creates, renames and moves subgroups by stable ID through the project registry", async () => {
  const f = library();
  const explorer = await screen.findByRole("region", { name: "资料浏览器" });
  await within(explorer).findByRole("button", { name: "查看 主角" });
  fireEvent.click(within(explorer).getByRole("button", { name: "新建分组" }));
  const createRoot = screen.getByRole("dialog", { name: "新建分组" });
  fireEvent.change(within(createRoot).getByLabelText("分组名称"), { target: { value: "临时分类" } });
  fireEvent.click(within(createRoot).getByRole("button", { name: "创建分组" }));
  const root = await within(explorer).findByRole("treeitem", { name: /临时分类/ });
  const rootId = root.getAttribute("data-group-id");
  expect(rootId).toBeTruthy();
  fireEvent.click(within(root.parentElement!.parentElement!).getByRole("button", { name: "管理 临时分类" }));
  fireEvent.click(within(explorer).getByRole("button", { name: "新建子分组" }));
  const createChild = screen.getByRole("dialog", { name: "新建子分组" });
  fireEvent.change(within(createChild).getByLabelText("分组名称"), { target: { value: "临时子组" } });
  fireEvent.click(within(createChild).getByRole("button", { name: "创建分组" }));
  const child = await within(explorer).findByRole("treeitem", { name: /临时子组/ });
  const childId = child.getAttribute("data-group-id");
  expect(childId).toBeTruthy();
  const groupNode = child.closest("li.material-group-node") as HTMLElement;
  fireEvent.click(within(groupNode).getByRole("button", { name: "管理 临时子组" }));
  fireEvent.click(within(explorer).getByRole("button", { name: "重命名" }));
  const rename = screen.getByRole("dialog", { name: "重命名分组" });
  fireEvent.change(within(rename).getByLabelText("分组名称"), { target: { value: "可用物" } });
  fireEvent.click(within(rename).getByRole("button", { name: "保存分组" }));
  const renamed = await within(explorer).findByRole("treeitem", { name: /可用物/ });
  expect(renamed).toHaveAttribute("data-group-id", childId);
  fireEvent.click(within(renamed.closest("li.material-group-node") as HTMLElement).getByRole("button", { name: "管理 可用物" }));
  fireEvent.click(within(explorer).getByRole("button", { name: "移动" }));
  const move = screen.getByRole("dialog", { name: "移动分组" });
  fireEvent.change(within(move).getByLabelText("移动到上级分组"), { target: { value: "yard" } });
  fireEvent.click(within(move).getByRole("button", { name: "移动分组" }));
  await waitFor(() => expect(parseMaterial(f.files["specs/project.md"]!)?.data.materialGroups).toMatchObject({ entity: expect.arrayContaining([expect.objectContaining({ id: childId, name: "可用物", parentId: "yard" })]) }));
  expect(f.onError).not.toHaveBeenCalled();
});

test("blocks deletion of assigned groups while allowing removal of an empty leaf", async () => {
  const f = library();
  const explorer = await screen.findByRole("region", { name: "资料浏览器" });
  await within(explorer).findByRole("button", { name: "查看 主角" });
  const character = within(explorer).getByRole("treeitem", { name: /^角色/ }).closest("li.material-group-node") as HTMLElement;
  fireEvent.click(within(character).getByRole("button", { name: "管理 角色" }));
  expect(within(character).getByRole("button", { name: "删除" })).toBeDisabled();
  expect(within(character).getByText("需先移动资料并删除子分组，才能删除此组。")).toBeVisible();
  const empty = within(explorer).getByRole("treeitem", { name: /^空分类/ }).closest("li.material-group-node") as HTMLElement;
  fireEvent.click(within(empty).getByRole("button", { name: "管理 空分类" }));
  fireEvent.click(within(empty).getByRole("button", { name: "删除" }));
  await waitFor(() => expect(parseMaterial(f.files["specs/project.md"]!)?.data.materialGroups).toMatchObject({ entity: expect.not.arrayContaining([expect.objectContaining({ id: "empty" })]) }));
  expect(f.files["specs/entities/hero.md"]).toContain("group: 角色");
});

test("migrates legacy group labels into project roots without rewriting material files", async () => {
  const f = library({
    "specs/project.md": writeMaterial({ id: "project", title: "项目" }, "# 项目"),
  });
  const explorer = await screen.findByRole("region", { name: "资料浏览器" });
  await within(explorer).findByRole("button", { name: "查看 主角" });
  await waitFor(() => expect(parseMaterial(f.files["specs/project.md"]!)?.data.materialGroups).toMatchObject({ entity: expect.arrayContaining([
    expect.objectContaining({ name: "角色", legacyName: "角色" }), expect.objectContaining({ name: "装备", legacyName: "装备" }),
  ]) }));
  expect(await within(explorer).findByRole("treeitem", { name: /角色/ })).toBeVisible();
  expect(parseMaterial(f.files["specs/entities/hero.md"]!)?.data).toMatchObject({ group: "角色" });
  expect(parseMaterial(f.files["specs/entities/hero.md"]!)?.data.groupId).toBeUndefined();
});

test("assigns an existing hierarchical group and saves its stable ID", async () => {
  const f = library();
  const explorer = await screen.findByRole("region", { name: "资料浏览器" });
  fireEvent.click(await within(explorer).findByRole("button", { name: "查看 主角" }));
  const group = await screen.findByLabelText("分组", { exact: true });
  fireEvent.change(group, { target: { value: "equipment" } });
  fireEvent.click(screen.getByRole("button", { name: "保存资料" }));
  await waitFor(() => expect(parseMaterial(f.files["specs/entities/hero.md"]!)?.data).toMatchObject({ groupId: "equipment" }));
  expect(parseMaterial(f.files["specs/entities/hero.md"]!)?.data.group).toBeUndefined();
});

test("uses compact icon cards with visible metadata and clamped descriptions", async () => {
  library();
  fireEvent.click(screen.getByRole("button", { name: "图标显示" }));
  const card = await screen.findByRole("button", { name: "查看 主角" });
  const text = card.querySelector<HTMLElement>(".material-item-text");
  expect(text).not.toBeNull();
  expect(text).toHaveClass("material-item-text");
  expect(within(card).getByText("通用实体", { selector: ".material-type-badge" })).toBeVisible();
  const cardRule = navigationMaterialsCss.match(/\.material-explorer \.material-results \.material-icon-card\s*\{([^}]*)\}/)?.[1] ?? "";
  expect(cardRule).toContain("grid-template-columns: 32px minmax(0, 1fr)");
  expect(cardRule).toContain("min-height: 88px");
  expect(cardRule).toContain("height: auto");
  const descriptionRule = navigationMaterialsCss.match(/\.material-explorer \.material-results \.material-icon-card > \.material-item-text > span\s*\{([^}]*)\}/)?.[1] ?? "";
  expect(descriptionRule).toContain("-webkit-line-clamp: 2");
});

test("truncates long card text while keeping the full value available on hover", async () => {
  const f = fixture({ project: true });
  const title = "一个非常长的资料标题，用于验证卡片不会撑破布局";
  const description = "这是一个非常长的资料说明，用于验证图标卡片中的文本会显示省略号而不会覆盖相邻卡片";
  const group = "一个非常长的资料分组名称";
  const path = "specs/entities/long.md";
  const content = writeMaterial({ id: "long", title, type: "entity", description, group, components: [] }, `# ${title}`);
  f.api.documents.mockResolvedValue([{ path, version, size: content.length }]);
  f.api.readDocument.mockResolvedValue({ path, content, version });
  render(<DocumentsView api={f.api} projectPath="C:/Godot/lantern" onError={vi.fn()} busy={false} revision={0} category="entity" />);
  fireEvent.click(screen.getByRole("button", { name: "图标显示" }));
  const card = await screen.findByRole("button", { name: `查看 ${title}` });
  expect(card.querySelector("strong")).toHaveAttribute("title", title);
  expect(card.querySelector(".material-item-text > span")).toHaveAttribute("title", description);
  expect(card.querySelector(".material-group-tag")).toHaveAttribute("title", group);
  const itemTextRule = materialsCss.match(/(?:^|\n)\.material-item-text\s*\{([^}]*)\}/)?.[1] ?? "";
  expect(itemTextRule).toContain("overflow: hidden");
  const childRule = materialsCss.match(/\.material-item-text strong, \.material-item-text > span\s*\{([^}]*)\}/)?.[1] ?? "";
  expect(childRule).toContain("text-overflow: ellipsis");
  expect(childRule).toContain("white-space: nowrap");
});

test("keeps entered material details when saving fails", async () => {
  const f = library();
  fireEvent.click(await screen.findByRole("button", { name: "查看 主角" }));
  const name = await screen.findByLabelText("名称");
  fireEvent.change(name, { target: { value: "新主角" } });
  f.api.saveDocument.mockRejectedValue(Object.assign(new Error("外部修改"), { code: "VERSION_CONFLICT" }));
  fireEvent.click(screen.getByRole("button", { name: "保存资料" }));
  await waitFor(() => expect(f.onError).toHaveBeenCalled());
  expect(name).toHaveValue("新主角");
  expect(f.api.createTask).not.toHaveBeenCalled();
});

test("keeps the creation dialog and name when persistence fails", async () => {
  const f = library();
  f.api.saveDocument.mockRejectedValue(new Error("磁盘不可写"));
  fireEvent.click(screen.getByRole("button", { name: "新建实体" }));
  const dialog = screen.getByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("名称"), { target: { value: "尚未创建的角色" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "创建实体" }));
  await waitFor(() => expect(f.onError).toHaveBeenCalled());
  expect(within(dialog).getByLabelText("名称")).toHaveValue("尚未创建的角色");
  expect(f.api.createTask).not.toHaveBeenCalled();
});

test("refreshes agent changes in a clean editor and ignores other projects", async () => {
  const f = library();
  fireEvent.click(await screen.findByRole("button", { name: "查看 主角" }));
  await screen.findByLabelText("名称");
  const reads = f.api.documents.mock.calls.length;
  f.emit("D:/other"); expect(f.api.documents.mock.calls.length).toBe(reads);
  f.files["specs/entities/hero.md"] = f.files["specs/entities/hero.md"]!.replace("title: 主角", "title: 智能体更新");
  f.emit();
  await waitFor(() => expect(screen.getByLabelText("名称")).toHaveValue("智能体更新"));
  expect(await screen.findByRole("button", { name: "查看 智能体更新" })).toBeVisible();
});

test("keeps local drafts while refreshing newly created agent materials", async () => {
  const f = library();
  fireEvent.click(await screen.findByRole("button", { name: "查看 主角" }));
  fireEvent.change(await screen.findByLabelText("名称"), { target: { value: "本地草稿" } });
  f.files["specs/entities/hero.md"] = f.files["specs/entities/hero.md"]!.replace("title: 主角", "title: 智能体版本");
  f.files["specs/entities/enemy.md"] = writeMaterial({ id: "enemy", title: "智能体新建", type: "entity", description: "", components: [] }, "# 智能体新建");
  f.emit();
  expect(await screen.findByRole("button", { name: "查看 智能体新建" })).toBeVisible();
  expect(screen.getByLabelText("名称")).toHaveValue("本地草稿");
});

test("keeps mixed component sources in one continuous parent hierarchy", async () => {
  const f = fixture({ project: true });
  const files: Record<string, string> = {
    "specs/components/state_machine.md": writeMaterial({ id: "state_machine", title: "状态机基类", type: "component", group: "基础组件", description: "系统生命周期组件", fields: [] }, "# 状态机基类"),
    "specs/components/health.md": writeMaterial({ id: "health", title: "生命值", type: "component", parent: "state_machine", description: "用户组件", fields: [] }, "# 生命值"),
  };
  f.api.documents.mockImplementation(async () => Object.entries(files).map(([path, content]) => ({ path, version, size: content.length })));
  f.api.readDocument.mockImplementation(async (path) => ({ path, version, content: files[path]! }));
  const onError = vi.fn();
  render(<DocumentsView api={f.api} projectPath="C:/Godot/lantern" onError={onError} busy={false} revision={0} category="component" />);
  const explorer = await screen.findByRole("region", { name: "资料浏览器" });
  await within(explorer).findByRole("button", { name: "查看 状态机基类" });
  await within(explorer).findByRole("button", { name: "查看 生命值" });
  expect(within(explorer).queryByRole("heading", { name: "官方组件" })).not.toBeInTheDocument();
  expect(within(explorer).queryByRole("heading", { name: "自定义组件" })).not.toBeInTheDocument();
  expect(within(explorer).getByRole("button", { name: "查看 状态机基类" })).toHaveTextContent("官方组件");
  expect(within(explorer).getByRole("button", { name: "查看 生命值" })).toHaveTextContent("自定义组件");
  expect(within(explorer).getByRole("list", { name: "状态机基类的子资料" })).toContainElement(within(explorer).getByRole("button", { name: "查看 生命值" }));
});

test("lists project assets by type in the right resource manager", async () => {
  const f = fixture({ project: true });
  f.api.documents.mockResolvedValue([]);
  f.api.projectTree.mockResolvedValue([
    { path: "assets/ui/logo.png", kind: "file" },
    { path: "assets/audio/theme.ogg", kind: "file" },
    { path: "assets/fonts/ui.woff2", kind: "file" },
    { path: "scripts/main.gd", kind: "file" },
  ]);
  render(<DocumentsView api={f.api} projectPath="C:/Godot/lantern" onError={vi.fn()} busy={false} revision={0} category="all" />);
  const resources = await screen.findByRole("region", { name: "资源管理器" });
  expect(within(resources).getByText("assets/ui/logo.png")).toBeVisible();
  expect(within(resources).getByText("assets/audio/theme.ogg")).toBeVisible();
  fireEvent.change(within(resources).getByLabelText("筛选资源类型"), { target: { value: "audio" } });
  expect(within(resources).getByText("assets/audio/theme.ogg")).toBeVisible();
  expect(within(resources).queryByText("assets/ui/logo.png")).not.toBeInTheDocument();
});

test("puts the project tree on the left and hides Godot uid files", async () => {
  const f = fixture({ project: true });
  f.api.documents.mockResolvedValue([]);
  f.api.projectTree.mockResolvedValue([
    { path: "project.godot", kind: "file" },
    { path: "scenes/main.tscn", kind: "file" },
    { path: "scenes/main.tscn.uid", kind: "file" },
  ]);
  render(<DocumentsView api={f.api} projectPath="C:/Godot/lantern" onError={vi.fn()} busy={false} revision={0} category="all" />);
  const tree = await screen.findByRole("tree", { name: "项目树" });
  fireEvent.click(within(tree).getByRole("button", { name: "scenes" }));
  expect(within(tree).getByRole("button", { name: "main.tscn" })).toBeVisible();
  expect(within(tree).queryByRole("button", { name: "main.tscn.uid" })).not.toBeInTheDocument();
  const styles = readFileSync(join(process.cwd(), "src", "renderer", "styles.css"), "utf8");
  expect(styles.match(/\.documents-layout\s*\{([^}]*)\}/)?.[1]).toContain("grid-template-columns: 290px minmax(0, 1fr)");
});

test("renders a preview when selecting a project image", async () => {
  const f = fixture({ project: true });
  f.api.documents.mockResolvedValue([{ path: "art/logo.png", version, size: 12 }]);
  f.api.projectTree.mockResolvedValue([{ path: "art/logo.png", kind: "file" }]);
  const projectFiles = {
    readText: vi.fn(),
    openMedia: vi.fn(async () => ({ id: "logo-lease", url: "http://127.0.0.1:3210/media/logo", kind: "image" as const, mimeType: "image/png", size: 12, generation: "logo-generation" })),
    releaseMedia: vi.fn(async () => undefined),
  };
  render(<DocumentsView api={{ ...f.api, projectFiles }} projectPath="C:/Godot/lantern" onError={vi.fn()} busy={false} revision={0} category="all" />);
  const tree = await screen.findByRole("tree", { name: "项目树" });
  fireEvent.click(within(tree).getByRole("button", { name: "art" }));
  fireEvent.click(within(tree).getByRole("button", { name: "logo.png" }));
  expect(await screen.findByRole("img", { name: "art/logo.png" })).toHaveAttribute("src", "http://127.0.0.1:3210/media/logo");
  expect(projectFiles.openMedia).toHaveBeenCalledWith("C:/Godot/lantern", "art/logo.png");
  expect(f.api.readMaterialImage).not.toHaveBeenCalled();
});



