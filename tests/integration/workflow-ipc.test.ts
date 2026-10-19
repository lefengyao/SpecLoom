import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  EntityLayoutRequestSchema,
  OrchestrationApproveRequestSchema,
  OrchestrationCancelRequestSchema,
  OrchestrationRetryRequestSchema,
  OrchestrationSaveRequestSchema,
  OrchestrationStartRequestSchema,
  WorkflowRunInputsSchema,
  WorkflowRunRequestSchema,
  WorkflowSaveRequestSchema,
  WorkflowSettingsRequestSchema,
  WorkflowStartForChatRequestSchema,
  WorkflowStartForTaskRequestSchema,
} from "../../src/main/ipc";
import { stringifyOrchestration } from "../../src/main/core/orchestration-store";
import type { ProjectCore } from "../../src/main/core/project-core";
import { WorkflowService } from "../../src/main/core/workflow-service";
import { loadOfficialWorkflow } from "../../src/main/core/workflow-official";
import { WorkflowRunner } from "../../src/main/core/workflow-runner";
import { OrchestrationDefinitionSchema } from "../../src/shared/orchestration";
import { MAX_RUN_CONTEXT_LENGTH } from "../../src/shared/workflow-api";
import { FakeWorkflowTaskAdapter } from "../helpers/fake-workflow-task-adapter";

/**
 * Pure schema tests for the workflow IPC surface.
 *
 * The handlers themselves need an Electron window and a live project core, so
 * this file only pins the request contracts the renderer has to satisfy. The id
 * rule is the same one the store applies to specs/workflows/<id>.yaml.
 */
describe("workflow save requests", () => {
  test("accepts a valid save request", () => {
    const parsed = WorkflowSaveRequestSchema.safeParse({
      id: "wf_demo",
      content: "schemaVersion: 1",
      expectedVersion: "absent",
    });
    expect(parsed.success).toBe(true);
  });

  test("accepts a sha256 file version token", () => {
    const parsed = WorkflowSaveRequestSchema.safeParse({
      id: "official_development_review",
      content: "schemaVersion: 1",
      expectedVersion: "sha256:" + "a".repeat(64),
    });
    expect(parsed.success).toBe(true);
  });

  test("rejects a path traversal id", () => {
    const parsed = WorkflowSaveRequestSchema.safeParse({
      id: "../escape",
      content: "schemaVersion: 1",
      expectedVersion: "absent",
    });
    expect(parsed.success).toBe(false);
  });

  test("rejects an uppercase or otherwise unsafe id", () => {
    for (const id of ["Wf_Demo", "WF", "1workflow", "_workflow", "workflow.yaml", "work flow"]) {
      expect(
        WorkflowSaveRequestSchema.safeParse({ id, content: "schemaVersion: 1", expectedVersion: "absent" }).success,
      ).toBe(false);
    }
  });

  test("rejects an id longer than 120 characters", () => {
    const parsed = WorkflowSaveRequestSchema.safeParse({
      id: "a" + "b".repeat(120),
      content: "schemaVersion: 1",
      expectedVersion: "absent",
    });
    expect(parsed.success).toBe(false);
  });

  test("rejects content above the 1 MiB document budget", () => {
    const parsed = WorkflowSaveRequestSchema.safeParse({
      id: "wf_demo",
      content: "x".repeat(1_048_577),
      expectedVersion: "absent",
    });
    expect(parsed.success).toBe(false);
  });

  test("rejects an unknown or invalid version token and unknown fields", () => {
    expect(WorkflowSaveRequestSchema.safeParse({ id: "wf_demo", content: "x", expectedVersion: "v1" }).success).toBe(false);
    expect(
      WorkflowSaveRequestSchema.safeParse({ id: "wf_demo", content: "x", expectedVersion: "absent", overwrite: true }).success,
    ).toBe(false);
  });
});

