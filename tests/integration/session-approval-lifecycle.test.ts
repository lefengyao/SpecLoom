import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { SessionStore } from "../../src/main/core/session-store";
import { SessionRuns, type SessionRunOptions } from "../../src/main/core/session-runs";
import type { AgentRunResult } from "../../src/main/core/agent-runtime";
import type { ToolApprovalInput } from "../../src/shared/approvals";

const roots: string[] = [];
const running = new Map<SessionRuns, Promise<unknown>[]>();
afterEach(async () => {
  for (const runs of running.keys()) runs.cancelAll();
  await Promise.allSettled([...running.values()].flat()); running.clear();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-approval-life-")); roots.push(root);
  const store = await SessionStore.open(root); const session = await store.create("审批");
  return { root, store, session, runs: new SessionRuns(store, root) };
}
const input: ToolApprovalInput = { toolName: "Bash", arguments: '{"command":"publish"}', reason: "会修改外部状态", risk: "high" };
const result = (summary = "done"): AgentRunResult => ({ summary, toolCalls: 0, rounds: 0, messages: [{ role: "assistant", content: summary }] });
function track<T>(runs: SessionRuns, promise: Promise<T>): Promise<T> {
  running.set(runs, [...(running.get(runs) ?? []), promise]); void promise.catch(() => undefined); return promise;
}
async function waiting(store: SessionStore, id: string) {
  await vi.waitFor(() => expect(store.get(id).status).toBe("waiting"));
  const record = store.get(id);
  const approval = record.items.find(item => item.kind === "approval" && item.status === "waiting");
  if (approval?.kind !== "approval") throw new Error("missing pending approval");
  return { record, approval };
}

test("new and old sessions use automatic risk approval and imports cannot grant permissions", async () => {
  const { root, store, session } = await setup();
  expect(session.approvalMode).toBe("auto");
  await store.patch(session.id, { approvalMode: "full" });
  await store.update(session.id, record => { record.items.push({ id: "old-approval", kind: "approval", request: { ...input, id: "old-approval", runId: "old", sessionId: session.id }, status: "approved" }); });
  const imported = await store.import(store.export(session.id));
  expect(imported.approvalMode).toBe("auto"); expect(imported.items.some(item => item.kind === "approval")).toBe(false);
  const reopened = await SessionStore.open(root); expect(reopened.get(session.id).approvalMode).toBe("full");
  const legacy = store.get(session.id); delete legacy.approvalMode; await store.save(legacy);
  expect((await SessionStore.open(root)).get(session.id).approvalMode).toBe("auto");
});

test("persists the approval decision before the waiting operation resumes", async () => {
  const { root, store, session, runs } = await setup(); let decision: boolean | undefined;
  const pending = track(runs, runs.send(session.id, "发布", async options => {
    decision = await options.onApproval(input);
    expect((await SessionStore.open(root)).get(session.id).items.find(item => item.kind === "approval")).toMatchObject({ status: "approved" });
    return result();
  }));
  const { record, approval } = await waiting(store, session.id);
  expect(decision).toBeUndefined(); expect(approval.request).toMatchObject({ ...input, sessionId: session.id, runId: record.runId, id: approval.id });
  await runs.approve(session.id, record.runId!, approval.id, true); await pending;
  expect(decision).toBe(true); expect(store.get(session.id).status).toBe("completed");
});

test("denial resumes with false and each identical invocation asks for its own approval", async () => {
  const { store, session, runs } = await setup(); const decisions: boolean[] = [];
  const pending = track(runs, runs.send(session.id, "两次", async options => { decisions.push(await options.onApproval(input)); decisions.push(await options.onApproval(input)); return result(); }));
  const first = await waiting(store, session.id);
  await runs.approve(session.id, first.record.runId!, first.approval.id, false);
  await vi.waitFor(() => expect(store.get(session.id).items.filter(item => item.kind === "approval")).toHaveLength(2), { timeout: 10000 });
  const second = await waiting(store, session.id); expect(decisions).toEqual([false]);
  await runs.approve(session.id, second.record.runId!, second.approval.id, true); await pending;
  expect(decisions).toEqual([false, true]);
  expect(store.get(session.id).items.filter(item => item.kind === "approval")).toMatchObject([{ status: "denied" }, { status: "approved" }]);
});

test("conflicting concurrent decisions cannot overwrite the persisted approval", async () => {
  const { store, session, runs } = await setup(); let decision: boolean | undefined;
  const pending = track(runs, runs.send(session.id, "竞态", async options => { decision = await options.onApproval(input); return result(); }));
  const { record, approval } = await waiting(store, session.id);
  const replies = await Promise.allSettled([runs.approve(session.id, record.runId!, approval.id, true), runs.approve(session.id, record.runId!, approval.id, false)]);
  await pending; expect(replies.map(reply => reply.status)).toEqual(["fulfilled", "rejected"]); expect(decision).toBe(true);
  expect(store.get(session.id).items.find(item => item.id === approval.id)).toMatchObject({ status: "approved" });
});

test("stale identities cannot resume a cancelled request or a newer run", async () => {
  const { store, session, runs } = await setup(); let resumed = false;
  const pending = track(runs, runs.send(session.id, "身份", async options => { await options.onApproval(input); resumed = true; return result(); }));
  const { record, approval } = await waiting(store, session.id);
  await expect(runs.approve(session.id, "stale", approval.id, true)).rejects.toThrow();
  await expect(runs.approve(session.id, record.runId!, "different", true)).rejects.toThrow();
  expect(resumed).toBe(false); runs.cancel(session.id); await expect(pending).rejects.toThrow();
  expect(store.get(session.id).items.find(item => item.id === approval.id)).toMatchObject({ status: "cancelled" });
  const next = track(runs, runs.send(session.id, "继续", async options => { await options.onApproval(input); return result(); }));
  const current = await waiting(store, session.id);
  await expect(runs.approve(session.id, record.runId!, approval.id, true)).rejects.toThrow();
  await runs.approve(session.id, current.record.runId!, current.approval.id, true); await next;
});

test("restart interrupts pending approvals and rejects saved requests", async () => {
  const { root, store, session, runs } = await setup();
  const pending = track(runs, runs.send(session.id, "重启", async options => { await options.onApproval(input); return result(); }));
  const { record, approval } = await waiting(store, session.id); const reopened = await SessionStore.open(root);
  expect(reopened.get(session.id).status).toBe("interrupted");
  expect(reopened.get(session.id).items.find(item => item.id === approval.id)).toMatchObject({ status: "interrupted" });
  await expect(new SessionRuns(reopened, root).approve(session.id, record.runId!, approval.id, true)).rejects.toThrow();
  runs.cancel(session.id); await expect(pending).rejects.toThrow();
});

test("an immediate subscriber can approve without racing waiter installation", async () => {
  const { store, session, runs } = await setup(); const decisions: Promise<unknown>[] = [];
  runs.subscribe(event => {
    const item = event.session.items.find(candidate => candidate.kind === "approval" && candidate.status === "waiting");
    if (item) decisions.push(runs.approve(session.id, event.runId!, item.id, true));
  });
  const completed = await runs.send(session.id, "即时", async options => { expect(await options.onApproval(input)).toBe(true); return result(); });
  await Promise.all(decisions); expect(completed.status).toBe("completed"); expect(store.get(session.id).items.filter(item => item.kind === "approval")).toHaveLength(1);
});

test("permissions cannot change while a run is awaiting its invocation approval", async () => {
  const { store, session, runs } = await setup();
  const pending = track(runs, runs.send(session.id, "权限", async options => { await options.onApproval(input); return result(); }));
  const { record, approval } = await waiting(store, session.id);
  await expect(store.patch(session.id, { approvalMode: "full" })).rejects.toThrow(); expect(store.get(session.id).approvalMode).toBe("auto");
  await runs.approve(session.id, record.runId!, approval.id, false); await pending;
});

test("parallel approvals retain waiting state until every independent request is decided", async () => {
  const { store, session, runs } = await setup();
  const pending = track(runs, runs.send(session.id, "并行", async options => { expect(await Promise.all([options.onApproval(input), options.onApproval({ ...input, toolName: "MCP" })])).toEqual([true, false]); return result(); }));
  await vi.waitFor(() => expect(store.get(session.id).items.filter(item => item.kind === "approval")).toHaveLength(2));
  const current = store.get(session.id); const items = current.items.filter(item => item.kind === "approval");
  await runs.approve(session.id, current.runId!, items[0]!.id, true); expect(store.get(session.id).status).toBe("waiting");
  await runs.approve(session.id, current.runId!, items[1]!.id, false); await pending; expect(store.get(session.id).status).toBe("completed");
});

test("cancel during a queued approval decision prevents permission from being committed", async () => {
  const { store, session, runs } = await setup(); let resumed = false;
  const pending = track(runs, runs.send(session.id, "取消竞态", async options => { await options.onApproval(input); resumed = true; return result(); }));
  const { record, approval } = await waiting(store, session.id); const update = store.update.bind(store);
  const hook = vi.spyOn(store, "update").mockImplementationOnce((id, action) => update(id, record => { runs.cancel(session.id); action(record); }));
  await expect(runs.approve(session.id, record.runId!, approval.id, true)).rejects.toThrow();
  await expect(pending).rejects.toThrow(); hook.mockRestore(); expect(resumed).toBe(false);
  expect(store.get(session.id).items.find(item => item.id === approval.id)).toMatchObject({ status: "cancelled" });
});

test("a captured callback from a completed run cannot create an approval in its successor", async () => {
  const { store, session, runs } = await setup(); let previous!: SessionRunOptions["onApproval"];
  await runs.send(session.id, "旧运行", async options => { previous = options.onApproval; return result(); });
  const pending = track(runs, runs.send(session.id, "新运行", async options => { await options.onApproval(input); return result(); }));
  const { record, approval } = await waiting(store, session.id);
  await expect(previous(input)).rejects.toThrow(); expect(store.get(session.id).items.filter(item => item.kind === "approval")).toHaveLength(1);
  await runs.approve(session.id, record.runId!, approval.id, true); await pending;
});

test("a detached approval cannot remain actionable after its owning run completes", async () => {
  const { store, session, runs } = await setup(); let detached!: Promise<boolean>;
  const completed = await runs.send(session.id, "结束", async options => { detached = options.onApproval(input); void detached.catch(() => undefined); return result(); });
  await expect(detached).rejects.toThrow();
  expect(completed.items.find(item => item.kind === "approval")).toMatchObject({ status: "interrupted" });
  const item = store.get(session.id).items.find(item => item.kind === "approval")!;
  await expect(runs.approve(session.id, completed.runId!, item.id, true)).rejects.toThrow();
});

test("answering a concurrent question retains the pending approval state", async () => {
  const { store, session, runs } = await setup();
  const pending = track(runs, runs.send(session.id, "一起等待", async options => {
    await Promise.all([options.onApproval(input), options.onQuestion!({ title: "问题", fields: [{ id: "f", label: "F", type: "text", required: false }] })]); return result();
  }));
  await vi.waitFor(() => expect(store.get(session.id).items.filter(item => item.kind === "approval" || item.kind === "question")).toHaveLength(2));
  const current = store.get(session.id); const question = current.items.find(item => item.kind === "question")!; const approval = current.items.find(item => item.kind === "approval")!;
  await runs.answer(session.id, current.runId!, question.id, { f: "yes" });
  expect(store.get(session.id).status).toBe("waiting"); expect(store.get(session.id).activity).toBe("等待你批准");
  await runs.approve(session.id, current.runId!, approval.id, true); await pending;
});

test("observer failure cannot undo a persisted approval or strand its waiting operation", async () => {
  const { store, session, runs } = await setup();
  runs.subscribe(event => { if (event.session.items.some(item => item.kind === "approval" && item.status === "approved")) throw new Error("renderer delivery failed"); });
  const pending = track(runs, runs.send(session.id, "通知", async options => { expect(await options.onApproval(input)).toBe(true); return result(); }));
  const { record, approval } = await waiting(store, session.id);
  await expect(runs.approve(session.id, record.runId!, approval.id, true)).resolves.toMatchObject({ status: "running" });
  await expect(pending).resolves.toMatchObject({ status: "completed" });
});
