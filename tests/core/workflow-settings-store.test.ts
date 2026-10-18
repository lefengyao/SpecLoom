import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveDefaultWorkflow } from "../../src/main/core/workflow-defaults";
import { WORKFLOW_SETTINGS_RELATIVE_PATH, WorkflowSettingsStore } from "../../src/main/core/workflow-settings-store";
import { OFFICIAL_WORKFLOW_ID, type WorkflowSettings } from "../../src/shared/orchestration";
import type { WorkflowDefinition } from "../../src/shared/workflow";

const roots: string[] = [];
async function root(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "specloom-workflow-settings-"));
  roots.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function settingsFile(root: string): string {
  return path.join(root, ...WORKFLOW_SETTINGS_RELATIVE_PATH.split("/"));
}

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

describe("WorkflowSettingsStore", () => {
  test("reads a missing settings file as schema version 1", async () => {
    const directory = await root();
    const store = new WorkflowSettingsStore(directory);
    expect(await store.read()).toEqual({ schemaVersion: 1 });
    expect(await readdir(directory)).toEqual([]);
  });

  test("saves to the fixed path with an atomic replace", async () => {
    const directory = await root();
    const store = new WorkflowSettingsStore(directory);
    const saved = await store.save({ schemaVersion: 1, defaultWorkflowId: "wf_custom" });
    expect(saved).toEqual({ schemaVersion: 1, defaultWorkflowId: "wf_custom" });
    expect(await store.read()).toEqual(saved);

    const file = settingsFile(directory);
    const raw = await readFile(file, "utf8");
    expect(JSON.parse(raw)).toEqual(saved);
    expect(raw.endsWith("\n")).toBe(true);
    // Temp + rename leaves only the final file behind, and a later save replaces it.
    expect(await readdir(path.dirname(file))).toEqual(["workflow-settings.json"]);
    await store.save({ schemaVersion: 1 });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ schemaVersion: 1 });
  });

  test("clearDefault removes the stored id", async () => {
    const directory = await root();
    const store = new WorkflowSettingsStore(directory);
    await store.save({ schemaVersion: 1, defaultWorkflowId: "wf_custom" });

    expect(await store.clearDefault()).toEqual({ schemaVersion: 1 });

    const raw = JSON.parse(await readFile(settingsFile(directory), "utf8")) as Record<string, unknown>;
    expect(raw).toEqual({ schemaVersion: 1 });
    expect("defaultWorkflowId" in raw).toBe(false);
    expect(await store.read()).toEqual({ schemaVersion: 1 });
  });

  test("falls back to empty settings for corrupt or invalid files", async () => {
    const directory = await root();
    const store = new WorkflowSettingsStore(directory);
    const file = settingsFile(directory);
    await mkdir(path.dirname(file), { recursive: true });

    await writeFile(file, "{not json", "utf8");
    expect(await store.read()).toEqual({ schemaVersion: 1 });

    await writeFile(file, JSON.stringify({ schemaVersion: 1, defaultWorkflowId: "Not A Workflow" }), "utf8");
    expect(await store.read()).toEqual({ schemaVersion: 1 });

    await writeFile(file, JSON.stringify({ schemaVersion: 2 }), "utf8");
    expect(await store.read()).toEqual({ schemaVersion: 1 });

    await writeFile(file, JSON.stringify({ schemaVersion: 1, extra: true }), "utf8");
    expect(await store.read()).toEqual({ schemaVersion: 1 });
  });

  test("rejects invalid settings instead of writing them", async () => {
    const directory = await root();
    const store = new WorkflowSettingsStore(directory);
    await expect(
      store.save({ schemaVersion: 1, defaultWorkflowId: "Not A Workflow" } as unknown as WorkflowSettings),
    ).rejects.toMatchObject({ name: "ProjectError", code: "VALIDATION_FAILED" });
    expect(await store.read()).toEqual({ schemaVersion: 1 });
  });

  test("reports a write failure as a project error", async () => {
    const directory = await root();
    const store = new WorkflowSettingsStore(directory);
    // A file where the fixed directory belongs makes the atomic write impossible.
    await writeFile(path.join(directory, ".specloom"), "occupied", "utf8");
    await expect(store.save({ schemaVersion: 1 })).rejects.toMatchObject({
      name: "ProjectError",
      code: "INTERNAL_ERROR",
    });
  });
});

