// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { MaterialRelationshipGraph } from "../../src/renderer/MaterialRelationshipGraph";
import { materialTree, type MaterialSummary } from "../../src/renderer/materials-model";

afterEach(cleanup);
function material(id: string, title: string, extra: Partial<MaterialSummary> = {}): MaterialSummary {
  return { id, title, path: `specs/entities/${id}.md`, type: "enemy", version: "1", content: "", fields: [], components: [], ...extra };
}
const root = material("root", "巡逻兵", { description: "基础敌人", groupPath: "基础实体 / 敌人" });
const child = material("child", "近战巡逻兵", { parent: "root", groupPath: "关卡 / 前院", extends: "template" });
const deep = material("deep", "精英巡逻兵", { parent: "child" });
const materials = [root, child, deep];

test("nodes show metadata, direct parent and group path and select through material paths", () => {
  const onSelect = vi.fn();
  const view = render(<MaterialRelationshipGraph tree={materialTree(materials)} materials={materials} category="entity" selectedPath={child.path} onSelect={onSelect} />);
  const selected = screen.getByRole("button", { name: "查看 近战巡逻兵" });
  expect(selected).toHaveAttribute("aria-pressed", "true");
  expect(within(selected).getByText("敌人")).toBeVisible();
  expect(within(selected).getByText("父级资料：巡逻兵")).toBeVisible();
  expect(within(selected).getByText("所属分组：关卡 / 前院")).toBeVisible();
  expect(screen.getByText("根资料")).toBeVisible();
  expect(screen.getByText("基础敌人")).toBeVisible();
  expect(view.container.querySelectorAll(".material-graph-edge")).toHaveLength(1);
  fireEvent.click(selected);
  expect(onSelect).toHaveBeenCalledWith(child.path);
});

test("shows component source across one parent tree and keeps context ancestors selectable", () => {
  const official = material("state_machine", "状态机基类", { path: "specs/components/state_machine.md", type: "component" });
  const custom = material("custom", "玩家状态机", { path: "specs/components/custom.md", type: "component", parent: "state_machine" });
  const tree = materialTree([official, custom]);
  tree[0]!.contextOnly = true;
  const onSelect = vi.fn();
  render(<MaterialRelationshipGraph tree={tree} materials={[official, custom]} category="component" onSelect={onSelect} />);
  const context = screen.getByRole("button", { name: "查看 状态机基类" });
  expect(context.closest(".material-graph-node")).toHaveClass("context-only");
  expect(within(context).getByText("路径上下文")).toBeVisible();
  expect(within(context).getByText("官方组件")).toBeVisible();
  expect(within(screen.getByRole("button", { name: "查看 玩家状态机" })).getByText("自定义组件")).toBeVisible();
  fireEvent.click(context);
  expect(onSelect).toHaveBeenCalledWith(official.path);
});

test("collapses branches locally and reveals the selected descendant path", () => {
  const view = render(<MaterialRelationshipGraph tree={materialTree(materials)} materials={materials} onSelect={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "查看 精英巡逻兵" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "收起 巡逻兵" }));
  expect(screen.queryByRole("button", { name: "查看 近战巡逻兵" })).not.toBeInTheDocument();
  expect(view.container.querySelectorAll(".material-graph-edge")).toHaveLength(0);
  view.rerender(<MaterialRelationshipGraph tree={materialTree(materials)} materials={materials} selectedPath={deep.path} onSelect={vi.fn()} />);
  expect(screen.getByRole("button", { name: "查看 精英巡逻兵" })).toBeVisible();
});

test("controlled expansion reports the next keys and follows the supplied state", () => {
  const onExpandedKeysChange = vi.fn();
  const tree = materialTree(materials);
  const view = render(<MaterialRelationshipGraph tree={tree} materials={materials} expandedKeys={new Set([root.path])} onExpandedKeysChange={onExpandedKeysChange} onSelect={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "展开 近战巡逻兵" }));
  expect(onExpandedKeysChange).toHaveBeenCalledWith(new Set([root.path, child.path]));
  expect(screen.queryByRole("button", { name: "查看 精英巡逻兵" })).not.toBeInTheDocument();
  view.rerender(<MaterialRelationshipGraph tree={tree} materials={materials} expandedKeys={new Set([root.path, child.path])} onExpandedKeysChange={onExpandedKeysChange} onSelect={vi.fn()} />);
  expect(screen.getByRole("button", { name: "查看 精英巡逻兵" })).toBeVisible();
});

