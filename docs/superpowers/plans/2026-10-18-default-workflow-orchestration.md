# Default Workflow and Sequential Orchestration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Add project default workflow resolution and a persisted sequential orchestration runtime, then wire task/chat triggers, agent tools, and the three-mode workflow UI.

**Architecture:** New project-scoped settings and orchestration stores feed a main-process WorkflowOrchestrator. It starts existing WorkflowRuns one step at a time, applies inherit/always/auto approval, passes a bounded previous-step summary, and pauses on failure. The renderer and agent tools consume the same service.

**Tech Stack:** TypeScript, Zod, YAML, Vitest, Electron main/preload, existing WorkflowRunner/ProjectCore.

---

## File map

Create:
- src/shared/orchestration.ts
- src/main/core/workflow-settings-store.ts
- src/main/core/workflow-defaults.ts
- src/main/core/orchestration-store.ts
- src/main/core/orchestration-run-store.ts
- src/main/core/workflow-orchestrator.ts
- src/main/core/workflow-trigger.ts
- tests/core/workflow-settings-store.test.ts
- tests/core/orchestration-store.test.ts
- tests/core/orchestration-run-store.test.ts
- tests/core/workflow-orchestrator.test.ts
- tests/core/workflow-trigger.test.ts
- tests/helpers/fake-orchestration-runner.ts

Modify:
- src/shared/workflow.ts — approvalPolicy
- src/shared/workflow-api.ts — context, auto approval, orchestration API types
- src/main/core/workflow-runner.ts — context prompts, auto approval
- src/main/core/workflow-service.ts — settings and orchestration methods
- src/main/ipc.ts, src/main/preload.ts, src/shared/desktop-api.ts — API surface
- src/main/core/tools/catalog.ts, src/main/core/tools/workspace-tools.ts — agent tools
- src/shared/contracts.ts — task goal
- src/renderer/WorkflowView.tsx, src/renderer/workflow/ — three modes, builder, run panel
- src/renderer/ScopeForm.tsx, src/renderer/chat/ChatWorkbench.tsx — task goal and implementation mode
- tests for each

---

## Task 1: Shared contracts

**Files:** Modify src/shared/workflow.ts; create src/shared/orchestration.ts; modify src/shared/workflow-api.ts; test tests/core/workflow-schema.test.ts.

- [ ] Write failing tests: approvalPolicy defaults to manual and accepts auto; run inputs accept context; orchestration definition validates steps/approval and rejects duplicate step ids.
- [ ] Run: npx vitest run tests/core/workflow-schema.test.ts — expect FAIL.
- [ ] Add WorkflowApprovalPolicySchema manual/auto default manual to definition settings.
- [ ] Add context max 32768 to WorkflowRunInputs and schema.
- [ ] Add OrchestrationApprovalSchema inherit/always/auto, OrchestrationStepSchema (id, workflowId, approval), OrchestrationDefinitionSchema (schemaVersion 1, id, title, description, steps 1..20, unique step ids).
- [ ] Add WorkflowSettingsSchema and WorkflowDefaultResolution.
- [ ] Run test — PASS.
- [ ] Commit: feat(workflow): add default and orchestration contracts.

## Task 2: Settings store and default resolver

**Files:** create src/main/core/workflow-settings-store.ts, src/main/core/workflow-defaults.ts; test tests/core/workflow-settings-store.test.ts.

- [ ] Test: missing file returns schemaVersion 1; save writes .specloom/editor/workflow-settings.json atomically; clearDefault removes field; corrupt JSON falls back empty.
- [ ] Run — FAIL.
- [ ] Implement WorkflowSettingsStore read/save/clearDefault with fixed path, temp+rename, Zod validation.
- [ ] Implement resolveDefaultWorkflow({settings, loadProject, loadOfficial}): project id if valid, else official; source project/official/fallback and warning.
- [ ] Test resolution with valid project, invalid project, no setting.
- [ ] Run — PASS; commit feat(workflow): persist project default and resolve fallback.

## Task 3: Orchestration store

**Files:** create src/main/core/orchestration-store.ts; test tests/core/orchestration-store.test.ts.

