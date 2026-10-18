import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { SessionStore } from "../../src/main/core/session-store";
import { SessionRuns, type SessionRunOptions } from "../../src/main/core/session-runs";
import type { AgentRunResult } from "../../src/main/core/agent-runtime";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await mkdtemp(path.join(os.tmpdir(), "specloom-bounded-stop-")); roots.push(root); const store = await SessionStore.open(root); const session = await store.create("Stop regression"); return { store, session, runs: new SessionRuns(store, root) }; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(next => { resolve = next; }); return { promise, resolve }; }
const completed = (summary: string): AgentRunResult => ({ summary, messages: [{ role: "assistant", content: summary }], toolCalls: 0, rounds: 1 });

test("Stop persists cancelled state promptly even when a process/tool executor never settles", async () => {
  const { store, session, runs } = await fixture(); const entered = deferred<void>();
  const execution = runs.send(session.id, "测试冻结作业", async () => { entered.resolve(); return new Promise<AgentRunResult>(() => undefined); });
  const outcome = execution.catch(error => error); await entered.promise;
  runs.cancel(session.id);
  await vi.waitFor(() => { expect(store.get(session.id).status).toBe("cancelled"); expect(runs.isRunning(session.id)).toBe(false); }, { timeout: 1000 });
  expect(await outcome).toMatchObject({ code: "MODEL_ERROR" }); expect(store.get(session.id).error).toContain("已停止");
});
test("a cancelled stuck executor cannot overwrite a subsequent run through late output or completion", async () => {
  const { store, session, runs } = await fixture(); const entered = deferred<SessionRunOptions>(); const late = deferred<AgentRunResult>();
  const execution = runs.send(session.id, "第一轮", async options => { entered.resolve(options); return late.promise; }); const outcome = execution.catch(error => error);
  const callbacks = await entered.promise; runs.cancel(session.id); await outcome;
  await runs.send(session.id, "第二轮", async () => completed("新的有效回复"));
  await callbacks.onEvent?.({ type: "text", round: 1, messageId: "stale", content: "失效输出" });
  await callbacks.onConversation?.([{ role: "assistant", content: "失效上下文" }]);
  late.resolve(completed("失效结果")); await late.promise; await Promise.resolve();
  const current = store.get(session.id); expect(current.status).toBe("completed");
  expect(JSON.stringify(current)).toContain("新的有效回复"); expect(JSON.stringify(current)).not.toMatch(/失效输出|失效上下文|失效结果/);
});

test("a cancelled executor's late question cannot put a newer run into waiting", async () => {
  const { store, session, runs } = await fixture(); const firstEntered = deferred<SessionRunOptions>();
  const first = runs.send(session.id, "第一轮", async options => { firstEntered.resolve(options); return new Promise<AgentRunResult>(() => undefined); }).catch(error => error);
  const oldCallbacks = await firstEntered.promise; runs.cancel(session.id); await first;
  const secondEntered = deferred<void>(), finish = deferred<AgentRunResult>();
  const second = runs.send(session.id, "第二轮", async () => { secondEntered.resolve(); return finish.promise; });
  await secondEntered.promise;
  const before = store.get(session.id);
  try {
    await expect(oldCallbacks.onQuestion!({ title: "失效问题", fields: [{ id: "f", label: "回答", type: "text", required: false }] })).rejects.toMatchObject({ code: "MODEL_ERROR" });
    expect(store.get(session.id)).toEqual(before);
    expect(store.get(session.id).status).toBe("running");
  } finally { finish.resolve(completed("新的有效回复")); await second; }
});

test("a question queued before cancellation rechecks ownership inside the store write", async () => {
  const { store, session, runs } = await fixture(); const entered = deferred<SessionRunOptions>();
  const execution = runs.send(session.id, "第一轮", async options => { entered.resolve(options); return new Promise<AgentRunResult>(() => undefined); }).catch(error => error);
  const callbacks = await entered.promise; const queued = deferred<void>(), release = deferred<void>();
  const update = store.update.bind(store);
  vi.spyOn(store, "update").mockImplementationOnce(async (...args) => { queued.resolve(); await release.promise; return update(...args); });
  const question = callbacks.onQuestion!({ title: "已排队的失效问题", fields: [{ id: "f", label: "回答", type: "text", required: false }] }).catch(error => error);
  await queued.promise; runs.cancel(session.id); await execution;
  await runs.send(session.id, "第二轮", async () => completed("新的有效回复"));
  const before = store.get(session.id); release.resolve();
  expect(await question).toMatchObject({ code: "MODEL_ERROR" });
  expect(store.get(session.id)).toEqual(before);
});

test("Stop wins when successful completion is queued but has not yet been written", async () => {
  const { store, session, runs } = await fixture(); const entered = deferred<void>(), finish = deferred<AgentRunResult>();
  const execution = runs.send(session.id, "完成前停止", async () => { entered.resolve(); return finish.promise; }).catch(error => error);
  await entered.promise; const queued = deferred<void>(), release = deferred<void>(); const update = store.update.bind(store);
  vi.spyOn(store, "update").mockImplementationOnce(async (...args) => { queued.resolve(); await release.promise; return update(...args); });
  finish.resolve(completed("未提交的完成结果")); await queued.promise;
  runs.cancel(session.id); release.resolve();
  expect(await execution).toMatchObject({ code: "MODEL_ERROR" });
  expect(store.get(session.id).status).toBe("cancelled");
  expect(JSON.stringify(store.get(session.id))).not.toContain("未提交的完成结果");
});
