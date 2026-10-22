# SpecLoom Plugin SDK and Git Plugin — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a trusted local SpecLoom plugin host with manifest-driven main/renderer extensions, ship the built-in Git plugin, and expose it as a first-class Git page.

**Architecture:** A main-process plugin manager discovers built-in and user plugins, validates manifests, activates trusted main modules, routes commands, and serves declared HTML pages through a custom protocol. The renderer hosts plugin pages in a sandboxed iframe with a postMessage bridge. The official Git plugin is a built-in package with an HTML page and a main module using the system Git CLI.

**Tech Stack:** TypeScript, Electron main/preload/IPC, Zod, React renderer, plain HTML/JS plugin page, Node child_process, Vitest.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/shared/plugins.ts` | Manifest, inventory, command, page, and bridge types with Zod schemas. |
| `src/main/core/plugins/plugin-manager.ts` | Discovery, validation, enable state, activation, commands, page resolution, install/uninstall. |
| `src/main/plugins/plugin-protocol.ts` | `specloom-plugin://` protocol registration and safe page serving. |
| `src/main/desktop-controller.ts` | Expose plugin manager operations to IPC. |
| `src/main/ipc.ts`, `src/main/preload.ts` | Plugin API channels. |
| `src/shared/desktop-api.ts` | Renderer plugin API types. |
| `src/renderer/PluginPageHost.tsx` | Iframe bridge and page lifecycle. |
| `src/renderer/PluginManagementView.tsx` | SpecLoom plugin section alongside Godot plugins. |
| `src/renderer/App.tsx` | Dynamic plugin navigation entries and page routing. |
| `resources/plugins/specloom-git/plugin.json` | Official plugin manifest. |
| `resources/plugins/specloom-git/main/index.mjs` | Git command handlers. |
| `resources/plugins/specloom-git/renderer/index.html` | Git page markup and bridge usage. |
| `resources/plugins/specloom-git/renderer/app.js` | Git page behavior. |
| `resources/plugins/specloom-git/renderer/style.css` | Git page styles. |
| `electron-builder.yml` | Ship built-in plugins as an extra resource. |
| `tests/core/plugin-manager.test.ts` | Discovery, validation, enable, invoke, page path, install tests. |
| `tests/renderer/PluginPageHost.test.tsx` | Bridge request/response tests. |
| `tests/renderer/git-plugin.test.tsx` | Navigation and page registration tests. |

---

### Task 1: Shared plugin schema and manifest

**Files:**
- Create: `src/shared/plugins.ts`
- Test: `tests/core/plugin-manifest.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "vitest";
import { PluginManifestSchema, pluginPageId } from "../../src/shared/plugins";

test("accepts a declared plugin page", () => {
  const manifest = PluginManifestSchema.parse({
    id: "specloom-git", name: "Git", version: "0.1.0", apiVersion: 1,
    main: "main/index.mjs",
    contributes: { pages: [{ id: "git", title: "Git", entry: "renderer/index.html" }] },
    permissions: ["git:read"],
  });
  expect(manifest.contributes.pages[0]?.id).toBe("git");
  expect(pluginPageId("specloom-git", "git")).toBe("plugin:specloom-git:git");
});

test("rejects traversal and absolute entries", () => {
  const base = { id: "x", name: "X", version: "0.1.0", apiVersion: 1, main: "main/index.mjs" };
  expect(() => PluginManifestSchema.parse({ ...base, main: "../evil.mjs" })).toThrow();
  expect(() => PluginManifestSchema.parse({ ...base, main: "/tmp/evil.mjs" })).toThrow();
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run tests/core/plugin-manifest.test.ts`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement schema**

Define:

- `PLUGIN_API_VERSION = 1`
- `PluginPageSchema`
- `PluginManifestSchema`
- `PluginSummarySchema` / `PluginInventorySchema`
- `PluginCommandRequestSchema`
- `PluginPageId` helpers:
  - `pluginPageId(pluginId, pageId)`
  - `parsePluginPageId(value)`
- Relative path validation that rejects `..`, absolute paths, backslashes as separators, empty segments, and control characters.

- [ ] **Step 4: Run test**

Run: `npx vitest run tests/core/plugin-manifest.test.ts`
Expected: PASS.

---

### Task 2: Plugin manager

