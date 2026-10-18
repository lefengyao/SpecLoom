import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { DesktopSessions } from "../../src/main/desktop-sessions";
import { ProjectCore } from "../../src/main/core/project-core";
import { parseMaterial } from "../../src/shared/project-materials";

afterEach(() => { vi.unstubAllGlobals(); });
test("the model discovers material tools, uses real returned versions and persists component bindings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "specloom-material-agent-"));
  const core = await ProjectCore.open(root);
  const profile = { id: "model", name: "Model", provider: "openai-compatible" as const, model: "fixture", baseUrl: "http://localhost:9999/v1", approved: true, timeoutMs: 5000, maxToolRounds: 8 };
  const sessions = new DesktopSessions(root, () => core, async () => profile, async () => "", async () => undefined);
  let round = 0;
  const offered: string[][] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as { tools: { function: { name: string } }[]; messages: { role: string; content: string }[] };
    offered.push(request.tools.map(tool => tool.function.name));
    const result = JSON.parse(request.messages.filter(message => message.role === "tool").at(-1)?.content ?? "{}") as { ok?: boolean; result?: { version: string } };
    if (result.ok !== undefined) expect(result.ok).toBe(true);
    let name = ""; let input: Record<string, unknown> = {};
    switch (round++) {
      case 0: name = "ToolSearch"; input = { query: "MaterialCreate MaterialBindComponent MaterialUpdate" }; break;
      case 1: name = "MaterialCreate"; input = { category: "component", id: "health", title: "生命值", properties: { fields: [{ key: "current", type: "number", default: 100 }] } }; break;
      case 2: name = "MaterialCreate"; input = { category: "entity", id: "hero", title: "主角" }; break;
      case 3: name = "MaterialRead"; input = { path: "specs/entities/hero.md" }; break;
      case 4: name = "MaterialBindComponent"; input = { path: "specs/entities/hero.md", expectedVersion: result.result!.version, componentPath: "specs/components/health.md", values: { current: 90 } }; break;
      case 5: name = "MaterialUpdate"; input = { path: "specs/entities/hero.md", expectedVersion: result.result!.version, changes: { group: "角色" } }; break;
    }
    const message = name ? { role: "assistant", content: null, tool_calls: [{ id: `material-${round}`, type: "function", function: { name, arguments: JSON.stringify(input) } }] } : { role: "assistant", content: "资料已保存" };
    return new Response(JSON.stringify({ choices: [{ message }] }), { headers: { "content-type": "application/json" } });
  }));
  try {
    const session = await sessions.create(root); const result = await sessions.send(root, session.id, "创建主角并设置生命值组件");
    expect(result.status).toBe("completed");
    expect(offered[0]).toContain("MaterialsList"); expect(offered[0]).not.toContain("MaterialCreate"); expect(offered[1]).toContain("MaterialCreate");
    expect(parseMaterial(await readFile(path.join(root, "specs/entities/hero.md"), "utf8"))?.data).toMatchObject({ title: "主角", group: "角色", components: [{ id: "health", values: { current: 90 } }] });
    expect(core.listTasks()).toEqual([]);
    expect(result.items.filter(item => item.kind === "tool").map(item => item.name)).toEqual(["ToolSearch", "MaterialCreate", "MaterialCreate", "MaterialRead", "MaterialBindComponent", "MaterialUpdate"]);
  } finally { await sessions.cancelAll(); await rm(root, { recursive: true, force: true }); }
}, 120_000);
