import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ModelProfile, TaskScopeSpec, ValidationResult } from "../../src/shared/contracts";
import type { ChangeReview } from "../../src/shared/desktop-api";
import { ProjectCoreWorkflowTaskAdapter, type WorkflowTaskAdapter, type WorkflowTaskCore } from "../../src/main/core/workflow-task-adapter";
import { ProjectError } from "../../src/main/core/errors";
import { FileStore } from "../../src/main/core/file-store";
import { loadOfficialWorkflow } from "../../src/main/core/workflow-official";
import { WorkflowRunner, type WorkflowRun, type WorkflowRunInputs } from "../../src/main/core/workflow-runner";
import { MAX_RUN_CONTEXT_LENGTH } from "../../src/shared/workflow-api";
import { FakeWorkflowTaskAdapter } from "../helpers/fake-workflow-task-adapter";

const profile: ModelProfile = {
  id: "model-1",
  name: "Test model",
  provider: "openai-compatible",
  model: "model-1",
  baseUrl: "https://example.com/v1",
  approved: true,
  timeoutMs: 30_000,
};
const validation: ValidationResult = { status: "pass", checks: [], diagnostics: [] };
const review: ChangeReview = {
  changeSet: {
    id: "changeset-1",
    taskId: "workflow-1",
    entries: [],
    dependencies: {},
    digest: "digest-1",
    status: "validated",
  },
  before: {},
  validation,
  approved: false,
};

function coreDouble(): WorkflowTaskCore {
  return {
    createTask: vi.fn(async (spec: TaskScopeSpec) => ({ id: spec.id, scope: spec })),
    removeTask: vi.fn(async () => {}),
    agentMessage: vi.fn(async () => ({ summary: "implemented" })),
    validate: vi.fn(async () => validation),
    previewChanges: vi.fn(async () => review),
    approveChanges: vi.fn(async () => review),
    rejectChanges: vi.fn(async () => review),
  };
}

/** Stands in for WorkflowRunner resolving a run input's model id for its next node. */
async function runnerModelProfile(adapter: WorkflowTaskAdapter, modelId: string): Promise<ModelProfile> {
  return await adapter.resolveModelProfile(modelId);
}

describe("workflow task adapter", () => {
  test("records the read task and write task with distinct scopes", async () => {
    const adapter = new FakeWorkflowTaskAdapter();
    const read = await adapter.createTask({ title: "plan", readPaths: ["specs"], writePaths: [] });
    const write = await adapter.createTask({ title: "implement", readPaths: ["specs"], writePaths: ["specs/entities"] });
    expect(read.scope.writePaths).toEqual([]);
    expect(write.scope.writePaths).toEqual(["specs/entities"]);
    expect(adapter.created).toHaveLength(2);
  });

  test("maps a ProjectCore double onto the workflow task interface", async () => {
    const core = coreDouble();
    const adapter = new ProjectCoreWorkflowTaskAdapter(core, (model) => (model === profile.id ? profile : undefined));
    const signal = new AbortController().signal;

    const created = await adapter.createTask({ title: "implement", readPaths: ["specs"], writePaths: ["specs/entities"] });
    const spec = vi.mocked(core.createTask).mock.calls[0]?.[0];
    expect(spec).toBeDefined();
    expect(spec?.id).toMatch(/^workflow-/);
    expect(created.id).toBe(spec?.id);
    expect(spec).toMatchObject({
      title: "implement",
      readPaths: ["specs/**"],
      writePaths: ["specs/entities/**"],
      allowDelete: false,
      mode: "manual",
    });
    expect(created.scope).toEqual({ title: "implement", readPaths: ["specs/**"], writePaths: ["specs/entities/**"] });

    expect(await adapter.runAgent(created.id, profile, "implement it", signal)).toEqual({ summary: "implemented" });
    expect(core.agentMessage).toHaveBeenCalledWith(created.id, profile, "implement it", signal);
    expect(await adapter.validate(created.id, signal)).toBe(validation);
    expect(core.validate).toHaveBeenCalledWith(created.id, signal);
    expect(await adapter.preview(created.id)).toBe(review);
    expect(core.previewChanges).toHaveBeenCalledWith(created.id);
    await adapter.approve(created.id, review.changeSet.digest);
    expect(core.approveChanges).toHaveBeenCalledWith(created.id, review.changeSet.digest);
    await adapter.reject(created.id);
    expect(core.rejectChanges).toHaveBeenCalledWith(created.id);
    await adapter.removeTask(created.id);
    expect(core.removeTask).toHaveBeenCalledWith(created.id);
  });

  test("resolves model profiles through the injected callback", async () => {
    const adapter = new ProjectCoreWorkflowTaskAdapter(coreDouble(), (model) => (model === profile.id ? profile : undefined));
    await expect(adapter.resolveModelProfile(profile.id)).resolves.toBe(profile);

    const error: unknown = await adapter.resolveModelProfile("missing").catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ProjectError);
    const projectError = error as ProjectError;
    expect(projectError.code).toBe("MODEL_ERROR");
    expect(projectError.message).toMatch(/model/i);
    expect(projectError.message).toContain(JSON.stringify("missing"));
  });

  test("fake and production adapters expose the runner profile seam", async () => {
    const fake = new FakeWorkflowTaskAdapter();
    fake.profile = profile;
    const production = new ProjectCoreWorkflowTaskAdapter(coreDouble(), (model) => (model === profile.id ? profile : undefined));
    const adapters: WorkflowTaskAdapter[] = [fake, production];

    for (const adapter of adapters) {
      await expect(runnerModelProfile(adapter, profile.id)).resolves.toBe(profile);
    }
  });

  test("fake preview reflects the validation result it just returned", async () => {
    const adapter = new FakeWorkflowTaskAdapter();
    const failed: ValidationResult = {
      status: "fail",
      checks: [],
      diagnostics: [{ severity: "error", message: "broken" }],
    };
    expect((await adapter.preview("task-1")).validation).toBe(adapter.validation);

    adapter.validationResults.push(failed);
    await expect(adapter.validate("task-1", new AbortController().signal)).resolves.toBe(failed);
    expect(adapter.lastValidation).toBe(failed);
    expect((await adapter.preview("task-1")).validation).toBe(failed);
  });
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), "specloom-workflow-runner-"));
  await mkdir(path.join(value, "specs", "entities"), { recursive: true });
  roots.push(value);
  return value;
}

