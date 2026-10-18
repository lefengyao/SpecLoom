import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { SessionRuns, type SessionRunOptions } from "../../src/main/core/session-runs";
import { SessionStore } from "../../src/main/core/session-store";
import { type AgentMessage } from "../../src/main/core/agent-runtime";

test.each(["guidance admission", "checkpoint merge", "concurrent guidance"] as const)("rejects %s overflow without silently removing earlier context", async boundary => {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-context-retention-"));
  const store = await SessionStore.open(root);
  const session = await store.create("retention");
  const history: AgentMessage[] = [
    { role: "user", content: "original goal must survive" },
    ...Array.from({ length: 32 }, () => ({ role: "user" as const, content: "h".repeat(129000) })),
  ];
  await store.update(session.id, record => { record.conversation = history; });
  let options!: SessionRunOptions;
  let start!: () => void;
  let finish!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const runs = new SessionRuns(store, root);
  const sending = runs.send(session.id, "continue current goal", async input => {
    options = input;
    start();
    await finished;
    input.signal.throwIfAborted();
    return { summary: "done", toolCalls: 0, rounds: 0, messages: history };
  });
  void sending.catch(() => undefined);
  try {
    await started;
    const runId = store.get(session.id).runId!;
    if (boundary === "guidance admission") {
      await expect(runs.guide(session.id, runId, "overflow", "g".repeat(100000)).then(() => undefined)).rejects.toMatchObject({ code: "MODEL_ERROR" });
      expect(store.get(session.id).items.some(item => item.id.endsWith(":guidance:overflow"))).toBe(false);
    } else if (boundary === "checkpoint merge") {
      await runs.guide(session.id, runId, "accepted", "g".repeat(32000));
      await expect(options.onConversation?.([...history, { role: "assistant", content: "r".repeat(40000) }], undefined, 900000)).rejects.toMatchObject({ code: "MODEL_ERROR" });
      expect(store.get(session.id).conversation.at(-1)?.content).toBe("g".repeat(32000));
    } else {
      const admissions = await Promise.allSettled([
        runs.guide(session.id, runId, "first", "a".repeat(40000)),
        runs.guide(session.id, runId, "second", "b".repeat(40000)),
      ]);
      expect(admissions.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
      expect(store.get(session.id).items.filter(item => item.kind === "message" && item.guidance)).toHaveLength(1);
      expect(await options.takeGuidance(false)).toHaveLength(1);
      await runs.guide(session.id, runId, "second", "retry within the remaining capacity");
      expect(await options.takeGuidance(false)).toEqual([{ role: "user", content: "retry within the remaining capacity" }]);
    }
    expect(store.get(session.id).conversation[0]?.content).toBe("original goal must survive");
    const reopened = await SessionStore.open(root);
    expect(reopened.get(session.id).conversation[0]?.content).toBe("original goal must survive");
  } finally {
    runs.cancel(session.id);
    finish();
    await Promise.allSettled([sending]);
    await rm(root, { recursive: true, force: true });
  }
});
