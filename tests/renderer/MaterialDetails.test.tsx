// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
});
