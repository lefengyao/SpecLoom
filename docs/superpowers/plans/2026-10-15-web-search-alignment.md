# Web Search Service Alignment Implementation Plan

**Goal:** Align SpecLoom with the user-provided StoryFabric web-search service reference.

**Architecture:** Reuse StoryFabric's standalone search kit and license notice under `src/main/core/search`. Keep provider routing separate from workspace tool execution, persist each session's search mode, and inherit it in child agents. Default to `off`; enabled modes expose the relevant tools without making discovery requests.

**Tech Stack:** TypeScript, Zod, existing workspace tool catalog, React, Vitest.

The user supplied the service design and requested implementation. Work in the existing source checkout; preserve unrelated changes and do not package or commit them.

## Provider services

- [x] Port the standalone kit with its MIT notice and adapt strict TypeScript optional arguments.
- [x] Preserve query/result limits, timestamps and `publishedAt`, JSON/SSE MCP responses, native protocol adapters, fallback, cancellation and the 30-second tool deadline.
- [x] Use `SPECLOOM_WEB_SEARCH_SELF_HOSTED_URL` with the reference default `http://127.0.0.1:8090`. Send extract mode and character limit to the self-hosted backend.
- [x] Enforce self-hosted response/query alignment and reject malformed sources while accepting empty result sets.

## Session and workspace integration

- [x] Add shared `WebSearchModeSchema` with `off | auto | native | free | self-hosted`, default `off`.
- [x] Persist/export/import `webSearchMode` and expose a composer select locked during a run or archive.
- [x] Add `WorkspaceTools.setWebSearch` and dynamically register `web_search` and `web_extract`; native excludes extraction, off removes both and rejects stale calls.
- [x] Pass the selected model and credential resolver into search execution and inherit the same context in delegates. Reserve session mutations while changing modes.
- [x] Add explicit untrusted-content/citation guidance and use the existing approval policy for network reads.
- [x] Preserve bounded full web results in model context while keeping visible tool records within their existing size limit.

## Verification

- [x] Run mocked service tests for free/self-hosted/native routing, malformed responses, URL guards and cancellation.
- [x] Run workspace/session tests for zero requests while off, mode changes, permissions, credential isolation and child inheritance.
- [x] Run renderer mode tests, related tool/runtime/session regressions, full typecheck, focused ESLint and `git diff --check`.
- [x] Verify the source development runtime loads the latest changes for user testing.

Validation commands: `npm exec vitest -- run tests/core/web-search* tests/core/web-extract* tests/integration/web-search* tests/renderer/WebSearchMode.test.tsx`, `npm run typecheck`, and focused `npm exec eslint -- ...`. Tests use local fixtures and mocked fetch; no paid model calls are required for validation.

## Verification results — 2026-10-15

- Final combined suite: 17 test files, 243 passed and 2 live cases skipped. This covers the web-search services, workspace tools, session integration, renderer selection, agent runtime, output redaction, context estimation/compression, stream recovery and approval/mutation regressions. The separate workspace-tools regression file also passed in the earlier related run.
- Native credential resolution failure was reproduced by a failing regression test before fixing it. Automatic mode now proceeds to anonymous free search; explicit native mode still reports the credential error, and cancellation sends no fallback request.
- Full `npm run typecheck`, focused ESLint, and `git diff --check` pass. Real hosted/self-hosted search and paid native APIs were not exercised.
- Source runtime restarted from `scripts/dev.mjs`: renderer `http://127.0.0.1:59657/`, Node PID 53932, visible/responding Electron PID 28404. Renderer modules return HTTP 200; the main source map contains 18 relevant embedded sources identical to disk. Development stderr is empty.
- User documentation: `docs/web-search.md`, with entry links in `README.md` and `docs/tool-workset.md`. No installer, release bundle, or commit was generated.
