// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WorkflowView } from "../../src/renderer/WorkflowView";
import type { DesktopApi, OrchestrationsApi, WorkflowApi, WorkflowDefaultsApi } from "../../src/shared/desktop-api";
import { OFFICIAL_WORKFLOW_ID, type OrchestrationDefinition, type OrchestrationRun } from "../../src/shared/orchestration";
import type { WorkflowDefinition } from "../../src/shared/workflow";
import type { WorkflowRun, WorkflowSummary } from "../../src/shared/workflow-api";

const version = `sha256:${"b".repeat(64)}` as const;

const releaseDefinition: WorkflowDefinition = {
  schemaVersion: 1,
  id: "wf_release",
  title: "我的发布审查",
  description: "发布前的人工审查。",
  version: 1,
  inputs: [
    { key: "goal", label: "目标", type: "string", required: true },
    { key: "readPaths", label: "读取范围", type: "paths", required: true },
    { key: "writePaths", label: "修改范围", type: "paths", required: true },
  ],
  nodes: [
    { id: "context", type: "context", label: "读取规范", position: { x: 80, y: 120 }, config: {} },
    { id: "implement", type: "agent", label: "发布实现", position: { x: 260, y: 120 }, config: { access: "write", prompt: "生成发布说明。" } },
    { id: "review", type: "approval", label: "发布审批", position: { x: 440, y: 120 }, config: { allowReject: true } },
  ],
  edges: [
    { id: "e1", from: "context", to: "implement", on: "success" },
    { id: "e2", from: "implement", to: "review", on: "success" },
  ],
  settings: { maxImplementAttempts: 2, approvalPolicy: "manual" },
};

const releaseSummary: WorkflowSummary = {
  id: releaseDefinition.id,
  title: releaseDefinition.title,
  nodeCount: releaseDefinition.nodes.length,
  writeCount: 1,
  definitionVersion: 1,
  fileVersion: version,
};

const orchestration: OrchestrationDefinition = {
  schemaVersion: 1,
  id: "orch_release",
  title: "发布前检查",
  description: "先开发审查，再发布审查。",
  steps: [
    { id: "step_review", workflowId: OFFICIAL_WORKFLOW_ID, approval: "inherit" },
    { id: "step_release", workflowId: "wf_release", approval: "always" },
  ],
};

const orchestrationSummary = {
  id: orchestration.id,
  title: orchestration.title,
  stepCount: orchestration.steps.length,
  fileVersion: version,
};

const childRun: WorkflowRun = {
  schemaVersion: 1,
  runId: "run-1",
  workflowId: OFFICIAL_WORKFLOW_ID,
  title: "官方开发审查",
  workflowVersion: 1,
  definitionSnapshot: { ...releaseDefinition, id: OFFICIAL_WORKFLOW_ID, title: "官方开发审查" },
  inputs: { goal: "发布 v1", readPaths: ["specs"], writePaths: ["specs/release"] },
  status: "waiting_approval",
  nodeStates: [
    { id: "context", type: "context", status: "completed", attempts: 1 },
    { id: "implement", type: "agent", status: "completed", attempts: 1 },
    { id: "review", type: "approval", status: "waiting_approval", attempts: 1 },
  ],
  readTaskIds: [],
  attempts: 1,
  approval: { digest: "sha256:deadbeef" },
  startedAt: "2026-10-18T10:00:00.000Z",
};

const orchestrationRun: OrchestrationRun = {
  schemaVersion: 1,
  orchestrationRunId: "orchrun-1",
  orchestrationId: orchestration.id,
  title: orchestration.title,
  inputs: { goal: "发布 v1", readPaths: ["specs"], writePaths: ["specs/release"] },
  steps: [
    { stepId: "step_review", workflowId: OFFICIAL_WORKFLOW_ID, approval: "inherit", runId: "run-1", status: "waiting_approval" },
    { stepId: "step_release", workflowId: "wf_release", approval: "always", status: "pending" },
  ],
  currentStepIndex: 0,
  status: "waiting_approval",
  startedAt: "2026-10-18T10:00:00.000Z",
};

function workflowApi(): WorkflowApi {
  return {
    list: vi.fn(async () => [releaseSummary]),
    read: vi.fn(async () => ({ definition: releaseDefinition, fileVersion: version, source: "schemaVersion: 1" })),
    save: vi.fn(async () => ({ fileVersion: version })),
    remove: vi.fn(async () => undefined),
    copyOfficial: vi.fn(async () => ({ id: "wf_review_copy", fileVersion: version })),
    start: vi.fn(async () => childRun),
    getRun: vi.fn(async () => childRun),
    listRuns: vi.fn(async () => [childRun]),
    approve: vi.fn(async () => undefined),
    reject: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    onUpdate: vi.fn(() => () => undefined),
    defaults: {
      read: vi.fn(async () => ({ schemaVersion: 1 as const })),
      save: vi.fn(async (settings) => settings),
      clear: vi.fn(async () => ({ schemaVersion: 1 as const })),
    } satisfies WorkflowDefaultsApi,
    onOrchestrationUpdate: vi.fn(() => () => undefined),
  };
}

function orchestrationApi(): OrchestrationsApi {
  return {
    list: vi.fn(async () => [orchestrationSummary]),
    read: vi.fn(async () => ({ definition: orchestration, fileVersion: version, source: "schemaVersion: 1" })),
    save: vi.fn(async () => ({ fileVersion: version })),
    remove: vi.fn(async () => undefined),
    start: vi.fn(async () => orchestrationRun),
    getRun: vi.fn(async () => orchestrationRun),
    listRuns: vi.fn(async () => [orchestrationRun]),
    approveStep: vi.fn(async () => undefined),
    rejectStep: vi.fn(async () => undefined),
    retryStep: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
  };
}

