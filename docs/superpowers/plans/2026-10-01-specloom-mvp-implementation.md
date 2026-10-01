# SpecLoom MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Godot-first Electron desktop agent that organizes Markdown/YAML project specifications, performs version-guarded project changes, runs snapshot Bash and Godot validation, and exposes the same capabilities through local MCP.

**Architecture:** Electron main process owns `ProjectCore`; renderer communicates only through typed IPC. `ProjectCore` owns path validation, SHA-256 version tokens, task scopes, atomic change sets, Skills, model tool calls, snapshot execution, and validation. The MCP adapter calls the same core interfaces, so desktop and external agents cannot bypass the file gate.

**Tech Stack:** Electron, TypeScript, React, Vite, Vitest, Zod, Node `crypto`/`fs`/`child_process`, OpenAI-compatible HTTP API, MCP Streamable HTTP transport, Godot 4 headless CLI.

---

## Execution Status

- [ ] Task 0: Scaffold (in progress)
- [ ] Task 1: Shared contracts and layout
- [ ] Task 2: Versioned files and staged changes
- [ ] Task 3: Scopes and Skills
- [ ] Task 4: Isolated snapshot Bash
- [ ] Task 5: Model/tool runtime
- [ ] Task 6: Specification and Godot validation
- [ ] Task 7: ProjectCore and IPC
- [ ] Task 8: MCP
- [ ] Task 9: Desktop workflow
- [ ] Task 10: Acceptance and documentation

Execution clarifications: the new repository stays in the user-selected `SpecLoom/` directory on `feat/specloom-mvp`. Arbitrary Bash uses a Docker Linux container whose only project mount is the snapshot, with networking disabled and resource limits; missing Docker/image fails closed. PowerShell is not a Bash substitute. Managed changes are serialized and journaled with guarded recovery; ordinary filesystem replacements cannot promise atomicity across arbitrary external editors or multiple paths. File tools stage changes, and manual mode requires UI approval before commit. Tests target these actual guarantees.

## File Map

Create the application under `SpecLoom/` with these boundaries:

- `package.json`, `tsconfig*.json`, `vite.config.ts`, `electron-builder.yml`: build, type checking, tests, and packaging.
- `src/main/core/`: framework-independent project contracts and services.
- `src/main/core/file-store.ts`: root confinement, version tokens, atomic reads and writes.
- `src/main/core/change-set.ts`: staged multi-file changes, previews, and compare-and-swap commit.
- `src/main/core/task-scope.ts`: approved task paths and operation permissions.
- `src/main/core/skill-registry.ts`: Skill discovery, source references, and version-bound loading.
- `src/main/core/snapshot-runner.ts`: snapshot creation, constrained Bash execution, and diff collection.
- `src/main/core/agent-runtime.ts`: OpenAI-compatible model client and tool-call loop.
- `src/main/core/validator.ts`: specification, reference, and Godot headless validation.
- `src/main/core/project-core.ts`: façade used by IPC and MCP.
- `src/main/ipc.ts`, `src/main/main.ts`, `src/main/mcp-server.ts`: Electron process wiring and local MCP transport.
- `src/renderer/`: React UI for project selection, task scope, agent conversation, change preview, and validation.
- `src/shared/contracts.ts`: serialized IPC/MCP request and result types.
- `skills/`: bundled Skill definitions copied into initialized projects.
- `tests/unit/`, `tests/integration/`, `tests/fixtures/godot-minimal/`: focused tests and a small Godot fixture.

Each task below names every file it creates or modifies. Execute the test step immediately after the implementation step and checkpoint the task before starting the next one.

