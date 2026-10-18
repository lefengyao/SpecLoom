import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { DesktopSessions } from "../../src/main/desktop-sessions";
import { WorkspaceTools } from "../../src/main/core/tools/workspace-tools";

const roots: string[] = [];
const desktops: DesktopSessions[] = [];
afterEach(async () => {
  for (const desktop of desktops.splice(0)) await desktop.cancelAll();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const profile = { id: "test", name: "test", model: "test", provider: "openai-compatible" as const, protocol: "openai" as const, approved: true, baseUrl: "http://model.test/v1", timeoutMs: 15000, maxToolRounds: 1 };
const completion = (message: object) => Response.json({ choices: [{ message }] });
const tool = (name: string, input: object) => ({ id: "shared", type: "function", function: { name, arguments: JSON.stringify(input) } });
const toolStream = (content: string) => new Response([
  { choices: [{ delta: { content } }] },
  { choices: [{ delta: { tool_calls: [{ index: 3, function: { name: "Glob", arguments: "{" } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 3, id: "shared", function: { arguments: '"pattern":"*"}' } }] } }] },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });

test.each([false, true])("a child can complete multiple tool rounds while the parent preserves every completed card (nested=%s)", async nested => {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-tool-rounds-")); roots.push(root);
  const capabilities = { tools: [], skills: [], mcp: [], plugins: [] };
  vi.spyOn(WorkspaceTools.prototype, "capabilities").mockResolvedValue(capabilities);
  vi.spyOn(WorkspaceTools.prototype, "refresh").mockResolvedValue(capabilities);
  const counts = new Map<string, number>();
  const target = nested ? "grandchild" : "child";
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, options: RequestInit) => {
    const body = JSON.parse(String(options.body)) as { messages: Array<{ role: string; content: string }> };
    const prompt = body.messages.find(message => message.role === "user")!.content;
    const request = (counts.get(prompt) ?? 0) + 1; counts.set(prompt, request);
    if (prompt === "parent" && request === 1) return completion({ role: "assistant", content: null, tool_calls: [tool("Agent", { prompt: "sibling" }), { ...tool("Agent", { prompt: "child" }), id: "child-delegation" }] });
    if (nested && prompt === "child" && request === 1) return completion({ role: "assistant", content: null, tool_calls: [tool("Agent", { prompt: "grandchild" })] });
    if (prompt === "sibling" && request === 1) return toolStream("sibling tool response");
    if (prompt === target && request <= 2) return toolStream("child executed response");
    if (prompt === "sibling" && request === 2) return completion({ role: "assistant", content: "sibling done" });
    return completion({ role: "assistant", content: `${prompt} done` });
  }));
  const desktop = new DesktopSessions(root, () => undefined, async () => profile, async () => "", async () => undefined); desktops.push(desktop);
  const session = await desktop.create("");
  const saved = await desktop.send("", session.id, "parent");
  const cards = saved.items.filter(item => item.kind === "tool");
  expect(saved.status).toBe("completed");
  expect(counts.get(target)).toBe(3);
  expect(counts.get("sibling")).toBe(2);
  expect(counts.get("parent")).toBe(2);
  expect(cards.filter(item => item.status === "receiving")).toEqual([]);
  expect(cards).toHaveLength(nested ? 6 : 5);
  expect(cards.filter(item => item.name === "Glob")).toHaveLength(3);
  expect(cards.filter(item => item.name === "Glob").every(item => item.status === "ok")).toBe(true);
  expect(cards.filter(item => item.name === "Agent" && item.status === "ok")).toHaveLength(nested ? 3 : 2);
  expect(cards.filter(item => item.name === "Agent" && item.status === "error")).toHaveLength(0);
  expect(new Set(cards.map(item => item.id)).size).toBe(cards.length);
  expect(saved.items.some(item => item.kind === "tool" && item.status === "receiving")).toBe(false);
});
