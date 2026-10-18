// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import App from "../../src/renderer/App";
import { DocumentsView } from "../../src/renderer/DocumentsView";
import { writeMaterial } from "../../src/shared/project-materials";
import { fixture, version } from "./fixtures";
import type { DesktopApi } from "../../src/shared/desktop-api";

afterEach(() => { cleanup(); localStorage.clear(); });

test("collapses the navigation, preserves the composer, and remembers the choice after reopening", async () => {
  fixture({ project: true });
  const first = render(<App />);
  const input = await screen.findByLabelText("任务消息");
  fireEvent.change(input, { target: { value: "收起导航时保留的草稿" } });
  fireEvent.click(screen.getByRole("button", { name: "收起导航" }));
  expect(screen.getByRole("button", { name: "展开导航" })).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByRole("navigation", { name: "项目视图" }).closest("aside")).toHaveClass("is-collapsed");
  fireEvent.click(screen.getByRole("button", { name: "组件" }));
  await screen.findByRole("region", { name: "资料浏览器" });
  fireEvent.click(screen.getByRole("button", { name: "工作区" }));
  expect(screen.getByLabelText("任务消息")).toBe(input);
  expect(input).toHaveValue("收起导航时保留的草稿");
  first.unmount();
  render(<App />);
  const expand = await screen.findByRole("button", { name: "展开导航" });
  expect(expand).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(expand);
  expect(screen.getByRole("button", { name: "收起导航" })).toHaveAttribute("aria-expanded", "true");
});

test("returns to visited documents immediately with the same editor and no repeated disk scan", async () => {
  const f = fixture({ project: true });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "规范" }));
  fireEvent.click(await screen.findByRole("button", { name: "查看 outline.md" }, { timeout: 5000 }));
  const editor = await screen.findByLabelText("文档内容");
  fireEvent.change(editor, { target: { value: "# 仍在编辑的草稿" } });
  const scans = f.api.documents.mock.calls.length;
  const reads = f.api.readDocument.mock.calls.length;
  fireEvent.click(screen.getAllByRole("button", { name: "设置" })[0]!);
  fireEvent.click(screen.getByRole("button", { name: "规范" }));
  expect(screen.getByLabelText("文档内容")).toBe(editor);
  expect(editor).toHaveValue("# 仍在编辑的草稿");
  await waitFor(() => expect(f.api.documents).toHaveBeenCalledTimes(scans));
  expect(f.api.readDocument).toHaveBeenCalledTimes(reads);
});

test("reuses catalog versions across categories while checking the selected file version", async () => {
  const f = fixture({ project: true });
  const files = {
    "specs/entities/hero.md": writeMaterial({ id: "hero", title: "主角", type: "entity", components: [] }, ""),
    "specs/components/health.md": writeMaterial({ id: "health", title: "生命", type: "component", fields: [] }, ""),
  };
  f.api.documents.mockResolvedValue(Object.entries(files).map(([path, content]) => ({ path, version, size: content.length })));
  f.api.readDocument.mockImplementation(async (path) => ({ path, version, content: files[path as keyof typeof files]! }));
  const props = { api: f.api, projectPath: "C:/Godot/lantern", busy: false, revision: 0, onError: vi.fn() };
  const { rerender } = render(<DocumentsView {...props} category="entity" />);
  fireEvent.click(await screen.findByRole("button", { name: "查看 主角" }));
  await screen.findByLabelText("名称");
  expect(f.api.readDocument).toHaveBeenCalledTimes(3);
  rerender(<DocumentsView {...props} category="component" />);
  await screen.findByRole("button", { name: "查看 生命" });
  expect(f.api.documents).toHaveBeenCalledOnce();
  expect(f.api.projectTree).toHaveBeenCalledOnce();
  expect(f.api.readDocument).toHaveBeenCalledTimes(3);
  rerender(<DocumentsView {...props} category="entity" />);
  await screen.findByRole("button", { name: "查看 主角" });
  expect(f.api.documents).toHaveBeenCalledOnce();
  expect(f.api.readDocument).toHaveBeenCalledTimes(3);
});

