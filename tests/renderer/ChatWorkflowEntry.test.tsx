// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ChatWorkbench } from "../../src/renderer/chat/ChatWorkbench";
import type { ChatSession, ChatSessionsApi, SessionEvent } from "../../src/shared/chat";
import type { DesktopApi, TaskView, WorkflowApi } from "../../src/shared/desktop-api";
import type { ChangeReview } from "../../src/shared/desktop-api";
import { OFFICIAL_WORKFLOW_ID } from "../../src/shared/orchestration";
import type { WorkflowRun } from "../../src/shared/workflow-api";
import { createBlankWorkflowDefinition } from "../../src/renderer/workflow/useWorkflow";
import { attachmentApi } from "./attachment-fixture";

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

const task = (goal?: string): TaskView => ({
  id: "task-1",
  scope: {
    id: "task-1",
    title: "修复灯塔交互",
    ...(goal === undefined ? {} : { goal }),
    readPaths: ["*"],
    writePaths: ["specs/entities/**"],
    mode: "manual",
    allowDelete: false,
  },
  status: "draft",
  running: false,
  summary: "",
  events: [],
});

const session = (id: string, title: string, taskId?: string): ChatSession => ({
  id, title, createdAt: "1", updatedAt: "1", archived: false, draft: "", draftRevision: 0,
  revision: 1, seq: 0, status: "idle", items: [], ...(taskId ? { taskId } : {}),
});

function run(runId: string): WorkflowRun {
  const definition = createBlankWorkflowDefinition(OFFICIAL_WORKFLOW_ID, "官方开发审查");
  return {
    schemaVersion: 1, runId, workflowId: OFFICIAL_WORKFLOW_ID, title: "官方开发审查", workflowVersion: 1,
    definitionSnapshot: definition, inputs: { goal: "实现", readPaths: ["*"], writePaths: ["specs/entities/**"] },
    status: "waiting_approval", nodeStates: [], readTaskIds: [], attempts: 1,
    approval: { digest: "digest-1" }, startedAt: "2026-10-18T10:00:00.000Z",
  };
}

function fixture(initial: ChatSession[], tasks: TaskView[], options: { defaultWorkflowId?: string } = {}) {
  const records = initial;
  const listeners = new Set<(event: SessionEvent) => void>();
  const api: ChatSessionsApi = {
    list: vi.fn(async () => structuredClone(records)),
    create: vi.fn(async () => session("new", "新会话")),
    patch: vi.fn(async (_root, id, patch) => { const next = records.find((s) => s.id === id)!; Object.assign(next, patch); if (patch.draft !== undefined) next.draftRevision++; next.revision++; return structuredClone(next); }),
    remove: vi.fn(async () => undefined), export: vi.fn(async () => "{}"), import: vi.fn(async () => session("i", "导入")),
    send: vi.fn(async (_root, id) => { const next = records.find((s) => s.id === id)!; return { ...next, status: "completed", revision: next.revision + 1 } as ChatSession; }),
    guide: vi.fn(async (_root, id) => structuredClone(records.find((s) => s.id === id)!)),
    cancel: vi.fn(async () => undefined), answer: vi.fn(async (_root, id) => records.find((s) => s.id === id)!), approve: vi.fn(async (_root, id) => records.find((s) => s.id === id)!),
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    subscribeChanges: () => () => undefined,
  };
  const defaults = {
    read: vi.fn(async () => ({ schemaVersion: 1 as const, ...(options.defaultWorkflowId ? { defaultWorkflowId: options.defaultWorkflowId } : {}) })),
    save: vi.fn(async (settings) => settings),
    clear: vi.fn(async () => ({ schemaVersion: 1 as const })),
  };
  const workflow = {
    list: vi.fn(async () => [{ id: "wf_project", title: "项目审查", nodeCount: 6, writeCount: 1, definitionVersion: 1, fileVersion: "v1" }]),
    read: vi.fn(async () => ({ definition: createBlankWorkflowDefinition("wf_project", "项目审查"), fileVersion: "v1", source: "" })),
    save: vi.fn(async () => ({ fileVersion: "v2" })), remove: vi.fn(async () => undefined),
    copyOfficial: vi.fn(async () => ({ id: "wf_copy", fileVersion: "v1" })),
    start: vi.fn(async () => run("run-started")), getRun: vi.fn(async (runId: string) => run(runId)),
    listRuns: vi.fn(async () => [run("run-task")]),
    approve: vi.fn(async () => undefined), reject: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined),
    startForTask: vi.fn(async () => ({ workflowId: OFFICIAL_WORKFLOW_ID, runId: "run-task", source: "official" as const })),
    startForChat: vi.fn(async () => ({ workflowId: OFFICIAL_WORKFLOW_ID, runId: "run-chat", source: "official" as const })),
    defaults,
    onUpdate: vi.fn(() => () => undefined),
  } satisfies WorkflowApi;
  const onOpenWorkflowRun = vi.fn();
  const onError = vi.fn();
  render(
    <ChatWorkbench
      api={api}
      attachments={attachmentApi()}
      projectPath="P"
      tasks={tasks}
      providers={[{ id: "p", name: "测试", protocol: "openai", baseUrl: "http://test", models: ["m"], modelSettings: { m: { vision: true } }, hasKey: false, keyStorage: "none" }]}
      defaultModel={{ providerId: "p", model: "m" }}
      review={undefined as ChangeReview | undefined}
      busy={false}
      workflow={workflow}
      onOpenWorkflowRun={onOpenWorkflowRun}
      onSelectTask={vi.fn()}
      onNewTask={vi.fn()}
      onReview={vi.fn(async () => undefined)}
      onError={onError}
      onFinished={vi.fn()}
    />,
  );
  return { api, workflow, defaults, onOpenWorkflowRun, onError, records };
}