describe("workflow run inputs", () => {
  const valid = {
    goal: "实现灯塔修复交互",
    readPaths: ["specs"],
    writePaths: ["scripts"],
    model: "model-1",
  };

  test("accepts valid inputs with and without a model", () => {
    expect(WorkflowRunInputsSchema.safeParse(valid).success).toBe(true);
    const withoutModel = { goal: valid.goal, readPaths: valid.readPaths, writePaths: valid.writePaths };
    expect(WorkflowRunInputsSchema.safeParse(withoutModel).success).toBe(true);
  });

  test("rejects empty or invalid path lists", () => {
    expect(WorkflowRunInputsSchema.safeParse({ ...valid, readPaths: [] }).success).toBe(false);
    expect(WorkflowRunInputsSchema.safeParse({ ...valid, writePaths: [] }).success).toBe(false);
    expect(WorkflowRunInputsSchema.safeParse({ ...valid, readPaths: [""] }).success).toBe(false);
    expect(WorkflowRunInputsSchema.safeParse({ ...valid, writePaths: ["  "] }).success).toBe(false);
  });

  test("rejects an empty goal and unknown fields", () => {
    expect(WorkflowRunInputsSchema.safeParse({ ...valid, goal: "   " }).success).toBe(false);
    expect(WorkflowRunInputsSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
  });
});
describe("workflow run context boundary", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function workflowRoot(): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "specloom-workflow-context-"));
    await mkdir(path.join(root, "specs", "entities"), { recursive: true });
    roots.push(root);
    return root;
  }

  test("context survives a valid IPC payload and persisted record validation", async () => {
    const payload = {
      goal: "实现灯塔修复交互",
      readPaths: ["specs"],
      writePaths: ["specs/entities"],
      context: "  上一步摘要：模型参数已确认  ",
    };
    const parsed = WorkflowRunInputsSchema.parse(payload);
    expect(parsed.context).toBe("上一步摘要：模型参数已确认");

    const root = await workflowRoot();
    const runner = new WorkflowRunner({ adapter: new FakeWorkflowTaskAdapter(), root });
    const run = runner.createRun(await loadOfficialWorkflow(), parsed);
    expect(run.inputs.context).toBe("上一步摘要：模型参数已确认");

    const recordPath = path.join(root, ".specloom", "workflows", "runs", run.runId + ".json");
    await mkdir(path.dirname(recordPath), { recursive: true });
    await writeFile(recordPath, JSON.stringify(run, null, 2) + "\n", "utf8");

    // The runner validates a persisted record with the same shared schema.
    const fresh = new WorkflowRunner({ adapter: new FakeWorkflowTaskAdapter(), root });
    expect((await fresh.getRun(run.runId)).inputs.context).toBe("上一步摘要：模型参数已确认");
  });

  test("record validation rejects an over-long context at the inputs boundary", async () => {
    const root = await workflowRoot();
    const runner = new WorkflowRunner({ adapter: new FakeWorkflowTaskAdapter(), root });
    const run = runner.createRun(await loadOfficialWorkflow(), {
      goal: "实现灯塔修复交互",
      readPaths: ["specs"],
      writePaths: ["specs/entities"],
    });
    const recordPath = path.join(root, ".specloom", "workflows", "runs", run.runId + ".json");
    await mkdir(path.dirname(recordPath), { recursive: true });
    await writeFile(
      recordPath,
      JSON.stringify({ ...run, inputs: { ...run.inputs, context: "x".repeat(MAX_RUN_CONTEXT_LENGTH + 1) } }),
      "utf8",
    );

    const fresh = new WorkflowRunner({ adapter: new FakeWorkflowTaskAdapter(), root });
    await expect(fresh.getRun(run.runId)).rejects.toThrow(/inputs\.context/);
  });
});

describe("workflow defaults requests", () => {
  test("accepts a settings document with or without a default workflow", () => {
    expect(WorkflowSettingsRequestSchema.safeParse({ settings: { schemaVersion: 1 } }).success).toBe(true);
    expect(
      WorkflowSettingsRequestSchema.safeParse({ settings: { schemaVersion: 1, defaultWorkflowId: "wf_demo" } }).success,
    ).toBe(true);
  });

  test("rejects an unsafe default workflow id, an unknown schema version, and unknown fields", () => {
    for (const defaultWorkflowId of ["../escape", "Wf_Demo", "workflow.yaml", "work flow", "a" + "b".repeat(120)]) {
      expect(
        WorkflowSettingsRequestSchema.safeParse({ settings: { schemaVersion: 1, defaultWorkflowId } }).success,
      ).toBe(false);
    }
    expect(WorkflowSettingsRequestSchema.safeParse({ settings: { schemaVersion: 2 } }).success).toBe(false);
    expect(
      WorkflowSettingsRequestSchema.safeParse({ settings: { schemaVersion: 1, defaultWorkflowId: "wf_demo", extra: true } })
        .success,
    ).toBe(false);
    expect(WorkflowSettingsRequestSchema.safeParse({ settings: { schemaVersion: 1 }, extra: true }).success).toBe(false);
  });
});

