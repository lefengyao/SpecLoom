import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { AgentRuntime, noToolsCatalog, type AgentMessage, type ToolExecution } from "../../src/main/core/agent-runtime";
import { SessionRuns, type SessionRunOptions } from "../../src/main/core/session-runs";
import { SessionStore } from "../../src/main/core/session-store";
import { DesktopSessions } from "../../src/main/desktop-sessions";
import type { RuntimeModelProfile } from "../../src/main/core/model-config";

const roots: string[] = [];
const live: SessionRuns[] = [];
const releases: Array<() => void> = [];
const jobs: Promise<unknown>[] = [];
afterEach(async () => { for (const runs of live.splice(0)) runs.cancelAll(); for (const release of releases.splice(0)) release(); await Promise.allSettled(jobs.splice(0)); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(ok => { resolve = ok; }); releases.push(() => resolve(undefined as T)); return { promise, resolve }; }
function track<T>(promise: Promise<T>) { jobs.push(promise); void promise.catch(() => undefined); return promise; }
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-guidance-")); roots.push(root);
  const store = await SessionStore.open(root); const session = await store.create("guidance");
  const runs = new SessionRuns(store, root); live.push(runs); return { root, store, session, runs };
}
const profile: RuntimeModelProfile = { id: "mock", name: "Mock", provider: "openai-compatible", model: "local", baseUrl: "http://localhost:1234", approved: true, timeoutMs: 2000 };
type RequestBody = { messages: AgentMessage[] };
function execute(options: SessionRunOptions, fetcher: typeof fetch) {
  return new AgentRuntime({ ...options, catalog: noToolsCatalog, executeTool: async () => undefined, fetch: fetcher }).run({ taskId: "chat", profile, prompt: options.prompt, previousMessages: options.previousMessages, signal: options.signal });
}

test("accepts guidance during streaming immediately, retains the response, and continues the same run", async () => {
  const { root, store, session, runs } = await setup(); const started = deferred<ReadableStreamDefaultController<Uint8Array>>(); const partial = deferred();
  const bodies: RequestBody[] = []; let finished = false;
  runs.subscribe(event => { if (event.session.items.some(item => item.kind === "message" && item.content === "first response")) partial.resolve(); });
  const fetching: typeof fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as RequestBody);
    if (bodies.length === 1) return new Response(new ReadableStream<Uint8Array>({ start(controller) { started.resolve(controller); } }), { headers: { "content-type": "text/event-stream" } });
    return Response.json({ choices: [{ message: { role: "assistant", content: "guidance applied" } }] });
  };
  const sending = track(runs.send(session.id, "initial task", options => execute(options, fetching)).then(value => { finished = true; return value; }));
  const stream = await started.promise; stream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"first response"}}]}\n\n')); await partial.promise;
  const runId = store.get(session.id).runId!;
  const [accepted] = await Promise.all([runs.guide(session.id, runId, "g1", "also add tests"), runs.guide(session.id, runId, "g1", "also add tests"), runs.guide(session.id, runId, "g2", "then update docs")]);
  expect(finished).toBe(false); expect(accepted.status).toBe("running"); expect(runs.isRunning(session.id)).toBe(true);
  expect(accepted.items.filter(item => item.id === `${runId}:guidance:g1`)).toHaveLength(1);
  await expect(runs.guide(session.id, runId, "g1", "different text")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  await expect(runs.guide(session.id, "stale-run", "g2", "wrong run")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  stream.close(); const completed = await sending;
  expect(completed.runId).toBe(runId); expect(completed.status).toBe("completed"); expect(bodies).toHaveLength(2);
  expect(bodies[1]!.messages).toEqual(expect.arrayContaining([{ role: "assistant", content: "first response" }, { role: "user", content: "also add tests" }]));
  expect(bodies[1]!.messages.filter(message => message.role === "user").map(message => message.content)).toEqual(["initial task", "also add tests", "then update docs"]);
  expect(completed.items.flatMap(item => item.kind === "message" && item.role === "assistant" ? [item.content] : [])).toEqual(["first response", "guidance applied"]);
  expect(store.get(session.id).conversation).toContainEqual({ role: "user", content: "also add tests" });
  expect((await runs.guide(session.id, runId, "g1", "also add tests")).status).toBe("completed");
  const reopened = await SessionStore.open(root);
  expect((await new SessionRuns(reopened, root).guide(session.id, runId, "g1", "also add tests")).status).toBe("completed");
  await expect(runs.guide(session.id, runId, "g3", "too late")).rejects.toMatchObject({ code: "MODEL_ERROR" });
});

