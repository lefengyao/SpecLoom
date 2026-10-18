# SpecLoom Model Diagnostics Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist privacy-safe model request traces, correlate final session errors to a diagnostic ID, and provide an in-app viewer, export, retention, and cleanup.

**Architecture:** A main-process `DiagnosticsLogStore` writes versioned JSONL under Electron `userData/logs`, rotates files, and enforces 30-day/25-MiB limits. `AgentRuntime` creates one trace per logical model call; `agent-client`, protocol parsing, and runtime retry boundaries append allowlisted events under that ID. A validated desktop API exposes summary/query/export/cleanup to a settings view; renderer never receives a filesystem path.

**Tech Stack:** TypeScript, Node `fs/promises`, Zod, Electron IPC/contextBridge, React, Vitest, existing `ProjectError` and `SessionRuns` infrastructure.

---

## Scope and file map

This plan implements only the approved model-diagnostics-log spec. Built-in and Godot plugin management remain a separate spec and implementation cycle.

- `src/shared/diagnostics.ts` — allowlisted event/query/result schemas shared by main and renderer.
- `src/main/core/diagnostics-log.ts` — bounded JSONL store, ordered append, list, summary, expiry cleanup, export, clear, flush.
- `src/main/core/agent-runtime.ts`, `agent-client.ts`, `protocols.ts`, `protocol-stream.ts` — request lifecycle and retry tracing; no content deltas enter the logger.
- `src/main/desktop-controller.ts`, `desktop-sessions.ts`, `core/project-core.ts`, `core/agent-chat.ts` — share the diagnostics service with all desktop agent entry points.
- `src/shared/chat.ts`, `src/main/core/session-runs.ts`, `src/renderer/chat/AgentSidebar.tsx`, `src/renderer/chat/ChatWorkbench.tsx` — persist and display/copy the optional final `diagnosticId`.
- `src/shared/desktop-api.ts`, `src/main/ipc.ts`, `src/main/preload.ts`, `src/main/main.ts` — validated list/summary/cleanup/export bridge; the main process owns the save dialog and destination path.
- `src/renderer/DiagnosticsView.tsx`, `src/renderer/SettingsViews.tsx`, `src/renderer/styles.css` — diagnostics UI inside Settings.
- Tests: `tests/core/diagnostics-log.test.ts`, `tests/core/streaming.test.ts`, `tests/core/agent-stream-recovery.test.ts`, `tests/renderer/DiagnosticsView.test.tsx`, `tests/renderer/Settings.test.tsx`, and focused IPC/controller tests under `tests/`.

Do not stage or commit unrelated files. The checkout already contains unrelated dirty and untracked work.

## Task 1: Define the diagnostics contract

**Files:** Create `src/shared/diagnostics.ts`; create `tests/core/diagnostics-schema.test.ts`.

- [x] **Step 1: Write schema rejection tests.** Cover the allowed lifecycle events, bounded IDs, positive attempt numbers, status/counter fields, and strict rejection of arbitrary message/body/headers fields.

```ts
import { describe, expect, it } from "vitest";
import { DiagnosticEventInputSchema } from "../../src/shared/diagnostics";

describe("diagnostic event schema", () => {
  it("accepts an allowlisted stream error", () => {
    expect(DiagnosticEventInputSchema.parse({
      type: "stream_read_error", diagnosticId: "9c1c7c73-ec83-41bb-8e1f-6d4770039f56",
      attempt: 1, protocol: "openai", errorCategory: "response_stream_error", causeCode: "UND_ERR_SOCKET",
      receivedBytes: 96, receivedFrames: 2, completionReceived: false,
    }).type).toBe("stream_read_error");
  });

  it("rejects raw messages, payloads, and unknown fields", () => {
    expect(DiagnosticEventInputSchema.safeParse({
      type: "stream_read_error", message: "secret", prompt: "private", headers: { authorization: "secret" },
    }).success).toBe(false);
  });
});
```

