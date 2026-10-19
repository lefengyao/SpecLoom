import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ProjectError } from "../../src/main/core/errors";
import { OrchestrationRunStore } from "../../src/main/core/orchestration-run-store";
import { WorkflowOrchestrator } from "../../src/main/core/workflow-orchestrator";
import { loadOfficialWorkflow } from "../../src/main/core/workflow-official";
import type { WorkflowRunInputs } from "../../src/main/core/workflow-runner";
import {
  OFFICIAL_WORKFLOW_ID,
  OrchestrationDefinitionSchema,
  type OrchestrationApproval,
  type OrchestrationDefinition,
  type OrchestrationRun,
  type OrchestrationRunStatus,
} from "../../src/shared/orchestration";
import { validateWorkflowDefinition, type WorkflowDefinition } from "../../src/shared/workflow";
import { MAX_RUN_CONTEXT_LENGTH } from "../../src/shared/workflow-api";
import { FakeOrchestrationRunner } from "../helpers/fake-orchestration-runner";

const NOW = "2026-10-18T00:00:00.000Z";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-orchestrator-"));
  roots.push(root);
  return root;
}

let official: WorkflowDefinition | undefined;
async function officialWorkflow(): Promise<WorkflowDefinition> {
  official ??= await loadOfficialWorkflow();
  return official;
}

/** The official workflow under another id, with a chosen approval policy. */
async function projectWorkflow(id: string, policy: "manual" | "auto"): Promise<WorkflowDefinition> {
  const base = await officialWorkflow();
  return validateWorkflowDefinition({
    ...base,
    id,
    title: "工作流 " + id,
    settings: { ...base.settings, approvalPolicy: policy },
  });
}

function orchestration(
  id: string,
  steps: { stepId: string; workflowId: string; approval?: OrchestrationApproval }[],
): OrchestrationDefinition {
  return OrchestrationDefinitionSchema.parse({
    schemaVersion: 1,
    id,
    title: "编排 " + id,
    description: "",
    steps: steps.map((step) => ({
      id: step.stepId,
      workflowId: step.workflowId,
      approval: step.approval ?? "inherit",
    })),
  });
}

function inputs(overrides: Partial<WorkflowRunInputs> = {}): WorkflowRunInputs {
  return {
    goal: overrides.goal ?? "实现一个可玩的关卡",
    readPaths: overrides.readPaths ?? ["specs"],
    writePaths: overrides.writePaths ?? ["specs/entities"],
    model: overrides.model ?? "model-1",
    ...(overrides.context === undefined ? {} : { context: overrides.context }),
  };
}

interface Harness {
  root: string;
  store: OrchestrationRunStore;
  runner: FakeOrchestrationRunner;
  orchestrator: WorkflowOrchestrator;
  /** A second orchestrator over the same store and child runner, as after a restart. */
  reopen: () => WorkflowOrchestrator;
}

async function createHarness(options: {
  orchestrations: OrchestrationDefinition[];
  workflows?: WorkflowDefinition[];
  runner?: FakeOrchestrationRunner;
  store?: OrchestrationRunStore;
  root?: string;
}): Promise<Harness> {
  const root = options.root ?? (await tempRoot());
  const store = options.store ?? new OrchestrationRunStore(root);
  const runner = options.runner ?? new FakeOrchestrationRunner();
  const orchestrations = new Map(options.orchestrations.map((definition) => [definition.id, definition] as const));
  const workflows = new Map((options.workflows ?? []).map((definition) => [definition.id, definition] as const));
  let sequence = 0;

  const build = (): WorkflowOrchestrator =>
    new WorkflowOrchestrator({
      runStore: store,
      orchestrationStore: {
        read: async (id: string) => {
          const definition = orchestrations.get(id);
          if (definition === undefined) {
            throw new ProjectError("FILE_NOT_FOUND", "Unknown orchestration: " + id);
          }
          return { definition };
        },
      },
      loadWorkflow: async (id: string) => {
        const definition = workflows.get(id);
        if (definition === undefined) {
          throw new ProjectError("FILE_NOT_FOUND", "Unknown workflow: " + id);
        }
        return definition;
      },
      loadOfficial: officialWorkflow,
      runner,
      now: () => new Date(NOW),
      idFactory: () => "orch-" + (++sequence),
    });

  return { root, store, runner, orchestrator: build(), reopen: build };
}

