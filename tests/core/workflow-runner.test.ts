import { describe, expect, test, vi } from "vitest";
import type { ModelProfile, TaskScopeSpec, ValidationResult } from "../../src/shared/contracts";
import type { ChangeReview } from "../../src/shared/desktop-api";
import { ProjectCoreWorkflowTaskAdapter, type WorkflowTaskAdapter, type WorkflowTaskCore } from "../../src/main/core/workflow-task-adapter";
import { ProjectError } from "../../src/main/core/errors";
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
      readPaths: ["specs"],
      writePaths: ["specs/entities"],
      allowDelete: false,
      mode: "manual",
    });
    expect(created.scope).toEqual({ title: "implement", readPaths: ["specs"], writePaths: ["specs/entities"] });

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