function renderView(): { workflow: WorkflowApi; orchestrations: OrchestrationsApi } {
  const workflow = workflowApi();
  const orchestrations = orchestrationApi();
  workflow.orchestrations = orchestrations;
  const api = { workflow } as unknown as DesktopApi;
  render(<WorkflowView api={api} models={[]} projectPath="E:/demo" onError={vi.fn()} />);
  return { workflow, orchestrations };
}

beforeAll(() => {
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

describe("OrchestrationView", () => {
  it("edits an orchestration: adds, reorders, warns about auto approval and saves", async () => {
    const { orchestrations } = renderView();
    await screen.findByRole("heading", { name: "工作流" });

    fireEvent.click(screen.getByRole("button", { name: "编排" }));

    const editor = await screen.findByRole("region", { name: "编排编辑器" });
    expect(within(editor).getByText("发布前检查")).toBeInTheDocument();
    expect((screen.getByLabelText("步骤 1 工作流") as HTMLSelectElement).value).toBe(OFFICIAL_WORKFLOW_ID);
    expect((screen.getByLabelText("步骤 2 工作流") as HTMLSelectElement).value).toBe("wf_release");

    fireEvent.click(screen.getByRole("button", { name: "添加步骤" }));
    expect(await screen.findByLabelText("步骤 3 工作流")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "上移步骤 2" }));
    await waitFor(() =>
      expect((screen.getByLabelText("步骤 1 工作流") as HTMLSelectElement).value).toBe("wf_release"),
    );
    expect((screen.getByLabelText("步骤 2 工作流") as HTMLSelectElement).value).toBe(OFFICIAL_WORKFLOW_ID);

    fireEvent.change(screen.getByLabelText("步骤 1 审批"), { target: { value: "auto" } });
    expect((await screen.findAllByText("自动批准：该步骤将跳过人工审查。")).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "运行" }));
    fireEvent.change(screen.getByLabelText("运行目标"), { target: { value: "orchestration" } });
    fireEvent.click(await screen.findByRole("button", { name: "保存为编排" }));
    await waitFor(() => expect(orchestrations.save).toHaveBeenCalledTimes(1));
    const [id, content, expectedVersion] = vi.mocked(orchestrations.save).mock.calls[0]!;
    expect(id).toBe("orch_release");
    expect(content).toContain("approval: auto");
    expect(expectedVersion).toBe(version);
  });

  it("runs the orchestration, shows the chain timeline and approves the current child", async () => {
    const { workflow, orchestrations } = renderView();
    await screen.findByRole("heading", { name: "工作流" });

    fireEvent.click(screen.getByRole("button", { name: "运行" }));
    fireEvent.change(screen.getByLabelText("运行目标"), { target: { value: "orchestration" } });

    const panel = await screen.findByRole("region", { name: "编排运行" });
    const timeline = screen.getByRole("region", { name: "编排时间线" });
    expect(within(timeline).getByText("官方开发审查")).toBeInTheDocument();
    expect(within(timeline).getByText("我的发布审查")).toBeInTheDocument();
    expect(within(timeline).getAllByText("待执行").length).toBe(2);

    fireEvent.change(within(panel).getByLabelText("目标"), { target: { value: "发布 v1" } });
    fireEvent.change(within(panel).getByLabelText("读取范围"), { target: { value: "specs" } });
    fireEvent.change(within(panel).getByLabelText("修改范围"), { target: { value: "specs/release" } });
    fireEvent.click(within(panel).getByRole("button", { name: "开始编排" }));

    await waitFor(() =>
      expect(orchestrations.start).toHaveBeenCalledWith("orch_release", {
        goal: "发布 v1",
        readPaths: ["specs"],
        writePaths: ["specs/release"],
      }),
    );
    expect((await screen.findAllByText("第 1 / 2 步")).length).toBeGreaterThan(0);
    expect(workflow.getRun).toHaveBeenCalledWith("run-1");

    const approval = await within(panel).findByRole("button", { name: "批准并记录决策" });
    fireEvent.click(approval);
    await waitFor(() => expect(orchestrations.approveStep).toHaveBeenCalledWith("orchrun-1", "sha256:deadbeef"));
  });

  it("builds a temporary queue in run mode and saves it as an orchestration", async () => {
    const { orchestrations } = renderView();
    await screen.findByRole("heading", { name: "工作流" });

    fireEvent.click(screen.getByRole("button", { name: "运行" }));
    fireEvent.change(screen.getByLabelText("运行目标"), { target: { value: "orchestration" } });

    const list = await screen.findByRole("region", { name: "我的编排" });
    fireEvent.click(within(list).getByRole("button", { name: "新建编排" }));

    const editor = await screen.findByRole("region", { name: "编排编辑器" });
    expect(within(editor).getByText(/还没有步骤/)).toBeInTheDocument();
    fireEvent.click(within(editor).getByRole("button", { name: "添加步骤" }));
    expect(await within(editor).findByLabelText("步骤 1 工作流")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "保存为编排" }));
    await waitFor(() => expect(orchestrations.save).toHaveBeenCalledTimes(1));
    const [id, , expectedVersion] = vi.mocked(orchestrations.save).mock.calls[0]!;
    expect(id).toMatch(/^orch_/);
    expect(expectedVersion).toBe("absent");
  });

  it("keeps the official workflow as the only default and lists no default star for orchestrations", async () => {
    renderView();
    await screen.findByRole("heading", { name: "工作流" });

    const defaults = await screen.findByRole("region", { name: "默认工作流" });
    expect(within(defaults).getByText("全局默认")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编排" }));

    const list = await screen.findByRole("region", { name: "我的编排" });
    expect(within(list).queryByRole("button", { name: /^设为默认：/ })).not.toBeInTheDocument();
  });
});