- [x] **Step 2: Run the focused test and verify it fails because the schema is absent.**

Run: `npx vitest run tests/core/diagnostics-schema.test.ts`  
Expected: FAIL at module resolution.

- [x] **Step 3: Add strict shared schemas.** Define `DiagnosticEventTypeSchema` for `request_started`, `connection_error`, `response_headers`, `first_stream_data`, `stream_read_error`, `protocol_parse_error`, `retry_scheduled`, `request_completed`, and `request_failed`; define severity, protocol, bounded optional correlation/context/counter/error fields; define `DiagnosticEventInputSchema`, persisted `DiagnosticEventSchema` with `eventId` and `at`, `DiagnosticQuerySchema`, `DiagnosticSummarySchema`, and inferred exported types. Use `.strict()` and never add raw message/body/header fields.

- [x] **Step 4: Run the schema tests.**

Run: `npx vitest run tests/core/diagnostics-schema.test.ts`  
Expected: PASS; malformed and content-bearing records are rejected.

## Task 2: Implement bounded JSONL storage

**Files:** Create `src/main/core/diagnostics-log.ts`; create `tests/core/diagnostics-log.test.ts`.

- [x] **Step 1: Write store behavior tests.** Use a temporary directory and injected clock/limits to cover append/list by diagnostic ID, ordered concurrent appends, corrupt-line tolerance, per-file rolling, expiry cleanup, total-size eviction, clear-all, export contents, and write/export failures.

```ts
it("keeps correlated events ordered and excludes unknown data", async () => {
  const store = new DiagnosticsLogStore(root, { now: () => new Date("2026-10-10T10:00:00.000Z") });
  await Promise.all([
    store.record({ type: "request_started", diagnosticId, attempt: 1, protocol: "openai", providerId: "p1", modelId: "m1" }),
    store.record({ type: "stream_read_error", diagnosticId, attempt: 1, protocol: "openai", errorCategory: "response_stream_error", causeCode: "UND_ERR_SOCKET" }),
  ]);
  const result = await store.list({ diagnosticId });
  expect(result.events.map(event => event.type)).toEqual(["request_started", "stream_read_error"]);
  expect(JSON.stringify(result)).not.toContain("prompt");
});
```

- [x] **Step 2: Verify focused storage tests fail.**

Run: `npx vitest run tests/core/diagnostics-log.test.ts`  
Expected: FAIL because the store is absent.

- [x] **Step 3: Implement the minimal store API.** Export `DiagnosticsLogStore` with `record(input)`, `list(query)`, `summary()`, `clearExpired()`, `clearAll()`, `exportTo(destination)`, and `flush()`. Store only `DiagnosticEventSchema` records in `userData/logs`; serialize appends on one promise tail; assign UTC timestamps and UUID event IDs in the store. Use 5-MiB files, 25-MiB total, 30-day retention, and delete oldest files first. Inject `now` and byte/age limits only as constructor options for deterministic tests. Validate every input before writing. Skip malformed JSONL rows while returning a read-issue count. Catch logging write failures at integration boundaries so they never replace a model error.

- [x] **Step 4: Verify retention, ordering, and export tests.**

Run: `npx vitest run tests/core/diagnostics-schema.test.ts tests/core/diagnostics-log.test.ts`  
Expected: PASS, including deterministic rotation and cleanup with test-sized limits.

## Task 3: Trace HTTP and stream lifecycle

**Files:** Modify `src/main/core/agent-runtime.ts`, `src/main/core/agent-client.ts`, `src/main/core/protocols.ts`, `src/main/core/protocol-stream.ts`; modify `tests/core/streaming.test.ts` and `tests/core/agent-stream-recovery.test.ts`.

