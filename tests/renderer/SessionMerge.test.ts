import { afterEach, expect, test, vi } from "vitest";
import { mergeSession } from "../../src/renderer/chat/useChatSessions";
import type { ChatItem, ChatSession } from "../../src/shared/chat";

afterEach(() => vi.restoreAllMocks());
const session = (items: ChatItem[], revision = 1): ChatSession => ({ id: "s", title: "S", createdAt: "1", updatedAt: "1", archived: false, draft: "", draftRevision: 0, revision, seq: 0, status: "idle", items });

test("merges long history without serializing message bodies and retains unchanged item identity", () => {
  const history: ChatItem[] = Array.from({ length: 220 }, (_, index) => ({ id: String(index), kind: "message", role: "assistant", content: '长历史 "\\\n正文'.repeat(800) }));
  const old = session(history);
  const next = structuredClone(old); next.revision++;
  next.items.push({ id: "live", kind: "thinking", content: "新内容", partial: true });
  const stringify = vi.spyOn(JSON, "stringify");
  const merged = mergeSession([old], next)[0]!;
  expect(merged.items.slice(0, history.length).every((item, index) => item === history[index])).toBe(true);
  expect(merged.items.at(-1)).toEqual(next.items.at(-1));
  expect(stringify.mock.calls.length).toBe(0);
});

test("preserves equal nested history regardless of object property order", () => {
  const question: ChatItem = { id: "q", kind: "question", status: "answered", question: { id: "q", sessionId: "s", runId: "r", title: "问题", fields: [{ id: "choice", label: "选项", type: "multi", required: true, options: [{ id: "a", label: "A" }] }] }, answer: { choice: ["a"] } };
  const next: ChatItem = { ...structuredClone(question), question: { fields: structuredClone(question.question.fields), title: "问题", runId: "r", sessionId: "s", id: "q" } };
  expect(mergeSession([session([question])], session([next], 2))[0]!.items[0]).toBe(question);
});

test("keeps changed metrics and approvals while rejecting older snapshots", () => {
  const reply: ChatItem = { id: "reply", kind: "message", role: "assistant", content: "完成", metrics: { firstTokenMs: 1, thinkingMs: 2, outputTokens: 3, outputRate: 4, durationMs: 5 } };
  const approval: ChatItem = { id: "approval", kind: "approval", status: "waiting", request: { id: "approval", sessionId: "s", runId: "r", toolName: "Bash", arguments: "{}", reason: "执行命令", risk: "standard" } };
  const old = session([reply, approval]);
  const next = structuredClone(old); next.revision++;
  const message = next.items[0]; if (message?.kind === "message") message.metrics!.outputTokens++;
  const request = next.items[1]; if (request?.kind === "approval") request.status = "approved";
  const merged = mergeSession([old], next);
  expect(merged[0]!.items).toEqual(next.items);
  expect(merged[0]!.items[0]).not.toBe(reply);
  expect(merged[0]!.items[1]).not.toBe(approval);
  expect(mergeSession(merged, old)).toBe(merged);
});

test("retains absent optional fields but applies a changed nested answer", () => {
  const question: ChatItem = { id: "q", kind: "question", status: "answered", question: { id: "q", sessionId: "s", runId: "r", title: "问题", fields: [{ id: "text", label: "回答", type: "text", required: true }] }, answer: { text: "旧答案" } };
  const old = session([question]); const equal = structuredClone(old); equal.revision++;
  const same = equal.items[0]; if (same?.kind === "question") same.question.description = undefined;
  const merged = mergeSession([old], equal);
  expect(merged[0]!.items[0]).toBe(question);
  const changed = structuredClone(equal); changed.revision++;
  const next = changed.items[0]; if (next?.kind === "question") next.answer!.text = "新答案";
  expect(mergeSession(merged, changed)[0]!.items[0]).toEqual(next);
  expect(mergeSession(merged, changed)[0]!.items[0]).not.toBe(question);
});