test("guidance at the final summary boundary causes another model response before completion", async () => {
  const { store, session, runs } = await setup(); const bodies: RequestBody[] = []; let guided = false;
  const fetching: typeof fetch = async (_url, init) => { bodies.push(JSON.parse(String(init?.body)) as RequestBody); return Response.json({ choices: [{ message: { role: "assistant", content: bodies.length === 1 ? "first final" : "continued final" } }] }); };
  const completed = await track(runs.send(session.id, "task", options => new AgentRuntime({ ...options, catalog: noToolsCatalog, executeTool: async () => undefined, fetch: fetching,
    onEvent: async event => { await options.onEvent?.(event); if (event.type === "summary" && !guided) { guided = true; await runs.guide(session.id, store.get(session.id).runId!, "final-guidance", "follow up before ending"); } },
  }).run({ taskId: "chat", profile, prompt: options.prompt, signal: options.signal })));
  expect(bodies).toHaveLength(2); expect(bodies[1]!.messages.at(-1)).toEqual({ role: "user", content: "follow up before ending" });
  expect(completed.items.some(item => item.kind === "message" && item.content === "continued final")).toBe(true);
});

test("guidance accepted at the Monitor idle summary continues the run before completion", async () => {
  const { store, session, runs } = await setup(); const bodies: RequestBody[] = []; let polls = 0, guided = false;
  const completed = await track(runs.send(session.id, "检查测试", options => new AgentRuntime({
    ...options,
    catalog: { providerTools: () => [], parseCall: (_name, json) => ({ name: "Monitor", input: JSON.parse(json) }) },
    executeTool: async () => { polls++; return { id: "finished-job", status: "completed", changed: false }; },
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as RequestBody);
      return Response.json({ choices: [{ message: polls < 5 ? { role: "assistant", content: null, tool_calls: [{ id: `poll-${polls}`, type: "function", function: { name: "Monitor", arguments: JSON.stringify({ operation: "poll", id: "finished-job", waitMs: 0 }) } }] } : { role: "assistant", content: "已处理后续引导" } }] });
    },
    onEvent: async event => {
      await options.onEvent?.(event);
      if (event.type === "summary" && event.summary.includes("停止重复轮询") && !guided) { guided = true; await runs.guide(session.id, store.get(session.id).runId!, "idle-guidance", "继续查看已有测试结果"); }
    },
  }).run({ taskId: "monitor-guidance", profile, prompt: options.prompt, signal: options.signal })));
  expect(completed.status).toBe("completed"); expect(polls).toBe(5); expect(bodies).toHaveLength(6);
  expect(bodies.at(-1)!.messages.at(-1)).toEqual({ role: "user", content: "继续查看已有测试结果" });
  expect(store.get(session.id).conversation).toContainEqual({ role: "assistant", content: "已处理后续引导" });
});

test("injects guidance after the complete active tool batch without cancelling or repeating tools", async () => {
  const { store, session, runs } = await setup(); const toolStarted = deferred(); const finishTool = deferred(); const bodies: RequestBody[] = [];
  const executeTool = vi.fn(async (call: ToolExecution) => { expect(call.signal?.aborted).toBe(false); toolStarted.resolve(); await finishTool.promise; return "tool result"; });
  const fetching: typeof fetch = async (_url, init) => { bodies.push(JSON.parse(String(init?.body)) as RequestBody); return Response.json({ choices: [{ message: bodies.length === 1 ? { role: "assistant", content: null, tool_calls: [{ id: "call", type: "function", function: { name: "Read", arguments: "{}" } }] } : { role: "assistant", content: "finished guided task" } }] }); };
  const sending = track(runs.send(session.id, "task", options => new AgentRuntime({ ...options, catalog: { providerTools: () => [], parseCall: name => ({ name, input: {} }) }, executeTool, fetch: fetching }).run({ taskId: "chat", profile, prompt: options.prompt, signal: options.signal })));
  await toolStarted.promise; const runId = store.get(session.id).runId!;
  await runs.guide(session.id, runId, "tool-guidance", "update the work after reading");
  expect(store.get(session.id).items.find(item => item.kind === "tool")?.status).toBe("running");
  finishTool.resolve(); await sending;
  expect(executeTool).toHaveBeenCalledOnce(); expect(executeTool.mock.calls[0]![0].signal?.aborted).toBe(false);
  expect(bodies[1]!.messages.map(message => message.role)).toEqual(["user", "assistant", "tool", "user"]);
  expect(bodies[1]!.messages.at(-1)?.content).toBe("update the work after reading");
});

