// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WorkflowView } from "../../src/renderer/WorkflowView";
import type { DesktopApi, WorkflowApi } from "../../src/shared/desktop-api";
import type { WorkflowDefinition } from "../../src/shared/workflow";
import type { WorkflowRun, WorkflowSummary } from "../../src/shared/workflow-api";

const version = `sha256:${"a".repeat(64)}` as const;

const definition: WorkflowDefinition = {
  schemaVersion: 1,
  id: "wf_official_development_review",
  title: "官方开发审查",
  description: "读取规范、规划、实现、校验、人工审查并记录决策。",
  version: 1,
  inputs: [
    { key: "goal", label: "目标", type: "string", required: true },
    { key: "readPaths", label: "读取范围", type: "paths", required: true },
    { key: "writePaths", label: "修改范围", type: "paths", required: true },
    { key: "model", label: "模型", type: "model", required: false },
  ],
  nodes: [
    { id: "context", type: "context", label: "读取规范", position: { x: 80, y: 120 }, config: {} },
    { id: "plan", type: "agent", label: "规划", position: { x: 260, y: 120 }, config: { access: "read", prompt: "阅读运行范围内的项目资料，输出可执行的实现计划；不得修改文件。" } },
    { id: "implement", type: "agent", label: "Agent 实现", position: { x: 440, y: 120 }, config: { access: "write", prompt: "根据目标和计划实现改动；只写 writePaths 允许的路径；完成后总结改动与验证建议。" } },
    { id: "validate", type: "validation", label: "自动校验", position: { x: 620, y: 120 }, config: {} },
    { id: "review", type: "approval", label: "人工审查", position: { x: 800, y: 120 }, config: { allowReject: true } },
    { id: "decide", type: "decision", label: "记录决策", position: { x: 980, y: 120 }, config: { directory: "specs/decisions" } },
  ],
  edges: [
    { id: "e1", from: "context", to: "plan", on: "success" },
    { id: "e2", from: "plan", to: "implement", on: "success" },
    { id: "e3", from: "implement", to: "validate", on: "success" },
    { id: "e4", from: "validate", to: "review", on: "success" },
    { id: "e5", from: "review", to: "decide", on: "success" },
    { id: "e6", from: "review", to: "implement", on: "reject" },
  ],
  settings: { maxImplementAttempts: 3 },
};

const summary: WorkflowSummary = {
  id: definition.id,
  title: definition.title,
  nodeCount: definition.nodes.length,
  writeCount: 1,
  definitionVersion: 1,
  fileVersion: version,
};

const run: WorkflowRun = {
  schemaVersion: 1,
  runId: "run-1",
  workflowId: definition.id,
  title: definition.title,
  workflowVersion: 1,
  definitionSnapshot: definition,
  inputs: { goal: "实现守灯人移动", readPaths: ["specs"], writePaths: ["specs/entities"] },
  status: "running",
  nodeStates: definition.nodes.map((node) => ({ id: node.id, type: node.type, status: "pending", attempts: 0 })),
  readTaskIds: [],
  attempts: 1,
  startedAt: "2026-10-18T10:00:00.000Z",
};

function workflowApi(): WorkflowApi {
  return {
    list: vi.fn(async () => [summary]),
    read: vi.fn(async () => ({ definition, fileVersion: version, source: "schemaVersion: 1" })),
    save: vi.fn(async () => ({ fileVersion: version })),
    remove: vi.fn(async () => undefined),
    copyOfficial: vi.fn(async () => ({ id: "wf_review_test", fileVersion: version })),
    start: vi.fn(async () => run),
    getRun: vi.fn(async () => run),
    listRuns: vi.fn(async () => [run]),
    approve: vi.fn(async () => undefined),
    reject: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    onUpdate: vi.fn(() => () => undefined),
  };
}

function renderView(): WorkflowApi {
  const workflow = workflowApi();
  const api = { workflow } as unknown as DesktopApi;
  render(<WorkflowView api={api} models={[]} projectPath="E:/demo" onError={vi.fn()} />);
  return workflow;
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
});

describe("WorkflowView", () => {
  it("renders the official six-node definition in build mode", async () => {
    const workflow = renderView();

    expect(screen.getByRole("heading", { name: "工作流" })).toBeInTheDocument();
    expect(screen.getByText("官方开发审查流程可复制、可编辑、可运行")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "编排" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "运行" })).toBeInTheDocument();

    expect(await screen.findByText("Agent 实现")).toBeInTheDocument();
    expect(screen.getByText("读取规范")).toBeInTheDocument();
    expect(screen.getByText("自动校验")).toBeInTheDocument();
    expect(screen.getByText("人工审查")).toBeInTheDocument();
    expect(screen.getByText("记录决策")).toBeInTheDocument();
    expect(workflow.list).toHaveBeenCalledTimes(1);
    expect(workflow.read).toHaveBeenCalledWith(definition.id);
  });

  it("switches to run mode and shows the run inputs", async () => {
    renderView();
    await screen.findByText("Agent 实现");

    fireEvent.click(screen.getByRole("button", { name: "运行" }));

    expect(screen.getByRole("button", { name: "运行" })).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByLabelText("目标")).toBeInTheDocument();
    expect(screen.getByLabelText("读取范围")).toBeInTheDocument();
    expect(screen.getByLabelText("修改范围")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始运行" })).toBeInTheDocument();
  });

  it("shows the agent fields when a canvas node is selected", async () => {
    renderView();

    const label = await screen.findByText("Agent 实现");
    const node = label.closest(".react-flow__node");
    fireEvent.click(node ?? label);

    expect(await screen.findByLabelText("访问")).toHaveValue("write");
    expect((screen.getByLabelText("提示词") as HTMLTextAreaElement).value).toContain("根据目标");
    expect(screen.getByText("implement")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("标签"), { target: { value: "Agent 实现（改）" } });
    expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();
    expect(screen.getByText("未保存")).toBeInTheDocument();
  });

  it("shows recent runs and opens the selected history run", async () => {
    renderView();
    await screen.findByText("Agent 实现");

    const history = screen.getByRole("region", { name: "最近运行" });
    expect(within(history).getByText("运行中", { exact: false })).toBeInTheDocument();
    fireEvent.click(within(history).getByRole("button"));

    expect(screen.getByRole("button", { name: "运行" })).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByLabelText("目标")).toBeInTheDocument();
  });

  it("adds and removes a read-only agent while editing", async () => {
    renderView();
    await screen.findByText("Agent 实现");

    fireEvent.click(screen.getByRole("button", { name: /添加只读 Agent/ }));
    expect(await screen.findByText("只读 Agent")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "删除只读 Agent" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "删除只读 Agent" }));
    await waitFor(() => expect(screen.queryByText("只读 Agent")).not.toBeInTheDocument());
  });

  it("deletes the selected workflow after confirmation", async () => {
    const workflow = renderView();
    await screen.findByText("Agent 实现");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    fireEvent.click(screen.getByRole("button", { name: "删除" }));

    await waitFor(() => expect(workflow.remove).toHaveBeenCalledWith(definition.id, version));
    expect(confirm).toHaveBeenCalled();
  });
});