- [ ] Test: save/read/list specs/orchestrations/<id>.yaml; version token; invalid YAML/duplicate step id rejected; path traversal rejected.
- [ ] Run — FAIL.
- [ ] Implement list/read/save/remove using FileStore, YAML parse/stringify, OrchestrationDefinitionSchema, id/path validation, ProjectError VALIDATION_FAILED with path.
- [ ] Test — PASS; commit feat(workflow): add sequential orchestration store.

## Task 4: Orchestration run store

**Files:** create src/main/core/orchestration-run-store.ts; test tests/core/orchestration-run-store.test.ts.

- [ ] Test: save/get/list newest first; malformed record rejected; queued/running records load as interrupted; path is .specloom/workflows/orchestration-runs/<id>.json.
- [ ] Run — FAIL.
- [ ] Implement atomic JSON store, ID regex, schema validation, bounded errors.
- [ ] Test — PASS; commit feat(workflow): persist orchestration runs.

## Task 5: Runner context and auto approval

**Files:** modify src/main/core/workflow-runner.ts, src/shared/workflow-api.ts; test tests/core/workflow-runner.test.ts.

- [ ] Test: auto workflow approves review and completes with approval.autoApproved; manual still waits; context appears in plan prompt; context bounded.
- [ ] Run — FAIL.
- [ ] Add context to inputs schema; append to plan/implement prompts with a 32768-character cap.
- [ ] In runReviewNode read definitionSnapshot.settings.approvalPolicy. manual: current waiting behavior. auto: adapter.approve(taskId,digest), set approval approvedAt/autoApproved/approvedBy orchestrator, node completed, persist, continue to decision.
- [ ] Ensure executeFrom handles continue/stop correctly and completed run.
- [ ] Test — PASS (existing 32 + new); commit feat(workflow): support run context and auto approval.

## Task 6: Orchestrator

**Files:** create src/main/core/workflow-orchestrator.ts, tests/helpers/fake-orchestration-runner.ts; test tests/core/workflow-orchestrator.test.ts.

- [ ] Test sequences: two steps shared inputs; first waits manual then approve starts second; auto first approves; always forces waiting; failure pauses and retry current; cancel; completed; restart waiting approval; previous summary in second context.
- [ ] Run — FAIL.
- [ ] Implement OrchestrationRunner interface: start/getRun/waitForRun/approve/reject/cancel/retry.
- [ ] Constructor: runStore, loadWorkflow, loadOrchestration, runner, now, idFactory.
- [ ] start creates OrchestrationRun with steps, persists, advance.
- [ ] advance starts child with inputs plus previous context; waits for waiting/completed/failed/cancelled; auto approves when effective approval auto; manual persists waiting; completed records summary/decisionPath and advances; failed pauses; final completed.
- [ ] approveStep/rejectStep/retryStep/cancel update child and advance.
- [ ] previousContext: summary, decisionPath, validation status, approval; cap 32768 characters.
- [ ] Persist and reload waiting; running -> interrupted.
- [ ] Test — PASS; commit feat(workflow): execute orchestration steps sequentially.

## Task 7: Service, IPC, preload, API

**Files:** modify src/main/core/workflow-service.ts, src/main/ipc.ts, src/main/preload.ts, src/shared/desktop-api.ts; test tests/integration/workflow-ipc.test.ts.

- [ ] Test schemas for settings and orchestration start/retry/cancel.
- [ ] Add WorkflowService methods: defaults read/save/clear; orchestration list/read/save/remove/start/getRun/listRuns/approveStep/rejectStep/retryStep/cancel.
- [ ] Add IPC operations and types; workflow:update for runs plus orchestration:update event.
- [ ] Expose preload methods and WorkflowApi types; no breaking existing methods.
- [ ] Run test + npm run typecheck — PASS; commit feat(workflow): expose defaults and orchestration IPC.

## Task 8: Agent workflow tools

**Files:** modify src/main/core/tools/catalog.ts, src/main/core/tools/workspace-tools.ts, wiring in ProjectCore/DesktopController; test tests/core/workspace-tools.test.ts.

