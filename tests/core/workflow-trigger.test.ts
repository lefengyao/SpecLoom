import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MAX_TASK_GOAL_LENGTH, TaskScopeSpecSchema, type TaskScopeSpec } from "../../src/shared/contracts";
import { OFFICIAL_WORKFLOW_ID, type WorkflowSettings } from "../../src/shared/orchestration";
import type { WorkflowDefinition } from "../../src/shared/workflow";
import type { WorkflowRun, WorkflowRunInputs } from "../../src/shared/workflow-api";
import { ProjectError } from "../../src/main/core/errors";
import { ProjectCore } from "../../src/main/core/project-core";
import { TaskScope } from "../../src/main/core/task-scope";
import {
  TASK_BINDINGS_RELATIVE_PATH,
  taskGoal,
  WorkflowTrigger,
  type WorkflowTriggerService,
} from "../../src/main/core/workflow-trigger";

const roots: string[] = [];
async function tempRoot(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "specloom-workflow-trigger-"));
  roots.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** Smallest B workflow that passes validateWorkflowDefinition. */
function definition(id: string): WorkflowDefinition {
  const position = { x: 0, y: 0 };
  return {
    schemaVersion: 1,
    id,
    title: "工作流 " + id,
    description: "",
    version: 1,
    inputs: [],
    nodes: [
      { id: "context", type: "context", label: "读取", position, config: {} },
      { id: "plan", type: "agent", label: "规划", position, config: { access: "read", prompt: "plan" } },
      { id: "implement", type: "agent", label: "实现", position, config: { access: "write", prompt: "implement" } },
      { id: "validate", type: "validation", label: "校验", position, config: {} },
      { id: "review", type: "approval", label: "审查", position, config: { allowReject: true } },
      { id: "decide", type: "decision", label: "记录", position, config: { directory: "specs/decisions" } },
    ],
    edges: [
      { id: "e1", from: "context", to: "plan", on: "success" },
      { id: "e2", from: "plan", to: "implement", on: "success" },
      { id: "e3", from: "implement", to: "validate", on: "success" },
      { id: "e4", from: "validate", to: "review", on: "success" },
      { id: "e5", from: "review", to: "decide", on: "success" },
    ],
    settings: { maxImplementAttempts: 3, approvalPolicy: "manual" },
  };
}

const OFFICIAL = definition(OFFICIAL_WORKFLOW_ID);
const PROJECT = definition("wf_custom");
const OTHER = definition("wf_other");

function scopeSpec(overrides: Partial<TaskScopeSpec> = {}): TaskScopeSpec {
  return {
    id: "task-1",
    title: "Implement the hero",
    readPaths: ["specs/**"],
    writePaths: ["specs/entities/**"],
    allowDelete: false,
    mode: "manual",
    ...overrides,
  };
}

function bindingsFile(root: string): string {
  return path.join(root, ...TASK_BINDINGS_RELATIVE_PATH.split("/"));
}

type StoredBindings = {
  schemaVersion: number;
  bindings: Record<string, { runId: string; workflowId: string; source: string }>;
};

async function readBindings(root: string): Promise<StoredBindings> {
  return JSON.parse(await readFile(bindingsFile(root), "utf8")) as StoredBindings;
}

/** In-memory WorkflowService double; the trigger never needs a real runner. */
class FakeWorkflowService implements WorkflowTriggerService {
  settings: WorkflowSettings = { schemaVersion: 1 };
  readonly definitions = new Map<string, WorkflowDefinition>();
  readonly started: { definition: WorkflowDefinition; inputs: WorkflowRunInputs }[] = [];
  readonly runs = new Map<string, WorkflowRun>();
  /** Not part of the trigger contract; recorded to prove the trigger never approves. */
  readonly approvals: string[] = [];
  private sequence = 0;

  constructor() {
    for (const item of [OFFICIAL, PROJECT, OTHER]) this.definitions.set(item.id, item);
  }

