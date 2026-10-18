import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { SessionStore } from "../../src/main/core/session-store";
import { SessionRuns } from "../../src/main/core/session-runs";
import { AgentRuntime, noToolsCatalog } from "../../src/main/core/agent-runtime";
import { DesktopSessions } from "../../src/main/desktop-sessions";
import { WorkspaceTools } from "../../src/main/core/tools/workspace-tools";
import type { ChatSession, SessionEvent } from "../../src/shared/chat";
import { ProjectError } from "../../src/main/core/errors";

const roots: string[] = [];
const runningTests = new Map<SessionRuns, Promise<unknown>[]>();
function track<T>(runs: SessionRuns, promise: Promise<T>): Promise<T> { runningTests.set(runs, [...(runningTests.get(runs) ?? []), promise]); void promise.catch(() => undefined); return promise; }
afterEach(async () => { for (const runs of runningTests.keys()) runs.cancelAll(); await Promise.allSettled([...runningTests.values()].flat()); runningTests.clear(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() { const root = await mkdtemp(path.join(os.tmpdir(), "specloom-sessions-")); roots.push(root); const store = await SessionStore.open(root); return { root, store }; }
const profile = { id: "test", name: "test", model: "test", provider: "openai-compatible" as const, protocol: "openai" as const, approved: true, baseUrl: "http://model.test/v1", timeoutMs: 15000, maxToolRounds: 3 };

test("persists a validated diagnostic ID on failure and clears it when a later run starts", async () => {
  const { root, store } = await setup();
  const session = await store.create("diagnostic");
  const runs = new SessionRuns(store, root);
  const diagnosticId = "9c1c7c73-ec83-41bb-8e1f-6d4770039f56";
  await expect(runs.send(session.id, "fail", async () => {
    throw new ProjectError("MODEL_ERROR", "The model stream failed while receiving data.", { diagnosticId });
  })).rejects.toMatchObject({ details: { diagnosticId } });
  expect(store.get(session.id).diagnosticId).toBe(diagnosticId);

  const completed = await runs.send(session.id, "retry", async () => ({
    summary: "recovered", toolCalls: 0, rounds: 1, messages: [{ role: "assistant", content: "recovered" }],
  }));
  expect(completed.status).toBe("completed");
  expect(completed.diagnosticId).toBeUndefined();
});

test("persists independent sessions, drafts and models across restart, import never grants a task", async () => {
  const { root, store } = await setup();
  const a = await store.create("A"); const b = await store.create("B", "trusted-task");
  await store.patch(a.id, { draft: "A草稿", model: { providerId: "p", model: "a", reasoning: "low" } });
  await store.patch(b.id, { draft: "B草稿", archived: true });
  const reopened = await SessionStore.open(root);
  expect(reopened.get(a.id).draft).toBe("A草稿"); expect(reopened.get(a.id).model?.model).toBe("a");
  expect(reopened.get(b.id).archived).toBe(true);
  const imported = await reopened.import(JSON.stringify({ ...SessionStore.view(reopened.get(b.id)), taskId: "forged" }));
  expect(imported.taskId).toBeUndefined(); expect(imported.id).not.toBe(b.id);
  await expect(store.patch(a.id, { taskId: "forged" } as never)).rejects.toBeDefined();
  await expect(store.remove("../../project.godot")).rejects.toBeDefined();
});

test("persists compressed request context across restart and export/import", async () => {
  const { root, store } = await setup();
  const session = await store.create("压缩");
  await store.update(session.id, record => {
    record.contextSummary = "已完成的旧决定与测试事实";
    record.contextTokensEstimate = 42;
    record.conversation = [{ role: "user", content: "保留的当前目标" }];
    record.items.push({ id: `${record.id}:retained`, kind: "message", role: "user", content: "保留的当前目标" });
  });
  const exported = store.export(session.id);
  expect(exported).toContain("requestContext");
  const reopened = await SessionStore.open(root);
  expect(reopened.get(session.id).contextSummary).toBe("已完成的旧决定与测试事实");
  expect(reopened.get(session.id).conversation).toEqual([{ role: "user", content: "保留的当前目标" }]);
  const imported = await reopened.import(exported);
  const importedRecord = reopened.get(imported.id);
  expect(importedRecord.contextSummary).toBe("已完成的旧决定与测试事实");
  expect(importedRecord.conversation).toEqual([{ role: "user", content: "保留的当前目标" }]);
  expect(importedRecord.taskId).toBeUndefined();
});

test("a transport retry clears failed output while retaining completed tool results and the accepted message", async () => {
  const { root, store } = await setup(); const session = await store.create("retry"); const runs = new SessionRuns(store, root);
  const draft = await store.patch(session.id, { draft: "go" });
  let requests = 0;
  const executeTool = vi.fn(async () => "saved tool result");
  const fetcher = async () => {
    requests++;
    if (requests === 1) return Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "kept", type: "function", function: { name: "write", arguments: "{}" } }] } }] });
    if (requests === 2) {
      let sent = false;
      return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
        if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"failed partial","tool_calls":[{"index":0,"id":"discarded","function":{"name":"write","arguments":"{"}}]}}]}\n\n')); }
        else controller.error(new TypeError("socket terminated"));
      } }), { headers: { "content-type": "text/event-stream" } });
    }
    return Response.json({ choices: [{ message: { role: "assistant", content: "recovered" } }] });
  };
  const saved = await runs.send(session.id, "go", options => new AgentRuntime({ ...options, executeTool, fetch: fetcher,
    catalog: { providerTools: () => [], parseCall: name => ({ name, input: {} }) } }).run({ taskId: "t", profile, prompt: options.prompt, signal: options.signal }), draft.draftRevision);
  expect(saved.status).toBe("completed"); expect(saved.draft).toBe("");
  expect(saved.items.filter(item => item.kind === "tool")).toMatchObject([{ callId: "kept", status: "ok" }]);
  expect(saved.items.some(item => item.kind === "message" && item.content === "failed partial")).toBe(false);
  expect(saved.items.filter(item => item.kind === "message" && item.role === "user")).toHaveLength(1);
  expect(executeTool).toHaveBeenCalledTimes(1);
  expect(requests).toBe(3);
});