- [x] **Step 1: Add failing trace tests.** Inject a fake `DiagnosticsLogStore`/trace callback into the existing mocked stream tests. Assert a rejected `reader.read()` produces correlated start, response-header, first-data (when chunks preceded failure), read-error, retry, and terminal-failure events, with attempt numbers and safe `UND_ERR_SOCKET`; assert the event records contain no streamed text.

```ts
expect(trace.events.map(event => event.type)).toContain("stream_read_error");
expect(trace.events.find(event => event.type === "stream_read_error")).toMatchObject({
  diagnosticId: trace.id, attempt: 1, causeCode: "UND_ERR_SOCKET", completionReceived: false,
});
expect(JSON.stringify(trace.events)).not.toContain("partial assistant text");
```

- [x] **Step 2: Run the focused tests and verify they fail on missing trace events.**

Run: `npx vitest run tests/core/streaming.test.ts tests/core/agent-stream-recovery.test.ts`  
Expected: the existing functional tests pass, and new diagnostic assertions fail.

- [x] **Step 3: Introduce a per-logical-call trace in `AgentRuntime`.** Create one UUID context for each model round, preserve it across the outer stream-retry loop, and increment a single underlying-attempt counter across `requestCompletion` transport retries and AgentRuntime stream retries. Pass only correlation IDs, provider/model IDs, protocol, round/attempt counters, and a typed `record` callback; do not pass message arrays or deltas.

- [x] **Step 4: Record request and response boundaries in `agent-client.ts` and `protocols.ts`.** Record request start immediately before fetch; record connection errors without arbitrary error messages; on response record only numeric HTTP status and a media-type allowlist; keep timeout, HTTP failure, cancellation, and transport failure distinct. Record retry scheduling before an internal transient retry.

- [x] **Step 5: Record stream boundaries in `protocol-stream.ts`.** Pass the trace into `readProtocolBody`; record first successful body data once, record reader failure with existing allowlisted `transportCause` output plus byte/frame/completion counters, and record protocol parse failures by reason category only. Do not pass chunk content to `record`.

- [x] **Step 6: Attach the trace ID to the terminal `ProjectError`.** On final failure, retain the existing safe `reason` and add `diagnosticId` to `ProjectError.details`; never attach it to user prompts or feed it back to the model. Emit `request_completed` only after the complete response has passed schema validation; emit `request_failed` once when retries/corrections end.

- [x] **Step 7: Verify trace behavior and privacy.**

Run: `npx vitest run tests/core/streaming.test.ts tests/core/agent-stream-recovery.test.ts`  
Expected: PASS for transport retries, parse correction, cancellation distinction, and no response-content leakage.

## Task 4: Share the logger across desktop model entry points

**Files:** Modify `src/main/desktop-controller.ts`, `src/main/desktop-sessions.ts`, `src/main/core/project-core.ts`, `src/main/core/agent-chat.ts`, and `src/main/main.ts`; create `tests/integration/desktop-diagnostics.test.ts` with a temporary user-data directory and mocked model transport.

- [x] **Step 1: Add a failing dependency-injection test.** Construct a desktop controller with a temporary user-data directory, run a mocked agent request through `DesktopSessions` and the legacy `ProjectCore` runtime path, and assert both use the same store instance and create records under that directory.

- [x] **Step 2: Add one shared `DiagnosticsLogStore` to desktop ownership.** Construct it from `app.getPath("userData")`, store it on `DesktopController`, and pass its typed trace factory through `DesktopSessions` and `ProjectCore` to every `AgentRuntime`, including delegated child agents and one-shot chat.

- [x] **Step 3: Apply expiry cleanup during startup and flush during shutdown.** Start cleanup without blocking model configuration, retain cleanup errors for the diagnostics UI status, and include `diagnostics.flush()` in the awaited shutdown path after session runs have stopped.

- [x] **Step 4: Verify service sharing and shutdown.**

Run: `npx vitest run tests/integration/desktop-diagnostics.test.ts`  
Expected: PASS; all desktop entry points write to one `userData/logs` store and pending writes are flushed on normal shutdown.

