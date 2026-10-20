// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { EntityWorkbench } from "../../src/renderer/EntityWorkbench";
import {
  ENTITY_CENTER,
  defaultEntityPositions,
  loadEntityLayout,
  pruneEntityLayout,
  saveEntityLayout,
  validateEntityLayout,
} from "../../src/renderer/entity-layout";
import type { DesktopApi } from "../../src/shared/desktop-api";

const version = `sha256:${"a".repeat(64)}` as const;

const markdown = (data: Record<string, unknown>, body = "") => `---\n${stringify(data)}---\n\n# ${String(data.title ?? data.id)}\n\n${body}`;
const entityFile = (id: string, title: string, extra: Record<string, unknown> = {}) =>
  markdown({
    schemaVersion: 1,
    id,
    title,
    type: "entity",
    status: "draft",
    version: 1,
    relations: [],
    source: "developer",
    components: [],
    ...extra,
  });
const componentFile = (id: string, title: string, fields: { key: string; label: string; type: string; default: unknown }[]) =>
  markdown({ schemaVersion: 1, id, title, type: "component", description: "", fields });

const healthFields = [
  { key: "current", label: "当前值", type: "number", default: 100 },
  { key: "max", label: "上限", type: "number", default: 100 },
];
const speedFields = [{ key: "value", label: "速度值", type: "number", default: 180 }];

const frontMatter = (content: string) => parse(content.split("---")[1]!) as Record<string, unknown>;

function setup(contents: Record<string, string>) {
  const api = {
    documents: vi.fn(async () =>
      Object.keys(contents).map((path) => ({ path, version, size: contents[path]!.length })),
    ),
    readDocument: vi.fn(async (path: string) => ({ path, version, content: contents[path]! })),
    saveDocument: vi.fn(async (_projectPath: string, path: string, content: string, _expectedVersion: string) => {
      contents[path] = content;
      return { path, version, content };
    }),
  };
  Object.defineProperty(window, "specloom", { configurable: true, value: api });
  const view = render(<EntityWorkbench api={api as unknown as DesktopApi} projectPath="C:/Godot/lantern" />);
  return { api, ...view };
}