### Task 0: Initialize the repository and toolchain

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.main.json`
- Create: `tsconfig.renderer.json`
- Create: `vite.config.ts`
- Create: `electron-builder.yml`
- Create: `src/main/main.ts`
- Create: `src/renderer/index.html`
- Create: `src/renderer/main.tsx`
- Create: `src/renderer/App.tsx`
- Create: `tests/smoke/toolchain.test.ts`

- [ ] **Step 1: Initialize Git and write package metadata**

Run:

```powershell
git init
npm init -y
```

Set `package.json` scripts and dependencies to:

```json
{
  "name": "specloom",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "concurrently -k \"vite --config vite.config.ts\" \"wait-on http://localhost:5173 && electron .\"",
    "build": "tsc -p tsconfig.main.json && vite build && electron-builder --dir",
    "typecheck": "tsc -p tsconfig.main.json --noEmit && tsc -p tsconfig.renderer.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint ."
  }
}
```

Install runtime packages `electron`, `react`, `react-dom`, `zod`, `@modelcontextprotocol/sdk`, and `execa`; install development packages `typescript`, `vite`, `@vitejs/plugin-react`, `vitest`, `jsdom`, `electron-builder`, `concurrently`, `wait-on`, `eslint`, `@types/node`, `@types/react`, and `@types/react-dom`.

- [ ] **Step 2: Add compiler and Vite configuration**

Use `tsconfig.json` as the shared strict base:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}
```

`tsconfig.main.json` includes `src/main`, `src/shared` and emits to `dist/main`; `tsconfig.renderer.json` includes `src/renderer`, `src/shared`, uses DOM libs and emits to `dist/renderer`. Configure `vite.config.ts` with the React plugin, renderer root `src/renderer`, output `dist/renderer`, and port `5173`.

- [ ] **Step 3: Add the minimal Electron and renderer entrypoints**

`src/main/main.ts` must create a `BrowserWindow` with `contextIsolation: true`, `nodeIntegration: false`, preload path `dist/main/preload.js`, and load the Vite renderer in development or `dist/renderer/index.html` in production. `src/renderer/App.tsx` renders the text `SpecLoom` and a disabled `Select Godot Project` button until IPC exists.

- [ ] **Step 4: Add a toolchain smoke test and run it**

Create `tests/smoke/toolchain.test.ts`:

```ts
import { describe, expect, it } from "vitest";

describe("toolchain", () => {
  it("runs TypeScript tests", () => {
    expect("SpecLoom").toBe("SpecLoom");
  });
});
```

Run `npm test -- tests/smoke/toolchain.test.ts` and expect one passing test. Run `npm run typecheck` and expect exit code 0.

- [ ] **Step 5: Checkpoint the scaffold**

Run:

```powershell
git add .
git commit -m "chore: scaffold specloom desktop app"
```

### Task 1: Define shared contracts and project initialization

**Files:**
- Create: `src/shared/contracts.ts`
- Create: `src/main/core/project-layout.ts`
- Create: `src/main/core/errors.ts`
- Create: `tests/unit/project-layout.test.ts`

- [ ] **Step 1: Write failing layout tests**

Cover a valid Godot root containing `project.godot`, initialization of `specs/` and `.specloom/`, and rejection of a directory without `project.godot`.

- [ ] **Step 2: Implement contracts and layout initialization**

Define these shared types in `src/shared/contracts.ts`: `VersionToken = string`, `FileVersion`, `FileReadResult`, `WriteRequest`, `PatchRequest`, `TaskScope`, `ChangeEntry`, `ChangeSet`, `ValidationResult`, `SkillSource`, and `ToolResult`. Define `ProjectLayout.initialize(root)` to create the exact directories from the design and copy bundled Skills from `skills/`.

Use `ProjectError` with codes `INVALID_PROJECT`, `PATH_ESCAPE`, `VERSION_CONFLICT`, `TASK_SCOPE_DENIED`, `COMMAND_FAILED`, `VALIDATION_FAILED`, and `MODEL_ERROR`.

- [ ] **Step 3: Run layout tests**

Run `npm test -- tests/unit/project-layout.test.ts`; expect all tests to pass and `npm run typecheck` to remain green.

- [ ] **Step 4: Checkpoint the contracts**

```powershell
git add src/shared src/main/core/project-layout.ts src/main/core/errors.ts tests/unit/project-layout.test.ts
git commit -m "feat: define project contracts and layout"
```

### Task 2: Implement version-guarded file access

**Files:**
- Create: `src/main/core/file-store.ts`
- Create: `src/main/core/change-set.ts`
- Create: `tests/unit/file-store.test.ts`
- Create: `tests/unit/change-set.test.ts`

- [ ] **Step 1: Write failing file-store tests**