test("rejects new guidance once the model has sealed completion", async () => {
  const { store, session, runs } = await setup(); const sealed = deferred(); const finish = deferred();
  const sending = track(runs.send(session.id, "task", async options => { const result = await execute(options, async () => Response.json({ choices: [{ message: { role: "assistant", content: "done" } }] })); sealed.resolve(); await finish.promise; return result; }));
  await sealed.promise; const runId = store.get(session.id).runId!;
  await expect(runs.guide(session.id, runId, "closed", "must not be silently accepted")).rejects.toMatchObject({ code: "MODEL_ERROR" });
  expect(store.get(session.id).items.some(item => item.id === `${runId}:guidance:closed`)).toBe(false);
  finish.resolve(); await sending;
});

test("delivers guidance images live and retains an idempotent receipt without durable image bytes", async () => {
  const { root, store, session, runs } = await setup(); const started = deferred(); const finishResponse = deferred(); const bodies: RequestBody[] = [];
  const images = [{ name: "reference.png", mimeType: "image/png", base64: "cGljdHVyZQ==" }];
  const sending = track(runs.send(session.id, "task", options => execute(options, async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as RequestBody); if (bodies.length === 1) { started.resolve(); await finishResponse.promise; }
    return Response.json({ choices: [{ message: { role: "assistant", content: "done" } }] });
  })));
  await started.promise; const runId = store.get(session.id).runId!;
  await runs.guide(session.id, runId, "image", "follow this reference", images);
  await expect(runs.guide(session.id, runId, "image", "follow this reference", [{ ...images[0]!, base64: "different" }])).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  finishResponse.resolve(); await sending;
  expect(bodies[1]!.messages.at(-1)?.content).toEqual([{ type: "text", text: "follow this reference" }, { type: "image_url", image_url: { url: "data:image/png;base64,cGljdHVyZQ==" } }]);
  const reopened = await SessionStore.open(root);
  expect(JSON.stringify(reopened.get(session.id))).not.toContain(images[0]!.base64);
  expect((await new SessionRuns(reopened, root).guide(session.id, runId, "image", "follow this reference", images)).status).toBe("completed");
});

test("accepted guidance survives cancellation before the next model boundary", async () => {
  const { root, store, session, runs } = await setup(); const started = deferred();
  const sending = track(runs.send(session.id, "task", options => execute(options, async () => new Response(new ReadableStream({ start() { started.resolve(); } }), { headers: { "content-type": "text/event-stream" } }))));
  await started.promise; const runId = store.get(session.id).runId!;
  await runs.guide(session.id, runId, "retained", "keep this accepted request");
  runs.cancel(session.id); await expect(sending).rejects.toThrow();
  const reopened = await SessionStore.open(root);
  expect(reopened.get(session.id).status).toBe("cancelled");
  expect(reopened.get(session.id).items).toContainEqual(expect.objectContaining({ id: `${runId}:guidance:retained`, content: "keep this accepted request" }));
  expect(reopened.get(session.id).conversation).toContainEqual({ role: "user", content: "keep this accepted request" });
  expect((await new SessionRuns(reopened, root).guide(session.id, runId, "retained", "keep this accepted request")).status).toBe("cancelled");
});

test("a checkpoint queued behind guidance admission retains the accepted request after cancellation", async () => {
  const { root, store, session, runs } = await setup(); const started = deferred<SessionRunOptions>(); const finish = deferred();
  const sending = track(runs.send(session.id, "initial task", async options => {
    started.resolve(options); await finish.promise; options.signal.throwIfAborted();
    return { summary: "unused", toolCalls: 0, rounds: 0, messages: [] };
  }));
  const options = await started.promise;
  await options.onConversation?.([{ role: "user", content: "initial task" }]);
  const runId = store.get(session.id).runId!;
  const guiding = runs.guide(session.id, runId, "queued-checkpoint", "retain this accepted request");
  const checkpoint = options.onConversation?.([{ role: "user", content: "initial task" }, { role: "assistant", content: "initial response" }]);
  await Promise.all([guiding, checkpoint]);
  runs.cancel(session.id); finish.resolve(); await expect(sending).rejects.toThrow();
  const reopened = await SessionStore.open(root);
  expect(reopened.get(session.id).items).toContainEqual(expect.objectContaining({ id: `${runId}:guidance:queued-checkpoint`, content: "retain this accepted request" }));
  expect(reopened.get(session.id).conversation).toContainEqual({ role: "user", content: "retain this accepted request" });
});