beforeAll(() => {
  // jsdom has neither ResizeObserver nor SVG.getBBox; React Flow needs both.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 900, height: 600, top: 0, left: 0, right: 900, bottom: 600, toJSON: () => ({}) }),
  });
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 40, height: 14 }),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("EntityWorkbench", () => {
  it("renders the entity tree, component library and canvas, then saves an edited field", async () => {
    const { api } = setup({
      "specs/entities/keeper.md": entityFile("keeper", "守灯人", {
        components: [{ id: "health", values: { current: 80 } }],
      }),
      "specs/components/health.md": componentFile("health", "生命", healthFields),
    });

    const entities = await screen.findByRole("complementary", { name: "实体列表" });
    expect(await within(entities).findByText("实体 1 · 组件 1")).toBeInTheDocument();
    expect(within(entities).getByRole("button", { name: /守灯人/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "打开组件栏" }));
    const library = screen.getByRole("complementary", { name: "组件库" });
    const libraryItem = within(library).getByRole("button", { name: /生命/ });
    expect(libraryItem).toHaveAccessibleName(/2 个字段/);
    expect(libraryItem).toHaveAccessibleName(/已添加/);

    const canvas = screen.getByRole("region", { name: "实体画布" });
    expect(await within(canvas).findByText("守灯人")).toBeInTheDocument();
    expect(within(canvas).getByText("生命")).toBeInTheDocument();

    fireEvent.click(within(entities).getByRole("button", { name: /守灯人/ }));
    fireEvent.click(within(canvas).getByLabelText("选择组件 生命"));

    const inspector = screen.getByRole("complementary", { name: "组件检查器" });
    expect(within(inspector).getByText("本实体")).toBeInTheDocument();
    expect(within(inspector).getByLabelText("当前值")).toHaveValue(80);
    expect(within(inspector).getByLabelText("上限")).toHaveValue(100);
    expect(within(inspector).getByRole("progressbar", { name: "当前值 范围" })).toBeInTheDocument();
    expect(within(inspector).getAllByText(/^数值 · 默认 100$/)).toHaveLength(2);

    fireEvent.change(within(inspector).getByLabelText("当前值"), { target: { value: "90" } });
    expect(within(inspector).getByLabelText("当前值")).toHaveValue(90);

    const save = screen.getByRole("button", { name: "保存资料" });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() => expect(api.saveDocument).toHaveBeenCalledTimes(1));
    const [projectArgument, pathArgument, contentArgument, versionArgument] = api.saveDocument.mock.calls[0]!;
    expect(projectArgument).toBe("C:/Godot/lantern");
    expect(pathArgument).toBe("specs/entities/keeper.md");
    expect(versionArgument).toBe(version);
    expect(frontMatter(contentArgument).components).toEqual([{ id: "health", values: { current: 90 } }]);
    await waitFor(() => expect(screen.getByRole("button", { name: "保存资料" })).toBeDisabled());
  });

  it("adds a library component with defaults, saves it, then removes it again", async () => {
    const { api } = setup({
      "specs/entities/keeper.md": entityFile("keeper", "守灯人", {
        components: [{ id: "health", values: { current: 80 } }],
      }),
      "specs/components/health.md": componentFile("health", "生命", healthFields),
      "specs/components/speed.md": componentFile("speed", "速度", speedFields),
    });

    fireEvent.click(await screen.findByRole("button", { name: "打开组件栏" }));
    const library = await screen.findByRole("complementary", { name: "组件库" });
    fireEvent.click(await within(library).findByRole("button", { name: /速度/ }));

    const canvas = screen.getByRole("region", { name: "实体画布" });
    expect(within(canvas).getByText("速度")).toBeInTheDocument();

    const inspector = screen.getByRole("complementary", { name: "组件检查器" });
    expect(within(inspector).getByText("本实体")).toBeInTheDocument();
    expect(within(inspector).getByLabelText("速度值")).toHaveValue(180);

    fireEvent.click(screen.getByRole("button", { name: "保存资料" }));
    await waitFor(() => expect(api.saveDocument).toHaveBeenCalledTimes(1));
    expect(frontMatter(api.saveDocument.mock.calls[0]![2]).components).toEqual([
      { id: "health", values: { current: 80 } },
      { id: "speed", values: { value: 180 } },
    ]);

    fireEvent.click(within(inspector).getByRole("button", { name: "移除组件" }));
    expect(within(canvas).queryByText("速度")).not.toBeInTheDocument();
    expect(within(inspector).getByText("选择画布中的组件查看字段")).toBeInTheDocument();

    const save = screen.getByRole("button", { name: "保存资料" });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(api.saveDocument).toHaveBeenCalledTimes(2));
    expect(frontMatter(api.saveDocument.mock.calls[1]![2]).components).toEqual([{ id: "health", values: { current: 80 } }]);
  });

  it("shows inherited components read-only until they are overridden", async () => {
    const { api } = setup({
      "specs/entities/base.md": entityFile("base", "守夜人", {
        components: [{ id: "health", values: { current: 60, max: 120 } }],
      }),
      "specs/entities/keeper.md": entityFile("keeper", "守灯人", { extends: "base", components: [] }),
      "specs/components/health.md": componentFile("health", "生命", healthFields),
    });

    const entities = await screen.findByRole("complementary", { name: "实体列表" });
    fireEvent.click(await within(entities).findByRole("button", { name: /守灯人/ }));

    const canvas = screen.getByRole("region", { name: "实体画布" });
    expect(await within(canvas).findByText("生命")).toBeInTheDocument();
    expect(within(canvas).getByText("继承")).toBeInTheDocument();
    expect(within(canvas).getByTitle("继承自 守夜人")).toBeInTheDocument();

    fireEvent.click(within(canvas).getByLabelText("选择组件 生命"));

    const inspector = screen.getByRole("complementary", { name: "组件检查器" });
    expect(within(inspector).getByText("继承自 守夜人")).toBeInTheDocument();
    const inheritedCurrent = within(inspector).getByLabelText("当前值");
    expect(inheritedCurrent).toBeDisabled();
    expect(inheritedCurrent).toHaveValue(60);
    expect(within(inspector).getByLabelText("上限")).toBeDisabled();
    expect(within(inspector).getByLabelText("上限")).toHaveValue(120);

    fireEvent.click(within(inspector).getByRole("button", { name: "覆盖继承组件" }));
    expect(within(inspector).getByText("本实体")).toBeInTheDocument();
    expect(within(inspector).queryByRole("button", { name: "覆盖继承组件" })).not.toBeInTheDocument();
    const ownCurrent = within(inspector).getByLabelText("当前值");
    expect(ownCurrent).toBeEnabled();
    expect(ownCurrent).toHaveValue(60);

    fireEvent.change(ownCurrent, { target: { value: "70" } });
    fireEvent.click(screen.getByRole("button", { name: "保存资料" }));
    await waitFor(() => expect(api.saveDocument).toHaveBeenCalledTimes(1));
    const [projectArgument, pathArgument, contentArgument] = api.saveDocument.mock.calls[0]!;
    expect(projectArgument).toBe("C:/Godot/lantern");
    expect(pathArgument).toBe("specs/entities/keeper.md");
    expect(frontMatter(contentArgument)).toMatchObject({
      id: "keeper",
      extends: "base",
      components: [{ id: "health", values: { current: 70, max: 120 } }],
    });
  });
});

