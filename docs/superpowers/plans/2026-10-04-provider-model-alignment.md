# Provider And Model Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add StoryFabric-compatible provider, model, JSON, session-selection, and protocol behavior to SpecLoom.

**Architecture:** Keep the existing Electron main-process authority and encrypted user-data vault. Add a versioned provider registry and protocol adapters in the core, expose typed IPC operations, and build a focused renderer provider/model manager around the existing app shell.

**Tech Stack:** TypeScript, Zod, Electron IPC/preload, React, Vitest, Testing Library, existing fetch-based agent runtime.

---

### Task 1: Shared provider and model contracts

**Files:** `src/shared/contracts.ts`, `src/shared/desktop-api.ts`, `tests/core/contracts.test.ts`

- [ ] Add strict provider, model settings, model reference, session reasoning, usage, and public credential status schemas.
- [ ] Add schema version 1 JSON validation with 64,000-character and safe-integer bounds.
- [ ] Preserve legacy `ModelProfile` parsing for migration tests.
- [ ] Run contract tests and typecheck.

### Task 2: Provider vault and migration

**Files:** `src/main/core/provider-vault.ts`, `src/main/core/model-vault.ts`, `src/main/desktop-controller.ts`, `src/main/ipc.ts`, `src/main/preload.ts`, related tests

- [ ] Write failing persistence, migration, credential reuse, delete-cleanup, and public-state tests.
- [ ] Implement encrypted provider records with ordered model lists and model overrides.
- [ ] Migrate old model profiles into a provider record on first read.
- [ ] Expose provider CRUD, model CRUD, discovery, and public credential status through typed IPC.

### Task 3: Effective model settings and JSON editor core

**Files:** `src/main/core/model-settings.ts`, `src/main/core/model-json.ts`, tests

- [ ] Write failing tests for family defaults, conservative fallback, override precedence, JSON validation, dangerous paths, and output/context bounds.
- [ ] Implement effective settings and safe reasoning-map application helpers shared by protocol adapters and renderer previews.
- [ ] Ensure JSON application is transactional and excludes provider/model IDs and credentials.

### Task 4: Protocol adapters and usage

**Files:** `src/main/core/protocols.ts`, `src/main/core/agent-client.ts`, `src/main/core/agent-runtime.ts`, tests

- [ ] Write failing mocked-request tests for OpenAI, Anthropic, and Gemini headers, URLs, output limits, reasoning, tools, and response parsing.
- [ ] Implement protocol adapters behind one completion interface, including normalized usage and tool calls.
- [ ] Keep retry, timeout, cancellation, response-size, and secret-redaction guarantees.

### Task 5: Runtime selection and session preferences

**Files:** `src/main/core/project-core.ts`, `src/main/desktop-controller.ts`, `src/shared/desktop-api.ts`, renderer workspace/useWorkspace files, tests

- [ ] Write failing tests for provider/model references, session reasoning overrides, invalid-reference errors, vision rejection, and context/output accounting.
- [ ] Route actual agent requests through the selected provider and effective model settings.
- [ ] Persist global default selection and expose current session selection without silent fallback.

### Task 6: Provider/model management UI

**Files:** `src/renderer/ProvidersView.tsx`, `src/renderer/ModelsView.tsx`, `src/renderer/App.tsx`, `src/renderer/styles.css`, renderer tests

- [ ] Write failing UI tests for provider CRUD, protocol fields, model search/add/remove, JSON edit/apply/revert, discovery failure preservation, and capability badges.
- [ ] Implement the provider-first workflow while retaining the existing model tab entry point.
- [ ] Reuse the existing context-menu clipboard behavior for JSON editing.

### Task 7: Verification and delivery

**Files:** documentation and targeted tests as needed

- [ ] Run renderer, core, integration, and full Vitest suites sequentially.
- [ ] Run lint, all TypeScript checks, and production build.
- [ ] Run the Electron flow with available dependencies and record unavailable Docker/Godot checks explicitly.
- [ ] Update configuration-entry documentation with the implemented contract and verified limitations.