  async defaultsRead(): Promise<WorkflowSettings> {
    return this.settings;
  }

  async read(id: string): Promise<{ definition: WorkflowDefinition }> {
    const found = this.definitions.get(id);
    if (!found) throw new ProjectError("FILE_NOT_FOUND", "Unknown workflow: " + id);
    return { definition: found };
  }

  async start(definitionToStart: WorkflowDefinition, inputs: WorkflowRunInputs): Promise<WorkflowRun> {
    const run: WorkflowRun = {
      schemaVersion: 1,
      runId: "run-" + (++this.sequence),
      workflowId: definitionToStart.id,
      title: definitionToStart.title,
      workflowVersion: definitionToStart.version,
      definitionSnapshot: definitionToStart,
      inputs,
      status: "waiting_approval",
      nodeStates: [],
      readTaskIds: [],
      attempts: 0,
      startedAt: "2026-10-18T00:00:00.000Z",
    };
    this.started.push({ definition: definitionToStart, inputs });
    this.runs.set(run.runId, run);
    return run;
  }

  async getRun(runId: string): Promise<WorkflowRun> {
    const run = this.runs.get(runId);
    if (!run) throw new ProjectError("FILE_NOT_FOUND", "Unknown workflow run: " + runId);
    return run;
  }

  async approve(runId: string): Promise<void> {
    this.approvals.push(runId);
  }
}

interface Fixture {
  root: string;
  service: FakeWorkflowService;
  trigger: WorkflowTrigger;
  scopes: Map<string, TaskScopeSpec>;
  newTrigger: () => WorkflowTrigger;
}

async function fixture(options: { settings?: WorkflowSettings; scopes?: TaskScopeSpec[] } = {}): Promise<Fixture> {
  const root = await tempRoot();
  const service = new FakeWorkflowService();
  if (options.settings !== undefined) service.settings = options.settings;
  const scopes = new Map<string, TaskScopeSpec>();
  for (const scope of options.scopes ?? [scopeSpec()]) scopes.set(scope.id, scope);
  const newTrigger = () => new WorkflowTrigger({
    root,
    service,
    resolveTaskScope: (taskId) => {
      const scope = scopes.get(taskId);
      if (!scope) throw new ProjectError("TASK_SCOPE_DENIED", "Choose an existing task scope");
      return scope;
    },
    loadOfficial: async () => OFFICIAL,
  });
  return { root, service, scopes, newTrigger, trigger: newTrigger() };
}

describe("task goal", () => {
  test("TaskScopeSpec trims and preserves an optional goal without granting permissions", () => {
    const parsed = TaskScopeSpecSchema.parse({ ...scopeSpec(), goal: "  Build the lighthouse keeper  " });
    expect(parsed.goal).toBe("Build the lighthouse keeper");

    const scope = new TaskScope(parsed);
    expect(scope.describe().goal).toBe("Build the lighthouse keeper");
    expect(scope.assertRead("specs/project.md")).toBe("specs/project.md");
    expect(() => scope.assertWrite("scripts/keeper.gd", "create")).toThrowError(
      expect.objectContaining({ code: "TASK_SCOPE_DENIED" }),
    );

    // A goal that looks like a path never widens the task's file permissions.
    const pathLike = new TaskScope(TaskScopeSpecSchema.parse({ ...scopeSpec(), goal: "scripts/keeper.gd" }));
    expect(() => pathLike.assertWrite("scripts/keeper.gd", "update")).toThrowError(
      expect.objectContaining({ code: "TASK_SCOPE_DENIED" }),
    );
  });

  test("treats a blank goal as absent, bounds it at 8192 characters, and falls back to the title", () => {
    expect(new TaskScope({ ...scopeSpec(), goal: "   " }).describe().goal).toBeUndefined();
    expect(TaskScopeSpecSchema.safeParse({ ...scopeSpec(), goal: "x".repeat(MAX_TASK_GOAL_LENGTH) }).success).toBe(true);
    expect(TaskScopeSpecSchema.safeParse({ ...scopeSpec(), goal: "x".repeat(MAX_TASK_GOAL_LENGTH + 1) }).success).toBe(false);

    expect(taskGoal({ title: "Legacy title" })).toBe("Legacy title");
    expect(taskGoal({ title: "Legacy title", goal: "   " })).toBe("Legacy title");
    expect(taskGoal({ title: "Legacy title", goal: "Ship the hero" })).toBe("Ship the hero");
  });

  test("createTask persists the goal in the task view and restores it", async () => {
    const root = await tempRoot();
    const core = await ProjectCore.open(root);
    try {
      const created = await core.createTask({
        ...scopeSpec({ id: "task-goal", title: "Implement keeper" }),
        goal: "  Build the lighthouse keeper  ",
      });
      expect(created.scope.goal).toBe("Build the lighthouse keeper");

      const legacy = await core.createTask(scopeSpec({ id: "task-legacy", title: "Legacy title" }));
      expect(legacy.scope.goal).toBeUndefined();
      expect(taskGoal(legacy.scope)).toBe("Legacy title");
    } finally {
      await core.close();
    }

    const reopened = await ProjectCore.open(root);
    try {
      const restored = reopened.listTasks().find((task) => task.id === "task-goal");
      expect(restored?.scope.goal).toBe("Build the lighthouse keeper");
    } finally {
      await reopened.close();
    }
  });
});

