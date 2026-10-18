# Agent Chat Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the agent conversation composer visible in an empty project workspace and automatically send its draft after explicit task-scope authorization.

**Architecture:** Keep file operations task-scoped. `WorkspaceView` owns only the visible empty-state composer and emits a start request; `App` owns the queued request and scope dialog; `useWorkspace` continues to send through the selected task after creation. No main-process protocol changes are needed.

**Tech Stack:** React, TypeScript, Vitest, Testing Library, Electron renderer.

---

### Task 1: Add the empty-workspace conversation surface

**Files:**
- Modify: `src/renderer/WorkspaceView.tsx`
- Modify: `src/renderer/styles.css`
- Test: `tests/renderer/App.test.tsx`

- [ ] **Step 1: Write the failing test**

Render `fixture({ project: true })`, assert a visible `智能体对话` heading, a `任务消息` textarea, and a `新建任务并开始对话` action. Click the action and assert the existing `确认任务范围` dialog appears.

- [ ] **Step 2: Run the focused test**

Run: `npx vitest run tests/renderer/App.test.tsx -t "empty workspace"`
Expected: FAIL because the empty branch currently renders only `项目工作区` and `新建任务`.

- [ ] **Step 3: Implement the empty composer**

Render a real agent section in the `!selected` branch. Keep the textarea disabled until task scope exists, show the selected provider model when available, show `配置供应商` when no model exists, and route the CTA to the existing `onNew` callback. Use the existing `.agent-section`, `.chat-messages`, and `.composer` styles with an empty-state modifier.

- [ ] **Step 4: Run the focused test**

Run: `npx vitest run tests/renderer/App.test.tsx -t "empty workspace"`
Expected: PASS.

### Task 2: Queue and auto-send the first message after authorization

**Files:**
- Modify: `src/renderer/WorkspaceView.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/useWorkspace.ts` only if a task-id-safe send helper is required
- Test: `tests/renderer/App.test.tsx`

- [ ] **Step 1: Write the failing test**

Type a prompt into the empty composer, submit it, assert the scope dialog opens and the prompt remains available. Confirm the scope and assert `createTask` receives the authorized scope followed by `agent` receiving the selected provider/model and original prompt. Add a cancellation assertion that `agent` is not called.

- [ ] **Step 2: Run the focused test**

Run: `npx vitest run tests/renderer/App.test.tsx -t "queues empty workspace chat"`
Expected: FAIL because the empty composer has no start callback and the app does not retain a pending prompt.

- [ ] **Step 3: Implement the queued request**

Add an `onStartConversation` callback from `WorkspaceView` to `App`. Store `{ model, prompt }` in App state before opening `ScopeForm`. On successful task creation, wait for the selected task id and call the existing `workspace.send`; clear the queued request after dispatch. On cancel, leave the draft in the empty composer and clear only the scope modal.

- [ ] **Step 4: Run focused regression tests**

Run: `npx vitest run tests/renderer/App.test.tsx tests/renderer/Races.test.tsx`
Expected: all selected renderer tests pass.

### Task 3: Verify the complete application

**Files:**
- No additional source files.

- [ ] **Step 1: Run renderer tests**

Run: `npx vitest run tests/renderer`
Expected: all renderer tests pass.

- [ ] **Step 2: Run project checks**

Run: `npm test -- --run`, `npm run typecheck`, `npm run lint`, and `git diff --check`.
Expected: tests and checks exit successfully.

- [ ] **Step 3: Build without packaging**

Run: `npm run build:app`
Expected: `dist/main` and `dist/renderer` are generated; no electron-builder packaging is run.