test("shows source badges without source section roots in the component semantic tree", async () => {
  const f = fixture({ project: true });
  const path = "specs/components/state_machine.md";
  const content = writeMaterial({ id: "state_machine", title: "状态机基类", type: "component", fields: [] }, "");
  const childPath = "specs/components/custom.md";
  const childContent = writeMaterial({ id: "custom", title: "自定义后代", type: "component", parent: "state_machine", fields: [] }, "");
  f.api.documents.mockResolvedValue([{ path, version, size: content.length }, { path: childPath, version, size: childContent.length }]);
  f.api.readDocument.mockImplementation(async (requested) => ({ path: requested, version, content: requested === path ? content : childContent }));
  render(<DocumentsView api={f.api} projectPath="C:/Godot/lantern" onError={vi.fn()} busy={false} revision={0} category="component" />);
  await screen.findByRole("button", { name: "查看 状态机基类" });
  expect(screen.queryByRole("heading", { name: "官方组件" })).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "自定义组件" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "查看 状态机基类" })).toHaveTextContent("官方组件");
  fireEvent.click(screen.getByRole("button", { name: "项目树" }));
  const tree = screen.getByRole("tree", { name: "组件库" });
  expect(within(tree).queryByRole("button", { name: "官方组件" })).not.toBeInTheDocument();
  expect(within(tree).queryByRole("button", { name: "自定义组件" })).not.toBeInTheDocument();
  expect(within(tree).getByRole("button", { name: "状态机基类" })).toBeVisible();
  fireEvent.click(within(tree).getByRole("button", { name: "展开 状态机基类" }));
  const parent = within(tree).getByRole("button", { name: "状态机基类" }).closest("li")!;
  expect(within(parent).getByRole("button", { name: "自定义后代" })).toBeVisible();
});

test("switches loaded material modes without more disk reads and keeps the open editor", async () => {
  const f = fixture({ project: true });
  render(<DocumentsView api={f.api} projectPath="C:/Godot/lantern" onError={vi.fn()} busy={false} revision={0} category="spec" />);
  fireEvent.click(await screen.findByRole("button", { name: "查看 outline.md" }));
  const editor = await screen.findByLabelText("文档内容");
  const calls = [f.api.documents.mock.calls.length, f.api.projectTree.mock.calls.length, f.api.readDocument.mock.calls.length];
  fireEvent.change(screen.getByLabelText("搜索资料"), { target: { value: "outline" } });
  for (const mode of ["关系图显示", "图标显示", "列表显示"]) {
    fireEvent.click(screen.getByRole("button", { name: mode }));
    expect(screen.getByLabelText("文档内容")).toBe(editor);
    expect(screen.getByRole("button", { name: "查看 outline.md" })).toHaveAttribute("aria-pressed", "true");
  }
  expect([f.api.documents.mock.calls.length, f.api.projectTree.mock.calls.length, f.api.readDocument.mock.calls.length]).toEqual(calls);
});

test("defers hidden material writes and refreshes once on return", async () => {
  const f = fixture({ project: true });
  let receive!: Parameters<NonNullable<DesktopApi["onMaterialChanged"]>>[0];
  const api = { ...f.api, onMaterialChanged: (listener: typeof receive) => { receive = listener; return () => undefined; } };
  const props = { api, projectPath: "C:/Godot/lantern", busy: false, revision: 0, onError: vi.fn(), category: "spec" as const };
  const view = render(<DocumentsView {...props} active />);
  await screen.findByRole("button", { name: "查看 outline.md" });
  const scans = f.api.documents.mock.calls.length;
  view.rerender(<DocumentsView {...props} active={false} />);
  act(() => { for (let index = 0; index < 20; index++) receive({ projectPath: props.projectPath, path: `specs/change-${index}.md`, version }); });
  expect(f.api.documents).toHaveBeenCalledTimes(scans);
  view.rerender(<DocumentsView {...props} active />);
  await waitFor(() => expect(f.api.documents).toHaveBeenCalledTimes(scans + 1));
  expect(f.api.projectTree).toHaveBeenCalledTimes(scans + 1);
});