Test SHA-256 tokens for existing files, `absent` for missing files, successful `read` with the current token, rejection of a stale read, root path confinement, and atomic creation with `expectedVersion: "absent"`.

- [ ] **Step 2: Implement `FileStore`**

Expose:

```ts
class FileStore {
  listVersion(relativePath: string): Promise<FileVersion>;
  read(relativePath: string, expectedVersion: VersionToken): Promise<FileReadResult>;
  write(relativePath: string, content: string, expectedVersion: VersionToken): Promise<FileVersion>;
  patch(relativePath: string, patch: TextPatch, expectedVersion: VersionToken): Promise<FileVersion>;
  remove(relativePath: string, expectedVersion: VersionToken): Promise<void>;
}
```

Resolve every path against the project root, reject traversal and symlink escapes, hash file bytes with SHA-256, and recheck the token immediately before an atomic temporary-file replacement. `patch` must verify its context and reject an ambiguous or missing match.

- [ ] **Step 3: Write failing change-set tests**

Cover staging create/update/delete, preview output, all-files-match commit, and rejection of the entire batch when one expected token is stale.

- [ ] **Step 4: Implement `ChangeSet`**

Store each entry with `path`, `operation`, `expectedVersion`, `nextContent`, `sourceTaskId`, and `sourceTool`. `commit()` must list every current version first, reject on any mismatch, then apply all entries through `FileStore` while preserving a JSON audit record under `.specloom/history/changes/`.

- [ ] **Step 5: Run file and change-set tests**

Run `npm test -- tests/unit/file-store.test.ts tests/unit/change-set.test.ts`; expect all tests to pass. Add a test that edits a file between `listVersion` and `commit` and observes `VERSION_CONFLICT` with no other file changed.

- [ ] **Step 6: Checkpoint the file gate**

```powershell
git add src/main/core/file-store.ts src/main/core/change-set.ts tests/unit/file-store.test.ts tests/unit/change-set.test.ts
git commit -m "feat: add version guarded project file access"
```

### Task 3: Add task scopes and version-bound Skills

**Files:**
- Create: `src/main/core/task-scope.ts`
- Create: `src/main/core/skill-registry.ts`
- Create: `skills/project-context/SKILL.md`
- Create: `skills/specification-reading/SKILL.md`
- Create: `skills/prompt-library/SKILL.md`
- Create: `skills/entity-catalog/SKILL.md`
- Create: `skills/entity-authoring/SKILL.md`
- Create: `skills/godot-generation/SKILL.md`
- Create: `skills/godot-validation/SKILL.md`
- Create: `skills/task-planning/SKILL.md`
- Create: `tests/unit/task-scope.test.ts`
- Create: `tests/unit/skill-registry.test.ts`

- [ ] **Step 1: Write failing scope tests**

Test a scope allowing `specs/entities/hero.md` and `scenes/hero.tscn`, rejecting `scripts/unrelated.gd`, rejecting delete when delete is disabled, and allowing read-only access outside the write set.

- [ ] **Step 2: Implement `TaskScope`**

Expose `assertRead(path)`, `assertWrite(path, operation)`, and `describe()`. Match normalized relative paths against explicit allow lists; never treat a directory prefix as permission for an unrelated file unless the scope explicitly contains that directory.

- [ ] **Step 3: Write failing Skill tests**

Test discovery of a Skill directory containing `SKILL.md`, loading its content plus source file versions, and refusing a cached load after the source version changes.

- [ ] **Step 4: Implement `SkillRegistry` and bundled Skills**

Each Skill has front matter with `id`, `name`, `purpose`, `allowedSources`, and `instructions`. `SkillRegistry.list()` returns metadata; `load(id, scope)` reads allowed source files through `FileStore` and returns content plus `VersionToken` for every source. Keep prompts, specifications, and entity catalogs as source references rather than duplicated hidden state.

- [ ] **Step 5: Run scope and Skill tests**

Run `npm test -- tests/unit/task-scope.test.ts tests/unit/skill-registry.test.ts`; expect all tests to pass.

- [ ] **Step 6: Checkpoint Skills**

