import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { AgentRuntime } from "../../src/main/core/agent-runtime";
import { SessionRuns } from "../../src/main/core/session-runs";
import { SessionStore } from "../../src/main/core/session-store";
import { DesktopSessions } from "../../src/main/desktop-sessions";
import { WorkspaceTools } from "../../src/main/core/tools/workspace-tools";

const roots: string[] = [];
const desktops: DesktopSessions[] = [];
afterEach(async () => {
  for (const desktop of desktops.splice(0)) await desktop.cancelAll();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() { const root = await mkdtemp(path.join(os.tmpdir(), "specloom-response-reset-")); roots.push(root); return { root, store: await SessionStore.open(root) }; }
const profile = { id: "test", name: "test", model: "test", provider: "openai-compatible" as const, protocol: "openai" as const, approved: true, baseUrl: "http://model.test/v1", timeoutMs: 15000, maxToolRounds: 4 };
const completion = (message: object) => Response.json({ choices: [{ message }] });
const tool = (id: string, name: string, input: object) => ({ id, type: "function", function: { name, arguments: JSON.stringify(input) } });
const stream = (frames: object[], invalid = false) => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + (invalid ? "data: {bad}\n\n" : "data: [DONE]\n\n"), { headers: { "content-type": "text/event-stream" } });

test("a response reset preserves parent and sibling tools and removes only its receiving cards and partial messages", async () => {
  const { root, store } = await setup(); const session = await store.create("isolation"); const runs = new SessionRuns(store, root);
  await runs.send(session.id, "start", async options => {
    const emit = options.onEvent!;
    await emit({ type: "tool-start", round: 1, streamIndex: 0, toolCallId: "parent", toolEventId: "parent", name: "Agent" });
    await emit({ type: "tool-args", round: 1, toolCallId: "sibling:pending_0", toolEventId: "sibling:receiving", name: "Read", arguments: "pending" });
    await emit({ type: "tool-start", round: 1, toolCallId: "child:running", toolEventId: "child:running", name: "Read" });
    await emit({ type: "tool-result", round: 1, toolCallId: "child:completed", toolEventId: "child:completed", name: "Read", output: "keep", ok: true });
    await emit({ type: "tool-args", round: 1, toolCallId: "child:pending_0", toolEventId: "child:receiving", name: "Read", arguments: "pending" });
    await emit({ type: "text", round: 0, messageId: "child:partial", content: "failed response" });
    await emit({ type: "thinking", round: 0, messageId: "sibling:thinking", content: "keep" });
    await emit({ type: "response-reset", round: 1, messageIds: ["child:partial"], toolEventIds: ["child:receiving", "child:running", "child:completed"] });
    const items = store.get(session.id).items;
    expect(items.find(item => item.kind === "tool" && item.callId === "parent")).toMatchObject({ status: "running" });
    expect(items.find(item => item.kind === "tool" && item.callId === "sibling:pending_0")).toMatchObject({ status: "receiving" });
    expect(items.find(item => item.kind === "tool" && item.callId === "child:running")).toMatchObject({ status: "running" });
    expect(items.find(item => item.kind === "tool" && item.callId === "child:completed")).toMatchObject({ status: "ok", output: "keep" });
    expect(items.some(item => item.kind === "tool" && item.callId === "child:pending_0")).toBe(false);
    expect(items.some(item => item.kind === "message" && item.content === "failed response")).toBe(false);
    expect(items.some(item => item.kind === "thinking" && item.content === "keep")).toBe(true);
    return { summary: "done", toolCalls: 0, rounds: 0, messages: [{ role: "assistant", content: "done" }] };
  });
});

test.each([false, true])("desktop child correction clears partial cards and preserves delegation results (nested=%s)", async nested => {
  const { root } = await setup();
  const capabilities = { tools: [], skills: [], mcp: [], plugins: [] };
  vi.spyOn(WorkspaceTools.prototype, "capabilities").mockResolvedValue(capabilities);
  vi.spyOn(WorkspaceTools.prototype, "refresh").mockResolvedValue(capabilities);
  const counts = new Map<string, number>();
  const target = nested ? "grandchild" : "child";
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, options: RequestInit) => {
    const body = JSON.parse(String(options.body)) as { messages: Array<{ role: string; content: string }> };
    const prompt = body.messages.find(message => message.role === "user")!.content;
    const request = (counts.get(prompt) ?? 0) + 1; counts.set(prompt, request);
    if (prompt === "parent" && request === 1) return completion({ role: "assistant", content: null, tool_calls: [tool("shared", "Agent", { prompt: "child" }), tool("sibling", "Agent", { prompt: "sibling" })] });
    if (nested && prompt === "child" && request === 1) return completion({ role: "assistant", content: null, tool_calls: [tool("shared", "Agent", { prompt: "grandchild" })] });
    if (prompt === target && request === 1) return stream([
      { choices: [{ delta: { content: "failed partial" } }] },
      { choices: [{ delta: { reasoning_content: "failed thinking" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "Glob", arguments: "{" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "shared", function: { arguments: "bad" } }] } }] },
    ], true);
    if ((prompt === target && request === 2) || (prompt === "sibling" && request === 1)) return stream([
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "Glob", arguments: "{" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "shared", function: { arguments: '"pattern":"*"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);
    return completion({ role: "assistant", content: `${prompt} done` });
  }));
  const desktop = new DesktopSessions(root, () => undefined, async () => profile, async () => "", async () => undefined); desktops.push(desktop);
  const session = await desktop.create("");
  const saved = await desktop.send("", session.id, "parent");
  const cards = saved.items.filter(item => item.kind === "tool");
  expect(saved.status).toBe("completed");
  expect(saved.items.some(item => (item.kind === "message" || item.kind === "thinking") && item.content.startsWith("failed"))).toBe(false);
  expect(cards).toHaveLength(nested ? 5 : 4);
  expect(cards.every(item => item.status === "ok")).toBe(true);
  expect(new Set(cards.map(item => item.id)).size).toBe(cards.length);
  expect(counts.get(target)).toBe(3);
});