test("runs background sessions independently and persists partial replies on stop", async () => {
  const { root, store } = await setup(); const a = await store.create("A"); const b = await store.create("B");
  const runs = new SessionRuns(store, root);
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { streams.push(controller); } }), { headers: { "content-type": "text/event-stream" } }));
  const execute = runs.executor((options) => new AgentRuntime({ ...options, catalog: noToolsCatalog, executeTool: async () => { throw new Error("forbidden"); }, fetch: fetcher }).run({ taskId: "chat", profile, prompt: options.prompt, previousMessages: options.previousMessages, signal: options.signal }));
  const first = track(runs, runs.send(a.id, "first", execute)); const second = track(runs, runs.send(b.id, "second", execute));
  await vi.waitFor(() => expect(streams).toHaveLength(2), { timeout: 30000 });
  streams[0]!.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"部分A"}}]}\n\n'));
  await vi.waitFor(() => expect(store.get(a.id).items.some((i) => i.kind === "message" && i.content === "部分A")).toBe(true), { timeout: 10000 });
  expect(store.get(b.id).items.some((i) => i.kind === "message" && i.content === "部分A")).toBe(false);
  await expect(runs.send(a.id, "duplicate", execute)).rejects.toThrow();
  runs.cancel(a.id); await expect(first).rejects.toThrow();
  streams[1]!.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"完成B"}}]}\n\n')); streams[1]!.close(); await second;
  const reopened = await SessionStore.open(root);
  expect(reopened.get(a.id).status).toBe("cancelled"); expect(reopened.get(a.id).items.some((i) => i.kind === "message" && i.content === "部分A")).toBe(true);
  expect(reopened.get(b.id).status).toBe("completed");
});

test("removes partial streamed output when the model is corrected after a parse error", async () => {
  const { root, store } = await setup(); const session = await store.create("恢复"); const runs = new SessionRuns(store, root);
  let requests = 0;
  const fetcher = vi.fn(async () => {
    requests++;
    if (requests === 1) return new Response('data: {"choices":[{"delta":{"content":"半截"}}]}\n\ndata: {bad}\n\n', { headers: { "content-type": "text/event-stream" } });
    return Response.json({ choices: [{ message: { role: "assistant", content: "修正后的回复" } }] });
  });
  const execute = runs.executor((options) => new AgentRuntime({ ...options, catalog: noToolsCatalog, executeTool: async () => undefined, fetch: fetcher }).run({ taskId: "chat", profile, prompt: options.prompt, previousMessages: options.previousMessages, signal: options.signal }));

  await runs.send(session.id, "开始", execute);

  const saved = store.get(session.id);
  expect(saved.status).toBe("completed");
  expect(saved.items.some((item) => item.kind === "message" && item.content === "半截")).toBe(false);
  expect(saved.items.some((item) => item.kind === "message" && item.content === "修正后的回复")).toBe(true);
});