```powershell
git add src/main/core/task-scope.ts src/main/core/skill-registry.ts skills tests/unit/task-scope.test.ts tests/unit/skill-registry.test.ts
git commit -m "feat: add task scopes and version bound skills"
```

### Task 4: Implement snapshot Bash execution

**Files:**
- Create: `src/main/core/snapshot-runner.ts`
- Create: `tests/unit/snapshot-runner.test.ts`
- Create: `tests/integration/snapshot-conflict.test.ts`

- [ ] **Step 1: Write failing snapshot tests**

Test that a command can create a file in a temporary snapshot, its diff is collected, the real project is unchanged before commit, timeout returns `COMMAND_FAILED`, and an external edit causes the final change set to reject all files.

- [ ] **Step 2: Implement snapshot creation and command limits**

`SnapshotRunner.create(taskScope)` copies readable project files into a private temporary snapshot, records baseline versions, and rejects symlinks. `exec(command, options)` invokes Bash in a Linux Docker container: the snapshot is the only project mount, root filesystem is read-only, networking is disabled, capabilities are dropped, no-new-privileges is enabled, and time/output/process/memory limits apply. Diff collection rejects files outside the approved write scope. No host shell fallback is allowed.

- [ ] **Step 3: Implement diff collection and commit handoff**

Compare snapshot files to the baseline, classify add/update/delete, and return a `ChangeSet` whose expected versions are the recorded real-project tokens. Do not expose a method that writes to the real root directly.

- [ ] **Step 4: Run snapshot tests**

Run `npm test -- tests/unit/snapshot-runner.test.ts tests/integration/snapshot-conflict.test.ts`; expect all tests to pass with the real fixture untouched after a rejected conflict.

- [ ] **Step 5: Checkpoint Bash isolation**

```powershell
git add src/main/core/snapshot-runner.ts tests/unit/snapshot-runner.test.ts tests/integration/snapshot-conflict.test.ts
git commit -m "feat: run agent commands in versioned snapshots"
```

### Task 5: Add OpenAI-compatible AgentRuntime

**Files:**
- Create: `src/main/core/agent-runtime.ts`
- Create: `src/main/core/tool-catalog.ts`
- Create: `tests/unit/agent-runtime.test.ts`
- Create: `tests/integration/agent-tool-loop.test.ts`

- [ ] **Step 1: Write failing HTTP-client tests**

Mock a `/v1/chat/completions` endpoint and test base URL joining, bearer authentication, tool schema serialization, one tool call followed by a final assistant message, request timeout, and bounded retry on a 429 response.

- [ ] **Step 2: Implement the OpenAI-compatible client**

Define `ModelConfig` with `baseUrl`, `model`, `apiKeyRef`, `temperature`, `timeoutMs`, and `maxToolRounds`. Store only `apiKeyRef` in project configuration; retrieve the key from the OS credential adapter. Send standard `messages`, `tools`, and `tool_choice` fields and parse assistant `tool_calls` without vendor-specific branches.

- [ ] **Step 3: Implement the tool catalog and loop**

Register `files.list_versions`, `files.read`, `files.write`, `files.patch`, `bash.exec`, `skills.list`, `skills.load`, `godot.validate`, `changes.preview`, and `changes.commit`. Before dispatching a call, validate its Zod input, assert the task scope, and append an audit event. Return tool errors as structured messages so the model must react to conflicts instead of receiving hidden exceptions.

- [ ] **Step 4: Run model tests**

Run `npm test -- tests/unit/agent-runtime.test.ts tests/integration/agent-tool-loop.test.ts`; expect all tests to pass without a live API key.

- [ ] **Step 5: Checkpoint the agent runtime**

```powershell
git add src/main/core/agent-runtime.ts src/main/core/tool-catalog.ts tests/unit/agent-runtime.test.ts tests/integration/agent-tool-loop.test.ts
git commit -m "feat: add openai compatible agent tool loop"
```

### Task 6: Implement specification and Godot validation

**Files:**
- Create: `src/main/core/validator.ts`
- Create: `tests/unit/validator.test.ts`
- Create: `tests/fixtures/godot-minimal/project.godot`
- Create: `tests/fixtures/godot-minimal/main.tscn`
- Create: `tests/fixtures/godot-minimal/main.gd`
- Create: `tests/integration/godot-validation.test.ts`

