# Workspace interactions implementation plan

**Goal:** Complete the six workspace interactions approved in `tra-station/SPECFAB_WORKSPACE_INTERACTION_OBSERVATION.md`, and repair StoryFabric's sidebar question entry.

**Architecture:** Keep tasks and digest approval as the permission boundary. Add project-local conversation sessions and a trusted versioned event bridge. Render persisted text/tool/question items through one timeline; input drafts and model preferences belong to sessions. A question resumes the existing run without granting file permissions.

**Stack:** TypeScript, Electron IPC, React, Zod, Vitest, Playwright. Execute inline in the current checkout to preserve the existing uncommitted implementation.

- [x] Protocols: first reproduce split Anthropic JSON and delayed SSE output in `tests/core/streaming.test.ts`. Add bounded UTF-8/SSE parsing in `src/main/core/protocol-stream.ts`; connect `protocols.ts`, `agent-client.ts` and runtime events. Run `npm test -- tests/core/streaming.test.ts tests/core/protocols.test.ts tests/core/agent-runtime.test.ts`.
- [x] Sessions and questions: test disk restart, concurrent sessions, stale identities, mandatory answers, retry and cancellation in `tests/integration/chat-sessions.test.ts`. Implement strict shared contracts, safe atomic session storage and session-run coordinator. Add scoped IPC APIs, preload listener, and project/task integration; normal sessions expose only the question interaction. Run the new integration tests and IPC tests.
- [x] Renderer: test draft isolation, failed-send recovery, IME, background streams, Markdown and question validation in `tests/renderer/ChatWorkbench.test.tsx`. Add a session hook, composer, Markdown bubbles, tool details, question cards and read-position-aware scrolling. Mount alongside existing task review controls; preserve compatibility for older hosts. Run renderer regressions.
- [x] StoryFabric: add sidebar question and approval-failure regressions; connect the question dialog and deferred reopen entry. Preserve pending approval on failure, disable duplicate confirmation and distinguish defer from rejection. Run sidebar/store regressions and builds.
- [x] Acceptance: exercise delayed real IPC SSE, switching sessions, stopping, persistence, question pause/resume and digest approval in Electron E2E. Run SpecLoom tests/typecheck/lint/build/E2E; run StoryFabric targeted tests/typecheck/build; update report with actual results and artifacts.

Every behavior change starts with a failing regression. Existing unrelated changes and release artifacts are retained. No commits or deployment are needed. Deliver SpecLoom 0.1.1 Windows packages and StoryFabric 0.2.37 standalone server bundle in their own version directories; retain previous artifacts.

## Verification result

SpecLoom: 437 Vitest tests passed, 10 Docker prerequisites tests skipped; final App/Races/ChatWorkbench regressions 35 passed; prompt clarification regression passed; typecheck/lint passed; 2 real Electron E2E flows passed. Windows 0.1.1 installer and portable ZIP rebuilt; source/lock/native versions, 7 packed application files, ZIP app.asar and SHA256 manifest verified. StoryFabric: 1268 tests passed and 5 environment-dependent tests skipped, web/node typechecks and all builds passed; 0.2.37 server archive version and 187 SHA256SUMS files verified. No deployments or commits.