describe("resolveDefaultWorkflow", () => {
  test("uses the official workflow when no project default is configured", async () => {
    const loadProject = vi.fn(async () => PROJECT);
    const loadOfficial = vi.fn(async () => OFFICIAL);

    await expect(
      resolveDefaultWorkflow({ settings: { schemaVersion: 1 }, loadProject, loadOfficial }),
    ).resolves.toEqual({ workflowId: OFFICIAL_WORKFLOW_ID, source: "official" });
    expect(loadProject).not.toHaveBeenCalled();
    expect(loadOfficial).toHaveBeenCalledTimes(1);
  });

  test("uses the configured project workflow when it loads", async () => {
    const loadProject = vi.fn(async () => PROJECT);
    const loadOfficial = vi.fn(async () => OFFICIAL);

    await expect(
      resolveDefaultWorkflow({
        settings: { schemaVersion: 1, defaultWorkflowId: "wf_custom" },
        loadProject,
        loadOfficial,
      }),
    ).resolves.toEqual({ workflowId: "wf_custom", source: "project" });
    expect(loadProject).toHaveBeenCalledWith("wf_custom");
    expect(loadOfficial).not.toHaveBeenCalled();
  });

  test("falls back to the official workflow when the configured workflow is missing", async () => {
    const loadProject = vi.fn(async () => {
      throw new Error("workflow file is missing");
    });
    const loadOfficial = vi.fn(async () => OFFICIAL);

    const result = await resolveDefaultWorkflow({
      settings: { schemaVersion: 1, defaultWorkflowId: "wf_custom" },
      loadProject,
      loadOfficial,
    });

    expect(result.workflowId).toBe(OFFICIAL_WORKFLOW_ID);
    expect(result.source).toBe("fallback");
    expect(result.warning).toContain("wf_custom");
    expect(result.warning).toContain("workflow file is missing");
  });

  test("falls back when the loaded definition declares another id", async () => {
    const loadProject = vi.fn(async () => definition("wf_other"));
    const loadOfficial = vi.fn(async () => OFFICIAL);

    const result = await resolveDefaultWorkflow({
      settings: { schemaVersion: 1, defaultWorkflowId: "wf_custom" },
      loadProject,
      loadOfficial,
    });

    expect(result.source).toBe("fallback");
    expect(result.warning).toContain("wf_other");
  });

  test("falls back when the project definition fails workflow validation", async () => {
    const broken = { ...PROJECT, nodes: [] } as unknown as WorkflowDefinition;
    const loadProject = vi.fn(async () => broken);
    const loadOfficial = vi.fn(async () => OFFICIAL);

    const result = await resolveDefaultWorkflow({
      settings: { schemaVersion: 1, defaultWorkflowId: "wf_custom" },
      loadProject,
      loadOfficial,
    });

    expect(result.workflowId).toBe(OFFICIAL_WORKFLOW_ID);
    expect(result.source).toBe("fallback");
    expect(result.warning).toBeDefined();
  });

  test("treats the official id as the official default without a warning", async () => {
    const loadProject = vi.fn(async () => PROJECT);
    const loadOfficial = vi.fn(async () => OFFICIAL);

    await expect(
      resolveDefaultWorkflow({
        settings: { schemaVersion: 1, defaultWorkflowId: OFFICIAL_WORKFLOW_ID },
        loadProject,
        loadOfficial,
      }),
    ).resolves.toEqual({ workflowId: OFFICIAL_WORKFLOW_ID, source: "official" });
    expect(loadProject).not.toHaveBeenCalled();
  });
});