- [ ] **Step 1: Write failing specification and reference tests**

Cover missing front matter fields, duplicate entity IDs, a relation to a missing entity, and a valid fixture. Assert each diagnostic contains `path`, `code`, `message`, and `severity`.

- [ ] **Step 2: Implement Markdown/YAML parsing and reference validation**

Parse front matter with a YAML parser, validate the required fields and allowed entity types, index all `specs/entities/**/*.md`, then resolve `relations`, task inputs, and generated-manifest references. Return deterministic diagnostics sorted by path and code.

- [ ] **Step 3: Add Godot headless execution**

Use a configured executable path and invoke `godot --headless --path <project> --editor --quit`. Capture exit code, stdout/stderr summaries, timeout, and command line. If a task declares a smoke scene, invoke `godot --headless --path <project> --scene <scene>` after import validation.

- [ ] **Step 4: Run validator tests**

Run `npm test -- tests/unit/validator.test.ts`. Run `npm test -- tests/integration/godot-validation.test.ts`; when Godot is unavailable, the test must skip with an explicit `GODOT_NOT_FOUND` diagnostic rather than report success.

- [ ] **Step 5: Checkpoint validation**

```powershell
git add src/main/core/validator.ts tests/unit/validator.test.ts tests/fixtures/godot-minimal tests/integration/godot-validation.test.ts
git commit -m "feat: validate specs references and godot projects"
```

### Task 7: Compose `ProjectCore` and wire Electron IPC

**Files:**
- Create: `src/main/core/project-core.ts`
- Create: `src/main/preload.ts`
- Create: `src/main/ipc.ts`
- Modify: `src/main/main.ts`
- Modify: `src/shared/contracts.ts`
- Create: `tests/integration/project-core.test.ts`

- [ ] **Step 1: Write failing façade tests**

Test project initialization, task creation with an explicit scope, a read using a token, staged preview, rejected stale commit, and validation result persistence under `.specloom/history/validations/`.

- [ ] **Step 2: Implement `ProjectCore`**

Construct `FileStore`, `SkillRegistry`, `SnapshotRunner`, `AgentRuntime`, and `Validator` with one project root. Expose `initializeProject`, `createTask`, `read`, `write`, `patch`, `runBash`, `listSkills`, `loadSkill`, `validate`, `previewChanges`, and `commitChanges`. Every method receives a task/session ID and records the actor and source tool.

- [ ] **Step 3: Add typed preload and IPC handlers**

Expose a narrow `window.specloom` API from `preload.ts`; do not expose Node or `ipcRenderer` directly. Add handlers for project selection, initialization, task creation, agent message, skills, change preview, commit, and validation. Validate every incoming payload with the same shared Zod schemas used by the tool catalog.

- [ ] **Step 4: Run core integration tests**

Run `npm test -- tests/integration/project-core.test.ts` and `npm run typecheck`; expect both to pass.

- [ ] **Step 5: Checkpoint the core boundary**

```powershell
git add src/main/core/project-core.ts src/main/preload.ts src/main/ipc.ts src/main/main.ts src/shared/contracts.ts tests/integration/project-core.test.ts
git commit -m "feat: compose project core and secure electron ipc"
```

### Task 8: Add local MCP transport

**Files:**
- Create: `src/main/mcp-server.ts`
- Create: `tests/integration/mcp-server.test.ts`
- Modify: `src/main/main.ts`

- [ ] **Step 1: Write failing MCP tests**

Test unauthenticated requests return 401, a valid local session can list versions and preview changes, and an MCP tool cannot commit a stale change set. Assert that the MCP server and IPC call the same `ProjectCore` instance.

- [ ] **Step 2: Implement the MCP adapter**

Start a loopback-only Streamable HTTP server with a random session token generated at startup. Register the tool schemas from `tool-catalog.ts`, translate MCP calls into `ProjectCore` calls, and return structured tool errors. Never expose raw filesystem or unrestricted shell endpoints.

- [ ] **Step 3: Run MCP tests and checkpoint**

Run `npm test -- tests/integration/mcp-server.test.ts`; expect all tests to pass.