test("repair lists select every error and unparsed material without drawing invalid edges", () => {
  const bad = material("bad", "丢失父级", { parent: "missing" });
  const badChild = material("badChild", "错误分支后代", { parent: "bad" });
  const unparsed = material("unparsed", "损坏资料", { invalid: true });
  const onSelect = vi.fn();
  const view = render(<MaterialRelationshipGraph tree={materialTree([root, bad, badChild, unparsed])} materials={[root, bad, badChild, unparsed]} onSelect={onSelect} />);
  expect(view.container.querySelectorAll(".material-graph-node")).toHaveLength(1);
  expect(view.container.querySelectorAll(".material-graph-edge")).toHaveLength(0);
  for (const [label, title, path] of [["关系错误", "丢失父级", bad.path], ["关系错误", "错误分支后代", badChild.path], ["未归类", "损坏资料", unparsed.path]] as const) {
    fireEvent.click(within(screen.getByRole("region", { name: label })).getByRole("button", { name: `查看 ${title}` }));
    expect(onSelect).toHaveBeenLastCalledWith(path);
  }
});

test("fit and zoom change only the local canvas and reset local scroll position", () => {
  render(<MaterialRelationshipGraph tree={materialTree(materials)} materials={materials} onSelect={vi.fn()} />);
  const viewport = screen.getByRole("region", { name: "父级关系画布" });
  Object.defineProperties(viewport, { clientWidth: { value: 360, configurable: true }, clientHeight: { value: 300, configurable: true } });
  expect(screen.getByLabelText("关系图缩放比例")).toHaveTextContent("100%");
  fireEvent.click(screen.getByRole("button", { name: "放大关系图" }));
  expect(screen.getByLabelText("关系图缩放比例")).toHaveTextContent("120%");
  fireEvent.click(screen.getByRole("button", { name: "缩小关系图" }));
  expect(screen.getByLabelText("关系图缩放比例")).toHaveTextContent("100%");
  viewport.scrollLeft = 80;
  viewport.scrollTop = 40;
  fireEvent.click(screen.getByRole("button", { name: "适配视图" }));
  expect(Number(screen.getByLabelText("关系图缩放比例").textContent!.replace("%", ""))).toBeLessThan(100);
  expect(viewport.scrollLeft).toBe(0);
  expect(viewport.scrollTop).toBe(0);
});

test("mouse wheel zooms toward the pointer location", () => {
  render(<MaterialRelationshipGraph tree={materialTree(materials)} materials={materials} onSelect={vi.fn()} />);
  const viewport = screen.getByRole("region", { name: "父级关系画布" });
  Object.defineProperties(viewport, {
    clientWidth: { value: 360, configurable: true },
    clientHeight: { value: 300, configurable: true },
    scrollLeft: { value: 100, writable: true, configurable: true },
    scrollTop: { value: 60, writable: true, configurable: true },
    getBoundingClientRect: { value: () => ({ left: 50, top: 20, right: 410, bottom: 320, width: 360, height: 300, x: 50, y: 20, toJSON: () => ({}) }), configurable: true },
  });

  fireEvent.wheel(viewport, { deltaY: -100, clientX: 150, clientY: 100 });

  expect(Number(screen.getByLabelText("关系图缩放比例").textContent!.replace("%", ""))).toBeGreaterThan(100);
  const zoom = Number(viewport.querySelector<HTMLElement>(".material-graph-canvas")!.style.transform.match(/[\d.]+/)![0]);
  expect(viewport.scrollLeft).toBeCloseTo(200 * zoom - 100, 5);
  expect(viewport.scrollTop).toBeCloseTo(140 * zoom - 80, 5);
});