test("a task session starts its default workflow from the first implementation message", async () => {
  const f = fixture([session("a", "修复灯塔交互", "task-1")], [task("让守灯人靠近灯塔时触发修复")]);
  await screen.findByRole("button", { name: "修复灯塔交互" });
  expect(screen.getByRole("button", { name: "实现" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByText(/默认工作流：官方开发审查/)).toBeVisible();

  fireEvent.change(screen.getByLabelText("任务消息"), { target: { value: "开始实现灯塔交互" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));

  await waitFor(() => expect(f.workflow.startForTask).toHaveBeenCalledWith("task-1", "开始实现灯塔交互"));
  expect(f.api.send).not.toHaveBeenCalled();
  const card = await screen.findByRole("region", { name: "工作流运行" });
  expect(card).toHaveTextContent("官方开发审查");
  fireEvent.click(screen.getByRole("button", { name: "查看运行" }));
  expect(f.onOpenWorkflowRun).toHaveBeenCalledWith("run-task");
});

test("chat implementation without a task scope asks for a compact scope before starting", async () => {
  const f = fixture([session("a", "自由会话")], []);
  await screen.findByRole("button", { name: "自由会话" });
  expect(screen.getByRole("button", { name: "问答" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "实现" }));
  fireEvent.change(screen.getByLabelText("任务消息"), { target: { value: "实现一个守灯人脚本" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));

  const dialog = await screen.findByRole("dialog", { name: "确认实现范围" });
  expect(dialog).toHaveTextContent("实现一个守灯人脚本");
  fireEvent.change(screen.getByLabelText("修改范围"), { target: { value: "scripts" } });
  fireEvent.click(screen.getByRole("button", { name: "开始实现" }));

  await waitFor(() => expect(f.workflow.startForChat).toHaveBeenCalledWith(expect.objectContaining({
    goal: "实现一个守灯人脚本",
    readPaths: ["*"],
    writePaths: ["scripts"],
  })));
  expect(f.api.send).not.toHaveBeenCalled();
  expect(await screen.findByRole("region", { name: "工作流运行" })).toBeVisible();
});

test("chat Q&A keeps the normal agent path", async () => {
  const f = fixture([session("a", "自由会话")], []);
  await screen.findByRole("button", { name: "自由会话" });
  fireEvent.change(screen.getByLabelText("任务消息"), { target: { value: "解释这个项目的结构" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(f.api.send).toHaveBeenCalled());
  expect(f.workflow.startForChat).not.toHaveBeenCalled();
});

test("implementation mode labels a project default workflow", async () => {
  const f = fixture([session("a", "自由会话")], [], { defaultWorkflowId: "wf_project" });
  await screen.findByRole("button", { name: "自由会话" });
  fireEvent.click(screen.getByRole("button", { name: "实现" }));
  await waitFor(() => expect(f.defaults.read).toHaveBeenCalled());
  expect(await screen.findByText(/默认工作流：项目审查/)).toBeVisible();
  expect(screen.getByLabelText("实现工作流")).toBeVisible();
});
