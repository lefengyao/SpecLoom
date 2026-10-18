# Session Context Compression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add durable, model-generated context compression at a default 90% effective context threshold.

**Architecture:** A focused compression helper summarizes complete historical message groups with the active model through the existing protocol client. `AgentRuntime` decides when to compress and carries a bounded summary alongside recent messages; `SessionStore` persists the summary without changing visible chat items.

**Tech Stack:** TypeScript, Zod, existing protocol client, Vitest.

---

### Task 1: Compression helper and tests

**Files:**
- Create: `src/main/core/agent-compression.ts`
- Test: `tests/core/agent-compression.test.ts`

- [x] Define complete-batch grouping, threshold calculation, chunk splitting, model summarization, recursive reduction, and bounded redaction.
- [x] Verify threshold and chunk behavior with deterministic protocol fixtures.

### Task 2: Runtime integration and tests

**Files:**
- Modify: `src/main/core/agent-runtime.ts`
- Test: `tests/core/agent-runtime.test.ts`

- [x] Accept an optional durable summary and compression callback.
- [x] Compress before normal fitting at 90%, preserve current goal and newest complete batches, and reuse the resulting summary on later requests.
- [x] Verify summary reuse, fallback, and secret handling.

### Task 3: Session persistence

**Files:**
- Modify: `src/shared/chat.ts`
- Modify: `src/main/core/session-store.ts`
- Modify: `src/main/core/session-runs.ts`
- Test: `tests/integration/chat-sessions.test.ts`

- [x] Persist bounded summary metadata through load, save, export, and import.
- [x] Pass the summary through run setup and checkpoints without altering visible items.
- [x] Verify reload and import behavior.

### Task 4: Verification

- [x] Run focused compression and runtime tests.
- [x] Run typecheck and the relevant session integration tests.

Verification on 2026-10-15: 9 targeted test files (61 tests) passed, the full main/renderer/tools typecheck passed, and focused ESLint passed. The checks cover compression and recursive chunking, single-turn tool histories, retry budgets across tool rounds, request token estimates, summary persistence, and near-capacity export/import.
