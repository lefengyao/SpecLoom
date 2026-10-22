import { expect, test } from "vitest";
import type { ChatSession } from "../../src/shared/chat";
import { mergeDeltaSession } from "../../src/renderer/chat/useChatSessions";

const base: ChatSession = {
  id: "session-1", title: "chat", createdAt: "2026-10-21T00:00:00.000Z", updatedAt: "2026-10-21T00:00:00.000Z",
  archived: false, draft: "", draftRevision: 0, revision: 4, seq: 7, approvalMode: "auto", webSearchMode: "off",
  status: "running", runId: "run-1", items: [],
};

test("merges a text delta into the active assistant item", () => {
  const next = mergeDeltaSession([base], {
    projectPath: "/project", sessionId: "session-1", runId: "run-1", seq: 8,
    stream: { type: "text", messageId: "answer", content: "hello", partial: true },
  });
  expect(next[0]?.items).toContainEqual({ id: "run-1:answer", kind: "message", role: "assistant", content: "hello", partial: true });
  expect(next[0]?.seq).toBe(8);
});

test("replaces an existing item and ignores stale or foreign-run deltas", () => {
  const withAnswer: ChatSession = { ...base, items: [{ id: "run-1:answer", kind: "message", role: "assistant", content: "hel", partial: true }] };
  const next = mergeDeltaSession([withAnswer], {
    projectPath: "/project", sessionId: "session-1", runId: "run-1", seq: 9,
    stream: { type: "text", messageId: "answer", content: "hello", partial: true },
  });
  expect(next[0]?.items).toEqual([{ id: "run-1:answer", kind: "message", role: "assistant", content: "hello", partial: true }]);

  expect(mergeDeltaSession([base], {
    projectPath: "/project", sessionId: "session-1", runId: "run-1", seq: 6,
    stream: { type: "text", messageId: "stale", content: "old", partial: true },
  })).toEqual([base]);
  expect(mergeDeltaSession([base], {
    projectPath: "/project", sessionId: "session-1", runId: "other-run", seq: 8,
    stream: { type: "text", messageId: "answer", content: "wrong", partial: true },
  })).toEqual([base]);
});