```powershell
git add src/main/mcp-server.ts tests/integration/mcp-server.test.ts src/main/main.ts
git commit -m "feat: expose project core through local mcp"
```

### Task 9: Build the renderer workflow

**Files:**
- Modify: `src/renderer/App.tsx`
- Create: `src/renderer/api.ts`
- Create: `src/renderer/components/ProjectPicker.tsx`
- Create: `src/renderer/components/TaskScopeForm.tsx`
- Create: `src/renderer/components/AgentPanel.tsx`
- Create: `src/renderer/components/ChangePreview.tsx`
- Create: `src/renderer/components/ValidationPanel.tsx`
- Create: `src/renderer/styles.css`
- Create: `tests/renderer/App.test.tsx`

- [ ] **Step 1: Write failing renderer tests**

Using Testing Library, test the state transitions: no project selected, initialized project, task scope confirmation, agent response, pending changes, stale conflict, and validation failure. The UI must show the affected paths and never show a successful completion when validation failed.

- [ ] **Step 2: Implement the minimal project workflow UI**

Keep the first screen task-oriented: project path and Godot status at the top, task scope form, agent conversation, change preview with approve/reject controls, and validation results. Use the typed `window.specloom` API only. Render conflict paths and the required next action (`Read latest version`) as structured messages.

- [ ] **Step 3: Run renderer tests and build**

Run `npm test -- tests/renderer/App.test.tsx`, `npm run typecheck`, and `npm run build`; expect all to pass and the Electron unpacked build to exist under `dist/`.

- [ ] **Step 4: Checkpoint the UI**

```powershell
git add src/renderer
git commit -m "feat: add specloom desktop workflow ui"
```

### Task 10: End-to-end acceptance and documentation

**Files:**
- Create: `tests/e2e/mvp-flow.test.ts`
- Create: `README.md`
- Create: `docs/architecture.md`
- Create: `docs/mcp.md`
- Modify: `docs/superpowers/specs/2026-10-01-specloom-mvp-design.md`

- [ ] **Step 1: Write the MVP fixture flow**

The test creates a temporary Godot fixture with one character entity, starts `ProjectCore`, creates a task allowing `specs/entities/characters/hero.md`, `scenes/hero.tscn`, and `scripts/hero.gd`, stages a generated scene through the tool loop, previews it, commits it, and runs validation. A second task attempts to commit using the old token and must receive `VERSION_CONFLICT`.

- [ ] **Step 2: Run the full verification suite**

Run:

```powershell
npm test
npm run typecheck
npm run build
```

Expected result: all tests pass, type checking exits 0, and Electron packaging completes. Run the Godot integration test separately and record whether a Godot 4 executable is available.

- [ ] **Step 3: Document local operation**

`README.md` must include prerequisites, `npm install`, `npm run dev`, project initialization, model configuration, local MCP endpoint discovery, Godot executable configuration, and the meaning of version conflicts. `docs/architecture.md` must link the core boundaries and `docs/mcp.md` must show a minimal authenticated MCP client configuration without including an API key.

- [ ] **Step 4: Update the design status and checkpoint**

Change the design document status to `Implemented in MVP` only after the full verification suite passes. Record any unavailable Godot executable as an explicit validation limitation.

```powershell
git add README.md docs tests docs/superpowers/specs/2026-10-01-specloom-mvp-design.md
git commit -m "test: verify and document specloom mvp"
```

## Self-review

- Spec coverage: product scope is covered by Tasks 0, 7, and 9; file version gating by Task 2; Skills by Task 3; snapshot Bash by Task 4; OpenAI-compatible agent by Task 5; Godot validation by Task 6; MCP by Task 8; errors and audit history by Tasks 2, 4, 7, and 10; tests and acceptance by every task and Task 10.
- Placeholder scan: the plan contains no `TODO`, `TBD`, or unspecified implementation step. Commands, paths, method names, expected outcomes, and test boundaries are explicit.
- Type consistency: `VersionToken`, `FileVersion`, `TaskScope`, `ChangeSet`, `ValidationResult`, `SkillSource`, and `ToolResult` are introduced in Task 1 and reused by later tasks. `ProjectCore` is the only dependency used by both IPC and MCP in Tasks 7 and 8.
