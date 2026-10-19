import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkspaceTools } from "../../src/main/core/tools/workspace-tools";
import type {
  WorkflowListResult,
  WorkflowRunView,
  WorkflowToolRuntime,
} from "../../src/main/core/tools/workflow-tools";
import { godotMcpToolDefinitions } from "../../src/main/core/godot-mcp/tool-definitions";
import type { GodotMcpHostRegistry } from "../../src/main/core/godot-mcp/host-registry";
import { createWorkflowToolRuntime } from "../../src/main/core/workflow-tool-runtime";
import type { ProjectCore } from "../../src/main/core/project-core";
import { loadOfficialWorkflow } from "../../src/main/core/workflow-official";
import { WorkflowRunner } from "../../src/main/core/workflow-runner";
import { WorkflowService } from "../../src/main/core/workflow-service";
import { OFFICIAL_WORKFLOW_ID, type OrchestrationRun } from "../../src/shared/orchestration";
import type { OrchestrationSummary } from "../../src/shared/orchestration-api";
import type { WorkflowRun, WorkflowSummary } from "../../src/shared/workflow-api";
import { FakeWorkflowTaskAdapter } from "../helpers/fake-workflow-task-adapter";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "specloom-tools-")); await writeFile(path.join(root, "main.ts"), "const value = 1;\n"); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
test("every conversation can discover tools; existing files require its own read receipt", async () => {
  const tools = new WorkspaceTools(root, "session-a");
  expect(tools.catalog.providerTools().map(t => t.function.name)).toContain("Read");
  await expect(tools.execute("Edit", { path: "main.ts", old_string: "1", new_string: "2" })).rejects.toThrow(/Read/);
  await tools.execute("Read", { path: "main.ts" });
  await tools.execute("Edit", { path: "main.ts", old_string: "1", new_string: "2" });
  expect(await readFile(path.join(root, "main.ts"), "utf8")).toContain("2");
  const other = new WorkspaceTools(root, "session-b");
  await expect(other.execute("Write", { path: "main.ts", content: "overwrite" })).rejects.toThrow(/Read/);
  await tools.close(); await other.close();
});

