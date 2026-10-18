import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { SessionStore, type SessionRecord } from "../../src/main/core/session-store";
import { SessionRuns } from "../../src/main/core/session-runs";
import { AgentConversationSchema, type AgentMessage } from "../../src/main/core/agent-runtime";
import { boundConversation } from "../../src/main/core/agent-conversation";
import { sessionFileLimit, type ChatItem, type SessionEvent } from "../../src/shared/chat";

const roots: string[] = [];
function originalItems(items: ChatItem[]): ChatItem[] {
  return items.filter(item => !(item.kind === "message" && item.content === "" && item.fileChanges)).map(item => {
    if (item.kind !== "message") return item;
    const copy = { ...item }; delete copy.fileChanges; return copy;
  });
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() { const root = await mkdtemp(path.join(os.tmpdir(), "specloom-session-capacity-")); roots.push(root); return { root, store: await SessionStore.open(root) }; }
function fillToBytes(record: Pick<SessionRecord, "items">, targetBytes: number) {
  const filler = Array.from({ length: Math.ceil(targetBytes / 120_000) }, (_, index) => ({ id: `filler-${index}`, kind: "message" as const, role: "assistant" as const, content: "" }));
  record.items.unshift(...filler);
  let remaining = targetBytes - Buffer.byteLength(JSON.stringify(record));
  for (const item of filler) { const length = Math.min(120_000, remaining); item.content = "x".repeat(length); remaining -= length; }
  expect(remaining).toBe(0);
}

test("preserves a conversation above 96 messages and 256KB across save, restart and export", async () => {
  const { root, store } = await setup(); const session = await store.create("long conversation");
  const history: AgentMessage[] = [{ role: "user", content: "Keep the original project decisions" }];
  for (let index = 0; index < 50; index++) history.push(
    { role: "assistant", content: null, tool_calls: [{ id: `read-${index}`, type: "function", function: { name: "Read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: `read-${index}`, content: `Result ${index}: `.padEnd(6000, "x") },
  );
  const record = store.get(session.id);
  record.conversation = history;
  record.contextSummary = "Earlier decisions remain available";
  await store.save(record);

  const reopened = await SessionStore.open(root);
  expect(reopened.get(session.id).conversation).toEqual(history);
  expect(reopened.get(session.id).contextSummary).toBe(record.contextSummary);
  const imported = await reopened.import(reopened.export(session.id));
  expect(reopened.get(imported.id).conversation).toEqual(history);
  expect((await SessionStore.open(root)).get(imported.id).conversation).toEqual(history);
  const runs = new SessionRuns(reopened, root);
  await runs.send(imported.id, "continue", async options => {
    expect(options.previousMessages).toEqual(history);
    return { summary: "continued", toolCalls: 0, rounds: 0,
      messages: boundConversation([...options.previousMessages, { role: "user", content: "continue" }, { role: "assistant", content: "continued" }]) };
  });
});

test("retains more than 64 legacy messages when opening their task session", async () => {
  const { root, store } = await setup();
  const history = Array.from({ length: 120 }, (_, index) => ({ role: index % 2 ? "assistant" as const : "user" as const,
    content: `${index}: `.padEnd(3000, "x") }));

  const session = await store.create("long legacy task", "long-trusted-task", history);

  expect(session.items).toHaveLength(history.length);
  expect(store.get(session.id).conversation).toEqual(history);
  expect((await SessionStore.open(root)).get(session.id).conversation).toEqual(history);
});

test.each([
  { providerId: "provider-b", model: "same-model" },
  { providerId: "provider-a", model: "other-model" },
])("clears request calibration when the selected model changes to $providerId/$model", async model => {
  const { root, store } = await setup(); const session = await store.create("model calibration");
  const record = store.get(session.id);
  record.model = { providerId: "provider-a", model: "same-model", reasoning: "inherit" };
  record.contextTokensEstimate = 1000;
  record.contextCalibration = { profileId: "provider-a/same-model", model: "same-model", estimatedInputTokens: 800, actualInputTokens: 1000 };
  record.lastRequestUsage = { promptTokens: 1000, completionTokens: 200, cachedTokens: 100, cacheWriteTokens: 0, source: "actual" };
  await store.save(record);

  const changed = await store.patch(session.id, { model: { ...model, reasoning: "inherit" } });

  expect(changed.contextCalibration).toBeUndefined();
  expect(changed.lastRequestUsage).toBeUndefined();
  expect(changed.contextTokensEstimate).toBeUndefined();
  expect((await SessionStore.open(root)).get(session.id).contextCalibration).toBeUndefined();
  expect((await SessionStore.open(root)).get(session.id).lastRequestUsage).toBeUndefined();
  expect((await SessionStore.open(root)).get(session.id).contextTokensEstimate).toBeUndefined();
});

test("preserves request calibration when only the reasoning preference changes", async () => {
  const { root, store } = await setup(); const session = await store.create("reasoning calibration");
  const record = store.get(session.id);
  record.model = { providerId: "provider-a", model: "same-model", reasoning: "off" };
  record.contextTokensEstimate = 1000;
  record.contextCalibration = { profileId: "provider-a/same-model", model: "same-model", estimatedInputTokens: 800, actualInputTokens: 1000 };
  record.lastRequestUsage = { promptTokens: 1000, completionTokens: 200, cachedTokens: 100, cacheWriteTokens: 0, source: "actual" };
  await store.save(record);

  const changed = await store.patch(session.id, { model: { providerId: "provider-a", model: "same-model", reasoning: "high" } });

  expect(changed.contextCalibration).toEqual(record.contextCalibration);
  expect(changed.lastRequestUsage).toEqual(record.lastRequestUsage);
  expect(changed.contextTokensEstimate).toBe(record.contextTokensEstimate);
  const reopened = await SessionStore.open(root); const imported = await reopened.import(reopened.export(session.id));
  const restored = (await SessionStore.open(root)).get(imported.id);
  expect(restored.contextCalibration).toEqual(record.contextCalibration);
  expect(restored.lastRequestUsage).toEqual(record.lastRequestUsage);
  expect(restored.contextTokensEstimate).toBe(record.contextTokensEstimate);
});

test("terminates a run when history reaches its capacity without losing saved history or the draft", async () => {
  const { root, store } = await setup(); const session = await store.create("capacity");
  await store.patch(session.id, { draft: "keep this unsent draft" });
  const runs = new SessionRuns(store, root); const events: SessionEvent[] = []; runs.subscribe(event => events.push(event));
  let beforeFailure: SessionRecord | undefined;
  await expect(runs.send(session.id, "continue", async options => {
    const record = store.get(session.id);
    record.activity = "正在输出回复";
    record.items.push({ id: `${record.runId}:reply`, kind: "message", role: "assistant", content: "a", partial: true });
    fillToBytes(record, sessionFileLimit - 10);
    // A saturated active record must be rejected while the previous persisted state remains usable.
    beforeFailure = store.get(session.id);
    await store.save(record);
    beforeFailure = store.get(session.id);
    await options.onEvent!({ type: "text", round: 0, messageId: "reply", content: "a".repeat(1000) });
    return { summary: "unreachable", toolCalls: 0, rounds: 0, messages: [] };
  })).rejects.toThrow("会话历史过大");
  const saved = store.get(session.id);
  expect(runs.isRunning(session.id)).toBe(false);
  expect(saved.status).toBe("error");
  expect(saved.error).toContain("会话历史过大");
  expect(originalItems(saved.items)).toEqual(beforeFailure!.items);
  expect(saved.draft).toBe("keep this unsent draft");
  expect(events.at(-1)?.session.status).toBe("error");
  const reopened = (await SessionStore.open(root)).get(session.id);
  expect(reopened.status).toBe("error"); expect(reopened.items).toEqual(saved.items); expect(reopened.draft).toBe(saved.draft);
});

test.each(["error", "cancelled"] as const)("saves %s with maximum error text and pending tools near the active capacity", async status => {
  const { root, store } = await setup(); const session = await store.create("pending tools"); const runs = new SessionRuns(store, root);
  await store.patch(session.id, { draft: "retained draft" });
  let beforeFailure: SessionRecord | undefined;
  await expect(runs.send(session.id, "continue", async () => {
    const record = store.get(session.id);
    const pendingCount = Math.min(4000, 4096 - Math.ceil(sessionFileLimit / 120_000) - 1);
    record.items.push(...Array.from({ length: pendingCount }, (_, index) => ({ id: `tool-${index}`, kind: "tool" as const,
      callId: `call-${index}`, name: "Read", arguments: "{}", output: "", status: "running" as const })));
    fillToBytes(record, sessionFileLimit - 65_536 - 10); await store.save(record); beforeFailure = store.get(session.id);
    if (status === "cancelled") runs.cancel(session.id);
    throw new Error("\0".repeat(4000));
  })).rejects.toThrow();
  const saved = store.get(session.id);
  expect(runs.isRunning(session.id)).toBe(false); expect(saved.status).toBe(status);
  expect(saved.draft).toBe("retained draft");
  expect(originalItems(saved.items)).toEqual(beforeFailure!.items.map(item => item.kind === "tool" ? { ...item, status: "cancelled" } : item));
  expect(saved.items).toHaveLength(4096);
  expect(saved.items.find(item => item.id === `${saved.runId}:user`)).toMatchObject({ content: "continue", fileChanges: { runId: saved.runId, files: [] } });
  expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThanOrEqual(sessionFileLimit);
  expect((await SessionStore.open(root)).get(session.id).status).toBe(status);
});

test("an oversized stream event retains the last saved reply and publishes a terminal error", async () => {
  const { root, store } = await setup(); const session = await store.create("stream capacity"); const runs = new SessionRuns(store, root);
  const events: SessionEvent[] = []; runs.subscribe(event => events.push(event)); let beforeFailure: SessionRecord | undefined;
  await expect(runs.send(session.id, "continue", async options => {
    const record = store.get(session.id); record.activity = "正在输出回复";
    record.items.push({ id: `${record.runId}:reply`, kind: "message", role: "assistant", content: "saved partial", partial: true });
    fillToBytes(record, sessionFileLimit - 65_536 - 10); await store.save(record); beforeFailure = store.get(session.id);
    await options.onEvent!({ type: "text", round: 0, messageId: "reply", content: "x".repeat(100_000) });
    return { summary: "unreachable", toolCalls: 0, rounds: 0, messages: [] };
  })).rejects.toThrow("会话历史过大");
  const saved = store.get(session.id);
  expect(saved.status).toBe("error"); expect(originalItems(saved.items)).toEqual(beforeFailure!.items);
  expect(events.at(-1)?.session.status).toBe("error");
  expect((await SessionStore.open(root)).get(session.id).items).toEqual(saved.items);
});

test("round trips a valid near-capacity export without expanding its derived model history past the file limit", async () => {
  const { root, store } = await setup(); const session = await store.create("near-capacity export"); const record = store.get(session.id);
  record.conversation = [{ role: "user", content: "latest goal" }, { role: "assistant", content: "latest answer" }];
  record.items.push({ id: "goal", kind: "message", role: "user", content: "latest goal" });
  fillToBytes(record, 4_050_000); await store.save(record);
  const exported = store.export(session.id); expect(Buffer.byteLength(exported)).toBeLessThan(sessionFileLimit);
  const imported = await store.import(exported);
  expect(imported.items).toEqual(record.items);
  expect(store.get(imported.id).conversation).toContainEqual({ role: "user", content: "latest goal" });
  expect(Buffer.byteLength(JSON.stringify(store.get(imported.id)))).toBeLessThanOrEqual(sessionFileLimit);
  expect((await SessionStore.open(root)).get(imported.id).items).toEqual(record.items);
});

test("round trips a near-capacity compressed session without duplicating its summary in the export", async () => {
  const { root, store } = await setup(); const session = await store.create("near-capacity summary export");
  const record = store.get(session.id);
  record.contextSummary = "s".repeat(65_000);
  const currentTurn: AgentMessage[] = [
    { role: "user", content: "current goal" },
    { role: "assistant", content: null, tool_calls: [{ id: "current-call", type: "function", function: { name: "Read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "current-call", content: "current tool result" },
    { role: "assistant", content: "current answer" },
  ];
  record.conversation = currentTurn;
  record.items.push({ id: "current-goal", kind: "message", role: "user", content: "current goal" });
  fillToBytes(record, sessionFileLimit - 1024); await store.save(record);
  expect(Buffer.byteLength(JSON.stringify(store.get(session.id)))).toBe(sessionFileLimit - 1024);

  const exported = store.export(session.id);
  expect(Buffer.byteLength(exported)).toBeLessThanOrEqual(sessionFileLimit);
  expect(JSON.parse(exported).requestContext).not.toHaveProperty("contextSummary");
  const imported = await store.import(exported);
  const retained = store.get(imported.id);

  expect(retained.contextSummary).toBe(record.contextSummary);
  expect(retained.conversation).toEqual(currentTurn);
  expect(retained.items).toEqual(record.items);
  expect((await SessionStore.open(root)).get(imported.id).conversation).toEqual(currentTurn);
  expect((await SessionStore.open(root)).get(imported.id).contextSummary).toBe(record.contextSummary);
});

test("rejects import input larger than the session file limit", async () => {
  const { store } = await setup(); const session = await store.create("oversized import");
  const exported = store.export(session.id);
  const oversized = exported + " ".repeat(sessionFileLimit - Buffer.byteLength(exported) + 1);

  await expect(store.import(oversized)).rejects.toThrow("导入会话过大");
  expect(store.list().map(value => value.id)).toEqual([session.id]);
});

test("trims imported request context at complete user turns while preserving its current tool batch and summary", async () => {
  const { root, store } = await setup(); const session = await store.create("compressed import");
  const record = store.get(session.id);
  record.id = "s"; record.createdAt = ""; record.updatedAt = ""; delete record.approvalMode;
  record.contextSummary = "Earlier decisions remain in the summary";
  const currentTurn: AgentMessage[] = [
    { role: "user", content: "current goal" },
    { role: "assistant", content: null, tool_calls: [{ id: "current-call", type: "function", function: { name: "Read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "current-call", content: "current tool result" },
    { role: "assistant", content: "current answer" },
  ];
  record.conversation = [
    { role: "user", content: "" },
    { role: "assistant", content: null, tool_calls: [{ id: "old-call", type: "function", function: { name: "Read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "old-call", content: "old tool result" },
    ...currentTurn,
  ];
  const input = { ...SessionStore.view(record), requestContext: { conversation: record.conversation, contextSummary: record.contextSummary } };
  fillToBytes(input, sessionFileLimit);
  const json = JSON.stringify(input); expect(Buffer.byteLength(json)).toBe(sessionFileLimit);

  const imported = await store.import(json);

  const retained = store.get(imported.id);
  expect(retained.conversation).toEqual(currentTurn);
  expect(AgentConversationSchema.safeParse(retained.conversation).success).toBe(true);
  expect(retained.contextSummary).toBe(record.contextSummary);
  expect(retained.items).toEqual(input.items);
  expect((await SessionStore.open(root)).get(imported.id).conversation).toEqual(currentTurn);
});

test("rejects an import that cannot retain its complete current turn and summary", async () => {
  const { store } = await setup(); const session = await store.create("current turn import");
  const record = store.get(session.id);
  record.id = "s"; record.createdAt = ""; record.updatedAt = ""; delete record.approvalMode;
  record.contextSummary = "Keep this summary";
  record.conversation = [
    { role: "user", content: "current goal" },
    { role: "assistant", content: null, tool_calls: [{ id: "current-call", type: "function", function: { name: "Read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "current-call", content: "current tool result" },
  ];
  const input = { ...SessionStore.view(record), requestContext: { conversation: record.conversation, contextSummary: record.contextSummary } };
  fillToBytes(input, sessionFileLimit);

  await expect(store.import(JSON.stringify(input))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  expect(store.list().map(value => value.id)).toEqual([session.id]);
});

test("a failed import never leaves an empty session behind", async () => {
  const { root, store } = await setup(); const session = await store.create("source"); const record = store.get(session.id);
  record.id = "s"; fillToBytes(record, sessionFileLimit);
  const input = SessionStore.view(record); input.draft += "x".repeat(Buffer.byteLength(JSON.stringify(record)) - Buffer.byteLength(JSON.stringify(input)));
  const json = JSON.stringify(input); expect(Buffer.byteLength(json)).toBe(sessionFileLimit);
  await expect(store.import(json)).rejects.toThrow("会话历史过大");
  expect(store.list().map(value => value.id)).toEqual([session.id]);
  expect((await readdir(path.join(root, ".specloom/history/sessions"))).filter(file => file.endsWith(".json"))).toHaveLength(1);
});

test("passes retained legacy task history to its next run without restoring tool authorization", async () => {
  const { root, store } = await setup();
  const history = [{ role: "user" as const, content: "Keep the existing task goal" }, { role: "assistant" as const, content: "Existing task answer" }];
  const session = await store.create("legacy task", "trusted-task", history);
  const reopened = await SessionStore.open(root); const runs = new SessionRuns(reopened, root);
  let previousMessages: unknown;
  await runs.send(session.id, "continue", async options => {
    previousMessages = options.previousMessages;
    return { summary: "continued", toolCalls: 0, rounds: 0, messages: [...options.previousMessages, { role: "user", content: "continue" }, { role: "assistant", content: "continued" }] };
  });
  expect(previousMessages).toEqual(history);
  expect(session.taskId).toBe("trusted-task");
  expect(session.items).toEqual(history.map((message, index) => ({ ...message, kind: "message", id: `${session.id}:history:${index}` })));
});
