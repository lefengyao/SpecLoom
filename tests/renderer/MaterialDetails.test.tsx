// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MaterialDetails } from "../../src/renderer/MaterialDetails";
import type { MaterialSummary } from "../../src/shared/material-catalog";

afterEach(cleanup);

const summary = (id: string, title: string, type: string, directory: string) => ({
  id, title, type, path: `specs/${directory}/${id}.md`, version: "sha256:x", content: "", fields: [], components: [],
}) as unknown as MaterialSummary;

const doc = (data: Record<string, unknown>) => ({ data, body: "\n# Doc\n" });
const renderDetails = (data: Record<string, unknown>, catalog: MaterialSummary[], onChange = vi.fn()) => {
  render(<MaterialDetails material={doc(data)} catalog={catalog} onChange={onChange} disabled={false} />);
  return onChange;
};

describe("structured editors for system, feature and decision specs", () => {
  const catalog = [
    summary("combat", "战斗系统", "system", "systems"),
    summary("vitality", "生命", "component", "components"),
    summary("keeper", "守灯人", "entity", "entities"),
    summary("armor-slots", "防具槽功能", "feature", "features"),
    summary("0001-shared-combat", "共享战斗实体", "decision", "decisions"),
    summary("0002-old", "旧决策", "decision", "decisions"),
  ];

  it("adds and removes component references on a system", () => {
    const added = renderDetails({ schemaVersion: 1, id: "combat", title: "战斗系统", type: "system", description: "" }, catalog);
    fireEvent.click(screen.getByRole("checkbox", { name: "引用的组件 生命" }));
    expect(added.mock.calls.at(-1)![0]).toMatchObject({ components: ["vitality"] });
    cleanup();
    const removed = renderDetails({ schemaVersion: 1, id: "combat", title: "战斗系统", type: "system", description: "", components: ["vitality", "keeper"] }, catalog);
    fireEvent.click(screen.getByRole("checkbox", { name: "引用的组件 生命" }));
    expect(removed.mock.calls.at(-1)![0]).toMatchObject({ components: ["keeper"] });
  });

  it("changes the feature status and links systems", () => {
    const onChange = renderDetails({ schemaVersion: 1, id: "armor-slots", title: "防具槽功能", type: "feature", status: "planned", description: "" }, catalog);
    fireEvent.change(screen.getByLabelText("功能状态"), { target: { value: "done" } });
    expect(onChange.mock.calls.at(-1)![0]).toMatchObject({ status: "done" });
    fireEvent.click(screen.getByRole("checkbox", { name: "关联系统 战斗系统" }));
    expect(onChange.mock.calls.at(-1)![0]).toMatchObject({ systems: ["combat"] });
  });

  it("links a decision to systems and to the decision it supersedes", () => {
    const onChange = renderDetails({ schemaVersion: 1, id: "0001-shared-combat", title: "共享战斗实体", type: "decision", status: "accepted", description: "" }, catalog);
    fireEvent.click(screen.getByRole("checkbox", { name: "影响的系统 战斗系统" }));
    expect(onChange.mock.calls.at(-1)![0]).toMatchObject({ affectedSystems: ["combat"] });
    fireEvent.change(screen.getByLabelText("取代的决策"), { target: { value: "0002-old" } });
    expect(onChange.mock.calls.at(-1)![0]).toMatchObject({ supersedes: "0002-old" });
  });

  it("sets and clears the scene file of an entity", () => {
    const set = renderDetails({ schemaVersion: 1, id: "keeper", title: "守灯人", type: "entity", description: "" }, catalog);
    fireEvent.change(screen.getByLabelText("场景文件"), { target: { value: "entities/keeper/keeper.tscn" } });
    expect(set.mock.calls.at(-1)![0]).toMatchObject({ scene: "entities/keeper/keeper.tscn" });
    cleanup();
    const cleared = renderDetails({ schemaVersion: 1, id: "keeper", title: "守灯人", type: "entity", description: "", scene: "entities/keeper/keeper.tscn" }, catalog);
    fireEvent.change(screen.getByLabelText("场景文件"), { target: { value: "" } });
    expect(cleared.mock.calls.at(-1)![0]).not.toHaveProperty("scene");
  });

  it("mounts a decision tree instance on a system", () => {
    const systemCatalog = [...catalog, summary("combat_tree", "战斗决策", "decision_tree", "decision_trees")];
    const onChange = renderDetails({ schemaVersion: 1, id: "combat", title: "战斗系统", type: "system", description: "" }, systemCatalog);
    fireEvent.click(screen.getByRole("button", { name: "挂载决策树" }));
    expect(onChange.mock.calls.at(-1)![0]).toMatchObject({ mounts: [{ id: "decision_tree", key: "tree_1", values: { tree: "combat_tree" } }] });
  });

  it("names a component instance with a key", () => {
    const entityCatalog = [...catalog, summary("health", "生命", "component", "components")];
    const onChange = renderDetails({ schemaVersion: 1, id: "keeper", title: "守灯人", type: "entity", description: "", components: [{ id: "health", values: {} }] }, entityCatalog);
    fireEvent.change(screen.getByLabelText("生命 的实例 key"), { target: { value: "tank" } });
    expect(onChange.mock.calls.at(-1)![0]).toMatchObject({ components: [{ id: "health", values: {}, key: "tank" }] });
  });

  it("declares signals on an entity and lists the trees listening to them", () => {
    const signalCatalog = [
      summary("combat_entity", "战斗实体", "entity", "entities"),
      { ...summary("combat_decision", "战斗决策", "decision_tree", "decision_trees"), treeSignals: ["combat_entity"] } as unknown as MaterialSummary,
    ];
    const onChange = renderDetails({ schemaVersion: 1, id: "combat_entity", title: "战斗实体", type: "entity", description: "" }, signalCatalog);
    fireEvent.click(screen.getByRole("button", { name: "添加信号" }));
    expect(onChange.mock.calls.at(-1)![0]).toMatchObject({ signals: ["signal_raised"] });
    const section = screen.getByRole("region", { name: "被引用" });
    expect(within(section).getByText("战斗决策")).toBeInTheDocument();
  });

  it("marks an official system with a badge", () => {
    renderDetails({ schemaVersion: 1, id: "audio", title: "音频", type: "system", scope: "system", description: "" }, [summary("audio", "音频", "system", "systems")]);
    expect(screen.getAllByText("官方").length).toBeGreaterThan(0);
  });

  it("edits audio buses on the audio system and locks built-ins", () => {
    const audioCatalog = [summary("audio", "音频", "system", "systems")];
    const onChange = renderDetails({
      schemaVersion: 1, id: "audio", title: "音频", type: "system", description: "",
      buses: [{ name: "master", volume: 1 }, { name: "music", parent: "master", volume: 1 }, { name: "sfx", parent: "master", volume: 1 }],
      events: [],
    }, audioCatalog);
    expect(screen.getByLabelText("总线名称 1")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "添加总线" }));
    const buses = (onChange.mock.calls.at(-1)![0] as { buses: { name: string }[] }).buses;
    expect(buses.map((bus) => bus.name)).toContain("bus_4");
    fireEvent.click(screen.getByRole("button", { name: "添加事件" }));
    const events = (onChange.mock.calls.at(-1)![0] as { events: { id: string; bus: string }[] }).events;
    expect(events[0]).toMatchObject({ id: "event_1", bus: "sfx" });
  });

  it("lists the systems and decision trees that reference a component", () => {
    const componentCatalog = [
      summary("vitality", "生命", "component", "components"),
      { ...summary("combat", "战斗系统", "system", "systems"), uses: ["vitality"] } as unknown as MaterialSummary,
      { ...summary("combat_tree", "战斗决策", "decision_tree", "decision_trees"), treeComponents: ["vitality"] } as unknown as MaterialSummary,
    ];
    render(<MaterialDetails material={doc({ schemaVersion: 1, id: "vitality", title: "生命", type: "component", description: "", fields: [] })} catalog={componentCatalog} onChange={vi.fn()} disabled={false} />);
    const section = screen.getByRole("region", { name: "被引用" });
    expect(within(section).getByText("战斗系统")).toBeInTheDocument();
    expect(within(section).getByText("战斗决策")).toBeInTheDocument();
  });

  it("lists the entities and systems a decision tree is mounted on", () => {
    const treeCatalog = [
      summary("combat_tree", "战斗决策", "decision_tree", "decision_trees"),
      { ...summary("keeper", "守灯人", "entity", "entities"), components: [{ id: "decision_tree", key: "ai", values: { tree: "combat_tree" }, notes: [] }] } as unknown as MaterialSummary,
      { ...summary("ai_system", "AI 系统", "system", "systems"), mounts: [{ id: "decision_tree", key: "ai", values: { tree: "combat_tree" }, notes: [] }] } as unknown as MaterialSummary,
    ];
    render(<MaterialDetails material={doc({ schemaVersion: 1, id: "combat_tree", title: "战斗决策", type: "decision_tree", description: "" })} catalog={treeCatalog} onChange={vi.fn()} disabled={false} />);
    const section = screen.getByRole("region", { name: "被引用" });
    expect(within(section).getByText("守灯人")).toBeInTheDocument();
    expect(within(section).getByText("AI 系统")).toBeInTheDocument();
  });
});