**Files:**
- Create: `src/main/core/plugins/plugin-manager.ts`
- Test: `tests/core/plugin-manager.test.ts`

- [ ] **Step 1: Write failing tests**

Cover:

- built-in plugin discovered and enabled by default;
- user plugin discovered but disabled;
- invalid manifest isolated with an error;
- enable activates main module and registers a command;
- invoke routes command with `projectPath`;
- disable deactivates and removes commands;
- page resolution rejects traversal and disabled plugins;
- install copies a folder into `userData/plugins`;
- uninstall removes only user plugins.

Use temporary directories and a fixture plugin whose main module exports:

```js
export async function activate(context) {
  context.commands.register("ping", async (input, ctx) => ({ pong: true, input, projectPath: ctx.projectPath }));
}
export async function deactivate() {}
```

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run tests/core/plugin-manager.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement manager**

Public interface:

```ts
export interface PluginManagerOptions {
  builtinDirectory: string;
  userDataDirectory: string;
  getProjectPath: () => string | undefined;
  storage?: (pluginId: string) => { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };
}
```

Methods:

- `list(): Promise<PluginInventory>`
- `setEnabled(id, enabled): Promise<PluginInventory>`
- `invoke(id, command, input): Promise<unknown>`
- `resolvePage(id, pageId): Promise<string>`
- `installDirectory(path): Promise<PluginInventory>`
- `uninstall(id): Promise<PluginInventory>`
- `revealTarget(id): Promise<string>`
- `close(): Promise<void>`

Rules:

- Official built-ins are read-only; installed user plugins are copied into `<userData>/plugins/<id>`.
- State is stored in `<userData>/plugins-state.json`; default state enables `official && enabledByDefault`.
- Main modules are loaded with `import(pathToFileURL(...))`; commands are stored per plugin.
- Commands are invoked with the current project path; missing project is a structured error.
- Page paths are resolved under the plugin root and must be regular non-symlink files.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/core/plugin-manager.test.ts`
Expected: PASS.

---

### Task 3: Main/preload/IPC wiring and protocol

**Files:**
- Create: `src/main/plugins/plugin-protocol.ts`
- Modify: `src/main/main.ts`, `src/main/ipc.ts`, `src/main/preload.ts`, `src/shared/desktop-api.ts`

- [ ] **Step 1: Add failing integration/type tests**

Add a manager test that resolves a page URL to an existing file, and a preload/IPC contract test only if the existing test harness supports it. At minimum, assert the shared API exposes:

```ts
interface PluginsApi {
  list(): Promise<PluginInventory>;
  setEnabled(id: string, enabled: boolean): Promise<PluginInventory>;
  invoke(id: string, command: string, input?: unknown): Promise<unknown>;
  install(): Promise<PluginInventory>;
  uninstall(id: string): Promise<PluginInventory>;
  reveal(id: string): Promise<void>;
  pageUrl(id: string, pageId: string): string;
}
```

- [ ] **Step 2: Implement**

- Register privileged scheme `specloom-plugin` before app ready.
- Protocol URL: `specloom-plugin://<plugin-id>/<page-id>`.
- Handler resolves through `PluginManager.resolvePage`, returns the HTML file with `text/html`; reject everything else.
- Add IPC operations: list, set enabled, invoke, install, uninstall, reveal, pageUrl.
- Add preload methods under `window.specloom.plugins`.
- Initialize manager after `app.whenReady`, before the window loads; close it on shutdown.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

---

### Task 4: Built-in Git plugin main module

**Files:**
- Create: `resources/plugins/specloom-git/plugin.json`
- Create: `resources/plugins/specloom-git/main/index.mjs`
- Modify: `electron-builder.yml`

- [ ] **Step 1: Add Git service tests**

Create `tests/core/git-plugin-commands.test.ts` with a temporary Git repository and a helper that imports the main module, activates it with a fake context, and invokes commands.

Cover:

- non-repository state;
- status and staged/unstaged file status;
- stage/unstage;
- commit;
- branch create/switch;
- history;
- diff limits;
- rejecting pull when no upstream / non-fast-forward;
- unavailable Git yields a structured error.

- [ ] **Step 2: Implement main module**

Use `spawn("git", args, { cwd: projectPath, env: sanitized, stdio: ["ignore","pipe","pipe"] })` with timeout and output cap. Commands:

