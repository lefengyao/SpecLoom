# Streaming Output Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove per-token full-session disk writes from the streaming hot path, while keeping durable checkpoints and existing session/UI behavior.

**Architecture:** `SessionRuns` will keep streamed text and thinking in an in-memory `SessionStore` record, publish snapshots in small batches, and checkpoint only at tool/approval/completion boundaries or every 128 streamed events. `SessionStore` gains `mutate()` for memory-only changes and `checkpoint()` for validated durable writes. No wire-format or renderer changes are required in this phase.

**Tech Stack:** Electron main process, TypeScript, Node.js, Vitest, existing `SessionStore` / `SessionRuns` / `AgentRuntime`.

---

## Scope

This plan targets the immediate 7 → 150+ token/s problem.

In scope:

- Avoid rewriting the full session JSON for every streamed token.
- Keep partial replies visible in the renderer during a run.
- Keep checkpoint durability at tool boundaries, approvals, cancellation, completion, and failures.
- Preserve existing event order, metric calculation, guidance, approval, and cancellation behavior.

Out of scope for this plan:

- Changing the renderer wire protocol from full `ChatSession` snapshots to incremental delta events.
- Adding a renderer `requestAnimationFrame` batcher.
- Changing the provider SSE parser.

Those are Phase 2 items if the measured result is still below target after this plan.

## Implementation notes (2026-10-21)

This plan was executed with two safety refinements:

- `SessionStore` keeps the last successfully written snapshot per session. When a checkpoint fails (for example, an oversized stream event), it restores that snapshot so the terminal error can be written instead of leaving the session stuck in `running`.
- A 64ms flush timer publishes short streams before the 16-event batch is full. Without it, a short response would not appear until the run ended, and guidance during streaming could race completion.

The measured long-response sample reached 147–155 token/s on the same DeepSeek configuration. Shorter responses report a lower rate because the metric window includes first-token and thinking time.

## Phase 2 delta stream (2026-10-22)

- Added `SessionDeltaEvent` with an optional `subscribeDelta` API.
- `DesktopSessions` creates its runs with `snapshotStreaming: false`; live text/thinking goes through delta events, while start, checkpoint, tool, approval, completion, and error boundaries still publish full `ChatSession` snapshots.
- The renderer merges deltas into the active session and leaves full snapshots as the durable correction path.
- The 64ms main-process flush already limits delta delivery to roughly 15 updates per second; no separate renderer animation-frame queue is needed at this event rate.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/main/core/session-store.ts` | Add in-memory mutation and explicit checkpoint APIs. |
| `src/main/core/session-runs.ts` | Stream text/thinking into memory, publish batches, checkpoint periodically and at boundaries. |
| `tests/integration/session-store-memory.test.ts` | New tests for memory-only mutation and durable checkpoint. |
| `tests/integration/session-stream-batching.test.ts` | Update batching expectations and checkpoint-count regression coverage. |
| `tests/integration/session-response-metrics.test.ts` | Confirm timing metrics still work with the new persistence path. |
| `tests/integration/session-capacity.test.ts` | Confirm oversized/terminal session behavior still works. |

---

### Task 1: Add memory-only mutation to SessionStore

**Files:**
- Modify: `src/main/core/session-store.ts:86-100`
- Test: `tests/integration/session-store-memory.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/session-store-memory.test.ts` with:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { SessionStore } from "../../src/main/core/session-store";

test("mutate changes memory without writing until checkpoint", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-session-memory-"));
  try {
    const store = await SessionStore.open(root);
    const session = await store.create("memory");

    const updated = await store.mutate(session.id, (record) => {
      record.status = "running";
      record.items.push({
        id: `${session.id}:reply`,
        kind: "message",
        role: "assistant",
        content: "partial",
        partial: true,
      });
      record.seq++;
    });

    expect(updated.status).toBe("running");
    expect(updated.items.find((item) => item.id === `${session.id}:reply`)).toMatchObject({
      kind: "message",
      role: "assistant",
      content: "partial",
      partial: true,
    });

    const beforeCheckpoint = await SessionStore.open(root);
    expect(beforeCheckpoint.get(session.id).items.some((item) => item.id === `${session.id}:reply`)).toBe(false);

    await store.checkpoint(session.id);

    const afterCheckpoint = await SessionStore.open(root);
    expect(afterCheckpoint.get(session.id).items.find((item) => item.id === `${session.id}:reply`)).toMatchObject({
      kind: "message",
      role: "assistant",
      content: "partial",
      partial: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkpoint validates the in-memory record before persisting", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-session-memory-validation-"));
  try {
    const store = await SessionStore.open(root);
    const session = await store.create("memory");

    await store.mutate(session.id, (record) => {
      record.items.push({ id: "broken", kind: "message", role: "assistant", content: "ok" } as never);
    });

    await expect(store.checkpoint(session.id)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npx vitest run tests/integration/session-store-memory.test.ts
```