function inputs(overrides: Partial<WorkflowRunInputs> & { omitModel?: boolean } = {}): WorkflowRunInputs {
  const { omitModel, ...rest } = overrides;
  const value: WorkflowRunInputs = {
    goal: rest.goal ?? "实现一个可玩的关卡",
    readPaths: rest.readPaths ?? ["specs"],
    writePaths: rest.writePaths ?? ["specs/entities"],
  };
  if (!omitModel) value.model = rest.model ?? "model-1";
  if (rest.context !== undefined) value.context = rest.context;
  return value;
}

function stateStatus(run: { nodeStates: { id: string; status: string }[] }, id: string): string | undefined {
  return run.nodeStates.find((state) => state.id === id)?.status;
}

/** The design's task title contract for both plan and write tasks. */
function workflowTaskTitle(run: { title: string; runId: string }): string {
  return "[工作流] " + run.title + " / " + run.runId;
}

async function persistRunRecord(root: string, run: WorkflowRun): Promise<void> {
  const directory = path.join(root, ".specloom", "workflows", "runs");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, run.runId + ".json"), JSON.stringify(run, null, 2) + "\n", "utf8");
}

async function readRunRecord(root: string, runId: string): Promise<Record<string, unknown>> {
  const source = await readFile(path.join(root, ".specloom", "workflows", "runs", runId + ".json"), "utf8");
  return JSON.parse(source) as Record<string, unknown>;
}