- [ ] Test: WorkflowList shows default; WorkflowCreate validates and returns id; WorkflowRun starts; OrchestrationCreate/Run; no WorkflowApprove tool; invalid definition returns readable error.
- [ ] Run — FAIL.
- [ ] Add tool definitions WorkflowList/Read/Create/Run/Status/Cancel and OrchestrationList/Read/Create/Run/Status/Cancel; initial false so ToolSearch discovers them.
- [ ] Add WorkflowToolRuntime interface and WorkspaceToolOptions.workflowTools; execute cases call runtime.
- [ ] Runtime uses WorkflowService, default resolution, current task scope; no approve.
- [ ] Test — PASS; commit feat(workflow): add agent workflow tools.

## Task 9: Task goal and triggers

**Files:** modify src/shared/contracts.ts, src/main/core/project-core.ts/task scope, create src/main/core/workflow-trigger.ts, modify DesktopController/WorkflowService; test tests/core/workflow-trigger.test.ts.

- [ ] Test: TaskScopeSpec accepts optional goal and preserves it; old tasks fallback title; trigger starts default once per task, records binding, idempotent; chat implementation resolves selected task scope or rejects without scope; explicit workflow overrides default.
- [ ] Run — FAIL.
- [ ] Add goal max 8192 to TaskScopeSpec and TaskView scope; UI later.
- [ ] Implement WorkflowTrigger with a fixed task-binding sidecar at .specloom/workflows/task-bindings.json mapping taskId to workflowRunId (atomic JSON, no user paths); startForTask(taskId, message), startForChat(goal, scope, workflowId?).
- [ ] Use resolveDefaultWorkflow; start via WorkflowService; return run; no auto approve beyond workflow policy.
- [ ] Test — PASS; commit feat(workflow): trigger default workflow for task and chat.

## Task 10: Workflow UI three modes, default star, builder, run

**Files:** modify src/renderer/WorkflowView.tsx, add src/renderer/workflow/OrchestrationBuilder.tsx, OrchestrationRunPanel.tsx, useOrchestration.ts, workflow.css; test tests/renderer/OrchestrationView.test.tsx and WorkflowView.test.tsx.

- [ ] Test: mode tabs Workflow/Orchestration/Run; official pinned default; project override star and restore; add step/reorder/approval inherit/always/auto; auto warning; run timeline.
- [ ] Run — FAIL.
- [ ] Rename build mode to workflow; mode union workflow/orchestration/run.
- [ ] Add default badge/star and restore button using API.
- [ ] Add orchestration list/builder; steps with workflow select, approval, up/down/remove/add; save; temporary queue.
- [ ] Add orchestration run panel and chain timeline; current child approval/retry/cancel.
- [ ] Run mode supports a temporary ordered queue and a Save as orchestration action.
- [ ] Update tests and CSS.
- [ ] Run npx vitest run tests/renderer/OrchestrationView.test.tsx tests/renderer/WorkflowView.test.tsx — PASS; npm run typecheck; commit feat(workflow): add orchestration editor and default UI.

## Task 11: Task/chat UI and E2E

**Files:** modify src/renderer/ScopeForm.tsx, src/renderer/App.tsx, src/renderer/chat/ChatWorkbench.tsx and composer; add tests/e2e/workflow-default-orchestration.spec.ts; tests.

- [ ] Test: task form has goal; first implementation message starts workflow; chat implementation toggle; no scope shows scope card; default label; run card.
- [ ] Implement goal field and trigger calls; chat mode toggle + scope resolution.
- [ ] E2E: task default to approval; chat implementation; orchestration of two workflows with manual approval then auto step; failure retry; auto warning.
- [ ] Run npx vitest run tests/renderer/ScopeForm.test.tsx; npm run test:e2e -- tests/e2e/workflow-default-orchestration.spec.ts; npm run typecheck.
- [ ] Commit feat(workflow): wire task and chat default entry.

## Self-review checklist

- Spec coverage: default official/project, task goal/first message, chat implementation, orchestration definition/run, shared inputs, summary handoff, inherit/always/auto, failure/retry, agent tools, UI, E2E.
- No TBD/TODO placeholders.
- Names consistent: WorkflowSettings, OrchestrationDefinition, OrchestrationRun, WorkflowDefaultResolution, WorkflowOrchestrator, effectiveApproval.
- Task bindings use .specloom/workflows/task-bindings.json; tests pin idempotency and atomic writes.
- No packaging.