test("an aborted refresh cannot clear a newer catalog after delayed MCP shutdown", async () => {
  const tools = new WorkspaceTools(root, "refresh-cancelled"); const controller = new AbortController();
  let finishClose!: () => void;
  const closing = new Promise<void>(resolve => { finishClose = resolve; });
  const internals = tools as unknown as { mcp: { close(): Promise<void> } };
  vi.spyOn(internals.mcp, "close").mockImplementationOnce(() => closing);
  const capabilities = vi.spyOn(tools, "capabilities");
  const refreshing = tools.refresh(controller.signal).catch(error => error);
  controller.abort();
  tools.catalog.add({ ...tools.catalog.all()[0]!, name: "mcp_newer_catalog" });
  finishClose();
  expect(await refreshing).toMatchObject({ name: "AbortError" });
  expect(tools.catalog.all().some(tool => tool.name === "mcp_newer_catalog")).toBe(true);
  expect(capabilities).not.toHaveBeenCalled();
  await tools.close();
});
test("conflicting reads preserve external changes and glob/grep find code", async () => {
  const tools = new WorkspaceTools(root, "conflict");
  await tools.execute("Read", { path: "main.ts" });
  await writeFile(path.join(root, "main.ts"), "external edit\n");
  await expect(tools.execute("Edit", { path: "main.ts", old_string: "value", new_string: "other" })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  expect(await tools.execute("Glob", { pattern: "**/*.ts" })).toEqual(["main.ts"]);
  expect(await tools.execute("Grep", { pattern: "external", glob: "**/*.ts" })).toMatchObject({ matches: [{ path: "main.ts", line: 1, text: "external edit" }] });
  await tools.close();
});
test("task and memory records survive reload; ToolSearch loads only matched schemas", async () => {
  const tools = new WorkspaceTools(root, "state");
  expect(tools.catalog.providerTools().some(t => t.function.name === "Monitor")).toBe(false);
  const discovered = await tools.execute("ToolSearch", { query: "Monitor" });
  expect(discovered).toMatchObject({ tools: [{ name: "Monitor" }] });
  expect(tools.catalog.providerTools().some(t => t.function.name === "Monitor")).toBe(true);
  const todo = await tools.execute("TaskCreate", { title: "实现移动", description: "角色移动" }) as { id: string };
  await tools.execute("TaskUpdate", { id: todo.id, status: "completed" });
  await tools.execute("memory", { operation: "write", key: "engine", value: "Godot 4.7.1" });
  await tools.close();
  const reloaded = new WorkspaceTools(root, "state");
  expect(await reloaded.execute("TaskList", {})).toMatchObject([{ id: todo.id, status: "completed" }]);
  expect(await reloaded.execute("memory", { operation: "read", key: "engine" })).toEqual({ key: "engine", value: "Godot 4.7.1" });
  await reloaded.close();
});

test("Godot projects discover and route only the eight validated read-only MCP tools", async () => {
  await writeFile(path.join(root, "project.godot"), "config_version=5\n[application]\nconfig/name=\"Fixture\"\n");
  const call = vi.fn(async (_root: string, name: string) => name === "get_editor_screenshot"
    ? { mimeType: "image/png", base64: "aGVsbG8=", width: 1, height: 1 }
    : { success: true, tool: name });
  const host = { call, status: () => ({ state: "connected", connected: true, projectPath: root, port: 6505, pendingRequests: 0 }) } as unknown as GodotMcpHostRegistry;
  const tools = new WorkspaceTools(root, "godot-session", { godotMcpHosts: host });
  tools.setPermissions("full");
  try {
    const capability = await tools.capabilities();
    expect(capability.plugins).toEqual([expect.objectContaining({ name: "SpecLoom Godot MCP" })]);
    const search = await tools.execute("ToolSearch", { query: "get_" }) as { tools: { name: string }[] };
    expect(search.tools.map(tool => tool.name).sort()).toEqual(godotMcpToolDefinitions.map(tool => tool.name).sort());
    await expect(tools.execute("get_scene_tree", {})).resolves.toEqual({ success: true, tool: "get_scene_tree" });
    await expect(tools.execute("get_editor_screenshot", {})).resolves.toMatchObject({ mimeType: "image/png", width: 1 });
    await expect(tools.execute("get_game_node_properties", { path: "../secret" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(call).toHaveBeenCalledWith(root, "get_scene_tree", { max_depth: 15 }, undefined);
    expect(call).toHaveBeenCalledTimes(2);
    expect(tools.catalog.all().some(tool => ["GodotScreenshot", "GodotPluginInstall"].includes(tool.name))).toBe(false);
  } finally { await tools.close(); }
});
test("commands execute from project root and Monitor streams actual lines with cancellation", async () => {
  const tools = new WorkspaceTools(root, "process");
  tools.setPermissions("full");
  try {
  const result = await tools.execute("code_execution", { language: "javascript", code: "console.log(6*7)" }) as { output: string; exitCode: number };
  expect(result.output.trim()).toBe("42"); expect(result.exitCode).toBe(0);
  const lines: string[] = [];
  const job = await tools.execute("Monitor", { operation: "start", command: "echo monitor-line" }, undefined, async l => { lines.push(l); }) as { id: string };
  await vi.waitFor(async () => expect(await tools.execute("Monitor", { operation: "poll", id: job.id, waitMs: 250 })).toMatchObject({ status: "completed" }), { timeout: 10000 });
  expect(lines.join("\n")).toContain("monitor-line");
  } finally { await tools.close(); }
});

test.skipIf(!process.env.SPECLOOM_PYTHON_EXECUTABLE)("code_execution uses a configured real Python interpreter and project working directory", async () => {
  const tools = new WorkspaceTools(root, "python");
  tools.setPermissions("full");
  try {
    const result = await tools.execute("code_execution", { language: "python", code: "from pathlib import Path\nprint(6*7)\nprint(Path('main.ts').read_text().strip())" }) as { output: string; exitCode: number };
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("42");
    expect(result.output).toContain("const value = 1;");
  } finally { await tools.close(); }
});

test("Read extracts real PDF pages, notebooks and image payloads", async () => {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const stream = "BT /F1 12 Tf 20 100 Td (SpecLoom PDF 42) Tj ET"; objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  let pdf = "%PDF-1.4\n"; const offsets = [0]; for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf); pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  await writeFile(path.join(root, "sample.pdf"), pdf); await writeFile(path.join(root, "sample.ipynb"), JSON.stringify({ cells: [{ cell_type: "code", source: ["print(42)"], outputs: [] }] }));
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jzGQAAAAASUVORK5CYII="; await writeFile(path.join(root, "sample.png"), Buffer.from(png, "base64"));
  const tools = new WorkspaceTools(root, "media");
  expect(await tools.execute("Read", { path: "sample.pdf" })).toMatchObject({ totalPages: 1, pages: [{ page: 1, text: "SpecLoom PDF 42" }] });
  expect(await tools.execute("Read", { path: "sample.ipynb" })).toMatchObject({ cells: [{ type: "code", source: "print(42)" }] });
  expect(await tools.execute("Read", { path: "sample.png" })).toMatchObject({ images: [{ mimeType: "image/png", base64: png }] });
  await tools.close();
});
/**
 * Workflow and orchestration tools.
 *
 * Delegation tests inject a fake runtime so they never start a real run; the
 * store-facing tests use a real WorkflowService over the temporary project so
 * creation, B validation, defaults, and file versions are exercised for real.
 */
function fakeRuntime(overrides: Partial<WorkflowToolRuntime> = {}): WorkflowToolRuntime {
  const unused = (name: string) => async (): Promise<never> => { throw new Error(name + " should not be called"); };
  return {
    list: async (): Promise<WorkflowListResult> => ({ workflows: [], defaultWorkflowId: OFFICIAL_WORKFLOW_ID, defaultSource: "official" }),
    read: unused("read"),
    create: unused("create"),
    run: unused("run"),
    status: unused("status"),
    cancel: unused("cancel"),
    orchestrationList: async () => ({ orchestrations: [] }),
    orchestrationRead: unused("orchestrationRead"),
    orchestrationCreate: unused("orchestrationCreate"),
    orchestrationRun: unused("orchestrationRun"),
    orchestrationStatus: unused("orchestrationStatus"),
    orchestrationCancel: unused("orchestrationCancel"),
    ...overrides,
  };
}

const WORKFLOW_TOOL_NAMES = [
  "WorkflowList", "WorkflowRead", "WorkflowCreate", "WorkflowRun", "WorkflowStatus", "WorkflowCancel",
  "OrchestrationList", "OrchestrationRead", "OrchestrationCreate", "OrchestrationRun", "OrchestrationStatus", "OrchestrationCancel",
];

test("workflow tools load on demand, are discoverable by ToolSearch, and offer no approval tool", async () => {
  const tools = new WorkspaceTools(root, "workflow-catalog");
  try {
    const names = tools.catalog.all().map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining(WORKFLOW_TOOL_NAMES));
    expect(names.filter(name => /approve/i.test(name))).toEqual([]);

    const initial = tools.catalog.providerTools().map(tool => tool.function.name);
    expect(initial).not.toContain("WorkflowRun");
    expect(initial).not.toContain("WorkflowList");

    const discovered = await tools.execute("ToolSearch", { query: "WorkflowRun" }) as { tools: { name: string }[] };
    expect(discovered.tools.map(tool => tool.name)).toContain("WorkflowRun");
    expect(tools.catalog.providerTools().map(tool => tool.function.name)).toContain("WorkflowRun");
    await expect(tools.execute("WorkflowApprove", { runId: "run-1" })).rejects.toMatchObject({ code: "MODEL_ERROR" });
  } finally { await tools.close(); }
});

test("WorkflowList and OrchestrationList report the injected runtime results", async () => {
  const workflows: WorkflowSummary[] = [{ id: "wf_demo", title: "Demo", nodeCount: 6, writeCount: 1, definitionVersion: 1, fileVersion: "absent" }];
  const orchestrations: OrchestrationSummary[] = [{ id: "chain_demo", title: "Chain", stepCount: 2, fileVersion: "absent" }];
  const list = vi.fn(async (): Promise<WorkflowListResult> => ({ workflows, defaultWorkflowId: "wf_demo", defaultSource: "project" }));
  const orchestrationList = vi.fn(async (): Promise<{ orchestrations: OrchestrationSummary[] }> => ({ orchestrations }));
  const tools = new WorkspaceTools(root, "workflow-list", { workflowTools: fakeRuntime({ list, orchestrationList }) });
  try {
    expect(await tools.execute("WorkflowList", {})).toEqual({ workflows, defaultWorkflowId: "wf_demo", defaultSource: "project" });
    expect(await tools.execute("OrchestrationList", {})).toEqual({ orchestrations });
    expect(list).toHaveBeenCalledTimes(1);
    expect(orchestrationList).toHaveBeenCalledTimes(1);
  } finally { await tools.close(); }
});

test("WorkflowCreate and OrchestrationCreate validate through the project service before writing", async () => {
  const service = new WorkflowService({
    core: { metadata: { path: root } } as unknown as ProjectCore,
    resolveProfile: () => { throw new Error("model resolution is not used when creating definitions"); },
  });
  const tools = new WorkspaceTools(root, "workflow-create", { workflowTools: createWorkflowToolRuntime({ service }) });
  try {
    expect(await tools.execute("WorkflowList", {})).toMatchObject({ workflows: [], defaultWorkflowId: OFFICIAL_WORKFLOW_ID, defaultSource: "official" });

    const official = await loadOfficialWorkflow();
    const created = await tools.execute("WorkflowCreate", { definition: { ...official, id: "wf_agent_created", title: "Agent created" } }) as { id: string; fileVersion: string };
    expect(created.id).toBe("wf_agent_created");
    expect(created.fileVersion).not.toBe("absent");
    expect(await readFile(path.join(root, "specs", "workflows", "wf_agent_created.yaml"), "utf8")).toContain("id: wf_agent_created");

    expect(await tools.execute("WorkflowList", {})).toMatchObject({ workflows: [{ id: "wf_agent_created" }], defaultSource: "official" });
    await service.defaultsSave({ schemaVersion: 1, defaultWorkflowId: "wf_agent_created" });
    expect(await tools.execute("WorkflowList", {})).toMatchObject({ defaultWorkflowId: "wf_agent_created", defaultSource: "project" });
    await expect(tools.execute("WorkflowCreate", { definition: { ...official, id: "wf_agent_created" } })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });

    const withoutWriteAgent = {
      ...official,
      id: "wf_broken",
      nodes: official.nodes.map(node => node.type === "agent" && node.config.access === "write"
        ? { ...node, config: { ...node.config, access: "read" as const } }
        : node),
    };
    await expect(tools.execute("WorkflowCreate", { definition: withoutWriteAgent })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringContaining("write agent"),
    });

    const orchestration = {
      schemaVersion: 1 as const,
      id: "chain_agent_created",
      title: "Agent chain",
      description: "",
      steps: [{ id: "first", workflowId: "wf_agent_created", approval: "inherit" as const }],
    };
    expect(await tools.execute("OrchestrationCreate", { definition: orchestration })).toMatchObject({ id: "chain_agent_created" });
    expect(await readFile(path.join(root, "specs", "orchestrations", "chain_agent_created.yaml"), "utf8")).toContain("id: chain_agent_created");
    expect(await tools.execute("OrchestrationList", {})).toMatchObject({ orchestrations: [{ id: "chain_agent_created", stepCount: 1 }] });
    await expect(tools.execute("OrchestrationCreate", { definition: { ...orchestration, id: "chain_broken", steps: [] } })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringContaining("at least one step"),
    });
  } finally { await tools.close(); }
});