test.each([false, true])("failed admission never reaches a checkpoint or model boundary (concurrent retry: %s)", async retry => {
  const { store, session, runs } = await setup(); const started = deferred<SessionRunOptions>(); const finish = deferred();
  let messages: AgentMessage[] = [{ role: "user", content: "initial task" }];
  const sending = track(runs.send(session.id, "initial task", async options => {
    started.resolve(options); await finish.promise;
    return { summary: "done", toolCalls: 0, rounds: 0, messages: [...messages, { role: "assistant", content: "done" }] };
  }));
  const options = await started.promise;
  const storage = store as unknown as { writeJson(path: string, json: string): Promise<void> }; const originalWrite = storage.writeJson.bind(store);
  let failed = false;
  vi.spyOn(storage, "writeJson").mockImplementation(async (file, json) => {
    if (!failed && json.includes(":guidance:failed")) { failed = true; throw new Error("disk write failed"); }
    await originalWrite(file, json);
  });
  const runId = store.get(session.id).runId!;
  const guiding = runs.guide(session.id, runId, "failed", "guidance admission");
  const retried = retry ? runs.guide(session.id, runId, "failed", "guidance admission") : Promise.resolve();
  const checkpoint = options.onConversation?.(messages);
  await expect(guiding).rejects.toThrow("disk write failed"); await retried; await checkpoint;
  expect(store.get(session.id).items.some(item => item.id === `${runId}:guidance:failed`)).toBe(retry);
  expect(store.get(session.id).conversation.filter(message => message.content === "guidance admission")).toHaveLength(retry ? 1 : 0);
  const pending = await options.takeGuidance(false);
  expect(pending).toEqual(retry ? [{ role: "user", content: "guidance admission" }] : []);
  expect(await options.takeGuidance(false)).toEqual([]);
  messages = [...messages, ...pending]; await options.onConversation?.(messages); finish.resolve(); await sending;
});

test("an old run cannot receive new guidance while another run is active", async () => {
  const { store, session, runs } = await setup();
  const first = await runs.send(session.id, "first", options => execute(options, async () => Response.json({ choices: [{ message: { role: "assistant", content: "first done" } }] })));
  const started = deferred(); const finishResponse = deferred(); const bodies: RequestBody[] = [];
  const sending = track(runs.send(session.id, "second", options => execute(options, async (_url, init) => { bodies.push(JSON.parse(String(init?.body)) as RequestBody); started.resolve(); await finishResponse.promise; return Response.json({ choices: [{ message: { role: "assistant", content: "second done" } }] }); })));
  await started.promise; expect(store.get(session.id).runId).not.toBe(first.runId);
  await expect(runs.guide(session.id, first.runId!, "stale", "never deliver this to the new run")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  finishResponse.resolve(); await sending;
  expect(bodies).toHaveLength(1); expect(JSON.stringify(bodies)).not.toContain("never deliver this");
});

test("a slow durable admission is awaited at the final boundary", async () => {
  const { store, session, runs } = await setup(); const started = deferred(); const finishResponse = deferred(); const saving = deferred(); const saved = deferred();
  const storage = store as unknown as { writeJson(path: string, json: string): Promise<void> }; const originalWrite = storage.writeJson.bind(store);
  vi.spyOn(storage, "writeJson").mockImplementation(async (file, json) => { if (json.includes(':guidance:slow')) { saving.resolve(); await saved.promise; } await originalWrite(file, json); });
  let requests = 0;
  const sending = track(runs.send(session.id, "task", options => execute(options, async () => { requests++; if (requests === 1) { started.resolve(); await finishResponse.promise; } return Response.json({ choices: [{ message: { role: "assistant", content: `reply ${requests}` } }] }); })));
  await started.promise; const guiding = runs.guide(session.id, store.get(session.id).runId!, "slow", "durably accepted"); await saving.promise;
  finishResponse.resolve(); expect(requests).toBe(1); saved.resolve(); await guiding; const completed = await sending;
  expect(requests).toBe(2); expect(completed.status).toBe("completed"); expect(store.get(session.id).conversation).toContainEqual({ role: "user", content: "durably accepted" });
});

test("shutdown rejects a pending guidance invocation before it reaches the live run", async () => {
  const core = { metadata: { path: "/fixture" } };
  const sessions = new DesktopSessions("/data", () => core as never, async () => profile, async () => "", async () => undefined);
  const initialized = deferred<SessionRuns>(); const guide = vi.fn(); const cancelAll = vi.fn();
  (sessions as unknown as { workspaces: Map<string, Promise<SessionRuns>> }).workspaces.set("/fixture", initialized.promise);
  const guiding = sessions.guide("/fixture", "session", "run", "guidance", "late initialization"); const rejected = expect(guiding).rejects.toThrow("正在关闭");
  const closing = sessions.shutdown(); initialized.resolve({ guide, cancelAll } as unknown as SessionRuns);
  await Promise.all([rejected, closing]); expect(guide).not.toHaveBeenCalled();
});
