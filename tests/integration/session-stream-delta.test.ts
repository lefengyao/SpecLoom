import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import type { SessionDeltaEvent } from "../../src/shared/chat";
import { SessionRuns } from "../../src/main/core/session-runs";
import { SessionStore } from "../../src/main/core/session-store";

test("publishes live text deltas while keeping full snapshots for boundaries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-stream-delta-"));
  try {
    const store = await SessionStore.open(root);
    const session = await store.create("delta");
    const runs = new SessionRuns(store, root, { snapshotStreaming: false });
    const deltas: SessionDeltaEvent[] = [];
    const snapshots: string[] = [];
    runs.subscribeDelta((event) => deltas.push(event));
    runs.subscribe((event) => snapshots.push(event.session.status));
    await runs.send(session.id, "hello", runs.executor(async (options) => {
      await options.onEvent?.({ type: "text", round: 0, messageId: "answer", content: "hello" });
      return { summary: "hello", toolCalls: 0, rounds: 0, messages: [{ role: "assistant", content: "hello" }] };
    }));
    expect(deltas).toContainEqual(expect.objectContaining({
      sessionId: session.id,
      stream: { type: "text", messageId: "answer", content: "hello", partial: true },
    }));
    expect(snapshots).toContain("completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