test("WorkflowRun resolves the default target, honors an explicit id, and rejects omitted inputs", async () => {
  const adapter = new FakeWorkflowTaskAdapter();
  const run: WorkflowRun = new WorkflowRunner({ adapter, root }).createRun(await loadOfficialWorkflow(), {
    goal: "实现灯塔修复交互",
    readPaths: ["specs"],
    writePaths: ["specs/entities"],
  });
  const runTool = vi.fn(async () => run);
  const statusTool = vi.fn(async () => run);
  const cancelTool = vi.fn(async () => ({ ...run, status: "cancelled" as const }));
  const tools = new WorkspaceTools(root, "workflow-run", { workflowTools: fakeRuntime({ run: runTool, status: statusTool, cancel: cancelTool }) });
  try {
    const inputs = { goal: "实现灯塔修复交互", readPaths: ["specs"], writePaths: ["specs/entities"] };
    const started = await tools.execute("WorkflowRun", { id: "default", ...inputs }) as WorkflowRunView;
    expect(started).toMatchObject({ runId: run.runId, workflowId: OFFICIAL_WORKFLOW_ID, status: "queued" });
    expect(started).not.toHaveProperty("definitionSnapshot");
    expect(runTool).toHaveBeenLastCalledWith(inputs, undefined);

    expect(await tools.execute("WorkflowRun", { id: "wf_custom", ...inputs })).toMatchObject({ runId: run.runId });
    expect(runTool).toHaveBeenLastCalledWith(inputs, "wf_custom");
    expect(await tools.execute("WorkflowRun", inputs)).toMatchObject({ runId: run.runId });
    expect(runTool).toHaveBeenLastCalledWith(inputs, undefined);
    expect(runTool).toHaveBeenCalledTimes(3);

    // Omitted goal or scope is a readable error; it must never borrow another scope.
    await expect(tools.execute("WorkflowRun", { goal: "只有目标" })).rejects.toMatchObject({ code: "VALIDATION_FAILED", message: expect.stringContaining("readPaths") });
    await expect(tools.execute("WorkflowRun", { readPaths: ["specs"], writePaths: ["specs"] })).rejects.toMatchObject({ code: "VALIDATION_FAILED", message: expect.stringContaining("goal") });
    await expect(tools.execute("WorkflowRun", { id: "wf_custom", goal: "只有目标", readPaths: ["specs"], writePaths: ["specs"], context: "x".repeat(32769) })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(runTool).toHaveBeenCalledTimes(3);

    expect(await tools.execute("WorkflowStatus", { runId: run.runId })).toMatchObject({ runId: run.runId, status: "queued" });
    expect(await tools.execute("WorkflowCancel", { runId: run.runId })).toMatchObject({ runId: run.runId, status: "cancelled" });
    expect(statusTool).toHaveBeenCalledWith(run.runId);
    expect(cancelTool).toHaveBeenCalledWith(run.runId);
  } finally { await tools.close(); }
});

test("orchestration run, status, and cancel delegate to the injected runtime", async () => {
  const inputs = { goal: "实现编排", readPaths: ["specs"], writePaths: ["specs/entities"] };
  const orchestrationRun = (status: OrchestrationRun["status"]): OrchestrationRun => ({
    schemaVersion: 1,
    orchestrationRunId: "orun-1",
    orchestrationId: "chain_demo",
    title: "Chain",
    inputs,
    steps: [{ stepId: "first", workflowId: "wf_demo", approval: "inherit", status: "pending" }],
    currentStepIndex: 0,
    status,
    startedAt: "2026-10-18T00:00:00.000Z",
  });
  const createTool = vi.fn(async () => ({ id: "chain_demo", fileVersion: "absent" as const }));
  const runTool = vi.fn(async () => orchestrationRun("queued"));
  const statusTool = vi.fn(async () => orchestrationRun("waiting_approval"));
  const cancelTool = vi.fn(async () => orchestrationRun("cancelled"));
  const tools = new WorkspaceTools(root, "orchestration-run", {
    workflowTools: fakeRuntime({ orchestrationCreate: createTool, orchestrationRun: runTool, orchestrationStatus: statusTool, orchestrationCancel: cancelTool }),
  });
  try {
    const definition = { schemaVersion: 1, id: "chain_demo", title: "Chain", description: "", steps: [{ id: "first", workflowId: "wf_demo" }] };
    expect(await tools.execute("OrchestrationCreate", { definition })).toEqual({ id: "chain_demo", fileVersion: "absent" });
    expect(createTool).toHaveBeenCalledWith(definition);

    expect(await tools.execute("OrchestrationRun", { id: "chain_demo", ...inputs })).toMatchObject({ orchestrationRunId: "orun-1", status: "queued" });
    expect(runTool).toHaveBeenCalledWith("chain_demo", inputs);
    await expect(tools.execute("OrchestrationRun", { id: "chain_demo", goal: "只有目标" })).rejects.toMatchObject({ code: "VALIDATION_FAILED", message: expect.stringContaining("readPaths") });

    expect(await tools.execute("OrchestrationStatus", { runId: "orun-1" })).toMatchObject({ orchestrationRunId: "orun-1", status: "waiting_approval" });
    expect(await tools.execute("OrchestrationCancel", { runId: "orun-1" })).toMatchObject({ orchestrationRunId: "orun-1", status: "cancelled" });
    expect(statusTool).toHaveBeenCalledWith("orun-1");
    expect(cancelTool).toHaveBeenCalledWith("orun-1");
  } finally { await tools.close(); }
});
