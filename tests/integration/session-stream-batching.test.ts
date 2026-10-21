import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { SessionRuns } from "../../src/main/core/session-runs";
import { SessionStore } from "../../src/main/core/session-store";

test("coalesces streaming text into bounded session writes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-stream-batch-"));
  try {
    const store = await SessionStore.open(root);
    const session = await store.create("batch");
    const runs = new SessionRuns(store, root);
    const update = vi.spyOn(store, "update");
    const finalText = "x".repeat(200);
    await runs.send(session.id, "hello", runs.executor(async (options) => {
      for (let index = 0; index < 200; index++) {
        await options.onEvent?.({ type: "text", round: 0, messageId: "answer", content: "x".repeat(index + 1) });
      }
      return { summary: finalText, toolCalls: 0, rounds: 0, messages: [{ role: "assistant", content: finalText }], usage: { promptTokens: 1, completionTokens: 200, cachedTokens: 0, cacheWriteTokens: 0 } };
    }));
    expect(update.mock.calls.length).toBeLessThan(20);
    const reply = store.get(session.id).items.find((item) => item.kind === "message" && item.role === "assistant");
    expect(reply?.kind === "message" ? reply.content : undefined).toBe(finalText);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