describe("workflow runner", () => {
  test("createRun snapshots the definition and inputs and queues every node", async () => {
    const root = await tempRoot();
    const runner = new WorkflowRunner({ adapter: new FakeWorkflowTaskAdapter(), root });
    const definition = await loadOfficialWorkflow();
    const value = inputs();

    const run = runner.createRun(definition, value);

    expect(run.schemaVersion).toBe(1);
    expect(run.status).toBe("queued");
    expect(run.workflowId).toBe(definition.id);
    expect(run.title).toBe(definition.title);
    expect(run.workflowVersion).toBe(definition.version);
    expect(run.nodeStates.map((state) => state.id)).toEqual(definition.nodes.map((node) => node.id));
    expect(run.nodeStates.every((state) => state.status === "pending" && state.attempts === 0)).toBe(true);
    expect(run.inputs).toEqual(value);
    expect(run.inputs.readPaths).not.toBe(value.readPaths);
    expect(run.definitionSnapshot).not.toBe(definition);
    expect(run.definitionSnapshot).toEqual(definition);
    expect(run.finishedAt).toBeUndefined();
    expect(run.decisionPath).toBeUndefined();
    expect(run.approval).toBeUndefined();
    expect(await runner.listRuns()).toEqual([]);

    value.goal = "mutated";
    value.readPaths.push("specs/mutated");
    const firstNode = definition.nodes[0];
    if (firstNode) firstNode.label = "mutated label";

    expect(run.inputs.goal).toBe("实现一个可玩的关卡");
    expect(run.inputs.readPaths).toEqual(["specs"]);
    expect(run.definitionSnapshot.nodes.find((node) => node.id === "context")?.label).toBe("读取规范");
  });

  test("createRun rejects an empty goal", async () => {
    const root = await tempRoot();
    const runner = new WorkflowRunner({ adapter: new FakeWorkflowTaskAdapter(), root });
    const definition = await loadOfficialWorkflow();
    expect(() => runner.createRun(definition, inputs({ goal: "   " }))).toThrow(ProjectError);
  });

  test("createRun rejects empty readPaths and writePaths", async () => {
    const root = await tempRoot();
    const runner = new WorkflowRunner({ adapter: new FakeWorkflowTaskAdapter(), root });
    const definition = await loadOfficialWorkflow();

    expect(() => runner.createRun(definition, inputs({ readPaths: [] }))).toThrow(/readPaths/i);
    expect(() => runner.createRun(definition, inputs({ writePaths: [] }))).toThrow(/writePaths/i);
  });

  test("the context node counts files and skips symlinks", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, "specs", "a.md"), "a", "utf8");
    await mkdir(path.join(root, "specs", "nested"), { recursive: true });
    await writeFile(path.join(root, "specs", "nested", "b.md"), "b", "utf8");
    const outside = path.join(root, "outside.md");
    await writeFile(outside, "outside", "utf8");
    let linked = false;
    try {
      await symlink(outside, path.join(root, "specs", "linked.md"), "file");
      linked = true;
    } catch {
      // Creating symlinks needs extra privileges on some Windows hosts.
    }

    const adapter = new FakeWorkflowTaskAdapter();
    const runner = new WorkflowRunner({ adapter, root });
    const run = runner.createRun(await loadOfficialWorkflow(), inputs());
    await runner.start(run.runId);
    const waiting = await runner.waitForRun(run.runId, (candidate) => candidate.status === "waiting_approval");
    const context = waiting.nodeStates.find((state) => state.id === "context")?.output ?? "";

    expect(context).toContain("read 2 file(s)");
    expect(context).toContain("write: specs/entities");
    if (linked) expect(context).toContain("1 symbolic link(s) skipped");
  });

  test("start runs the official graph in success-edge order and waits for approval", async () => {
    const root = await tempRoot();
    const adapter = new FakeWorkflowTaskAdapter();
    adapter.summaries = ["planned work", "implemented work"];
    const runner = new WorkflowRunner({ adapter, root });
    const definition = await loadOfficialWorkflow();
    const value = inputs();

    const run = runner.createRun(definition, value);
    await runner.start(run.runId);

    const waiting = await runner.waitForRun(run.runId, (candidate) => candidate.status === "waiting_approval");
    const title = workflowTaskTitle(run);
    expect(adapter.agents).toEqual([title, title]);
    expect(adapter.created).toHaveLength(2);

    const planScope = adapter.created[0];
    const implementScope = adapter.created[1];
    expect(planScope?.title).toBe(title);
    expect(planScope?.writePaths).toEqual([]);
    expect(planScope?.readPaths).toEqual(value.readPaths);
    expect(implementScope?.title).toBe(title);
    expect(implementScope?.writePaths).toEqual(value.writePaths);
    expect(implementScope?.readPaths).toEqual(value.readPaths);

    expect(adapter.prompts[1]).toContain(value.goal);
    expect(adapter.prompts[1]).toContain("planned work");
    expect(waiting.approval?.digest).toBe(adapter.digest);
    expect(waiting.writeTaskId).toBeDefined();
    expect(waiting.readTaskIds).toHaveLength(1);
    expect(adapter.removed).toEqual(waiting.readTaskIds);
    expect(waiting.validation?.status).toBe("pass");
    expect(waiting.resolvedModel).toBe(profile.id);
    expect(stateStatus(waiting, "context")).toBe("completed");
    expect(stateStatus(waiting, "plan")).toBe("completed");
    expect(stateStatus(waiting, "implement")).toBe("completed");
    expect(stateStatus(waiting, "validate")).toBe("completed");
    expect(stateStatus(waiting, "review")).toBe("waiting_approval");
    expect(stateStatus(waiting, "decide")).toBe("pending");
    expect(waiting.attempts).toBe(1);
    expect(waiting.finishedAt).toBeUndefined();

    await expect(runner.start(run.runId)).rejects.toThrow(/active/i);
    const second = runner.createRun(definition, value);
    await expect(runner.start(second.runId)).rejects.toThrow(/active/i);
    expect(adapter.agents).toEqual([title, title]);
  });

  test("an auto approval workflow approves the review and completes the run", async () => {
    const root = await tempRoot();
    const adapter = new FakeWorkflowTaskAdapter();
    const runner = new WorkflowRunner({ adapter, root });
    const definition = structuredClone(await loadOfficialWorkflow());
    definition.settings.approvalPolicy = "auto";
    const run = runner.createRun(definition, inputs());

    await runner.start(run.runId);
    const completed = await runner.waitForRun(run.runId, (candidate) => candidate.status === "completed");

    expect(adapter.approvals).toEqual([{ taskId: completed.writeTaskId, digest: adapter.digest }]);
    expect(completed.approval).toMatchObject({
      digest: adapter.digest,
      autoApproved: true,
      approvedBy: "orchestrator",
    });
    expect(completed.approval?.approvedAt).toBeDefined();
    expect(stateStatus(completed, "review")).toBe("completed");
    expect(stateStatus(completed, "decide")).toBe("completed");
    expect(completed.decisionPath).toBeDefined();
    expect(completed.finishedAt).toBeDefined();
    expect(completed.error).toBeUndefined();

    const record = await readRunRecord(root, run.runId);
    expect(record.status).toBe("completed");
    expect(record.approval).toMatchObject({ digest: adapter.digest, autoApproved: true, approvedBy: "orchestrator" });
  });

  test("a manual approval policy still waits for a human decision", async () => {
    const root = await tempRoot();
    const adapter = new FakeWorkflowTaskAdapter();
    const runner = new WorkflowRunner({ adapter, root });
    const definition = structuredClone(await loadOfficialWorkflow());
    definition.settings.approvalPolicy = "manual";
    const run = runner.createRun(definition, inputs());

    await runner.start(run.runId);
    const waiting = await runner.waitForRun(run.runId, (candidate) => candidate.status === "waiting_approval");

    expect(adapter.approvals).toHaveLength(0);
    expect(waiting.approval).toEqual({ digest: adapter.digest });
    expect(waiting.approval?.autoApproved).toBeUndefined();
    expect(stateStatus(waiting, "review")).toBe("waiting_approval");
    expect(stateStatus(waiting, "decide")).toBe("pending");
  });

  test("run context is appended to the plan and implement prompts", async () => {
    const root = await tempRoot();
    const adapter = new FakeWorkflowTaskAdapter();
    const runner = new WorkflowRunner({ adapter, root });
    const context = "上一步摘要：模型参数已确认";
    const run = runner.createRun(await loadOfficialWorkflow(), inputs({ context }));

    await runner.start(run.runId);
    await runner.waitForRun(run.runId, (candidate) => candidate.status === "waiting_approval");

    expect(adapter.prompts).toHaveLength(2);
    const planPrompt = adapter.prompts[0];
    const implementPrompt = adapter.prompts[1];
    if (planPrompt === undefined || implementPrompt === undefined) {
      throw new Error("expected a plan prompt and an implement prompt");
    }
    expect(planPrompt).toContain("Context:");
    expect(planPrompt).toContain(context);
    expect(implementPrompt).toContain("Context:");
    expect(implementPrompt).toContain(context);
    // The implement prompt keeps goal and plan before the context block.
    expect(implementPrompt).toContain("Goal:");
    expect(implementPrompt.indexOf("Plan:")).toBeLessThan(implementPrompt.indexOf("Context:"));
  });

  test("run context is persisted in the record and survives a reload", async () => {
    const root = await tempRoot();
    const adapter = new FakeWorkflowTaskAdapter();
    const runner = new WorkflowRunner({ adapter, root });
    const context = "previous step summary";
    const run = runner.createRun(await loadOfficialWorkflow(), inputs({ context }));

    await runner.start(run.runId);
    await runner.waitForRun(run.runId, (candidate) => candidate.status === "waiting_approval");

    const record = await readRunRecord(root, run.runId);
    expect((record.inputs as { context?: string }).context).toBe(context);

    const fresh = new WorkflowRunner({ adapter: new FakeWorkflowTaskAdapter(), root });
    expect((await fresh.getRun(run.runId)).inputs.context).toBe(context);
  });

  test("no context block is appended when the run has no context", async () => {
    const root = await tempRoot();
    const adapter = new FakeWorkflowTaskAdapter();
    const runner = new WorkflowRunner({ adapter, root });
    const definition = await loadOfficialWorkflow();
    const run = runner.createRun(definition, inputs());

    await runner.start(run.runId);
    await runner.waitForRun(run.runId, (candidate) => candidate.status === "waiting_approval");

    const planNode = definition.nodes.find((node) => node.type === "agent" && node.config.access === "read");
    if (!planNode || planNode.type !== "agent") throw new Error("expected a plan node");
    expect(adapter.prompts[0]).toBe(planNode.config.prompt);
    expect(adapter.prompts[0]).not.toContain("Context:");
    expect(adapter.prompts[1]).not.toContain("Context:");
  });

  test("run context is bounded to the shared character cap", async () => {
    const root = await tempRoot();
    const runner = new WorkflowRunner({ adapter: new FakeWorkflowTaskAdapter(), root });
    const definition = await loadOfficialWorkflow();
    const atLimit = "x".repeat(MAX_RUN_CONTEXT_LENGTH);

    const accepted = runner.createRun(definition, inputs({ context: atLimit }));
    expect(accepted.inputs.context).toHaveLength(MAX_RUN_CONTEXT_LENGTH);
    expect(() => runner.createRun(definition, inputs({ context: atLimit + "x" }))).toThrow(/32768/);
  });

  test("start returns while the run is still executing in the background", async () => {
    const root = await tempRoot();
    const adapter = new FakeWorkflowTaskAdapter();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    adapter.onRunAgent = async () => {
      await gate;
    };
    const runner = new WorkflowRunner({ adapter, root });
    const run = runner.createRun(await loadOfficialWorkflow(), inputs());

    await runner.start(run.runId);
    expect((await runner.getRun(run.runId)).status).toBe("running");
    release();
    await runner.waitForRun(run.runId, (candidate) => candidate.status === "waiting_approval");
  });

  test("approve completes the run and writes the decision record", async () => {
    const root = await tempRoot();
    const adapter = new FakeWorkflowTaskAdapter();
    adapter.summaries = ["planned work", "implemented work"];
    const runner = new WorkflowRunner({ adapter, root });
    const definition = await loadOfficialWorkflow();
    const run = runner.createRun(definition, inputs());

    await runner.start(run.runId);
    const waiting = await runner.waitForRun(run.runId, (candidate) => candidate.status === "waiting_approval");
    const digest = waiting.approval?.digest;
    if (!digest) throw new Error("expected an approval digest");

    await expect(runner.approve(run.runId, "wrong-digest")).rejects.toThrow(/digest/i);
    expect(stateStatus(await runner.getRun(run.runId), "review")).toBe("waiting_approval");

    await runner.approve(run.runId, digest);
    const completed = await runner.waitForRun(run.runId, (candidate) => candidate.status === "completed");

    expect(adapter.approvals).toEqual([{ taskId: completed.writeTaskId, digest }]);
    expect(completed.nodeStates.every((state) => state.status === "completed")).toBe(true);
    expect(completed.finishedAt).toBeDefined();
    expect(completed.error).toBeUndefined();
    expect(completed.approval?.digest).toBe(digest);
    expect(completed.approval?.approvedAt).toBeDefined();

    const decisionPath = completed.decisionPath;
    if (!decisionPath) throw new Error("expected a decision path");
    expect(decisionPath.startsWith("specs/decisions/")).toBe(true);
    expect(decisionPath).toContain(run.runId);
    expect(decisionPath.endsWith(".md")).toBe(true);

    const content = await readFile(path.join(root, decisionPath), "utf8");
    expect(content).toContain("runId: " + run.runId);
    expect(content).toContain("workflowId: " + definition.id);
    expect(content).toContain("title: " + definition.title);
    expect(content).toContain("goal: " + run.inputs.goal);
    expect(content).toContain("planned work");
    expect(content).toContain("implemented work");
    expect(content).toContain("approvalDigest: " + digest);
    expect(content).toContain("approvedAt:");
    expect(content).toContain("startedAt:");
    expect(content).toContain("model: model-1");
    expect(content).toContain("validationStatus: pass");
    expect(content).toContain("## 目标");
    expect(content).toContain("## 计划摘要");
    expect(content).toContain("## 实现摘要");
    expect(content).toContain("## 校验");
    expect(content).toContain("## 审批");

    const files = await readdir(path.join(root, "specs", "decisions"));
    expect(files).toHaveLength(1);
    expect(files[0]).toContain(run.runId);
  });

  test("a decision names a non-empty resolved model when the input omits one", async () => {
    const root = await tempRoot();
    const adapter = new FakeWorkflowTaskAdapter();
    const runner = new WorkflowRunner({ adapter, root });
    const run = runner.createRun(await loadOfficialWorkflow(), inputs({ omitModel: true }));

    await runner.start(run.runId);
    const waiting = await runner.waitForRun(run.runId, (candidate) => candidate.status === "waiting_approval");
    expect(waiting.inputs.model).toBeUndefined();
    expect(waiting.resolvedModel).toBe(profile.id);
    const digest = waiting.approval?.digest;
    if (!digest) throw new Error("expected an approval digest");

    await runner.approve(run.runId, digest);
    const completed = await runner.waitForRun(run.runId, (candidate) => candidate.status === "completed");
    const decisionPath = completed.decisionPath;
    if (!decisionPath) throw new Error("expected a decision path");
    expect(await readFile(path.join(root, decisionPath), "utf8")).toContain("model: " + profile.id);
  });

  test("decision documents are written through the injected FileStore", async () => {
    const root = await tempRoot();
    const adapter = new FakeWorkflowTaskAdapter();
    const files = new FileStore(root);
    const write = vi.spyOn(files, "write");
    const runner = new WorkflowRunner({ adapter, root, files });
    const run = runner.createRun(await loadOfficialWorkflow(), inputs());

    await runner.start(run.runId);
    const waiting = await runner.waitForRun(run.runId, (candidate) => candidate.status === "waiting_approval");
    const digest = waiting.approval?.digest;
    if (!digest) throw new Error("expected an approval digest");
    await runner.approve(run.runId, digest);
    await runner.waitForRun(run.runId, (candidate) => candidate.status === "completed");

    expect(write).toHaveBeenCalledTimes(1);
    const call = write.mock.calls[0];
    expect(call?.[0]).toMatch(/^specs\/decisions\//);
    expect(call?.[2]).toBe("absent");
  });

  test("reject reruns implement and waits for approval again", async () => {
    const root = await tempRoot();
    const adapter = new FakeWorkflowTaskAdapter();
    const runner = new WorkflowRunner({ adapter, root });
    const definition = await loadOfficialWorkflow();
    const run = runner.createRun(definition, inputs());
    const title = workflowTaskTitle(run);

    await runner.start(run.runId);
    const waiting = await runner.waitForRun(run.runId, (candidate) => candidate.status === "waiting_approval");
    expect(waiting.attempts).toBe(1);
    const writeTaskId = waiting.writeTaskId;
    if (!writeTaskId) throw new Error("expected a write task");

    await runner.reject(run.runId);
    const again = await runner.waitForRun(
      run.runId,
      (candidate) => candidate.status === "waiting_approval" && candidate.attempts === 2,
    );

    expect(again.attempts).toBe(2);
    expect(adapter.rejections).toEqual([writeTaskId]);
    expect(adapter.agents.filter((label) => label === title)).toHaveLength(3);
    expect(adapter.created).toHaveLength(2);
    expect(again.writeTaskId).toBe(writeTaskId);
    expect(again.approval?.digest).toBe(adapter.digest);
    expect(stateStatus(again, "implement")).toBe("completed");
    if (!again.approval) throw new Error("expected an approval digest after reject");

    await runner.approve(run.runId, again.approval.digest);
    const completed = await runner.waitForRun(run.runId, (candidate) => candidate.status === "completed");
    expect(completed.attempts).toBe(2);
    expect(completed.decisionPath).toBeDefined();
  });

  test("rejections fail only once the attempt count exceeds maxImplementAttempts", async () => {
    const root = await tempRoot();
    const adapter = new FakeWorkflowTaskAdapter();
    const runner = new WorkflowRunner({ adapter, root });
    const definition = structuredClone(await loadOfficialWorkflow());
    definition.settings.maxImplementAttempts = 2;
    const run = runner.createRun(definition, inputs());
    const title = workflowTaskTitle(run);

    await runner.start(run.runId);
    await runner.waitForRun(run.runId, (candidate) => candidate.status === "waiting_approval");
    await runner.reject(run.runId);
    const second = await runner.waitForRun(
      run.runId,
      (candidate) => candidate.status === "waiting_approval" && candidate.attempts === 2,
    );
    expect(second.attempts).toBe(2);

    // The second rejection makes attempts 3 > 2; the run must fail rather than rerun.
    await runner.reject(run.runId);
    const failed = await runner.waitForRun(run.runId, (candidate) => candidate.status === "failed");

    expect(failed.error).toMatch(/exhausted/i);
    expect(failed.error).toContain("3 of 2");
    expect(adapter.rejections).toHaveLength(2);
    expect(adapter.agents.filter((label) => label === title)).toHaveLength(3);
    expect(stateStatus(failed, "review")).toBe("failed");
    expect(failed.writeTaskId).toBeDefined();
  });

  test("a failed validation leaves the write task and retry validate reaches approval", async () => {
    const root = await tempRoot();
    const adapter = new FakeWorkflowTaskAdapter();
    const failed: ValidationResult = {
      status: "fail",
      checks: [],
      diagnostics: [{ severity: "error", message: "broken reference" }],
    };
    adapter.validationResults.push(failed, { status: "pass", checks: [], diagnostics: [] });
    const runner = new WorkflowRunner({ adapter, root });
    const definition = await loadOfficialWorkflow();
    const run = runner.createRun(definition, inputs());
    const title = workflowTaskTitle(run);

    await runner.start(run.runId);
    const failedRun = await runner.waitForRun(run.runId, (candidate) => candidate.status === "failed");
    expect(failedRun.error).toContain("broken reference");
    expect(stateStatus(failedRun, "validate")).toBe("failed");
    expect(failedRun.validation?.status).toBe("fail");
    expect(failedRun.writeTaskId).toBeDefined();
    expect(adapter.agents).toEqual([title, title]);
    expect(adapter.removed).toHaveLength(1);

    await runner.retry(run.runId, "validate");
    const waiting = await runner.waitForRun(run.runId, (candidate) => candidate.status === "waiting_approval");
    expect(adapter.validations).toHaveLength(2);
    expect(waiting.validation?.status).toBe("pass");
    expect(waiting.writeTaskId).toBe(failedRun.writeTaskId);
    expect(waiting.error).toBeUndefined();
  });

  test("a skipped validation still reaches approval for a human decision", async () => {
    const root = await tempRoot();
    const adapter = new FakeWorkflowTaskAdapter();
    adapter.validationResults.push({
      status: "skipped",
      checks: [],
      diagnostics: [{ severity: "warning", message: "Godot headless requires Docker" }],
    });
    const runner = new WorkflowRunner({ adapter, root });
    const run = runner.createRun(await loadOfficialWorkflow(), inputs());

    await runner.start(run.runId);
    const waiting = await runner.waitForRun(run.runId, (candidate) => candidate.status === "waiting_approval");
    expect(waiting.validation?.status).toBe("skipped");
    expect(stateStatus(waiting, "validate")).toBe("completed");
    expect(waiting.error).toBeUndefined();
  });

  test("a failed plan can recover with retry plan", async () => {
    const root = await tempRoot();
    const adapter = new FakeWorkflowTaskAdapter();
    adapter.agentError = new Error("model unavailable");
    const runner = new WorkflowRunner({ adapter, root });
    const definition = await loadOfficialWorkflow();
    const run = runner.createRun(definition, inputs());
    const title = workflowTaskTitle(run);

    await runner.start(run.runId);
    const failedRun = await runner.waitForRun(run.runId, (candidate) => candidate.status === "failed");
    expect(failedRun.error).toContain("model unavailable");
    expect(stateStatus(failedRun, "plan")).toBe("failed");
    expect(failedRun.writeTaskId).toBeUndefined();
    expect(failedRun.readTaskIds).toHaveLength(1);
    expect(adapter.removed).toEqual(failedRun.readTaskIds);
    expect(adapter.agents).toEqual([]);

    delete adapter.agentError;
    await runner.retry(run.runId, "plan");
    const waiting = await runner.waitForRun(run.runId, (candidate) => candidate.status === "waiting_approval");
    expect(adapter.agents).toEqual([title, title]);
    expect(waiting.error).toBeUndefined();
    expect(stateStatus(waiting, "plan")).toBe("completed");
    expect(stateStatus(waiting, "review")).toBe("waiting_approval");
  });

  test("cancel while waiting approval stops the run without a decision", async () => {
    const root = await tempRoot();
    const adapter = new FakeWorkflowTaskAdapter();
    const runner = new WorkflowRunner({ adapter, root });
    const definition = await loadOfficialWorkflow();
    const run = runner.createRun(definition, inputs());

    await runner.start(run.runId);
    await runner.waitForRun(run.runId, (candidate) => candidate.status === "waiting_approval");
    await runner.cancel(run.runId);

    const cancelled = await runner.getRun(run.runId);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.finishedAt).toBeDefined();
    expect(cancelled.decisionPath).toBeUndefined();
    expect(adapter.approvals).toHaveLength(0);
    expect(stateStatus(cancelled, "review")).not.toBe("completed");

    const decisions = await readdir(path.join(root, "specs", "decisions")).catch(() => []);
    expect(decisions).toEqual([]);
  });

  test("cancel aborts a running agent and stops before later nodes", async () => {
    const root = await tempRoot();
    const adapter = new FakeWorkflowTaskAdapter();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    adapter.onRunAgent = async () => {
      await gate;
    };
    const runner = new WorkflowRunner({ adapter, root });
    const definition = await loadOfficialWorkflow();
    const run = runner.createRun(definition, inputs());
    const title = workflowTaskTitle(run);

    await runner.start(run.runId);
    await runner.waitForRun(run.runId, () => adapter.runs.length === 1);
    await runner.cancel(run.runId);
    expect((await runner.getRun(run.runId)).status).toBe("cancelled");

    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const after = await runner.getRun(run.runId);
    expect(after.status).toBe("cancelled");
    expect(adapter.agents).toEqual([title]);
    expect(adapter.created).toHaveLength(1);
    expect(after.writeTaskId).toBeUndefined();
    expect(after.decisionPath).toBeUndefined();
  });

  test("run records survive a new runner instance and list newest first", async () => {
    const root = await tempRoot();
    let clock = new Date("2025-01-02T03:04:05.000Z");
    let sequence = 0;
    const adapter = new FakeWorkflowTaskAdapter();
    const runner = new WorkflowRunner({
      adapter,
      root,
      now: () => clock,
      idFactory: () => "run-" + (++sequence),
    });
    const definition = await loadOfficialWorkflow();

    const first = runner.createRun(definition, inputs());
    expect(first.runId).toBe("run-1");
    await runner.start(first.runId);
    const waiting = await runner.waitForRun(first.runId, (candidate) => candidate.status === "waiting_approval");
    const digest = waiting.approval?.digest;
    if (!digest) throw new Error("expected an approval digest");
    await runner.approve(first.runId, digest);
    await runner.waitForRun(first.runId, (candidate) => candidate.status === "completed");

    clock = new Date(clock.getTime() + 60_000);
    const second = runner.createRun(definition, inputs());
    expect(second.runId).toBe("run-2");
    await runner.start(second.runId);
    await runner.waitForRun(second.runId, (candidate) => candidate.status === "waiting_approval");

    const fresh = new WorkflowRunner({ adapter: new FakeWorkflowTaskAdapter(), root });
    const records = await fresh.listRuns();
    expect(records.map((record) => record.runId)).toEqual(["run-2", "run-1"]);
    expect((await fresh.getRun("run-1")).status).toBe("completed");
    expect((await fresh.getRun("run-2")).status).toBe("waiting_approval");
    expect((await fresh.getRun("run-1")).decisionPath).toBeDefined();

    const persisted = await readRunRecord(root, "run-1");
    expect(persisted.runId).toBe("run-1");
    expect(persisted.status).toBe("completed");
  });

  test("a persisted waiting_approval run survives a new runner and can be approved", async () => {
    const root = await tempRoot();
    const adapter = new FakeWorkflowTaskAdapter();
    const runner = new WorkflowRunner({ adapter, root });
    const run = runner.createRun(await loadOfficialWorkflow(), inputs());

    await runner.start(run.runId);
    const waiting = await runner.waitForRun(run.runId, (candidate) => candidate.status === "waiting_approval");
    const digest = waiting.approval?.digest;
    if (!digest) throw new Error("expected an approval digest");

    const fresh = new WorkflowRunner({ adapter, root });
    const hydrated = await fresh.getRun(run.runId);
    expect(hydrated.status).toBe("waiting_approval");
    expect(hydrated.approval?.digest).toBe(digest);
    expect(hydrated.resolvedModel).toBe(profile.id);

    await fresh.approve(run.runId, digest);
    const completed = await fresh.waitForRun(run.runId, (candidate) => candidate.status === "completed");
    expect(completed.decisionPath).toBeDefined();
    expect(adapter.approvals).toEqual([{ taskId: completed.writeTaskId, digest }]);

    const decisionPath = completed.decisionPath;
    if (!decisionPath) throw new Error("expected a decision path");
    expect(await readFile(path.join(root, decisionPath), "utf8")).toContain("runId: " + run.runId);

    // The state the fresh runner observed is already durable for the next runner.
    const persisted = await readRunRecord(root, run.runId);
    expect(persisted.status).toBe("completed");
    expect(persisted.decisionPath).toBe(decisionPath);
    expect(persisted.approval).toMatchObject({ digest });
    expect((persisted.approval as { approvedAt?: string }).approvedAt).toBeDefined();
    expect((await new WorkflowRunner({ adapter, root }).getRun(run.runId)).status).toBe("completed");
  });

  test("a new runner can reject and cancel a persisted waiting run", async () => {
    const root = await tempRoot();
    const adapter = new FakeWorkflowTaskAdapter();
    const runner = new WorkflowRunner({ adapter, root });
    const run = runner.createRun(await loadOfficialWorkflow(), inputs());

    await runner.start(run.runId);
    await runner.waitForRun(run.runId, (candidate) => candidate.status === "waiting_approval");

    const fresh = new WorkflowRunner({ adapter, root });
    const waiting = await fresh.getRun(run.runId);
    const writeTaskId = waiting.writeTaskId;
    if (!writeTaskId) throw new Error("expected a write task");

    await fresh.reject(run.runId);
    const rejected = await fresh.waitForRun(
      run.runId,
      (candidate) => candidate.status === "waiting_approval" && candidate.attempts === 2,
    );
    expect(rejected.attempts).toBe(2);
    // Only implement -> validate -> review rerun; the write task is reused.
    expect(rejected.writeTaskId).toBe(writeTaskId);
    expect(adapter.rejections).toEqual([writeTaskId]);
    expect(adapter.created).toHaveLength(2);
    expect(adapter.agents).toHaveLength(3);
    const persisted = await readRunRecord(root, run.runId);
    expect(persisted.status).toBe("waiting_approval");
    expect(persisted.attempts).toBe(2);

    await fresh.cancel(run.runId);
    const cancelled = await fresh.getRun(run.runId);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.decisionPath).toBeUndefined();
    expect((await readRunRecord(root, run.runId)).status).toBe("cancelled");
    const decisions = await readdir(path.join(root, "specs", "decisions")).catch(() => []);
    expect(decisions).toEqual([]);
  });

  test("a new runner can retry a persisted failed run", async () => {
    const root = await tempRoot();
    const adapter = new FakeWorkflowTaskAdapter();
    adapter.validationResults.push({ status: "fail", checks: [], diagnostics: [{ severity: "error", message: "broken" }] });
    adapter.validationResults.push({ status: "pass", checks: [], diagnostics: [] });
    const runner = new WorkflowRunner({ adapter, root });
    const run = runner.createRun(await loadOfficialWorkflow(), inputs());

    await runner.start(run.runId);
    await runner.waitForRun(run.runId, (candidate) => candidate.status === "failed");

    const fresh = new WorkflowRunner({ adapter, root });
    await fresh.retry(run.runId, "validate");
    const waiting = await fresh.waitForRun(run.runId, (candidate) => candidate.status === "waiting_approval");
    expect(waiting.validation?.status).toBe("pass");
  });

  test("queued and running records hydrate as interrupted", async () => {
    const root = await tempRoot();
    let sequence = 0;
    const runner = new WorkflowRunner({
      adapter: new FakeWorkflowTaskAdapter(),
      root,
      idFactory: () => "run-" + (++sequence),
    });
    const definition = await loadOfficialWorkflow();

    const queued = structuredClone(runner.createRun(definition, inputs()));
    const running = structuredClone(runner.createRun(definition, inputs()));
    running.status = "running";
    const runningPlan = running.nodeStates.find((state) => state.id === "plan");
    if (!runningPlan) throw new Error("expected a plan node");
    runningPlan.status = "running";
    await persistRunRecord(root, queued);
    await persistRunRecord(root, running);

    const fresh = new WorkflowRunner({ adapter: new FakeWorkflowTaskAdapter(), root });
    const hydratedQueued = await fresh.getRun(queued.runId);
    expect(hydratedQueued.status).toBe("interrupted");
    expect(hydratedQueued.error).toMatch(/interrupted/i);
    expect((await readRunRecord(root, queued.runId)).status).toBe("interrupted");

    const hydratedRunning = await fresh.getRun(running.runId);
    expect(hydratedRunning.status).toBe("interrupted");
    expect(stateStatus(hydratedRunning, "plan")).toBe("failed");
    expect((await readRunRecord(root, running.runId)).status).toBe("interrupted");
  });

  test("a new start is rejected while a persisted waiting run exists", async () => {
    const root = await tempRoot();
    const adapter = new FakeWorkflowTaskAdapter();
    const runner = new WorkflowRunner({ adapter, root });
    const definition = await loadOfficialWorkflow();
    const first = runner.createRun(definition, inputs());

    await runner.start(first.runId);
    await runner.waitForRun(first.runId, (candidate) => candidate.status === "waiting_approval");

    const createdBefore = adapter.created.length;
    const agentsBefore = adapter.runs.length;
    const fresh = new WorkflowRunner({ adapter, root });
    const second = fresh.createRun(definition, inputs());
    await expect(fresh.start(second.runId)).rejects.toThrow(/waiting for approval/i);

    expect((await fresh.getRun(second.runId)).status).toBe("queued");
    expect((await fresh.getRun(first.runId)).status).toBe("waiting_approval");
    // The blocked run must not create a task, an agent run, or even a record.
    expect(adapter.created).toHaveLength(createdBefore);
    expect(adapter.runs).toHaveLength(agentsBefore);
    const runFiles = (await readdir(path.join(root, ".specloom", "workflows", "runs")))
      .filter((name) => name.endsWith(".json"));
    expect(runFiles).toEqual([first.runId + ".json"]);
  });

  test("a status is only observable once its record is durable, so cleanup never races a write", async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const root = await tempRoot();
      const runner = new WorkflowRunner({ adapter: new FakeWorkflowTaskAdapter(), root });
      const run = runner.createRun(await loadOfficialWorkflow(), inputs());

      await runner.start(run.runId);
      const waiting = await runner.waitForRun(run.runId, (candidate) => candidate.status === "waiting_approval");

      // What waitForRun reported must already be the record on disk.
      const persisted = await readRunRecord(root, run.runId);
      expect(persisted.status).toBe("waiting_approval");
      expect(persisted.approval).toEqual({ digest: waiting.approval?.digest });

      // No persist is in flight: recursive removal cannot race a recreated record.
      await expect(rm(root, { recursive: true })).resolves.toBeUndefined();
    }
  });

  test("persisted records use title, definitionSnapshot and approval", async () => {
    const root = await tempRoot();
    const adapter = new FakeWorkflowTaskAdapter();
    const runner = new WorkflowRunner({ adapter, root });
    const definition = await loadOfficialWorkflow();
    const run = runner.createRun(definition, inputs());

    await runner.start(run.runId);
    const waiting = await runner.waitForRun(run.runId, (candidate) => candidate.status === "waiting_approval");
    const record = await readRunRecord(root, run.runId);
    expect(record.title).toBe(definition.title);
    expect(record.definitionSnapshot).toEqual(definition);
    expect(record.approval).toEqual({ digest: waiting.approval?.digest });
    expect(record).not.toHaveProperty("workflowTitle");
    expect(record).not.toHaveProperty("definition");
    expect(record).not.toHaveProperty("approvalDigest");

    const digest = waiting.approval?.digest;
    if (!digest) throw new Error("expected an approval digest");
    await runner.approve(run.runId, digest);
    await runner.waitForRun(run.runId, (candidate) => candidate.status === "completed");
    const completedRecord = await readRunRecord(root, run.runId);
    expect(completedRecord.approval).toMatchObject({ digest });
    expect((completedRecord.approval as { approvedAt?: string }).approvedAt).toBeDefined();
  });

  test("invalid persisted records are rejected with a bounded internal error", async () => {
    const root = await tempRoot();
    const runner = new WorkflowRunner({ adapter: new FakeWorkflowTaskAdapter(), root });
    const run = runner.createRun(await loadOfficialWorkflow(), inputs());
    const invalid = { ...structuredClone(run), status: "bogus" } as unknown as WorkflowRun;
    await persistRunRecord(root, invalid);

    const fresh = new WorkflowRunner({ adapter: new FakeWorkflowTaskAdapter(), root });
    const error: unknown = await fresh.getRun(run.runId).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ProjectError);
    expect((error as ProjectError).code).toBe("INTERNAL_ERROR");
    expect((error as ProjectError).message).toMatch(/invalid at status/i);
    expect((error as ProjectError).message.length).toBeLessThanOrEqual(2000);
  });

  test("persisted errors are redacted and bounded", async () => {
    const root = await tempRoot();
    const adapter = new FakeWorkflowTaskAdapter();
    const secret = "super-secret-token-123";
    adapter.agentError = new Error("apiKey=" + secret + " Bearer abcdef " + "x".repeat(5000));
    const runner = new WorkflowRunner({ adapter, root });
    const run = runner.createRun(await loadOfficialWorkflow(), inputs());

    await runner.start(run.runId);
    const failed = await runner.waitForRun(run.runId, (candidate) => candidate.status === "failed");
    expect(failed.error).toBeDefined();
    expect(failed.error).not.toContain(secret);
    expect(failed.error).not.toContain("abcdef");
    expect(failed.error).toContain("[redacted]");
    expect(failed.error?.length).toBeLessThanOrEqual(2000);
  });

  test("waitForRun times out with a non-model error code", async () => {
    const root = await tempRoot();
    const runner = new WorkflowRunner({ adapter: new FakeWorkflowTaskAdapter(), root });
    const run = runner.createRun(await loadOfficialWorkflow(), inputs());

    const error: unknown = await runner.waitForRun(run.runId, () => false, 10).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ProjectError);
    expect((error as ProjectError).code).toBe("INTERNAL_ERROR");
    expect((error as ProjectError).code).not.toBe("MODEL_ERROR");
    expect((error as ProjectError).message).toMatch(/timed out/i);
  });
});
