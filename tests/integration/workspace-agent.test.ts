import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkspaceTools } from "../../src/main/core/tools/workspace-tools";
import { DesktopSessions } from "../../src/main/desktop-sessions";
import { ProjectCore } from "../../src/main/core/project-core";

const roots: string[] = []; const closes: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(path.join(tmpdir(), "specloom-workspace-agent-")); roots.push(root); return root; }
const profile = { id: "model", name: "Model", provider: "openai-compatible" as const, model: "fixture", baseUrl: "http://localhost:9999/v1", approved: true, timeoutMs: 5000, maxToolRounds: 8 };
function response(message: unknown) { return new Response(JSON.stringify({ choices: [{ message }] }), { headers: { "content-type": "application/json" } }); }
function call(name: string, input: unknown) { return { role: "assistant", content: null, tool_calls: [{ id: `${name}-call`, type: "function", function: { name, arguments: JSON.stringify(input) } }] }; }

test("discovers and invokes a real stdio MCP tool with demand-loaded schemas", async () => {
  const root = await fixture(); const server = path.join(root, "server.cjs");
  await writeFile(server, `const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line); if(m.id===undefined)return;let result;if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};else if(m.method==='tools/list')result={tools:[{name:'echo',description:'回声工具',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}}]};else if(m.method==='tools/call')result={content:[{type:'text',text:'MCP实际执行：'+m.params.arguments.text}]};else result={};console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));});`);
  await writeFile(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [server] } } }));
  const tools = new WorkspaceTools(root, "mcp"); closes.push(() => tools.close());
  tools.setPermissions("full");
  const capabilities = await tools.capabilities(); expect(capabilities.mcp[0]).toMatchObject({ name: "fixture", status: "connected" });
  const name = capabilities.mcp[0]!.tools[0]!;
  expect(tools.catalog.providerTools().map(t => t.function.name)).not.toContain(name);
  await tools.execute("ToolSearch", { query: "回声工具" });
  expect(tools.catalog.providerTools().map(t => t.function.name)).toContain(name);
  expect(await tools.execute(name, { text: "hello" })).toMatchObject({ content: [{ type: "text", text: "MCP实际执行：hello" }] });
});
test("generic sessions execute Skill and Agent in independent model context and keep child calls visible", async () => {
  const root = await fixture(); await writeFile(path.join(root, "main.ts"), "export const answer=42;\n");
  const skills = path.join(root, ".specloom/skills/workflow"); await mkdir(skills, { recursive: true });
  await writeFile(path.join(skills, "SKILL.md"), "---\nname: 项目工作流\ndescription: 先查看主脚本\n---\n先用 Read 查看 main.ts，保持模块解耦。\n");
  const core = await ProjectCore.open(root); const sessions = new DesktopSessions(root, () => core, async () => profile, async () => "全局要求", async () => undefined); closes.push(() => sessions.cancelAll());
  const session = await sessions.create(root);
  await vi.waitFor(async () => expect((await sessions.list(root)).find(s => s.id === session.id)?.capabilities?.skills).toMatchObject([{ id: "workflow", name: "项目工作流" }]), { timeout: 30_000 });
  const requests: { messages: { role: string; content: string }[] }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    switch (requests.length) {
      case 1: return response(call("Skill", { id: "workflow" }));
      case 2: return response(call("ToolSearch", { query: "Agent" }));
      case 3: return response(call("Agent", { prompt: "子任务只探索 main.ts", title: "探索代码" }));
      case 4: return response(call("Read", { path: "main.ts" }));
      case 5: return response({ role: "assistant", content: "子任务结果：answer 为42" });
      default: return response({ role: "assistant", content: "父任务完成" });
    }
  }));
  const result = await sessions.send(root, session.id, "父任务的独立上下文目标");
  expect(result.status).toBe("completed");
  expect(requests[3]!.messages.filter(m => m.role === "user").map(m => m.content)).toEqual(["子任务只探索 main.ts"]);
  expect(requests[1]!.messages.some(m => m.content?.includes("先用 Read 查看 main.ts"))).toBe(true);
  expect(result.items.filter(i => i.kind === "tool").map(i => i.name)).toEqual(["Skill", "ToolSearch", "Agent", "Read"]);
  expect(await readFile(path.join(root, "main.ts"), "utf8")).toContain("42");
});
