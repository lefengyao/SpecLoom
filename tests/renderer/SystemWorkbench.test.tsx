// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { SystemWorkbench } from "../../src/renderer/SystemWorkbench";
import type { DesktopApi } from "../../src/shared/desktop-api";

const version = `sha256:${"a".repeat(64)}` as const;
const markdown = (data: Record<string, unknown>, body = "") => `---\n${stringify(data)}---\n\n# ${String(data.title ?? data.id)}\n\n${body}`;
const frontMatter = (content: string) => parse(content.split("---")[1]!) as Record<string, unknown>;

const decisionTreeComponent = markdown({
  schemaVersion: 1, id: "decision_tree", title: "决策树", type: "component", scope: "system", description: "",
  fields: [
    { key: "enabled", label: "启用", type: "boolean", default: true },
    { key: "tree", label: "决策树", type: "string", default: "" },
  ],
});
const tree = (id: string, title: string) => markdown({
  schemaVersion: 1, id, title, type: "decision_tree", description: "",
  root: { id: "root", kind: "selector", children: [{ id: "idle", kind: "action", action: "idle" }] },
});
const system = (mounts: unknown[]) => markdown({
  schemaVersion: 1, id: "audio", title: "音频", type: "system", scope: "system", description: "", mounts,
});

function setup(contents: Record<string, string>) {
  const api = {
    documents: vi.fn(async () => Object.keys(contents).map((path) => ({ path, version, size: contents[path]!.length }))),
    readDocument: vi.fn(async (path: string) => ({ path, version, content: contents[path]! })),
    saveDocument: vi.fn(async (_projectPath: string, path: string, content: string, expectedVersion: string) => {
      void expectedVersion;
      contents[path] = content;
      return { path, version, content };
    }),
  };
  Object.defineProperty(window, "specloom", { configurable: true, value: api });
  const view = render(<SystemWorkbench api={api as unknown as DesktopApi} projectPath="C:/Godot/lantern" />);
  return { api, ...view };
}

const mountNode = (container: HTMLElement, key: string): Element => {
  const node = [...container.querySelectorAll(".react-flow__node")].find((element) => element.textContent?.includes(key));
  if (!node) throw new Error(`mount card '${key}' not found`);
  return node;
};

afterEach(() => { cleanup(); window.localStorage.clear(); });

beforeAll(() => {
  // jsdom has neither ResizeObserver nor SVG.getBBox; React Flow needs both.
  vi.stubGlobal("ResizeObserver", class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 900, height: 600, top: 0, left: 0, right: 900, bottom: 600, toJSON: () => ({}) }),
  });
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 40, height: 14 }),
  });
});

describe("SystemWorkbench", () => {
  it("lists systems and shows their mounts on the canvas", async () => {
    const { container } = setup({
      "specs/systems/audio.md": system([{ id: "decision_tree", key: "ai", values: { tree: "combat" } }]),
      "specs/components/decision_tree.md": decisionTreeComponent,
      "specs/decision_trees/combat.md": tree("combat", "战斗决策"),
    });
    const region = await screen.findByRole("region", { name: "系统工作台" });
    fireEvent.click(within(region).getByText("音频"));
    await waitFor(() => expect(container.querySelectorAll(".react-flow__node").length).toBe(2));
    expect(mountNode(container, "ai").textContent).toContain("决策树");
    fireEvent.click(mountNode(container, "ai"));
    expect(screen.getByLabelText("挂载 key")).toHaveValue("ai");
  });

  it("edits a decision tree reference and saves the mounts list", async () => {
    const { api } = setup({
      "specs/systems/audio.md": system([{ id: "decision_tree", key: "ai", values: { tree: "combat" } }]),
      "specs/components/decision_tree.md": decisionTreeComponent,
      "specs/decision_trees/combat.md": tree("combat", "战斗决策"),
      "specs/decision_trees/patrol.md": tree("patrol", "巡逻决策"),
    });
    const region = await screen.findByRole("region", { name: "系统工作台" });
    fireEvent.click(within(region).getByText("音频"));
    await waitFor(() => expect(region.querySelectorAll(".react-flow__node").length).toBe(2));
    fireEvent.click(mountNode(region as HTMLElement, "ai"));
    fireEvent.change(screen.getByLabelText("挂载决策树"), { target: { value: "patrol" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.saveDocument).toHaveBeenCalledTimes(1));
    const mounts = frontMatter(api.saveDocument.mock.calls[0]![2]).mounts as { id: string; key: string; values: { tree: string } }[];
    expect(mounts).toEqual([{ id: "decision_tree", key: "ai", values: { tree: "patrol" } }]);
  });

  it("adds a mount from the component browser", async () => {
    const { api } = setup({
      "specs/systems/audio.md": system([]),
      "specs/components/decision_tree.md": decisionTreeComponent,
      "specs/decision_trees/combat.md": tree("combat", "战斗决策"),
    });
    const region = await screen.findByRole("region", { name: "系统工作台" });
    fireEvent.click(within(region).getByText("音频"));
    fireEvent.click(await screen.findByRole("button", { name: "添加挂载" }));
    const dialog = await screen.findByRole("dialog", { name: "添加组件" });
    fireEvent.click(within(dialog).getByRole("button", { name: /决策树/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "添加" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.saveDocument).toHaveBeenCalledTimes(1));
    const mounts = frontMatter(api.saveDocument.mock.calls[0]![2]).mounts as { id: string; key: string }[];
    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toMatchObject({ id: "decision_tree", key: "decision_tree_1" });
  });
});