## Task 5: Preserve and surface diagnostic IDs in sessions

**Files:** Modify `src/shared/chat.ts`, `src/main/core/session-runs.ts`, `src/renderer/chat/AgentSidebar.tsx`, `src/renderer/chat/ChatWorkbench.tsx`, and focused chat tests.

- [x] **Step 1: Add failing session tests.** Verify old serialized sessions without `diagnosticId` remain valid, final traced failure persists its ID, and successful/new runs clear the previous error ID.
- [x] **Step 2: Add optional `diagnosticId` to `ChatSessionSchema` and the session record type.** Keep it adjacent to `error`; do not replace the stable user-facing error message.
- [x] **Step 3: In `SessionRuns` catch handling, copy only a validated UUID from `ProjectError.details.diagnosticId`.** Leave the field absent for untraced failures and cancellation; clear it when a new run starts or succeeds.
- [x] **Step 4: Render the diagnostic ID with a copy button beside the run error in `ChatWorkbench` and session details in `AgentSidebar`.** Use the existing clipboard/copy UI helpers and preserve rendering of older sessions with only `error`.
- [x] **Step 5: Run focused chat tests.**

Run: `npx vitest run tests/integration/chat-sessions.test.ts tests/renderer/ChatWorkbench.test.tsx`  
Expected: PASS; old session fixtures remain compatible and a final failure exposes a copyable ID.

## Task 6: Add a validated desktop diagnostics API

**Files:** Modify `src/shared/desktop-api.ts`, `src/main/desktop-controller.ts`, `src/main/ipc.ts`, `src/main/preload.ts`, `src/main/main.ts`; add `tests/integration/diagnostics-ipc.test.ts`.

- [x] **Step 1: Write failing IPC boundary tests.** Check valid list filters, reject oversized query text/invalid UUIDs, confirm renderer cannot pass a destination path, and confirm untrusted senders cannot invoke the operation.
- [x] **Step 2: Define `DiagnosticsApi` in `desktop-api.ts`.** Expose `list(query)`, `summary()`, `clearExpired()`, `clearAll()`, and `export()`; `export()` accepts no path and returns whether the user saved a file.
- [x] **Step 3: Add controller methods delegating to the shared store.** The controller validates/normalizes query results and does not return the internal log directory.
- [x] **Step 4: Add strict IPC schemas and dispatch cases.** Add read-only operations to list/summary; treat clear/export as mutations under the existing trusted-sender gate. Have the main process open `dialog.showSaveDialog` with a `.jsonl` filter, then pass the selected path directly to `DiagnosticsLogStore.exportTo`; a cancelled dialog returns `false`.
- [x] **Step 5: Add frozen preload methods using the existing `invoke` helper.** Do not expose `fs`, `path`, arbitrary file reads, or a renderer-provided export path.
- [x] **Step 6: Run boundary tests.**

Run: `npx vitest run tests/integration/diagnostics-ipc.test.ts`  
Expected: PASS; only the trusted main frame can list or clear, and export path selection is main-process-owned.

## Task 7: Build the diagnostics settings view

**Files:** Create `src/renderer/DiagnosticsView.tsx`; modify `src/renderer/SettingsViews.tsx`, `src/renderer/styles.css`, `tests/renderer/DiagnosticsView.test.tsx`, and `tests/renderer/Settings.test.tsx`.

- [x] **Step 1: Write failing view tests.** Cover empty state, summary limits, event list and details, filtering by diagnostic ID, export, prune-old, clear-all confirmation, and IPC errors. Mock `window.specloom.diagnostics`; assert no log content appears beyond the safe fields returned by the main process.
- [x] **Step 2: Add a diagnostics section to `SettingsView`.** Keep the existing appearance/tools/agent sections intact; render the new view only when the desktop API exposes diagnostics.
- [x] **Step 3: Implement `DiagnosticsView`.** Load `summary()` and `list()`, filter locally by validated query/diagnostic ID, refresh after mutations, show phase/severity/status/attempt counters, expand allowlisted fields, provide export/prune/clear controls, and display log count/bytes/retention. Require explicit confirmation before `clearAll()`.
- [x] **Step 4: Add only the layout styles needed for the event table/cards and safe narrow-window wrapping.** Use existing settings tokens and button styles.
- [x] **Step 5: Verify focused view tests.**

