// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { EntityWorkbench } from "../../src/renderer/EntityWorkbench";
import {
  CARD_GAP,
  COMPONENT_CARD_SIZE,
  ENTITY_CARD_SIZE,
  ENTITY_ORIGIN,
  ENTITY_SELF_LAYOUT_ID,
  defaultEntityPositions,
  loadEntityLayout,
  pruneEntityLayout,
  rectOf,
  rectsOverlap,
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
const componentFile = (id: string, title: string, fields: { key: string; label: string; type: string; default: unknown }[], extra: Record<string, unknown> = {}) =>
  markdown({ schemaVersion: 1, id, title, type: "component", description: "", fields, ...extra });

const healthFields = [
  { key: "current", label: "当前值", type: "number", default: 100 },
  { key: "max", label: "上限", type: "number", default: 100 },
];
const speedFields = [{ key: "value", label: "速度值", type: "number", default: 180 }];

const frontMatter = (content: string) => parse(content.split("---")[1]!) as Record<string, unknown>;

function setup(contents: Record<string, string>, options: { imageUrl?: string; onOpenDetail?: (path: string) => void } = {}) {
  const api = {
    documents: vi.fn(async () =>
      Object.keys(contents).map((path) => ({ path, version, size: contents[path]!.length })),
    ),
    readDocument: vi.fn(async (path: string) => ({ path, version, content: contents[path]! })),
    readMaterialImage: vi.fn(async () => options.imageUrl ?? "data:image/png;base64,AAAA"),
    saveDocument: vi.fn(async (_projectPath: string, path: string, content: string, expectedVersion: string) => {
      void expectedVersion;
      contents[path] = content;
      return { path, version, content };
    }),
  };
  Object.defineProperty(window, "specloom", { configurable: true, value: api });
  const view = render(
    <EntityWorkbench
      api={api as unknown as DesktopApi}
      projectPath="C:/Godot/lantern"
      {...(options.onOpenDetail ? { onOpenDetail: options.onOpenDetail } : {})}
    />,
  );
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

    fireEvent.click(screen.getByRole("button", { name: "添加组件" }));
    const library = screen.getByRole("dialog", { name: "创建组件" });
    const libraryItem = within(library).getByRole("button", { name: /生命/ });
    expect(libraryItem).toHaveAccessibleName(/已添加/);
    expect(within(library).getByText("current")).toBeInTheDocument();
    expect(within(library).getByText("max")).toBeInTheDocument();
    fireEvent.click(within(library).getByRole("button", { name: "取消" }));

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

  it("adds itemized binding notes and saves them on the entity", async () => {
    const { api } = setup({
      "specs/entities/keeper.md": entityFile("keeper", "守灯人", { components: [{ id: "health", values: { current: 80 } }] }),
      "specs/components/health.md": componentFile("health", "生命", healthFields),
    });
    const canvas = await screen.findByRole("region", { name: "实体画布" });
    fireEvent.click(await within(canvas).findByLabelText("选择组件 生命"));
    const inspector = await screen.findByRole("complementary", { name: "组件检查器" });
    fireEvent.click(within(inspector).getByRole("button", { name: "添加描述" }));
    fireEvent.change(within(inspector).getByLabelText("描述 1"), { target: { value: "生命值不得为负" } });
    fireEvent.click(screen.getByRole("button", { name: "保存资料" }));
    await waitFor(() => expect(api.saveDocument).toHaveBeenCalledOnce());
    expect(frontMatter(api.saveDocument.mock.calls[0]![2]).components).toEqual([
      { id: "health", values: { current: 80 }, notes: ["生命值不得为负"] },
    ]);
  });

  it("shows component description and markdown notes in the inspector and browser", async () => {
    setup({
      "specs/entities/keeper.md": entityFile("keeper", "守灯人", { components: [{ id: "health", values: { current: 80 } }] }),
      "specs/components/health.md": markdown(
        { schemaVersion: 1, id: "health", title: "生命", type: "component", description: "生命值组件。", notes: ["当前生命不得低于 0。"], fields: healthFields },
        "## 行为契约\n\n- 生命归零时离场。",
      ),
    });
    const canvas = await screen.findByRole("region", { name: "实体画布" });
    fireEvent.click(await within(canvas).findByLabelText("选择组件 生命"));
    const inspector = await screen.findByRole("complementary", { name: "组件检查器" });
    expect(within(inspector).getByText("生命值组件。")).toBeInTheDocument();
    expect(within(inspector).getByText("当前生命不得低于 0。")).toBeInTheDocument();
    expect(within(inspector).getByText(/生命归零时离场/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "添加组件" }));
    const browser = await screen.findByRole("dialog", { name: "创建组件" });
    expect(within(browser).getByText("当前生命不得低于 0。")).toBeInTheDocument();
    expect(within(browser).getByText(/生命归零时离场/)).toBeInTheDocument();
  });

  it("groups the component browser by material group, then by inheritance", async () => {
    setup({
      "specs/entities/keeper.md": entityFile("keeper", "守灯人"),
      "specs/project.md": markdown({ schemaVersion: 1, id: "project", title: "项目", type: "project", materialGroups: { component: [
        { id: "base-group", name: "基础组件", order: 0 },
        { id: "weapon-group", name: "武器组件", order: 1 },
      ] } }),
      "specs/components/base.md": componentFile("base", "基础", healthFields, { groupId: "base-group" }),
      "specs/components/child.md": componentFile("child", "派生", [], { groupId: "base-group", extends: "base" }),
      "specs/components/weapon.md": componentFile("weapon", "武器", [], { groupId: "weapon-group" }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "添加组件" }));
    const library = await screen.findByRole("dialog", { name: "创建组件" });
    expect(within(library).getAllByText("基础组件").length).toBeGreaterThan(0);
    expect(within(library).getAllByText("武器组件").length).toBeGreaterThan(0);
    expect(within(library).getByRole("button", { name: /基础/ })).toHaveAttribute("data-depth", "0");
    expect(within(library).getByRole("button", { name: /派生/ })).toHaveAttribute("data-depth", "1");
    expect(within(library).getByRole("button", { name: /武器/ })).toHaveAttribute("data-depth", "0");
  });

  it("shows entity details in the side panel and opens the full editor on demand", async () => {
    const onOpenDetail = vi.fn();
    setup({ "specs/entities/keeper.md": entityFile("keeper", "守灯人", { description: "持灯的人" }) }, { onOpenDetail });
    const canvas = await screen.findByRole("region", { name: "实体画布" });
    fireEvent.click(await within(canvas).findByText("守灯人"));
    const panel = await screen.findByRole("complementary", { name: "实体详情" });
    expect(within(panel).getByText("specs/entities/keeper.md")).toBeInTheDocument();
    expect(within(panel).getByText("持灯的人")).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "详情" }));
    expect(onOpenDetail).toHaveBeenCalledWith("specs/entities/keeper.md");
  });

  it("opens the full component editor from the inspector button", async () => {
    const onOpenDetail = vi.fn();
    setup({
      "specs/entities/keeper.md": entityFile("keeper", "守灯人", { components: [{ id: "health", values: { current: 80 } }] }),
      "specs/components/health.md": componentFile("health", "生命", healthFields),
    }, { onOpenDetail });
    const canvas = await screen.findByRole("region", { name: "实体画布" });
    fireEvent.click(await within(canvas).findByLabelText("选择组件 生命"));
    const inspector = await screen.findByRole("complementary", { name: "组件检查器" });
    fireEvent.click(within(inspector).getByRole("button", { name: "详情" }));
    expect(onOpenDetail).toHaveBeenCalledWith("specs/components/health.md");
  });

  it("selects a component in place and shows its details in the sidebar inspector", async () => {
    setup({
      "specs/entities/keeper.md": entityFile("keeper", "守灯人", { components: [{ id: "health", values: { current: 80 } }] }),
      "specs/components/health.md": componentFile("health", "生命", healthFields),
    });
    const canvas = await screen.findByRole("region", { name: "实体画布" });
    fireEvent.click(await within(canvas).findByLabelText("选择组件 生命"));
    const inspector = await screen.findByRole("complementary", { name: "组件检查器" });
    expect(within(inspector).getByText("本实体")).toBeInTheDocument();
    expect(within(inspector).getByLabelText("当前值")).toHaveValue(80);
  });

  it("shows declared anchors and where each component mounts", async () => {
    setup({
      "specs/entities/keeper.md": entityFile("keeper", "守灯人", {
        anchors: [{ name: "head", node: "Visual/Head" }],
        components: [{ id: "armor_class_1", mount: { parent: "__entity__", anchor: "head" } }],
      }),
      "specs/components/armor_class_1.md": componentFile("armor_class_1", "一类防具", healthFields, { anchors: [{ name: "slot_1" }] }),
    });
    const canvas = await screen.findByRole("region", { name: "实体画布" });
    await within(canvas).findByLabelText("选择组件 一类防具");
    expect(canvas.querySelector(".ewb-card-mount")?.textContent).toContain("head");
    const anchorLabels = [...canvas.querySelectorAll(".ewb-card-spec-anchors")].map((element) => element.textContent ?? "");
    expect(anchorLabels.some((text) => text.includes("head"))).toBe(true);
    expect(anchorLabels.some((text) => text.includes("slot_1"))).toBe(true);
  });

  it("flags overlapping cards and re-arranges them into a collision-free layout", async () => {
    window.localStorage.clear();
    saveEntityLayout("C:/Godot/lantern", { keeper: {
      [ENTITY_SELF_LAYOUT_ID]: { x: 0, y: 0, size: { width: 280, height: 180 } },
      health: { x: 10, y: 10 },
      speed: { x: 20, y: 20 },
    } });
    setup({
      "specs/entities/keeper.md": entityFile("keeper", "守灯人", { components: [{ id: "health", values: { current: 80 } }, { id: "speed", values: { value: 180 } }] }),
      "specs/components/health.md": componentFile("health", "生命", healthFields),
      "specs/components/speed.md": componentFile("speed", "速度", speedFields),
    });
    const canvas = await screen.findByRole("region", { name: "实体画布" });
    await within(canvas).findByLabelText("选择组件 生命");
    expect(document.querySelectorAll(".react-flow__node.ewb-overlap").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "自动整理组件" }));
    const payload = JSON.parse(window.localStorage.getItem("specloom.entity-layouts.C:/Godot/lantern")!);
    const keeper = payload.entities.keeper as Record<string, { x: number; y: number; size?: { width: number; height: number } }>;
    expect(keeper[ENTITY_SELF_LAYOUT_ID]).toMatchObject({ x: 0, y: 0 });
    const rects = Object.entries(keeper).map(([id, entry]) => rectOf(entry, id === ENTITY_SELF_LAYOUT_ID ? ENTITY_CARD_SIZE : COMPONENT_CARD_SIZE));
    for (const [index, rect] of rects.entries()) {
      for (const [other, otherRect] of rects.entries()) {
        if (index !== other) expect(rectsOverlap(rect, otherRect)).toBe(false);
      }
    }
  });

  it("adds a custom anchor and assigns both connection ends", async () => {
    setup({
      "specs/entities/keeper.md": entityFile("keeper", "守灯人", { components: [{ id: "health", values: { current: 80 } }] }),
      "specs/components/health.md": componentFile("health", "生命", healthFields),
    });
    const canvas = await screen.findByRole("region", { name: "实体画布" });
    fireEvent.click(await within(canvas).findByLabelText("选择组件 生命"));
    const inspector = await screen.findByRole("complementary", { name: "组件检查器" });
    fireEvent.change(within(inspector).getByLabelText("实体侧"), { target: { value: "left" } });
    fireEvent.click(within(inspector).getByRole("button", { name: "添加锚点" }));
    const target = within(inspector).getByLabelText("组件侧") as HTMLSelectElement;
    const custom = [...target.options].find((option) => option.value.startsWith("custom-"));
    expect(custom).toBeDefined();
    fireEvent.change(target, { target: { value: custom!.value } });

    const payload = JSON.parse(window.localStorage.getItem("specloom.entity-layouts.C:/Godot/lantern")!);
    expect(payload.entities.keeper.health).toMatchObject({
      sourceAnchor: "left",
      targetAnchor: custom!.value,
      anchors: [expect.objectContaining({ id: custom!.value, side: "right", offset: 25 })],
    });
    expect(within(inspector).getAllByText("右侧 25%").length).toBeGreaterThan(0);
  });

  it("shows the entity illustration with a resizable preview and a hide toggle", async () => {
    setup(
      { "specs/entities/keeper.md": entityFile("keeper", "守灯人", { image: "assets/specloom/materials/art.png" }) },
      { imageUrl: "data:image/png;base64,AAAA" },
    );
    const canvas = await screen.findByRole("region", { name: "实体画布" });
    const image = await within(canvas).findByAltText("守灯人配图");
    expect(image).toHaveAttribute("src", "data:image/png;base64,AAAA");
    fireEvent.change(screen.getByLabelText("配图大小"), { target: { value: "240" } });
    expect(image).toHaveStyle({ maxHeight: "240px" });
    fireEvent.click(screen.getByRole("button", { name: "配图" }));
    expect(within(canvas).queryByAltText("守灯人配图")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "配图" })).toHaveAttribute("aria-pressed", "false");
  });

  it("adds a library component with defaults, saves it, then removes it again", async () => {
    const { api } = setup({
      "specs/entities/keeper.md": entityFile("keeper", "守灯人", {
        components: [{ id: "health", values: { current: 80 } }],
      }),
      "specs/components/health.md": componentFile("health", "生命", healthFields),
      "specs/components/speed.md": componentFile("speed", "速度", speedFields),
    });

    fireEvent.click(await screen.findByRole("button", { name: "添加组件" }));
    const library = await screen.findByRole("dialog", { name: "创建组件" });
    fireEvent.click(await within(library).findByRole("button", { name: /速度/ }));
    fireEvent.click(within(library).getByRole("button", { name: "创建" }));

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
    expect(await screen.findByRole("complementary", { name: "实体详情" })).toBeInTheDocument();

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
    const keeperButton = await within(entities).findByRole("button", { name: /守灯人/ });
    expect(keeperButton).toHaveAccessibleName(/继承自 守夜人/);
    expect(keeperButton).toHaveAttribute("title", expect.stringContaining("继承自 守夜人"));
    fireEvent.click(keeperButton);

    const canvas = screen.getByRole("region", { name: "实体画布" });
    expect(await within(canvas).findByText("生命")).toBeInTheDocument();
    expect(within(canvas).getByText("继承")).toBeInTheDocument();
    expect(within(canvas).getAllByTitle("继承自 守夜人").length).toBeGreaterThan(0);

    fireEvent.click(within(canvas).getByLabelText("选择组件 生命"));

    const inspector = screen.getByRole("complementary", { name: "组件检查器" });
    expect(within(inspector).getByText("继承自 守夜人")).toBeInTheDocument();
    const inheritedCurrent = within(inspector).getByLabelText("当前值");
    expect(inheritedCurrent).toBeEnabled();
    expect(inheritedCurrent).toHaveValue(60);
    expect(within(inspector).getByLabelText("上限")).toBeEnabled();
    expect(within(inspector).getByLabelText("上限")).toHaveValue(120);

    fireEvent.change(inheritedCurrent, { target: { value: "70" } });
    expect(within(inspector).getByText("本实体")).toBeInTheDocument();
    expect(within(inspector).queryByRole("button", { name: "覆盖继承组件" })).not.toBeInTheDocument();
    expect(within(inspector).getByLabelText("当前值")).toHaveValue(70);
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
    const anchored = validateEntityLayout({
      keeper: { health: {
        x: 1, y: 2, sourceAnchor: "left", targetAnchor: "custom-right",
        anchors: [
          { id: "custom-right", side: "right", offset: 30 },
          { id: "custom-right", side: "left", offset: 40 },
          { id: "bad", side: "diagonal", offset: 20 },
        ],
      } },
    });
    expect(anchored).toEqual({ keeper: { health: {
      x: 1, y: 2, sourceAnchor: "left", targetAnchor: "custom-right",
      anchors: [{ id: "custom-right", side: "right", offset: 30 }],
    } } });
    expect(pruneEntityLayout(anchored, "keeper", ["health"])).toEqual(anchored);
  });

  it("places components deterministically around the origin and prunes orphans", () => {
    const ids = ["health", "speed", "inventory"];
    const first = defaultEntityPositions(ids);
    expect(defaultEntityPositions(ids)).toEqual(first);
    expect(Object.keys(first).sort()).toEqual([...ids].sort());
    expect(new Set(Object.values(first).map((point) => `${point.x}:${point.y}`)).size).toBe(ids.length);
    const entity = rectOf(ENTITY_ORIGIN, ENTITY_CARD_SIZE);
    for (const point of Object.values(first)) {
      expect(rectsOverlap(rectOf(point, COMPONENT_CARD_SIZE), entity)).toBe(false);
      expect(point.x).toBeGreaterThanOrEqual(ENTITY_CARD_SIZE.width + CARD_GAP);
    }

    const single = defaultEntityPositions(["health"]);
    expect(single.health?.x).toBeGreaterThanOrEqual(ENTITY_CARD_SIZE.width + CARD_GAP);
    expect(single.health?.y).toBe(0);
    expect(defaultEntityPositions([])).toEqual({});

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