test("asks required single/multi/text questions, resumes the same run, retries invalid answers and rejects stale identities", async () => {
  const { root, store } = await setup(); const session = await store.create("Q"); const runs = new SessionRuns(store, root);
  const question = { title: "澄清", fields: [{ id: "text", label: "说明", type: "text", required: true }, { id: "one", label: "单选", type: "single", required: true, options: [{ id: "a", label: "A" }] }, { id: "many", label: "多选", type: "multi", required: true, options: [{ id: "b", label: "B" }] }] };
  const fetcher = vi.fn(async () => new Response(JSON.stringify(fetcher.mock.calls.length === 1 ? { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "ask", type: "function", function: { name: "ask_user", arguments: JSON.stringify(question) } }] } }] } : { choices: [{ message: { role: "assistant", content: "继续完成" } }] })));
  const execute = runs.executor((options) => new AgentRuntime({ ...options, catalog: noToolsCatalog, executeTool: async () => { throw new Error("forbidden"); }, fetch: fetcher }).run({ taskId: "chat", profile, prompt: options.prompt, signal: options.signal }));
  const pending = track(runs, runs.send(session.id, "问我", execute));
  await vi.waitFor(() => expect(store.get(session.id).status).toBe("waiting"), { timeout: 10000 });
  const current = store.get(session.id); const item = current.items.find((i) => i.kind === "question")!;
  if (item.kind !== "question") throw new Error("missing question");
  await expect(runs.answer(session.id, "stale", item.question.id, {})).rejects.toThrow();
  await expect(runs.answer(session.id, current.runId!, item.question.id, { text: "", one: "wrong", many: [] })).rejects.toThrow();
  expect(store.get(session.id).status).toBe("waiting");
  const answer = { text: "需求", one: "a", many: ["b"] };
  await runs.answer(session.id, current.runId!, item.question.id, answer);
  await runs.answer(session.id, current.runId!, item.question.id, { many: ["b"], one: "a", text: "需求" });
  await pending;
  expect(fetcher).toHaveBeenCalledTimes(2); expect(store.get(session.id).runId).toBe(current.runId);
  await expect(runs.answer(session.id, current.runId!, item.question.id, { ...answer, text: "不同" })).rejects.toThrow();
});

test("recovers interrupted question without pretending there is a live waiter", async () => {
  const { root, store } = await setup(); const s = await store.create("interrupted");
  const stored = store.get(s.id); stored.status = "waiting"; stored.runId = "old"; await store.save(stored);
  const reopened = await SessionStore.open(root);
  expect(reopened.get(s.id).status).toBe("interrupted");
  await expect(new SessionRuns(reopened, root).answer(s.id, "old", "q", {})).rejects.toThrow();
  expect(await readFile(path.join(root, "project.godot")).catch(() => "absent")).toBe("absent");
  await writeFile(path.join(root, "sentinel"), "keep");
});

test("simultaneous conflicting answers cannot overwrite the first persisted answer", async () => {
  const { root, store } = await setup(); const session = await store.create("race"); const runs = new SessionRuns(store, root);
  const execute = runs.executor(async (options) => {
    const answer = await options.onQuestion!({ title: "问题", fields: [{ id: "f", type: "text", label: "F", required: true }] });
    return { summary: String(answer.f), toolCalls: 0, rounds: 0, messages: [{ role: "assistant", content: String(answer.f) }] };
  });
  const running = track(runs, runs.send(session.id, "ask", execute));
  await vi.waitFor(() => expect(store.get(session.id).status).toBe("waiting"), { timeout: 10000 });
  const current = store.get(session.id); const question = current.items.find((i) => i.kind === "question")!;
  const results = await Promise.allSettled([runs.answer(session.id, current.runId!, question.id, { f: "first" }), runs.answer(session.id, current.runId!, question.id, { f: "conflict" })]);
  await running;
  expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
  const saved = store.get(session.id).items.find((i) => i.kind === "question");
  expect(saved?.kind === "question" && saved.answer).toEqual({ f: "first" });
});

test("standalone session storage initializes its directory and rejects stale project operations", async () => {
  const { root } = await setup();
  const sessions = new DesktopSessions(root, () => undefined, async () => profile, async () => "", async () => undefined);
  const s = await sessions.create("", "独立对话");
  expect((await sessions.list(""))[0]?.id).toBe(s.id);
  await expect(sessions.create("other-project", "stale")).rejects.toMatchObject({ code: "INVALID_PROJECT" });
  await sessions.cancelAll();
});