Run: `npx vitest run tests/renderer/DiagnosticsView.test.tsx tests/renderer/Settings.test.tsx`  
Expected: PASS; filters, safe details, export, retention, and destructive-action confirmation work.

## Task 8: Full regression, packaged-path check, and build

**Files:** Update tests only where regression evidence requires it; no unrelated formatting or refactoring.

- [x] **Step 1: Run all core and integration tests.**

Run: `npm test -- --reporter=dot`  
Observed: the full suite completed but remains non-green in this checkout: 101 files passed, 4 files had 8 failed tests, 5 tests were skipped, and one cancellation-related unhandled rejection was reported. The pre-implementation baseline was also non-green (97 files passed, 3 failed). The two `App.test.tsx` failures are the existing ambiguous `getByRole("tree")` selectors where both the entity tree and material group tree match. Approval suites pass in isolation (14/14 and 4/4, repeated twice); the race suite also passes in isolation (6/6).

- [x] **Step 2: Run type checks and lint.**

Run: `npm run typecheck` and `npm run lint`  
Expected: both PASS for main, renderer, tools, and ESLint.

- [x] **Step 3: Verify user-data wiring.** The desktop-controller integration test constructs the production controller with a temporary user-data directory, appends and reads a sample event, clears it, and confirms the log store returns to zero files/events. `main.ts` supplies Electron's `app.getPath("userData")` to that same constructor.

- [x] **Step 4: Build the latest distribution.**

Run: `npm run build -- --config.directories.output=release/0.1.5` and `npm run module:build`  
Observed: both completed; Windows x64 installer/portable packages are in `release/0.1.5`, and the multi-instance module is in the Hub 0.1.6 module release and exports directories. Existing 0.1.4 artifacts were preserved.

## Plan self-review

- **Spec coverage:** storage/privacy/rotation/cleanup/export are covered by Tasks 1–2 and 6–7; request lifecycle and retry correlation by Task 3; all runtime entry points and lifecycle flush by Task 4; session correlation by Task 5; privacy/boundary tests by Tasks 1, 3, and 6; package verification by Task 8.
- **Placeholders:** no `TODO`, `TBD`, or open implementation decisions remain; APIs, files, limits, and validation commands are named.
- **Type consistency:** `DiagnosticEventInputSchema` and persisted `DiagnosticEventSchema` are shared; `DiagnosticsLogStore` owns storage operations; `diagnosticId` is a UUID in trace events and an optional top-level `ChatSession` field; renderer `export()` has no path parameter.

## Execution record

- `npm run typecheck` and `npm run lint`: PASS after the final Hub export wiring change.
- Focused diagnostics, IPC, renderer, session, and Hub-runtime suites: PASS; the final packaging check covered 5 files / 17 tests.
- Windows x64 outputs (app version 0.1.5): setup `118,764,811` bytes, SHA-256 `e6649eb19a1f1d90938ceea4506f913013af793c579cd7f2ade7dc5fe84a24be`; portable ZIP `167,710,518` bytes, SHA-256 `b08670e3024fdb5054412d2f690a14d5c21a9ce2262321c2de1381602c66f8d0`.
- Trailblazer Hub 0.1.6 module: `19,233,340` bytes, SHA-256 `98913b277f52db8c5b5567da0eb5e7f1f17b50ec8b2a30aa58956c73040b759c`; its manifest retains `multiInstance: true` and `minimumHostVersion: 0.1.6`.
