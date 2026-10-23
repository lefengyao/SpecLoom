import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { SessionRuns } from "../../src/main/core/session-runs";
import { SessionStore } from "../../src/main/core/session-store";

test("emits one usage record for a request with provider usage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-usage-callback-"));
  try {
    const store = await SessionStore.open(root);
    const session = await store.create("usage");
    const seen: unknown[] = [];
    const runs = new SessionRuns(store, root, { onUsageRecord: (record) => { seen.push(record); throw new Error("log failure"); } });
    const execute = runs.executor(async (options) => {
      await options.onUsage?.({ promptTokens: 11, completionTokens: 7, cachedTokens: 3, cacheWriteTokens: 0 });
      return { summary: "done", toolCalls: 0, rounds: 0, messages: [{ role: "assistant", content: "done" }] };
    });
    await runs.send(session.id, "hello", execute);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ promptTokens: 11, completionTokens: 7, cachedTokens: 3, status: "completed", workspaceId: root });
    expect(store.get(session.id).usage).toMatchObject({ promptTokens: 11, completionTokens: 7 });
  } finally { await rm(root, { recursive: true, force: true }); }
});