describe("WorkflowTrigger task starts", () => {
  test("starts the project default once, records a durable binding, and is idempotent", async () => {
    const { root, service, trigger, newTrigger } = await fixture({
      settings: { schemaVersion: 1, defaultWorkflowId: PROJECT.id },
      scopes: [scopeSpec({ goal: "  Build the hero  " })],
    });

    const first = await trigger.startForTask("task-1", "Implement the hero");
    expect(first).toEqual({ workflowId: PROJECT.id, runId: "run-1", source: "project" });
    expect(service.started).toHaveLength(1);
    expect(service.started[0]?.definition.id).toBe(PROJECT.id);
    expect(service.started[0]?.inputs).toEqual({
      goal: "Build the hero",
      readPaths: ["specs/**"],
      writePaths: ["specs/entities/**"],
    });
    expect(service.approvals).toEqual([]);

    const second = await trigger.startForTask("task-1", "Implement the hero again");
    expect(second).toEqual(first);
    expect(service.started).toHaveLength(1);

    // A fresh trigger over the same root finds the durable binding instead of starting again.
    const third = await newTrigger().startForTask("task-1", "Implement the hero again");
    expect(third).toEqual(first);
    expect(service.started).toHaveLength(1);

    expect(await readBindings(root)).toMatchObject({
      schemaVersion: 1,
      bindings: { "task-1": { runId: "run-1", workflowId: PROJECT.id, source: "project" } },
    });
    // Temp + rename leaves no partial file behind.
    expect(await readdir(path.dirname(bindingsFile(root)))).toEqual(["task-bindings.json"]);
  });

  test("serializes concurrent starts so one task starts exactly once", async () => {
    const { service, trigger } = await fixture({
      settings: { schemaVersion: 1, defaultWorkflowId: PROJECT.id },
    });

    const [first, second] = await Promise.all([
      trigger.startForTask("task-1", "First message"),
      trigger.startForTask("task-1", "Second message"),
    ]);

    expect(service.started).toHaveLength(1);
    expect(first.runId).toBe("run-1");
    expect(second.runId).toBe("run-1");
  });

  test("falls back to the official workflow when the configured default cannot load", async () => {
    const { root, service, trigger } = await fixture({
      settings: { schemaVersion: 1, defaultWorkflowId: "wf_missing" },
    });

    const result = await trigger.startForTask("task-1", "Implement the hero");

    expect(result.workflowId).toBe(OFFICIAL_WORKFLOW_ID);
    expect(result.source).toBe("fallback");
    expect(result.warning).toContain("wf_missing");
    expect(service.started[0]?.definition.id).toBe(OFFICIAL_WORKFLOW_ID);
    expect((await readBindings(root)).bindings["task-1"]?.source).toBe("fallback");
  });

  test("uses the task title as the goal for tasks without one", async () => {
    const { service, trigger } = await fixture({
      settings: { schemaVersion: 1, defaultWorkflowId: PROJECT.id },
      scopes: [scopeSpec({ title: "Legacy title" })],
    });

    await trigger.startForTask("task-1", "Implement the legacy task");

    expect(service.started[0]?.inputs.goal).toBe("Legacy title");
  });

  test("rejects an unknown task or a blank first message without starting a run", async () => {
    const { service, trigger } = await fixture({
      settings: { schemaVersion: 1, defaultWorkflowId: PROJECT.id },
    });

    await expect(trigger.startForTask("missing-task", "Implement")).rejects.toMatchObject({ code: "TASK_SCOPE_DENIED" });
    await expect(trigger.startForTask("task-1", "   ")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(service.started).toHaveLength(0);
  });

  test("rejects a corrupt binding sidecar instead of starting a duplicate run", async () => {
    const { root, service, trigger } = await fixture({
      settings: { schemaVersion: 1, defaultWorkflowId: PROJECT.id },
    });
    const file = bindingsFile(root);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{not json", "utf8");

    await expect(trigger.startForTask("task-1", "Implement")).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(service.started).toHaveLength(0);
  });
});

describe("WorkflowTrigger chat starts", () => {
  test("uses the default workflow and lets an explicit workflow override it", async () => {
    const { service, trigger } = await fixture({
      settings: { schemaVersion: 1, defaultWorkflowId: PROJECT.id },
    });

    const fallback = await trigger.startForChat({
      goal: "Implement a keeper",
      readPaths: ["specs/**"],
      writePaths: ["scripts/**"],
    });
    expect(fallback).toEqual({ workflowId: PROJECT.id, runId: "run-1", source: "project" });

    const explicit = await trigger.startForChat({
      goal: "Implement a keeper",
      readPaths: ["specs/**"],
      writePaths: ["scripts/**"],
      workflowId: OTHER.id,
    });
    expect(explicit).toEqual({ workflowId: OTHER.id, runId: "run-2", source: "explicit" });

    const official = await trigger.startForChat({
      goal: "Implement a keeper",
      readPaths: ["specs/**"],
      writePaths: ["scripts/**"],
      workflowId: OFFICIAL_WORKFLOW_ID,
    });
    expect(official).toEqual({ workflowId: OFFICIAL_WORKFLOW_ID, runId: "run-3", source: "explicit" });

    expect(service.started.map((entry) => entry.definition.id)).toEqual([PROJECT.id, OTHER.id, OFFICIAL_WORKFLOW_ID]);
    expect(service.approvals).toEqual([]);
  });

  test("falls back to official for a chat start when the project default is invalid", async () => {
    const { service, trigger } = await fixture({
      settings: { schemaVersion: 1, defaultWorkflowId: "wf_missing" },
    });

    const result = await trigger.startForChat({
      goal: "Implement a keeper",
      readPaths: ["specs/**"],
      writePaths: ["scripts/**"],
    });

    expect(result.workflowId).toBe(OFFICIAL_WORKFLOW_ID);
    expect(result.source).toBe("fallback");
    expect(result.warning).toBeDefined();
    expect(service.started[0]?.definition.id).toBe(OFFICIAL_WORKFLOW_ID);
  });

  test("rejects a chat implementation without a valid scope or goal", async () => {
    const { service, trigger } = await fixture({
      settings: { schemaVersion: 1, defaultWorkflowId: PROJECT.id },
    });

    await expect(trigger.startForChat({ goal: "Implement", readPaths: [], writePaths: ["specs/**"] })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    await expect(trigger.startForChat({ goal: "   ", readPaths: ["specs/**"], writePaths: ["specs/**"] })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(service.started).toHaveLength(0);
  });
});