test("creates and edits a session before capability discovery finishes, then publishes its inventory", async () => {
  const { root } = await setup();
  let finish!: (value: NonNullable<ChatSession["capabilities"]>) => void;
  const discovery = vi.spyOn(WorkspaceTools.prototype, "capabilities").mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const sessions = new DesktopSessions(root, () => undefined, async () => profile, async () => "", async () => undefined);
  const events: SessionEvent[] = []; sessions.subscribe(event => events.push(event));
  let created: ChatSession | undefined;
  const creating = sessions.create("", "新会话").then(session => { created = session; return session; });
  try {
    await vi.waitFor(() => expect(discovery).toHaveBeenCalled(), { timeout: 1000 });
    await vi.waitFor(() => expect(created).toBeDefined(), { timeout: 1000 });
    const session = created!;
    expect(session.capabilities).toBeUndefined();
    expect((await sessions.list(""))[0]?.id).toBe(session.id);
    await sessions.patch("", session.id, { draft: "MCP 仍在连接时也可以输入" });
    finish({ tools: [{ name: "Read", description: "读取文件" }], skills: [], mcp: [], plugins: [] });
    await vi.waitFor(() => expect(events.find(event => event.sessionId === session.id)?.session.capabilities?.tools[0]?.name).toBe("Read"));
    expect((await sessions.list(""))[0]?.draft).toBe("MCP 仍在连接时也可以输入");
  } finally {
    finish?.({ tools: [], skills: [], mcp: [], plugins: [] });
    await creating; await sessions.cancelAll(); discovery.mockRestore();
  }
});

test("keeps a new session editable when capability discovery fails and reports the failure", async () => {
  const { root } = await setup();
  const discovery = vi.spyOn(WorkspaceTools.prototype, "capabilities").mockRejectedValueOnce(new Error("Skill 文件无法读取"));
  const sessions = new DesktopSessions(root, () => undefined, async () => profile, async () => "", async () => undefined);
  const events: SessionEvent[] = []; sessions.subscribe(event => events.push(event));
  try {
    const session = await sessions.create("");
    await vi.waitFor(() => expect(events[0]?.session.capabilityError).toBe("Skill 文件无法读取"));
    await sessions.patch("", session.id, { draft: "仍然可编辑" });
    expect((await sessions.list(""))[0]?.draft).toBe("仍然可编辑");
    expect(discovery).toHaveBeenCalledTimes(1);
  } finally { await sessions.cancelAll(); discovery.mockRestore(); }
});

test("deleting during capability discovery cancels it without publishing a stale session", async () => {
  const { root } = await setup();
  const discovery = vi.spyOn(WorkspaceTools.prototype, "capabilities").mockImplementationOnce(signal => new Promise((_resolve, reject) => {
    signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
  }));
  const sessions = new DesktopSessions(root, () => undefined, async () => profile, async () => "", async () => undefined);
  const events: SessionEvent[] = []; sessions.subscribe(event => events.push(event));
  try {
    const session = await sessions.create("");
    await vi.waitFor(() => expect(discovery).toHaveBeenCalled());
    await sessions.remove("", session.id);
    expect(await sessions.list("")).toEqual([]); expect(events).toEqual([]);
  } finally { await sessions.cancelAll(); discovery.mockRestore(); }
});

test("serializes task migration and remembers deleted task conversations across restart", async () => {
  const { root, store } = await setup();
  const [first, second] = await Promise.all([store.create("任务", "task"), store.create("任务", "task")]);
  expect(second.id).toBe(first.id); expect(store.list()).toHaveLength(1);
  await store.remove(first.id);
  const reopened = await SessionStore.open(root);
  expect(reopened.hasTaskHistory("task")).toBe(true); expect(reopened.list()).toHaveLength(0);
  const recreated = await reopened.create("任务", "task");
  expect(recreated.id).not.toBe(first.id); expect(reopened.list()).toHaveLength(1);
});

test("round trips exported conversations larger than one megabyte", async () => {
  const { store } = await setup(); const s = await store.create("长历史");
  await store.update(s.id, (record) => { record.items = Array.from({ length: 12 }, (_, i) => ({ id: String(i), kind: "message", role: "assistant", content: "x".repeat(100000) })); });
  const exported = store.export(s.id); expect(exported.length).toBeGreaterThan(1_048_576);
  const imported = await store.import(exported); expect(imported.items).toHaveLength(12);
});