test("one tool card follows a sparse stream index through validation and execution", async () => {
  const { root, store } = await setup(); const session = await store.create("identity"); const runs = new SessionRuns(store, root);
  const fetcher = vi.fn(async () => fetcher.mock.calls.length === 1 ? stream([
    { choices: [{ delta: { tool_calls: [{ index: 3, function: { name: "Read", arguments: "{" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 3, id: "final", function: { arguments: "}" } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ]) : completion({ role: "assistant", content: "done" }));
  const saved = await runs.send(session.id, "start", options => new AgentRuntime({ ...options, catalog: { providerTools: () => [], parseCall: () => ({ name: "Read", input: {} }) }, executeTool: async () => "read", fetch: fetcher }).run({ taskId: "test", profile, prompt: options.prompt, signal: options.signal }));
  const cards = saved.items.filter(item => item.kind === "tool");
  expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({ callId: "final", status: "ok" });
});

test("Gemini provider IDs follow the synthesized call IDs through execution", async () => {
  const { root, store } = await setup(); const session = await store.create("gemini identity"); const runs = new SessionRuns(store, root);
  const fetcher = vi.fn(async () => fetcher.mock.calls.length === 1 ? stream([
    { candidates: [{ content: { parts: [{ text: "calling" }, { functionCall: { id: "provider-id", name: "Read", args: {} } }, { functionCall: { name: "Read", args: {} } }] }, finishReason: "STOP" }] },
  ]) : Response.json({ candidates: [{ content: { parts: [{ text: "done" }] }, finishReason: "STOP" }] }));
  const saved = await runs.send(session.id, "start", options => new AgentRuntime({ ...options, catalog: { providerTools: () => [], parseCall: () => ({ name: "Read", input: {} }) }, executeTool: async () => "read", fetch: fetcher }).run({ taskId: "test", profile: { ...profile, protocol: "gemini" }, prompt: options.prompt, signal: options.signal }));
  const cards = saved.items.filter(item => item.kind === "tool");
  expect(cards).toHaveLength(2);
  expect(cards.map(item => [item.callId, item.status])).toEqual([["call_0", "ok"], ["call_1", "ok"]]);
});