`state`, `diff`, `stage`, `unstage`, `commit`, `branches`, `createBranch`, `switchBranch`, `fetch`, `pull`, `push`, `history`, `commitDetail`, `init`.

No shell strings. Never force push. Pull uses `--ff-only`. Redact credentials in remote URLs.

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/core/git-plugin-commands.test.ts`
Expected: PASS.

- [ ] **Step 4: Ship resources**

Add to `electron-builder.yml`:

```yaml
  - from: resources/plugins
    to: plugins
```

---

### Task 5: Git plugin page

**Files:**
- Create: `resources/plugins/specloom-git/renderer/index.html`
- Create: `resources/plugins/specloom-git/renderer/app.js`
- Create: `resources/plugins/specloom-git/renderer/style.css`

- [ ] **Step 1: Build page markup**

Header with repository state, branch, ahead/behind, fetch/pull/push. Body with changed files, diff, commit composer, branches/history tabs. Include a loading state, empty states, and an inline error area.

- [ ] **Step 2: Implement bridge client**

```js
const request = (method, params) => new Promise((resolve, reject) => {
  const id = crypto.randomUUID();
  const onMessage = (event) => {
    if (event.data?.channel !== "specloom-plugin" || event.data?.id !== id) return;
    window.removeEventListener("message", onMessage);
    if (event.data.ok) resolve(event.data.result);
    else reject(new Error(event.data.error ?? "Plugin request failed"));
  };
  window.addEventListener("message", onMessage);
  parent.postMessage({ channel: "specloom-plugin", type: "request", id, method, params }, "*");
});
```

Use it to invoke Git commands, refresh after mutations, and show errors.

- [ ] **Step 3: Style**

Implement a compact Git GUI with a three-column workspace on desktop, collapsing to one column below 900px. Preserve keyboard focus, button disabled states, and readable diff monospace text.

- [ ] **Step 4: Verify page manually only after explicit approval**

Do not launch the app during implementation unless the user requests it.

---

### Task 6: Renderer host, navigation, management UI

**Files:**
- Create: `src/renderer/PluginPageHost.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/PluginManagementView.tsx`
- Create: `resources/plugins/specloom-git/...` already above.

- [ ] **Step 1: Implement PluginPageHost**

Load `plugins.pageUrl(pluginId, pageId)` in an iframe. Handle only messages whose `event.source` is the iframe content window. Route:

- `project.get`
- `plugin.invoke`
- `plugin.storage.get/set`
- `ui.openExternal`

Return structured responses. Show a loading state and an error fallback.

- [ ] **Step 2: Dynamic navigation**

- After project open, call `plugins.list()`.
- For each enabled page, add an entry under a “Plugin pages” group.
- Tab IDs use `plugin:<pluginId>:<pageId>`.
- Disable/removal while active redirects to `plugins`.
- Pass the current project to the page host.

- [ ] **Step 3: Plugin management**

Add a SpecLoom section above the Godot section:

- official badge
- enabled switch
- install local folder button
- uninstall for user plugins
- reveal directory
- page count
- trusted-plugin warning

Keep existing Godot inventory behavior unchanged for non-Godot projects.

- [ ] **Step 4: Tests**

Add renderer tests for:

- Git nav entry appears when the built-in page is enabled.
- Disabling removes the entry.
- PluginPageHost resolves a request and rejects foreign-window messages.
- Plugin management renders both SpecLoom and Godot sections.

- [ ] **Step 5: Run tests and typecheck**

Run:

```bash
npx vitest run tests/core/plugin-manifest.test.ts tests/core/plugin-manager.test.ts tests/core/git-plugin-commands.test.ts tests/renderer/PluginPageHost.test.tsx tests/renderer/git-plugin.test.tsx
npm run typecheck
```

Expected: PASS.

---

## Verification Checklist

- [ ] Manifest traversal tests pass.
- [ ] Built-in Git plugin is enabled by default.
- [ ] User plugin disabled by default and activates only after enable.
- [ ] Plugin commands receive the current project path.
- [ ] Disabled plugin pages cannot be resolved.
- [ ] Git page performs status/stage/commit/branch/history/sync.
- [ ] Pull is fast-forward only; push never forces.
- [ ] Existing Godot plugin management still works.
- [ ] No source Electron app is launched during implementation.
- [ ] No packaging until explicitly requested.