describe("orchestration definition requests", () => {
  test("accepts a save request with a valid id and version token", () => {
    expect(
      OrchestrationSaveRequestSchema.safeParse({
        id: "chain_demo",
        content: "schemaVersion: 1",
        expectedVersion: "absent",
      }).success,
    ).toBe(true);
    expect(
      OrchestrationSaveRequestSchema.safeParse({
        id: "chain_demo",
        content: "schemaVersion: 1",
        expectedVersion: "sha256:" + "a".repeat(64),
      }).success,
    ).toBe(true);
  });

  test("rejects a path traversal or otherwise unsafe orchestration id", () => {
    for (const id of ["../escape", "Chain_Demo", "1chain", "_chain", "chain.yaml", "chain demo", "a" + "b".repeat(120)]) {
      expect(
        OrchestrationSaveRequestSchema.safeParse({ id, content: "schemaVersion: 1", expectedVersion: "absent" }).success,
      ).toBe(false);
    }
  });

  test("rejects content above the 1 MiB budget, an invalid version token, and unknown fields", () => {
    expect(
      OrchestrationSaveRequestSchema.safeParse({
        id: "chain_demo",
        content: "x".repeat(1_048_577),
        expectedVersion: "absent",
      }).success,
    ).toBe(false);
    expect(
      OrchestrationSaveRequestSchema.safeParse({ id: "chain_demo", content: "x", expectedVersion: "v1" }).success,
    ).toBe(false);
    expect(
      OrchestrationSaveRequestSchema.safeParse({
        id: "chain_demo",
        content: "x",
        expectedVersion: "absent",
        overwrite: true,
      }).success,
    ).toBe(false);
  });
});

describe("orchestration run requests", () => {
  const inputs = { goal: "实现编排", readPaths: ["specs"], writePaths: ["specs/entities"] };

  test("accepts a start request with shared run inputs and bounded context", () => {
    const parsed = OrchestrationStartRequestSchema.safeParse({
      id: "chain_demo",
      inputs: { ...inputs, context: "  上一步摘要  " },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.inputs.context).toBe("上一步摘要");
  });

  test("rejects an invalid orchestration id, empty inputs, and over-long context", () => {
    expect(OrchestrationStartRequestSchema.safeParse({ id: "../escape", inputs }).success).toBe(false);
    expect(OrchestrationStartRequestSchema.safeParse({ id: "chain_demo", inputs: {} }).success).toBe(false);
    expect(
      OrchestrationStartRequestSchema.safeParse({ id: "chain_demo", inputs: { ...inputs, goal: "   " } }).success,
    ).toBe(false);
    expect(
      OrchestrationStartRequestSchema.safeParse({
        id: "chain_demo",
        inputs: { ...inputs, context: "x".repeat(MAX_RUN_CONTEXT_LENGTH + 1) },
      }).success,
    ).toBe(false);
    expect(
      OrchestrationStartRequestSchema.safeParse({ id: "chain_demo", inputs: { ...inputs, extra: true } }).success,
    ).toBe(false);
  });

  test("accepts safe run ids and rejects traversal for every run operation", () => {
    expect(WorkflowRunRequestSchema.safeParse({ runId: "run-1.a_b" }).success).toBe(true);
    for (const runId of ["../escape", ".hidden", "a/b", "", "a".repeat(129)]) {
      expect(WorkflowRunRequestSchema.safeParse({ runId }).success).toBe(false);
      expect(OrchestrationApproveRequestSchema.safeParse({ runId, digest: "digest" }).success).toBe(false);
      expect(OrchestrationRetryRequestSchema.safeParse({ runId, action: "implement" }).success).toBe(false);
      expect(OrchestrationCancelRequestSchema.safeParse({ runId }).success).toBe(false);
    }
    expect(WorkflowRunRequestSchema.safeParse({ runId: "run-1", extra: true }).success).toBe(false);
  });

  test("validates the approval digest and retry action", () => {
    expect(OrchestrationApproveRequestSchema.safeParse({ runId: "run-1", digest: "sha256:abc" }).success).toBe(true);
    expect(OrchestrationApproveRequestSchema.safeParse({ runId: "run-1", digest: "" }).success).toBe(false);
    for (const action of ["plan", "implement", "validate"]) {
      expect(OrchestrationRetryRequestSchema.safeParse({ runId: "run-1", action }).success).toBe(true);
    }
    expect(OrchestrationRetryRequestSchema.safeParse({ runId: "run-1", action: "restart" }).success).toBe(false);
  });
});

describe("workflow service defaults and orchestrations", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function serviceRoot(): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "specloom-workflow-service-"));
    await mkdir(path.join(root, "specs", "orchestrations"), { recursive: true });
    roots.push(root);
    return root;
  }

  /**
   * Only metadata.path is read by the defaults and orchestration-definition
   * methods, so a plain double keeps this test Electron-free.
   */
  function service(root: string): WorkflowService {
    return new WorkflowService({
      core: { metadata: { path: root } } as unknown as ProjectCore,
      resolveProfile: () => {
        throw new Error("profile resolution is not used by these operations");
      },
    });
  }

  const orchestration = OrchestrationDefinitionSchema.parse({
    schemaVersion: 1,
    id: "chain_demo",
    title: "编排 chain_demo",
    description: "",
    steps: [{ id: "first", workflowId: "wf_demo", approval: "inherit" }],
  });

  test("reads, saves, and clears the project defaults", async () => {
    const client = service(await serviceRoot());
    expect(await client.defaultsRead()).toEqual({ schemaVersion: 1 });

    const saved = await client.defaultsSave({ schemaVersion: 1, defaultWorkflowId: "wf_demo" });
    expect(saved).toEqual({ schemaVersion: 1, defaultWorkflowId: "wf_demo" });
    expect(await client.defaultsRead()).toEqual(saved);

    expect(await client.defaultsClear()).toEqual({ schemaVersion: 1 });
    expect(await client.defaultsRead()).toEqual({ schemaVersion: 1 });
  });

  test("lists, reads, saves, and removes orchestration definitions", async () => {
    const client = service(await serviceRoot());
    const content = stringifyOrchestration(orchestration);

    const saved = await client.orchestrationSave("chain_demo", content, "absent");
    expect(saved.fileVersion).not.toBe("absent");

    const summaries = await client.orchestrationList();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ id: "chain_demo", title: "编排 chain_demo", stepCount: 1 });

    const read = await client.orchestrationRead("chain_demo");
    expect(read.definition.id).toBe("chain_demo");
    expect(read.fileVersion).toBe(saved.fileVersion);

    await client.orchestrationRemove("chain_demo", saved.fileVersion);
    expect(await client.orchestrationList()).toEqual([]);
  });

  test("rejects a traversal id and an unknown orchestration at the service boundary", async () => {
    const client = service(await serviceRoot());
    await expect(client.orchestrationRead("../escape")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      client.orchestrationStart("chain_missing", {
        goal: "实现编排",
        readPaths: ["specs"],
        writePaths: ["specs/entities"],
      }),
    ).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
  });
});

