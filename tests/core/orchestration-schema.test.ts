import { describe, expect, test } from "vitest";
import {
  OrchestrationDefinitionSchema,
  WorkflowSettingsSchema,
  type WorkflowDefaultResolution,
} from "../../src/shared/orchestration";

function step(id: string, workflowId = "wf_official_development_review", approval?: string) {
  return {
    id,
    workflowId,
    ...(approval === undefined ? {} : { approval }),
  };
}

const base = {
  schemaVersion: 1,
  id: "orch_release",
  title: "发布前检查",
  description: "发布前的连续审查",
  steps: [
    step("s1", "wf_official_development_review", "inherit"),
    step("s2", "wf_custom_release", "always"),
    step("s3", "wf_custom_notes", "auto"),
  ],
};

describe("orchestration definition", () => {
  test("accepts a sequential definition with inherit, always, and auto approvals", () => {
    const definition = OrchestrationDefinitionSchema.parse(base);
    expect(definition.id).toBe("orch_release");
    expect(definition.title).toBe("发布前检查");
    expect(definition.steps.map((entry) => entry.id)).toEqual(["s1", "s2", "s3"]);
    expect(definition.steps.map((entry) => entry.workflowId)).toEqual([
      "wf_official_development_review",
      "wf_custom_release",
      "wf_custom_notes",
    ]);
    expect(definition.steps.map((entry) => entry.approval)).toEqual(["inherit", "always", "auto"]);
  });

  test("defaults a step approval to inherit", () => {
    const definition = OrchestrationDefinitionSchema.parse({
      ...base,
      steps: [step("s1", "wf_custom_release")],
    });
    expect(definition.steps[0]?.approval).toBe("inherit");
  });

  test("rejects duplicate step ids", () => {
    const result = OrchestrationDefinitionSchema.safeParse({
      ...base,
      steps: [step("s1"), step("s1", "wf_custom_release")],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path.join("."))).toContain("steps.1.id");
    expect(result.error.issues.some((issue) => /duplicate step id: s1/.test(issue.message))).toBe(true);
  });

  test("rejects an unknown step approval", () => {
    const result = OrchestrationDefinitionSchema.safeParse({
      ...base,
      steps: [step("s1", "wf_custom_release", "never")],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((issue) => issue.path.join(".") === "steps.0.approval")).toBe(true);
  });

  test("rejects an empty step list", () => {
    const result = OrchestrationDefinitionSchema.safeParse({ ...base, steps: [] });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((issue) => issue.path.join(".") === "steps")).toBe(true);
  });

  test("accepts 20 steps and rejects 21", () => {
    const twenty = Array.from({ length: 20 }, (_, index) => step("s" + index, "wf_custom_release"));
    expect(OrchestrationDefinitionSchema.safeParse({ ...base, steps: twenty }).success).toBe(true);

    const twentyOne = [...twenty, step("s20", "wf_custom_release")];
    expect(OrchestrationDefinitionSchema.safeParse({ ...base, steps: twentyOne }).success).toBe(false);
  });

  test("rejects an orchestration id that is not a snake_case file name", () => {
    for (const id of ["Orch_release", "1orch", "orch-release", "orch release", ""]) {
      expect(OrchestrationDefinitionSchema.safeParse({ ...base, id }).success).toBe(false);
    }
  });

  test("rejects unknown definition fields", () => {
    expect(OrchestrationDefinitionSchema.safeParse({ ...base, extra: true }).success).toBe(false);
  });
});

describe("workflow settings", () => {
  test("accepts schemaVersion 1 with a project default workflow id", () => {
    const settings = WorkflowSettingsSchema.parse({
      schemaVersion: 1,
      defaultWorkflowId: "wf_custom_review",
    });
    expect(settings.schemaVersion).toBe(1);
    expect(settings.defaultWorkflowId).toBe("wf_custom_review");
  });

  test("allows the default workflow id to be absent", () => {
    const settings = WorkflowSettingsSchema.parse({ schemaVersion: 1 });
    expect(settings.defaultWorkflowId).toBeUndefined();
  });

  test("rejects an unknown schema version", () => {
    expect(WorkflowSettingsSchema.safeParse({ schemaVersion: 2 }).success).toBe(false);
  });

  test("rejects a default workflow id longer than 120 characters", () => {
    const tooLong = "wf_" + "a".repeat(118);
    expect(WorkflowSettingsSchema.safeParse({ schemaVersion: 1, defaultWorkflowId: tooLong }).success).toBe(false);
    expect(
      WorkflowSettingsSchema.safeParse({ schemaVersion: 1, defaultWorkflowId: "a".repeat(120) }).success,
    ).toBe(true);
  });

  test("rejects an empty default workflow id", () => {
    expect(WorkflowSettingsSchema.safeParse({ schemaVersion: 1, defaultWorkflowId: "   " }).success).toBe(false);
  });

  test("describes a resolved default workflow", () => {
    const resolution: WorkflowDefaultResolution = {
      workflowId: "wf_official_development_review",
      source: "official",
    };
    expect(resolution.source).toBe("official");
    expect(resolution.warning).toBeUndefined();
  });
});
