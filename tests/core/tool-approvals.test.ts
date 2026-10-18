import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { WorkspaceTools } from "../../src/main/core/tools/workspace-tools";
import { approvalArguments, mcpConnectionApproval, toolApproval } from "../../src/main/core/tools/approval-policy";
import { godotMcpToolDefinitions } from "../../src/main/core/godot-mcp/tool-definitions";

let root: string;
let external: string;
const worksets: WorkspaceTools[] = [];
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "specloom-approval-project-"));
  external = await mkdtemp(path.join(tmpdir(), "specloom-approval-external-"));
  await writeFile(path.join(root, "local.txt"), "before");
  await writeFile(path.join(external, "outside.txt"), "before");
});
afterEach(async () => {
  await Promise.all(worksets.splice(0).map(tools => tools.close()));
  await Promise.all([rm(root, { recursive: true, force: true }), rm(external, { recursive: true, force: true })]);
});
function workspace() { const tools = new WorkspaceTools(root, "approval"); worksets.push(tools); return tools; }

test("ask requests approval before external reads and denial prevents effects", async () => {
  const tools = workspace(); const approve = vi.fn<(input: unknown) => Promise<boolean>>(async () => false);
  tools.setPermissions("ask", approve);
  await tools.execute("Read", { path: "local.txt" });
  await tools.execute("Edit", { path: "local.txt", old_string: "before", new_string: "after" });
  expect(approve).not.toHaveBeenCalled();
  await expect(tools.execute("Read", { path: path.join(external, "outside.txt") })).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
  expect(approve).toHaveBeenCalledWith(expect.objectContaining({ toolName: "Read", risk: "standard" }));
  await expect(tools.execute("Bash", { command: "Set-Content denied.txt changed", shell: "powershell" })).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
  await expect(readFile(path.join(root, "denied.txt"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("auto allows external ordinary reads but gates writes and sensitive reads", async () => {
  const tools = workspace(); const approve = vi.fn(async () => true);
  tools.setPermissions("auto", approve);
  const target = path.join(external, "outside.txt");
  await tools.execute("Read", { path: target });
  expect(approve).not.toHaveBeenCalled();
  await tools.execute("Edit", { path: target, old_string: "before", new_string: "after" });
  expect(approve).toHaveBeenCalledWith(expect.objectContaining({ toolName: "Edit", risk: "high" }));
  await writeFile(path.join(external, ".env"), "TOKEN=private");
  await tools.execute("Read", { path: path.join(external, ".env") });
  expect(approve).toHaveBeenLastCalledWith(expect.objectContaining({ toolName: "Read", risk: "high" }));
});

test("full access preserves external read receipts, conflicts and reserved runtime paths", async () => {
  const tools = workspace(); const approve = vi.fn(async () => false);
  tools.setPermissions("full", approve);
  const target = path.join(external, "outside.txt");
  await expect(tools.execute("Write", { path: target, content: "changed" })).rejects.toThrow(/Read/);
  await tools.execute("Read", { path: target });
  await writeFile(target, "external edit");
  await expect(tools.execute("Edit", { path: target, old_string: "before", new_string: "changed" })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  await tools.execute("Read", { path: target });
  await tools.execute("Write", { path: target, content: "changed" });
  expect(await readFile(target, "utf8")).toBe("changed");
  await tools.execute("Write", { path: path.join(external, "new", "nested.txt"), content: "new" });
  expect(await readFile(path.join(external, "new", "nested.txt"), "utf8")).toBe("new");
  await tools.execute("Write", { path: path.join(external, "specs", "plain.md"), content: "plain external markdown" });
  expect(await readFile(path.join(external, "specs", "plain.md"), "utf8")).toBe("plain external markdown");
  await mkdir(path.join(root, ".specloom"), { recursive: true });
  await writeFile(path.join(root, ".specloom", "sessions.json"), "runtime");
  await expect(tools.execute("Read", { path: path.join(root, ".specloom", "sessions.json") })).rejects.toMatchObject({ code: "TASK_SCOPE_DENIED" });
  expect(approve).not.toHaveBeenCalled();
});

test("approval cancellation prevents a late allow response from executing", async () => {
  const tools = workspace(); const controller = new AbortController();
  let resolve!: (answer: boolean) => void;
  const approve = vi.fn(() => new Promise<boolean>(done => { resolve = done; }));
  tools.setPermissions("ask", approve);
  const execution = tools.execute("Write", { path: path.join(external, "cancelled.txt"), content: "no" }, controller.signal);
  await vi.waitFor(() => expect(approve).toHaveBeenCalled());
  controller.abort(); resolve(true);
  await expect(execution).rejects.toMatchObject({ name: "AbortError" });
  await expect(readFile(path.join(external, "cancelled.txt"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("host code and every shell command require approval in restricted modes", async () => {
  const tools = workspace(); tools.setPermissions("auto");
  for (const command of ["echo safe", "pwd", "echo $(whoami)", "echo safe; Set-Content bypass.txt no", "echo safe > bypass.txt", "git status", "curl https://example.com", "echo `whoami`", "echo %PATH%", "echo !PATH!"])
    await expect(tools.execute("Bash", { command })).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
  await expect(tools.execute("code_execution", { language: "javascript", code: "console.log(42)" })).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
});

test("background MCP discovery never starts an unapproved server", async () => {
  await writeFile(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { blocked: { command: "definitely-not-a-real-mcp-server" } } }));
  const tools = workspace(); tools.setPermissions("auto");
  expect((await tools.capabilities()).mcp).toMatchObject([{ name: "blocked", status: "error", error: expect.stringMatching(/审批/) }]);
});

test("MCP discovery denial prevents any HTTP connection", async () => {
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.writeHead(500); response.end(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing server address");
    await writeFile(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { network: { url: `http://127.0.0.1:${address.port}/mcp` } } }));
    const tools = workspace(); const approve = vi.fn(async () => false);
    tools.setPermissions("ask", approve);
    expect((await tools.capabilities()).mcp).toMatchObject([{ name: "network", status: "error" }]);
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ toolName: "MCPConnect" }));
    expect(requests).toBe(0);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test("shell names and apparent builtins cannot bypass restricted mode approval", () => {
  for (const mode of ["ask", "auto"] as const) for (const [shell, command] of [["bash", "echo safe"], ["bash", "pwd"], ["cmd", "echo safe"], ["powershell", "Write-Output safe"], ["powershell", "Get-Location"]])
    expect(toolApproval(mode, root, "Bash", { shell, command })).toMatchObject({ risk: "high" });
});

test("changing permissions invalidates a pending tool approval", async () => {
  const tools = workspace(); let resolve!: (answer: boolean) => void;
  const approve = vi.fn(() => new Promise<boolean>(done => { resolve = done; }));
  tools.setPermissions("ask", approve);
  const execution = tools.execute("Write", { path: path.join(external, "stale.txt"), content: "no" });
  await vi.waitFor(() => expect(approve).toHaveBeenCalled());
  tools.setPermissions("auto"); resolve(true);
  await expect(execution).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
  await expect(readFile(path.join(external, "stale.txt"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("Grep and Skill source reads gate sensitive files before returning their contents", async () => {
  const tools = workspace(); const approve = vi.fn(async () => false);
  tools.setPermissions("auto", approve);
  await writeFile(path.join(root, ".env"), "PRIVATE=secret-value");
  await mkdir(path.join(root, ".specloom", "skills", "read-env"), { recursive: true });
  await writeFile(path.join(root, ".specloom", "skills", "read-env", "SKILL.md"), "---\nname: Read environment\n---\nRead sources");
  await expect(tools.execute("Grep", { pattern: "PRIVATE", glob: ".env" })).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
  await expect(tools.execute("Skill", { id: "read-env", sourcePaths: [".env"] })).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
  expect(approve).toHaveBeenCalledTimes(2);
});

test("approval display redacts secrets and marks truncation", async () => {
  const tools = workspace(); const approve = vi.fn<(input: unknown) => Promise<boolean>>(async () => false);
  tools.setPermissions("auto", approve);
  await expect(tools.execute("Bash", { command: "curl --token secret-command-value" }, undefined, undefined, value => value.replaceAll("secret-command-value", "[redacted]"))).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
  expect(approve.mock.calls[0]?.[0]).not.toHaveProperty("arguments", expect.stringContaining("secret-command-value"));
  const connection = mcpConnectionApproval("server", { command: "node", args: ["--token", "secret-arg-value"], url: "https://user:secret-password@example.com/mcp?token=secret-query-value#secret-fragment-value" });
  expect(connection.arguments).not.toMatch(/secret-/);
  expect(toolApproval("auto", root, "code_execution", { code: "x".repeat(20000) })?.arguments).toContain("显示已截断");
  for (const tool of godotMcpToolDefinitions) {
    expect(toolApproval("auto", root, tool.name, {})).toBeUndefined();
    expect(toolApproval("ask", root, tool.name, {})).toMatchObject({ risk: "standard" });
  }
  expect(approvalArguments({ command: 'curl --access-token "quoted-secret value" --api-key=flag-secret' })).not.toMatch(/quoted-secret|flag-secret/);
  expect(toolApproval("auto", root, "files_read", { path: ".env" })).toMatchObject({ risk: "high" });
  expect(toolApproval("auto", root, "skills_load", { sourcePaths: [".ssh/config"] })).toMatchObject({ risk: "high" });
});