describe("entity layout requests", () => {
  test("accepts finite entity/component points", () => {
    expect(EntityLayoutRequestSchema.safeParse({ layout: { keeper: { health: { x: 1, y: 2 } } } }).success).toBe(true);
  });

  test("rejects non-finite points and unknown fields", () => {
    expect(EntityLayoutRequestSchema.safeParse({ layout: { keeper: { health: { x: Number.NaN, y: 2 } } } }).success).toBe(false);
    expect(EntityLayoutRequestSchema.safeParse({ layout: { keeper: { health: { x: 1, y: 2 } } }, extra: true }).success).toBe(false);
  });
});
describe("workflow trigger requests", () => {
  test("accepts a task start with an optional bounded implementation message", () => {
    expect(WorkflowStartForTaskRequestSchema.safeParse({ taskId: "task-1" }).success).toBe(true);
    expect(
      WorkflowStartForTaskRequestSchema.safeParse({ taskId: "task-1", message: "开始实现灯塔交互" }).success,
    ).toBe(true);
    expect(WorkflowStartForTaskRequestSchema.safeParse({ taskId: "" }).success).toBe(false);
    expect(
      WorkflowStartForTaskRequestSchema.safeParse({ taskId: "task-1", message: "x".repeat(131073) }).success,
    ).toBe(false);
    expect(
      WorkflowStartForTaskRequestSchema.safeParse({ taskId: "task-1", extra: true }).success,
    ).toBe(false);
  });

  test("accepts a chat implementation turn with shared scope inputs and an optional workflow", () => {
    const input = { goal: "实现守灯人交互", readPaths: ["*"], writePaths: ["scripts"] };
    expect(WorkflowStartForChatRequestSchema.safeParse({ input }).success).toBe(true);
    expect(
      WorkflowStartForChatRequestSchema.safeParse({
        input: { ...input, workflowId: "wf_demo", model: "model-1" },
      }).success,
    ).toBe(true);
  });

  test("rejects a chat turn without a usable goal, paths, or with an unsafe workflow id", () => {
    const input = { goal: "实现守灯人交互", readPaths: ["*"], writePaths: ["scripts"] };
    expect(WorkflowStartForChatRequestSchema.safeParse({ input: { ...input, goal: "   " } }).success).toBe(false);
    expect(WorkflowStartForChatRequestSchema.safeParse({ input: { ...input, readPaths: [] } }).success).toBe(false);
    expect(WorkflowStartForChatRequestSchema.safeParse({ input: { ...input, writePaths: [] } }).success).toBe(false);
    expect(
      WorkflowStartForChatRequestSchema.safeParse({ input: { ...input, workflowId: "../escape" } }).success,
    ).toBe(false);
    expect(WorkflowStartForChatRequestSchema.safeParse({ input: { ...input, extra: true } }).success).toBe(false);
  });
});