Expected: FAIL because `store.mutate` and `store.checkpoint` do not exist.

- [ ] **Step 3: Implement the SessionStore APIs**

In `src/main/core/session-store.ts`, immediately before the existing `update` method, add:

```ts
  /**
   * Apply a streaming update to the in-memory record without touching disk.
   * The SessionRuns checkpoint loop is responsible for the durable write.
   */
  async mutate(id: string, action: (record: SessionRecord) => void): Promise<SessionRecord> {
    return this.queue(async () => {
      const record = this.records.get(id);
      if (!record) throw new ProjectError("VALIDATION_FAILED", "会话不存在");
      action(record);
      record.updatedAt = new Date().toISOString();
      return structuredClone(record);
    });
  }

  /** Validate and persist the current in-memory record. */
  async checkpoint(id: string): Promise<SessionRecord> {
    return this.queue(async () => {
      const record = this.records.get(id);
      if (!record) throw new ProjectError("VALIDATION_FAILED", "会话不存在");
      return this.write(record);
    });
  }
```

Do not change `update()` or `write()`.

- [ ] **Step 4: Run the test again**

Run:

```bash
npx vitest run tests/integration/session-store-memory.test.ts
```

Expected: PASS. The first test proves memory changes are invisible to a reopened store until checkpoint; the second proves checkpoint still validates.

- [ ] **Step 5: Commit**

```bash
git add src/main/core/session-store.ts tests/integration/session-store-memory.test.ts
git commit -m "feat(session): add memory mutation and explicit checkpoints"
```

---

### Task 2: Add checkpointed streaming state to SessionRuns

**Files:**
- Modify: `src/main/core/session-runs.ts:87-135`
- Test: `tests/integration/session-stream-batching.test.ts`

- [ ] **Step 1: Write the failing batching regression test**

Replace the body of `tests/integration/session-stream-batching.test.ts` with:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { SessionRuns } from "../../src/main/core/session-runs";
import { SessionStore } from "../../src/main/core/session-store";