function waitFor(
  orchestrator: WorkflowOrchestrator,
  orchestrationRunId: string,
  status: OrchestrationRunStatus,
): Promise<OrchestrationRun> {
  return orchestrator.waitForRun(orchestrationRunId, (run) => run.status === status);
}

async function rejection(promise: Promise<unknown>): Promise<ProjectError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ProjectError);
  return error as ProjectError;
}

describe("workflow orchestrator", () => {
  test("runs two steps in order and shares the run inputs", async () => {
    const plan = await projectWorkflow("wf_plan", "manual");
    const harness = await createHarness({
      workflows: [plan],
      orchestrations: [
        orchestration("orch_two", [
          { stepId: "plan", workflowId: "wf_plan" },
          { stepId: "review", workflowId: OFFICIAL_WORKFLOW_ID },
        ]),
      ],
    });
    harness.runner.scripts = [{ summary: "第一步完成" }, {}];

    const started = await harness.orchestrator.start("orch_two", inputs());
    expect(started.orchestrationId).toBe("orch_two");
    expect(started.title).toBe("编排 orch_two");
    expect(started.status).toBe("queued");
    expect(started.steps.map((step) => step.stepId)).toEqual(["plan", "review"]);
    expect(started.steps.every((step) => step.status === "pending")).toBe(true);

    const done = await waitFor(harness.orchestrator, started.orchestrationRunId, "completed");
    expect(done.currentStepIndex).toBe(2);
    expect(done.steps.map((step) => step.status)).toEqual(["completed", "completed"]);
    expect(done.steps[0]?.summary).toBe("第一步完成");
    expect(done.finishedAt).toBeDefined();

    expect(harness.runner.created.map((child) => child.definition.id)).toEqual(["wf_plan", OFFICIAL_WORKFLOW_ID]);
    expect(harness.runner.started).toEqual(harness.runner.created.map((child) => child.runId));
    const shared = inputs();
    for (const child of harness.runner.created) {
      expect(child.inputs.goal).toBe(shared.goal);
      expect(child.inputs.readPaths).toEqual(shared.readPaths);
      expect(child.inputs.writePaths).toEqual(shared.writePaths);
      expect(child.inputs.model).toBe(shared.model);
    }
    expect(harness.runner.inputs(0).context).toBeUndefined();

    const listed = await harness.orchestrator.listRuns();
    expect(listed.map((run) => run.orchestrationRunId)).toEqual([started.orchestrationRunId]);
  });

  test("pauses a manual step and starts the next step after approval", async () => {
    const plan = await projectWorkflow("wf_plan", "manual");
    const harness = await createHarness({
      workflows: [plan],
      orchestrations: [
        orchestration("orch_manual", [
          { stepId: "plan", workflowId: "wf_plan" },
          { stepId: "review", workflowId: "wf_plan" },
        ]),
      ],
    });
    harness.runner.scripts = [
      { startStatus: "waiting_approval", digest: "digest-plan", summary: "计划完成" },
      {},
    ];

    const started = await harness.orchestrator.start("orch_manual", inputs());
    const id = started.orchestrationRunId;
    const paused = await waitFor(harness.orchestrator, id, "waiting_approval");

    expect(paused.currentStepIndex).toBe(0);
    expect(paused.steps[0]?.status).toBe("waiting_approval");
    expect(paused.steps[1]?.status).toBe("pending");
    expect(harness.runner.created).toHaveLength(1);
    expect(harness.runner.approvals).toEqual([]);

    const durable = await harness.store.get(id);
    expect(durable.status).toBe("waiting_approval");
    expect(durable.steps[0]?.status).toBe("waiting_approval");
    const childRunId = durable.steps[0]?.runId;
    expect(childRunId).toBeDefined();

    await harness.orchestrator.approve(id, "digest-plan");
    const done = await waitFor(harness.orchestrator, id, "completed");

    expect(harness.runner.approvals).toEqual([{ runId: childRunId, digest: "digest-plan" }]);
    expect(harness.runner.created).toHaveLength(2);
    expect(done.currentStepIndex).toBe(2);
    expect(done.steps[0]?.autoApproved).toBeUndefined();
    expect(done.steps[0]?.status).toBe("completed");
    expect(done.status).toBe("completed");
  });

  test("auto approval runs a step without a person", async () => {
    const plan = await projectWorkflow("wf_plan", "manual");
    const harness = await createHarness({
      workflows: [plan],
      orchestrations: [orchestration("orch_auto", [{ stepId: "plan", workflowId: "wf_plan", approval: "auto" }])],
    });
    harness.runner.scripts = [{ startStatus: "waiting_approval", digest: "digest-auto", summary: "自动完成" }];

    const started = await harness.orchestrator.start("orch_auto", inputs());
    const done = await waitFor(harness.orchestrator, started.orchestrationRunId, "completed");

    expect(harness.runner.approvals).toEqual([
      { runId: harness.runner.created[0]?.runId, digest: "digest-auto" },
    ]);
    expect(done.steps[0]?.autoApproved).toBe(true);
    expect(done.steps[0]?.status).toBe("completed");
    expect(done.steps[0]?.summary).toBe("自动完成");
  });

  test("inherit follows the workflow approval policy", async () => {
    const auto = await projectWorkflow("wf_auto", "auto");
    const harness = await createHarness({
      workflows: [auto],
      orchestrations: [orchestration("orch_inherit", [{ stepId: "one", workflowId: "wf_auto" }])],
    });
    harness.runner.scripts = [{ startStatus: "waiting_approval", digest: "digest-inherit" }];

    const started = await harness.orchestrator.start("orch_inherit", inputs());
    const done = await waitFor(harness.orchestrator, started.orchestrationRunId, "completed");

    expect(harness.runner.approvals).toHaveLength(1);
    expect(done.steps[0]?.autoApproved).toBe(true);
  });

  test("always forces a manual pause on an auto workflow", async () => {
    const auto = await projectWorkflow("wf_auto", "auto");
    const harness = await createHarness({
      workflows: [auto],
      orchestrations: [orchestration("orch_always", [{ stepId: "one", workflowId: "wf_auto", approval: "always" }])],
    });
    harness.runner.scripts = [{ startStatus: "waiting_approval", digest: "digest-always" }];

    const started = await harness.orchestrator.start("orch_always", inputs());
    const id = started.orchestrationRunId;
    const paused = await waitFor(harness.orchestrator, id, "waiting_approval");

    expect(paused.steps[0]?.status).toBe("waiting_approval");
    expect(paused.steps[0]?.autoApproved).toBeUndefined();
    expect(harness.runner.approvals).toEqual([]);

    await harness.orchestrator.approveStep(id, "digest-always");
    const done = await waitFor(harness.orchestrator, id, "completed");
    expect(done.status).toBe("completed");
  });

  test("hands the previous step summary, decision path, validation, and approval to the next step", async () => {
    const first = await projectWorkflow("wf_first", "manual");
    const second = await projectWorkflow("wf_second", "manual");
    const harness = await createHarness({
      workflows: [first, second],
      orchestrations: [
        orchestration("orch_context", [
          { stepId: "first", workflowId: "wf_first", approval: "auto" },
          { stepId: "second", workflowId: "wf_second", approval: "always" },
        ]),
      ],
    });
    harness.runner.scripts = [
      {
        startStatus: "waiting_approval",
        digest: "digest-first",
        approveStatus: "completed",
        summary: "第一步摘要",
        decisionPath: "specs/decisions/first.md",
        validation: { status: "pass", checks: [], diagnostics: [] },
      },
      { startStatus: "waiting_approval", digest: "digest-second" },
    ];

    const started = await harness.orchestrator.start("orch_context", inputs({ context: "用户补充上下文" }));
    const id = started.orchestrationRunId;
    const paused = await waitFor(harness.orchestrator, id, "waiting_approval");

    expect(paused.currentStepIndex).toBe(1);
    expect(paused.steps[0]?.status).toBe("completed");
    expect(paused.steps[0]?.summary).toBe("第一步摘要");
    expect(paused.steps[0]?.decisionPath).toBe("specs/decisions/first.md");
    expect(harness.runner.created).toHaveLength(2);
    expect(harness.runner.inputs(0).context).toBe("用户补充上下文");

    const context = harness.runner.inputs(1).context ?? "";
    expect(context).toContain("第一步摘要");
    expect(context).toContain("specs/decisions/first.md");
    expect(context).toContain("pass");
    expect(context).toContain("自动批准");
    expect(context).toContain("用户补充上下文");

    await harness.orchestrator.approve(id, "digest-second");
    const done = await waitFor(harness.orchestrator, id, "completed");
    expect(done.steps[1]?.status).toBe("completed");
  });

  test("caps the previous-step context at 32768 characters", async () => {
    const first = await projectWorkflow("wf_first", "manual");
    const second = await projectWorkflow("wf_second", "manual");
    const harness = await createHarness({
      workflows: [first, second],
      orchestrations: [
        orchestration("orch_cap", [
          { stepId: "first", workflowId: "wf_first" },
          { stepId: "second", workflowId: "wf_second" },
        ]),
      ],
    });
    harness.runner.scripts = [
      { summary: "摘".repeat(40000) },
      { startStatus: "waiting_approval", digest: "digest-second" },
    ];

    const started = await harness.orchestrator.start("orch_cap", inputs());
    const id = started.orchestrationRunId;
    await waitFor(harness.orchestrator, id, "waiting_approval");

    expect(MAX_RUN_CONTEXT_LENGTH).toBe(32768);
    const context = harness.runner.inputs(1).context ?? "";
    expect(context.length).toBe(MAX_RUN_CONTEXT_LENGTH);
  });

  test("pauses on a failed step and retries the current step", async () => {
    const one = await projectWorkflow("wf_one", "manual");
    const two = await projectWorkflow("wf_two", "manual");
    const harness = await createHarness({
      workflows: [one, two],
      orchestrations: [
        orchestration("orch_retry", [
          { stepId: "one", workflowId: "wf_one" },
          { stepId: "two", workflowId: "wf_two" },
        ]),
      ],
    });
    harness.runner.scripts = [{ startStatus: "failed", error: "计划失败" }, {}];

    const started = await harness.orchestrator.start("orch_retry", inputs());
    const id = started.orchestrationRunId;
    const failed = await waitFor(harness.orchestrator, id, "failed");

    expect(failed.currentStepIndex).toBe(0);
    expect(failed.steps[0]?.status).toBe("failed");
    expect(failed.steps[0]?.error).toContain("计划失败");
    expect(failed.error).toContain("计划失败");
    expect(failed.steps[1]?.status).toBe("pending");
    expect(harness.runner.created).toHaveLength(1);
    expect((await harness.store.get(id)).status).toBe("failed");

    const childRunId = failed.steps[0]?.runId;
    await harness.orchestrator.retry(id, "implement");
    const done = await waitFor(harness.orchestrator, id, "completed");

    expect(harness.runner.retries).toEqual([{ runId: childRunId, action: "implement" }]);
    expect(done.status).toBe("completed");
    expect(done.currentStepIndex).toBe(2);
    expect(done.steps.map((step) => step.status)).toEqual(["completed", "completed"]);
    expect(harness.runner.created).toHaveLength(2);
  });

  test("rejects the current child and keeps the orchestration waiting", async () => {
    const one = await projectWorkflow("wf_one", "manual");
    const harness = await createHarness({
      workflows: [one],
      orchestrations: [orchestration("orch_reject", [{ stepId: "one", workflowId: "wf_one" }])],
    });
    harness.runner.scripts = [{ startStatus: "waiting_approval", digest: "digest-one", rejectStatus: "waiting_approval" }];

    const started = await harness.orchestrator.start("orch_reject", inputs());
    const id = started.orchestrationRunId;
    const paused = await waitFor(harness.orchestrator, id, "waiting_approval");

    await harness.orchestrator.rejectStep(id);
    expect(harness.runner.rejections).toEqual([paused.steps[0]?.runId]);

    const still = await harness.orchestrator.getRun(id);
    expect(still.status).toBe("waiting_approval");
    expect(still.steps[0]?.status).toBe("waiting_approval");
    expect(still.steps[0]?.autoApproved).toBeUndefined();

    await harness.orchestrator.approve(id, "digest-one");
    const done = await waitFor(harness.orchestrator, id, "completed");
    expect(done.status).toBe("completed");
  });

  test("cancels the current child and the orchestration", async () => {
    const one = await projectWorkflow("wf_one", "manual");
    const harness = await createHarness({
      workflows: [one],
      orchestrations: [orchestration("orch_cancel", [{ stepId: "one", workflowId: "wf_one" }])],
    });
    harness.runner.scripts = [{ startStatus: "waiting_approval", digest: "digest-one" }];

    const started = await harness.orchestrator.start("orch_cancel", inputs());
    const id = started.orchestrationRunId;
    const paused = await waitFor(harness.orchestrator, id, "waiting_approval");
    const childRunId = paused.steps[0]?.runId;

    await harness.orchestrator.cancel(id);

    const cancelled = await harness.orchestrator.getRun(id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.steps[0]?.status).toBe("cancelled");
    expect(cancelled.finishedAt).toBeDefined();
    expect(harness.runner.cancellations).toEqual([childRunId]);
    expect((await harness.store.get(id)).status).toBe("cancelled");

    const error = await rejection(harness.orchestrator.approve(id, "digest-one"));
    expect(error.code).toBe("VALIDATION_FAILED");
  });

  test("reloads a waiting run and approves it from a new orchestrator", async () => {
    const one = await projectWorkflow("wf_one", "manual");
    const harness = await createHarness({
      workflows: [one],
      orchestrations: [orchestration("orch_restart", [{ stepId: "one", workflowId: "wf_one" }])],
    });
    harness.runner.scripts = [{ startStatus: "waiting_approval", digest: "digest-restart" }];

    const started = await harness.orchestrator.start("orch_restart", inputs());
    const id = started.orchestrationRunId;
    await waitFor(harness.orchestrator, id, "waiting_approval");

    const reopened = harness.reopen();
    const reloaded = await reopened.getRun(id);
    expect(reloaded.status).toBe("waiting_approval");
    expect(reloaded.currentStepIndex).toBe(0);
    expect(reloaded.steps[0]?.status).toBe("waiting_approval");

    await reopened.approve(id, "digest-restart");
    const done = await reopened.waitForRun(id, (run) => run.status === "completed");
    expect(done.status).toBe("completed");
  });

  test("loads a running record as interrupted", async () => {
    const one = await projectWorkflow("wf_one", "manual");
    const harness = await createHarness({
      workflows: [one],
      orchestrations: [orchestration("orch_stale", [{ stepId: "one", workflowId: "wf_one" }])],
    });
    const record: OrchestrationRun = {
      schemaVersion: 1,
      orchestrationRunId: "orch-stale",
      orchestrationId: "orch_stale",
      title: "旧编排",
      inputs: inputs(),
      steps: [{ stepId: "one", workflowId: "wf_one", approval: "inherit", status: "running", runId: "child-1" }],
      currentStepIndex: 0,
      status: "running",
      startedAt: NOW,
    };
    await harness.store.save(record);

    const loaded = await harness.orchestrator.getRun("orch-stale");
    expect(loaded.status).toBe("interrupted");
    expect(loaded.steps[0]?.status).toBe("failed");
    expect(loaded.error).toContain("interrupted");
  });

  test("allows only one active orchestration", async () => {
    const one = await projectWorkflow("wf_one", "manual");
    const harness = await createHarness({
      workflows: [one],
      orchestrations: [orchestration("orch_one", [{ stepId: "one", workflowId: "wf_one" }])],
    });
    harness.runner.scripts = [{ startStatus: "waiting_approval", digest: "digest-one" }];

    const started = await harness.orchestrator.start("orch_one", inputs());
    await waitFor(harness.orchestrator, started.orchestrationRunId, "waiting_approval");

    const error = await rejection(harness.orchestrator.start("orch_one", inputs()));
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.message).toContain("already");
  });

  test("refuses to start when a step references a missing workflow", async () => {
    const harness = await createHarness({
      orchestrations: [orchestration("orch_missing", [{ stepId: "review", workflowId: "wf_missing" }])],
    });

    const error = await rejection(harness.orchestrator.start("orch_missing", inputs()));
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.message).toContain("review");
    expect(error.message).toContain("wf_missing");
    expect(await harness.store.list()).toEqual([]);
    expect(harness.runner.created).toEqual([]);
  });
});
