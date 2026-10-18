import { describe, expect, test } from "vitest";
import { EntityLayoutRequestSchema, WorkflowRunInputsSchema, WorkflowSaveRequestSchema } from "../../src/main/ipc";

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
describe("entity layout requests", () => {
  test("accepts finite entity/component points", () => {
    expect(EntityLayoutRequestSchema.safeParse({ layout: { keeper: { health: { x: 1, y: 2 } } } }).success).toBe(true);
  });

  test("rejects non-finite points and unknown fields", () => {
    expect(EntityLayoutRequestSchema.safeParse({ layout: { keeper: { health: { x: Number.NaN, y: 2 } } } }).success).toBe(false);
    expect(EntityLayoutRequestSchema.safeParse({ layout: { keeper: { health: { x: 1, y: 2 } } }, extra: true }).success).toBe(false);
  });
});
