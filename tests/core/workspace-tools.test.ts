import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkspaceTools } from "../../src/main/core/tools/workspace-tools";
import { godotMcpToolDefinitions } from "../../src/main/core/godot-mcp/tool-definitions";
import type { GodotMcpHostRegistry } from "../../src/main/core/godot-mcp/host-registry";

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