test("fit accommodates large graphs that require a scale below ten percent", () => {
  const largeCatalog = Array.from({ length: 30 }, (_, index) => material(`root-${index}`, `根资料 ${index}`));
  render(<MaterialRelationshipGraph tree={materialTree(largeCatalog)} materials={largeCatalog} onSelect={vi.fn()} />);
  const viewport = screen.getByRole("region", { name: "父级关系画布" });
  Object.defineProperties(viewport, { clientWidth: { value: 360, configurable: true }, clientHeight: { value: 480, configurable: true } });
  fireEvent.click(screen.getByRole("button", { name: "适配视图" }));
  expect(screen.getByLabelText("关系图缩放比例")).toHaveTextContent("8%");
  const scrollArea = viewport.querySelector<HTMLElement>(".material-graph-scroll-area")!;
  expect(parseFloat(scrollArea.style.width)).toBeLessThanOrEqual(viewport.clientWidth);
  expect(parseFloat(scrollArea.style.height)).toBeLessThanOrEqual(viewport.clientHeight);
});

test("canvas pans internally with the pointer and keyboard and remains bounded in CSS", () => {
  render(<MaterialRelationshipGraph tree={materialTree(materials)} materials={materials} onSelect={vi.fn()} />);
  const viewport = screen.getByRole("region", { name: "父级关系画布" });
  expect(viewport).toHaveAttribute("tabindex", "0");
  viewport.scrollLeft = 100;
  viewport.scrollTop = 100;
  fireEvent.keyDown(viewport, { key: "ArrowRight" });
  expect(viewport.scrollLeft).toBeGreaterThan(100);
  fireEvent.pointerDown(viewport, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 70, clientY: 80 });
  fireEvent.pointerUp(viewport, { pointerId: 1 });
  expect(viewport.scrollLeft).toBeGreaterThan(140);
  expect(viewport.scrollTop).toBe(120);
  const css = readFileSync(join(process.cwd(), "src/renderer/navigation-materials.css"), "utf8");
  const rule = css.match(/\.material-graph-viewport\s*\{([^}]*)\}/)![1]!;
  expect(rule).toContain("overflow: auto");
  expect(rule).toContain("overscroll-behavior: contain");
  expect(rule).toContain("height:");
  expect(rule).toContain("max-width: 100%");
});

test("controlled selection requests all selected ancestors without changing caller state", () => {
  const onExpandedKeysChange = vi.fn();
  const keys = new Set<string>();
  const tree = materialTree(materials);
  render(<MaterialRelationshipGraph tree={tree} materials={materials} selectedPath={deep.path} expandedKeys={keys} onExpandedKeysChange={onExpandedKeysChange} onSelect={vi.fn()} />);
  expect(onExpandedKeysChange).toHaveBeenCalledWith(new Set([root.path, child.path]));
  expect(keys.size).toBe(0);
});

test("node buttons remain clickable while canvas panning is enabled", () => {
  const onSelect = vi.fn();
  render(<MaterialRelationshipGraph tree={materialTree(materials)} materials={materials} onSelect={onSelect} />);
  const viewport = screen.getByRole("region", { name: "父级关系画布" });
  const node = screen.getByRole("button", { name: "查看 巡逻兵" });
  viewport.scrollLeft = 100;
  fireEvent.pointerDown(node, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 70, clientY: 80 });
  fireEvent.pointerUp(node, { pointerId: 1 });
  fireEvent.click(node);
  expect(viewport.scrollLeft).toBe(100);
  expect(onSelect).toHaveBeenCalledWith(root.path);
});

test("provides node metadata to assistive technology", () => {
  render(<MaterialRelationshipGraph tree={materialTree(materials)} materials={materials} category="entity" onSelect={vi.fn()} />);
  expect(screen.getByRole("button", { name: "查看 近战巡逻兵" })).toHaveAccessibleDescription(/实体类型：敌人.*父级资料：巡逻兵.*所属分组：关卡 \/ 前院/);
});