describe("entity layout helpers", () => {
  it("validates untrusted JSON and persists one layout per project", () => {
    saveEntityLayout("C:/Godot/lantern", { keeper: { health: { x: 10, y: 20 } } });
    expect(loadEntityLayout("C:/Godot/lantern")).toEqual({ keeper: { health: { x: 10, y: 20 } } });
    expect(window.localStorage.getItem("specloom.entity-layouts.C:/Godot/lantern")).toContain("health");
    expect(loadEntityLayout("C:/Godot/other")).toEqual({});

    window.localStorage.setItem("specloom.entity-layouts.bad", "{not json");
    expect(loadEntityLayout("bad")).toEqual({});
    expect(
      validateEntityLayout({
        keeper: { health: { x: 1, y: 2 }, broken: { x: "1", y: 2 }, missing: null },
        junk: [],
      }),
    ).toEqual({ keeper: { health: { x: 1, y: 2 } } });
  });

  it("places components deterministically around the center and prunes orphans", () => {
    const ids = ["health", "speed", "inventory"];
    const first = defaultEntityPositions("keeper", ids);
    expect(defaultEntityPositions("keeper", ids)).toEqual(first);
    expect(Object.keys(first).sort()).toEqual([...ids].sort());
    expect(new Set(Object.values(first).map((point) => `${point.x}:${point.y}`)).size).toBe(ids.length);
    for (const point of Object.values(first)) {
      expect(Math.hypot(point.x - ENTITY_CENTER.x, point.y - ENTITY_CENTER.y)).toBeGreaterThan(150);
    }

    const single = defaultEntityPositions("keeper", ["health"]);
    expect(single.health?.x).toBe(ENTITY_CENTER.x);
    expect(single.health?.y).toBeLessThan(ENTITY_CENTER.y);
    expect(defaultEntityPositions("keeper", [])).toEqual({});

    const pruned = pruneEntityLayout(
      {
        keeper: { health: { x: 1, y: 2 }, speed: { x: 3, y: 4 } },
        other: { health: { x: 5, y: 6 } },
      },
      "keeper",
      ["health"],
    );
    expect(pruned).toEqual({ keeper: { health: { x: 1, y: 2 } }, other: { health: { x: 5, y: 6 } } });
    expect(pruneEntityLayout({ keeper: { health: { x: 1, y: 2 } } }, "keeper", [])).toEqual({});
  });
});