test("streams through memory and checkpoints instead of writing every token", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-stream-batch-"));
  try {
    const store = await SessionStore.open(root);
    const session = await store.create("batch");
    const runs = new SessionRuns(store, root);
    const update = vi.spyOn(store, "update");
    const checkpoint = vi.spyOn(store, "checkpoint");
    const finalText = "x".repeat(200);

    await runs.send(session.id, "hello", runs.executor(async (options) => {
      for (let index = 0; index < 200; index++) {
        await options.onEvent?.({ type: "text", round: 0, messageId: "answer", content: "x".repeat(index + 1) });
      }
      return {
        summary: finalText,
        toolCalls: 0,
        rounds: 0,
        messages: [{ role: "assistant", content: finalText }],
        usage: { promptTokens: 1, completionTokens: 200, cachedTokens: 0, cacheWriteTokens: 0 },
      };
    }));

    expect(update.mock.calls.length).toBeLessThan(10);
    expect(checkpoint.mock.calls.length).toBeLessThan(6);

    const reply = store.get(session.id).items.find((item) => item.kind === "message" && item.role === "assistant");
    expect(reply?.kind === "message" ? reply.content : undefined).toBe(finalText);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npx vitest run tests/integration/session-stream-batching.test.ts
```

Expected: FAIL because the current implementation calls `store.update()` for every stream batch.

- [ ] **Step 3: Replace the stream writer with memory mutation and checkpoints**

In `src/main/core/session-runs.ts`, replace the block from the `streamBatchSize` declaration through the end of `flushStreams` with:

```ts
    // The stream hot path must not serialize and rename the whole session file.
    // Apply text/thinking in small memory batches; checkpoint at boundaries and
    // every 128 applied stream events.
    const streamBatchSize = 16;
    const checkpointEvery = 128;
    const pendingStreams = new Map<string, AgentEvent>();
    let pendingStreamCount = 0;
    let appliedSinceCheckpoint = 0;
    let streamChain: Promise<void> = Promise.resolve();
    let streamWriteError: unknown;

    const applyEvents = async (events: AgentEvent[]): Promise<void> => {
      const updated = await this.store.mutate(sessionId, (record) => {
        if (this.live.get(sessionId) !== run || run.controller.signal.aborted) return;
        for (const event of events) { record.seq++; this.apply(record, run.id, event); }
      });
      if (!run.controller.signal.aborted) this.publish(SessionStore.view(updated));
    };

    const checkpoint = async (): Promise<void> => {
      try {
        const updated = await this.store.checkpoint(sessionId);
        appliedSinceCheckpoint = 0;
        if (!run.controller.signal.aborted) this.publish(SessionStore.view(updated));
      } catch (error) {
        streamWriteError ??= error;
        throw error;
      }
    };

    const maybeCheckpoint = async (): Promise<void> => {
      if (appliedSinceCheckpoint >= checkpointEvery) await checkpoint();
    };

    const flushStreams = (): Promise<void> => {
      streamChain = streamChain.then(async () => {
        if (!pendingStreams.size) return;
        const events = [...pendingStreams.values()];
        pendingStreams.clear();
        pendingStreamCount = 0;
        appliedSinceCheckpoint += events.length;
        await applyEvents(events);
      }).catch((error) => {
        streamWriteError ??= error;
        throw error;
      });
      return streamChain;
    };
```

- [ ] **Step 4: Wire checkpointing into stream and boundary events**

In the same file, change the `onEvent` handler to:

```ts
        onEvent: async (event) => {
          if (this.live.get(sessionId) !== run || run.controller.signal.aborted) return;
          if (streamWriteError) throw streamWriteError;
          this.observe(run, event, Date.now());
          await fileTracker.observe(event).catch(() => undefined);
          if (event.type === "text" || event.type === "thinking") {
            pendingStreams.set(`${event.type}:${event.messageId}`, event);
            pendingStreamCount++;
            if (pendingStreamCount >= streamBatchSize) {
              await flushStreams();
              await maybeCheckpoint();
            }
            return;
          }
          await flushStreams();
          await applyEvents([event]);
          await checkpoint();
        },
```

Then update the two checkpoint boundaries:

```ts
        onConversation: async (messages, contextSummary, contextTokensEstimate, contextCalibration) => {
          if (this.live.get(sessionId) !== run || run.controller.signal.aborted) return;
          await flushStreams();
          await checkpoint();
          const updated = await this.store.update(sessionId, (record) => {
```

and:

```ts
        onUsage: async usage => {
          if (this.live.get(sessionId) !== run || run.controller.signal.aborted) return;
          await flushStreams();
          await checkpoint();
          const updated = await this.store.update(sessionId, record => {
```

After `execute(...)` returns, replace:

```ts
      await flushStreams();
      if (streamWriteError) throw streamWriteError;
```

with:

```ts
      await flushStreams();
      await checkpoint();
      if (streamWriteError) throw streamWriteError;
```

In the `catch` block, replace:

```ts
      if (started) {
        const fileChanges = await finishFiles();
```

with:

```ts
      if (started) {
        await flushStreams().catch(() => undefined);
        await checkpoint().catch(() => undefined);
        const fileChanges = await finishFiles();
```

- [ ] **Step 5: Run the batching test**

Run:

```bash
npx vitest run tests/integration/session-stream-batching.test.ts
```

Expected: PASS. The final reply is intact, `store.update()` is no longer called for stream batches, and checkpoints stay below 6 for 200 events.

- [ ] **Step 6: Commit**

```bash
git add src/main/core/session-runs.ts tests/integration/session-stream-batching.test.ts
git commit -m "perf(chat): keep streaming text in memory and checkpoint on boundaries"
```

---

### Task 3: Preserve metrics and terminal-state behavior

**Files:**
- Test: `tests/integration/session-response-metrics.test.ts`
- Test: `tests/integration/session-capacity.test.ts`
- Test: `tests/integration/session-stop-bounded.test.ts`

- [ ] **Step 1: Run the existing timing test**

Run:

```bash
npx vitest run tests/integration/session-response-metrics.test.ts
```

Expected: PASS. Metrics still attach to the final reply and `Date.now()` call count remains four.

- [ ] **Step 2: Run capacity and stop tests**

Run:

```bash
npx vitest run tests/integration/session-capacity.test.ts tests/integration/session-stop-bounded.test.ts
```

Expected: PASS. Oversized stream events still produce terminal errors, cancellation still persists a cancelled state, and late executor output cannot overwrite a newer run.

- [ ] **Step 3: Add a checkpoint durability assertion**

In `tests/integration/session-stream-batching.test.ts`, after the final reply assertion, add:

```ts
    const reopened = await SessionStore.open(root);
    const persisted = reopened.get(session.id).items.find((item) => item.kind === "message" && item.role === "assistant");
    expect(persisted?.kind === "message" ? persisted.content : undefined).toBe(finalText);
```

- [ ] **Step 4: Run the updated test**

Run:

```bash
npx vitest run tests/integration/session-stream-batching.test.ts
```

Expected: PASS. The final reply is durable after the run completes.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/session-stream-batching.test.ts
git commit -m "test(chat): verify checkpointed stream durability"
```

---

### Task 4: Run the complete verification and measure real throughput

**Files:**
- No production files.
- Manual verification only.

- [ ] **Step 1: Run type checking**

Run:

```bash
npm run typecheck
```

Expected: exit code 0.

- [ ] **Step 2: Run the targeted streaming/session suite**

Run:

```bash
npx vitest run tests/integration/session-stream-batching.test.ts tests/integration/session-response-metrics.test.ts tests/integration/session-capacity.test.ts tests/integration/session-stop-bounded.test.ts tests/integration/session-approvals.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Run the full suite**

Run:

```bash
npm test
```

Expected: exit code 0. If a known flaky approval test fails in parallel, rerun that file alone before changing code.

- [ ] **Step 4: Measure the real provider path**

Run the source app:

```bash
npm run dev
```

Open the example project, select `deepseek-flash`, and send:

```text
请用约120字介绍你自己。
```

Check the final response metrics.

Target:

- At least `150 token/s` on the same provider and model.
- No missing final text.
- Stop, tool approval, and retry still behave normally.

If the result is still below `150 token/s`, do not add more batching in this plan. Proceed to the Phase 2 delta-event/RAF plan instead.

- [ ] **Step 5: Commit final documentation or test adjustments**

If no code changes remain, nothing to commit. If you updated comments or tests during verification:

```bash
git add src/main/core/session-runs.ts tests/integration
git commit -m "test(chat): verify streaming checkpoint performance"
```

---

## Verification Checklist

- [ ] `store.mutate()` does not write the session file.
- [ ] `store.checkpoint()` validates and writes the current record.
- [ ] A text stream publishes partial content before completion.
- [ ] A completed reply is present after reopening the store.
- [ ] Tool boundaries force a checkpoint.
- [ ] Cancellation persists a cancelled state.
- [ ] Oversized stream events still fail with the existing terminal error.
- [ ] Response metrics still attach only to the final reply.
- [ ] Targeted tests and `npm run typecheck` pass.
- [ ] Real `deepseek-flash` measurement reaches at least 150 token/s.

## Rollback

If checkpointing introduces a regression:

1. Revert `src/main/core/session-runs.ts` to the previous `store.update()` path.
2. Keep the new `SessionStore.mutate()` / `checkpoint()` methods only if their tests pass.
3. Re-run the targeted suite from Task 4.
