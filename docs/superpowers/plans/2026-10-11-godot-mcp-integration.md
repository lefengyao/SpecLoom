# SpecLoom Godot MCP Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking. Do not stage or commit files; preserve the existing dirty worktree.

**Goal:** Bundle the GodotMCP-Standalone addon into SpecLoom, expose its eight already-registered read-only tools through the internal Agent and official inbound MCP service, and replace the old Godot screenshot bridge with confirmed install-and-enable flow.

**Architecture:** Add a project-keyed `GodotMcpHostRegistry` that shares one loopback WebSocket bridge between Agent sessions and inbound MCP calls. Vendor the upstream addon and license as application resources, patch its handshake to select the SpecLoom service, and install it at `addons/godot_mcp/` through the existing safe project-plugin manager. Keep all tools read-only and preserve desktop screenshot/input tools.

**Tech Stack:** Electron main process, TypeScript, MCP SDK, `ws`, Zod, React, Godot 4.7 GDScript, Vitest, electron-builder.

---

## File map

| File | Responsibility |
| --- | --- |
| `src/main/core/godot-mcp/tool-definitions.ts` | The fixed eight-tool allowlist, Zod schemas, Godot route mapping, and MCP tool result types. |
| `src/main/core/godot-mcp/bridge.ts` | One bounded WebSocket/JSON-RPC bridge for one canonical Godot project path. |
| `src/main/core/godot-mcp/host-registry.ts` | Share and close project bridge instances; run the eight validated tools and maintain bounded Output-log snapshots. |
| `src/main/core/godot-mcp/output-log.ts` | MIT-adapted bounded Output-log parser, snapshots, severity filters, cursors, and expiry. |
| `resources/godot-mcp/addons/godot_mcp/**` | Vendored upstream Godot addon with SpecLoom service handshake adjustment. |
| `resources/godot-mcp/manifest.json` | Per-file upstream baseline and packaged SHA-256 digests used to validate the bundle and recognize safe updates. |
| `resources/godot-mcp/LICENSE` and `resources/godot-mcp/NOTICE.md` | Preserve MIT terms and record upstream name/version plus local adaptation. |
| `src/main/core/plugins/godot-mcp-installer.ts` | Copy the packaged addon safely and transactionally into a Godot project. |
| `src/main/core/godot-mcp/bundle.ts` | Validate resource manifest, hashes, required addon files, plugin path, and route allowlist. |
| `src/main/core/plugins/godot-project-plugins.ts` | Inventory/status, managed-plugin enablement, and migration of the old screenshot bridge settings. |
| `src/main/core/plugins/godot-screenshot.ts` | Delete the retired polling-based Godot screenshot bridge after its migration responsibilities move into the MCP installer/manager. |
| `src/shared/godot-plugins.ts`, `src/shared/desktop-api.ts` | Typed managed MCP plugin state and renderer API. |
| `src/main/ipc.ts`, `src/main/preload.ts`, `src/main/desktop-controller.ts`, `src/main/hub-module.ts`, `src/main/hub-workspaces.ts` | Confirmed installation, plugin status, enable/disable, project-scoped service wiring, Hub mutation authorization, and module resource-root injection. |
| `src/main/core/project-core.ts`, `src/main/desktop-sessions.ts`, `src/main/core/tools/workspace-tools.ts` | Share the bridge across inbound MCP, Agent sessions, and child Agents. |
| `src/main/core/tool-catalog.ts`, `src/main/core/tools/catalog.ts`, `src/main/core/tools/approval-policy.ts` | Register the fixed Godot MCP tools and retire old screenshot bridge model tools. |
| `src/main/mcp-server.ts` | Preserve text and image tool-result content for inbound clients. |
| `src/renderer/PluginManagementView.tsx`, `src/renderer/ToolsViews.tsx` | Official plugin card, explicit install/enable confirmation, connection status, and tool descriptions. |
| `electron-builder.yml`, `scripts/build-hub-module.mjs` | Include vendor addon and license in packaged desktop builds and Trailblazer Hub module archives. |
| `docs/mcp.md`, `docs/plugins/plugin-management.md`, `docs/plugins/godot-screenshot.md`, `docs/plugins/godot-mcp.md`, `README.md` | Document the official integration, migration, and removed screenshot transport. |

## Task 1: Define the read-only tool contract

**Files:**
- Create: `src/main/core/godot-mcp/tool-definitions.ts`
- Modify: `src/main/core/tool-catalog.ts`
- Modify: `src/main/core/tools/catalog.ts`
- Test: `tests/core/godot-mcp-tools.test.ts`
- Test: `tests/core/workspace-tools.test.ts`

- [x] **Step 1: Write failing allowlist and schema tests**

Assert that the tool names are exactly `get_diagnostics`, `get_output_log`, `get_editor_screenshot`, `get_game_screenshot`, `get_project_info`, `get_scene_tree`, `get_game_scene_tree`, and `get_game_node_properties`; assert that each maps to its route from the approved design spec. Reject a scene depth above 64, a log page above 500, a node path containing `..`, and a screenshot argument that is not an empty object.

- [x] **Step 2: Run the focused tests and confirm failure**

Run: `npx vitest run tests/core/godot-mcp-tools.test.ts tests/core/workspace-tools.test.ts`

Expected: FAIL because the Godot MCP tool contract has not been defined.

- [x] **Step 3: Add the eight exact tool definitions**

Use these parameter bounds in `tool-definitions.ts`:

```ts
const empty = z.object({}).strict();
const outputLog = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  direction: z.enum(["older", "newer"]).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  levels: z.array(z.enum(["ERROR", "WARNING", "INFO", "DEBUG", "UNKNOWN"])).max(5).optional(),
}).strict();
const sceneTree = z.object({ max_depth: z.number().int().min(0).max(64).optional().default(15) }).strict();
const nodeProperties = z.object({
  path: z.string().max(4096).refine(value => !value.includes("..")),
  properties: z.array(z.string().min(1).max(128)).max(128).optional(),
}).strict();
```

Define every item with `name`, `description`, `route`, and `schema`; map the eight names to the routes in the spec. Append the definitions to inbound `ToolCatalog`. Add them to `WorkspaceCatalog` only for a Godot project; remove `GodotScreenshot` and `GodotPluginInstall` from the workspace catalog. Do not include any other route or upstream module.

- [x] **Step 4: Run focused tests and typecheck**

Run: `npx vitest run tests/core/godot-mcp-tools.test.ts tests/core/workspace-tools.test.ts`

Expected: PASS with exactly eight Godot tool definitions and no legacy screenshot bridge tools. Then run `npm run typecheck` and expect exit code 0.

## Task 2: Implement the shared loopback bridge and project registry

**Files:**
- Create: `src/main/core/godot-mcp/bridge.ts`
- Create: `src/main/core/godot-mcp/host-registry.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Test: `tests/core/godot-mcp-bridge.test.ts`
- Test: `tests/core/godot-mcp-host.test.ts`
- Test: `tests/core/godot-mcp-output-log.test.ts`

- [x] **Step 1: Add fake-editor tests first**

Test an in-process WebSocket peer connecting to the bridge, receiving the `server_hello` project path and `serviceId: "specloom"`, and answering one allowlisted route. Require a `client_hello` acknowledgment before reporting the addon connected; reject mismatched project paths and service ids. Also test rejection of a non-allowlisted route, request timeout, abort cleanup, maximum message size, and registry reuse for two calls with the same root.

- [x] **Step 2: Verify the focused tests fail**

Run: `npx vitest run tests/core/godot-mcp-bridge.test.ts tests/core/godot-mcp-host.test.ts`

Expected: FAIL because the bridge and registry do not exist.

- [x] **Step 3: Add WebSocket dependency and bridge**

Run: `npm install ws` and `npm install --save-dev @types/ws`.

Implement `GodotMcpBridge` with a loopback-only listener, a bounded port search from 6505 through 6514, a 24 MiB frame cap, one editor peer per project service, a 30-second request timeout, pending request cancellation, and deterministic `close()`. Send only the selected project's canonical path and `serviceId: "specloom"` in `server_hello`; accept a connection only after a `client_hello` acknowledgment with the same project path and service id. Route requests through the fixed route map rather than accepting a model-provided method name.

- [x] **Step 4: Add project registry, dispatch, and Output-log snapshots**

Implement `GodotMcpHostRegistry.forProject(root)`, `acquire(root)`, `release(root)`, `status(root)`, and `closeAll()`. Canonicalize roots with `realpath`, reuse the same bridge for all consumers of one project, and close it when the final project lease ends. Implement each tool by parsing its schema from `tool-definitions.ts`, sending only its mapped route, preserving the upstream Output-log cursor/page behavior, and translating transport errors to `ProjectError` with a stable code and reconnect hint. `get_diagnostics` must return local disconnected status and reconnect guidance without waiting on an offline bridge.

On Windows, normalize separators and compare canonical project paths case-insensitively; preserve the real path spelling sent to Godot. Make `release()` and `closeAll()` idempotent so controller shutdown and app shutdown can both clean up safely.

For screenshot tools, require a valid canonical base64 PNG no larger than 8 MiB and dimensions no larger than 32,768 per axis or 100 million pixels. Return `{ mimeType: "image/png", base64, width, height }` to Agent callers; never log or persist the base64. For Output-log history, cap snapshots at 8 MiB each, keep at most 8 snapshots, expire them after 10 minutes, and reject stale cursors.

- [x] **Step 5: Run focused bridge tests**

Run: `npx vitest run tests/core/godot-mcp-bridge.test.ts tests/core/godot-mcp-host.test.ts`

Expected: PASS for successful calls, validation failures, disconnection, abort, timeout, cursor expiry, project isolation, and registry reuse.

## Task 3: Vendor the addon and package its resources

**Files:**
- Create: `resources/godot-mcp/addons/godot_mcp/**`
- Create: `resources/godot-mcp/manifest.json`
- Create: `resources/godot-mcp/LICENSE`
- Create: `resources/godot-mcp/NOTICE.md`
- Modify: `resources/godot-mcp/addons/godot_mcp/plugin.gd`
- Modify: `electron-builder.yml`
- Modify: `src/main/core/godot-mcp/host-registry.ts`
- Test: `tests/core/godot-mcp-plugin-bundle.test.ts`
- Test: `tests/smoke/toolchain.test.ts`

- [x] **Step 1: Add bundle integrity tests**

Inject a temporary addon-resource directory and verify that it contains `plugin.cfg`, `plugin.gd`, the route router, WebSocket client, required observability/inspection command scripts, the upstream MIT license, and a notice that identifies the source as GodotMCP-Standalone 1.1.0. Reject a bundle with a missing required script or a plugin configuration whose script path escapes `addons/godot_mcp/`.

- [x] **Step 2: Confirm tests fail, then copy upstream resources**

Run: `npx vitest run tests/core/godot-mcp-plugin-bundle.test.ts`

Expected: FAIL before the resource bundle is added. Copy the full `GodotMCP-Standalone/addons/godot_mcp/` tree so its editor plugin and resource references remain intact, copy its `LICENSE`, and write `NOTICE.md` with source path, package version 1.1.0, plugin metadata version, and the SpecLoom handshake adaptation. Generate `manifest.json` with each file's upstream SHA-256 and packaged SHA-256 (which may differ for intentionally patched files). Do not copy the standalone Node MCP server or its npm dependencies.

- [x] **Step 3: Make the Godot addon select only SpecLoom**

Patch the addon connection scan so it accepts a bridge only when both the canonical project path and `serviceId == "specloom"` match, then replies with `client_hello`. When a port belongs to a standalone MCP server without that service id, disconnect and continue scanning instead of binding to it. Keep the Godot-side route allowlist exactly equal to the eight routes in the spec. Remove the addon timer and recursive popup/dialog auto-dismiss behavior; enabling an observability plugin must not dismiss project dialogs as a side effect.

- [x] **Step 4: Package resource files in development and production**

Add an electron-builder `extraResources` mapping from `resources/godot-mcp` to `godot-mcp`, and resolve it through the app root in development and `process.resourcesPath` when packaged. Verify the manifest before exposing installation: reject path traversal, missing files, and hash mismatches. The host registry must fail with `BACKEND_UNAVAILABLE` and a path-specific message if the plugin bundle is missing.

- [x] **Step 5: Run bundle and packaging-input tests**

Run: `npx vitest run tests/core/godot-mcp-plugin-bundle.test.ts tests/smoke/toolchain.test.ts`

Expected: PASS and confirm the vendor addon plus `LICENSE` are included in the staged application resources. Do not run an installer over existing release artifacts at this step.

## Task 4: Add safe install/enable migration for the official plugin

**Files:**
- Create: `src/main/core/plugins/godot-mcp-installer.ts`
- Modify: `src/main/core/plugins/godot-project-plugins.ts`
- Delete: `src/main/core/plugins/godot-screenshot.ts`
- Modify: `src/shared/godot-plugins.ts`
- Modify: `src/main/desktop-controller.ts`
- Modify: `src/main/ipc.ts`
- Modify: `src/main/preload.ts`
- Modify: `src/shared/desktop-api.ts`
- Modify: `src/main/hub-module.ts`
- Test: `tests/core/godot-mcp-installer.test.ts`
- Test: `tests/core/godot-project-plugins.test.ts`
- Test: `tests/integration/plugin-management.test.ts`
- Test: `tests/integration/hub-module.test.ts`
- Test: `tests/unit/ipc.test.ts`
- Delete: `tests/core/godot-screenshot.test.ts`
- Delete: `tests/integration/godot-screenshot-plugin.test.ts`

- [x] **Step 1: Add migration and conflict tests**

Test install into a Godot fixture with an unrelated enabled plugin. Assert that installation writes only the known addon files and `.specloom-managed.json` marker, adds `res://addons/godot_mcp/plugin.cfg`, removes only the old screenshot bridge plugin reference and exact owned `SpecLoomCapture` Autoload, preserves all other settings, and returns `restartRequired: true`. Test byte-identical repeated installation, update when every existing file matches an upstream baseline or the previous marker, modified-file conflict, Autoload collision, malformed plugin setting, junction/symlink rejection, concurrent `project.godot` change, and rollback after a failed write.

- [x] **Step 2: Verify migration tests fail**

Run: `npx vitest run tests/core/godot-mcp-installer.test.ts tests/core/godot-project-plugins.test.ts tests/integration/plugin-management.test.ts tests/integration/hub-module.test.ts`

Expected: FAIL because only the old screenshot bridge is managed.

- [x] **Step 3: Implement transactional plugin installation**

Use the existing `PathPolicy`, project-setting parser, size limits, temporary files and version checks. Install at `addons/godot_mcp/`. Validate the packaged manifest and every source digest before writing. Existing files may be updated only when each file matches the packaged upstream baseline or the previous `.specloom-managed.json` marker. Write the current marker with the installed file hashes. Check every file and project setting before writing. Merge the enabled plugin reference without dropping third-party entries. Roll back files newly created or safely updated by this transaction if `project.godot` cannot be committed. Never recursively delete addon directories.

- [x] **Step 4: Make the managed plugin a first-class inventory entry**

Replace `PluginInventory.screenshotBridge` with a `godotMcp` entry containing installation state (`missing`, `ready`, `conflict`), installed version, enabled state, and live connection state. Exclude `addons/godot_mcp/plugin.cfg` from the generic plugin list. Add `pluginsInstallGodotMcp` and `pluginsSetGodotMcpEnabled` IPC routes; remove old screenshot bridge mutation routes and update `hub-module.ts`'s mutation allowlist. Reject generic `setGodotPluginEnabled` for the managed MCP id.

- [x] **Step 5: Verify install, IPC and multi-project management**

Run: `npx vitest run tests/core/godot-mcp-installer.test.ts tests/core/godot-project-plugins.test.ts tests/integration/plugin-management.test.ts tests/integration/hub-module.test.ts tests/unit/ipc.test.ts`

Expected: PASS for cancel-safe API behavior, current-project binding, idempotence, migration, rollback, status, and unrelated plugin preservation.

## Task 5: Wire the shared service through project and Agent lifecycles

**Files:**
- Modify: `src/main/core/project-core.ts`
- Modify: `src/main/desktop-controller.ts`
- Modify: `src/main/desktop-sessions.ts`
- Modify: `src/main/core/tools/workspace-tools.ts`
- Modify: `src/main/core/tools/approval-policy.ts`
- Modify: `src/main/core/tools/catalog.ts`
- Modify: `src/main/core/tool-catalog.ts`
- Test: `tests/core/workspace-tools.test.ts`
- Test: `tests/core/tool-approvals.test.ts`
- Test: `tests/integration/workspace-agent.test.ts`
- Test: `tests/integration/controller-shared-services.test.ts`

- [x] **Step 1: Write failing Agent registry and execution tests**

Inject a fake `GodotMcpHostRegistry` into `WorkspaceTools`. Assert that `ToolSearch("Godot scene")` returns the registered read-only tools, each tool calls the mapped host operation with parsed arguments, screenshot results reach the existing vision-image extraction path, and no call is made for invalid schemas. Assert the old `GodotScreenshot` and `GodotPluginInstall` names are absent. Under approval modes, the new Godot tools follow the existing read-only desktop rule: `full` and `auto` need no prompt; `ask` requests approval.

- [x] **Step 2: Run focused tests and confirm failure**

Run: `npx vitest run tests/core/workspace-tools.test.ts tests/core/tool-approvals.test.ts tests/integration/workspace-agent.test.ts`

Expected: FAIL because `WorkspaceTools` still uses `GodotScreenshotPlugin`.

- [x] **Step 3: Inject and share the project host**

Add `godotMcpHost` to project/core and session options. `ProjectCore.open()` acquires a host lease for Godot projects; `ProjectCore.close()` releases it. `DesktopController.transition()` closes the previous core before replacing it, and `shutdown()` closes the active core. After Hub/runtime controllers have released their leases, application shutdown calls `closeAll()` as a final cleanup. `DesktopSessions.toolbox()` and child-Agent construction pass the same host instance so sessions for one root do not bind another WebSocket port. Keep a distinct host for each canonical project root.

- [x] **Step 4: Dispatch the registered tools through the shared host**

Add `GodotMcp*` names from `tool-definitions.ts` to `WorkspaceCatalog` only when the active root is a Godot project; dispatch them before external MCP fallback through `godotMcpHost.call(projectRoot, name, input, signal)`. Add all eight read-only names to the approval-policy read-only set. Remove old bridge classes from `WorkspaceTools` construction, execution, and capability descriptions. Expose the official MCP plugin's live status in `SessionCapabilities.plugins`.

- [x] **Step 5: Run Agent and lifecycle tests**

Run: `npx vitest run tests/core/workspace-tools.test.ts tests/core/tool-approvals.test.ts tests/integration/workspace-agent.test.ts tests/integration/controller-shared-services.test.ts`

Expected: PASS, with same-root service reuse, isolated roots, active cancellation, and screenshots passed to the model as images without base64 in text output.

## Task 6: Expose the tools through the official inbound MCP server

**Files:**
- Modify: `src/main/core/tool-catalog.ts`
- Modify: `src/main/core/project-core.ts`
- Modify: `src/main/mcp-server.ts`
- Test: `tests/integration/mcp-server.test.ts`
- Test: `tests/integration/mcp-server-drain.test.ts`

- [x] **Step 1: Add inbound MCP contract tests**

Connect with the existing authenticated Streamable HTTP test client. Assert `tools/list` contains the original review tools plus exactly eight Godot tool names. Call one text tool and both screenshot tools through an injected fake project host. Assert text results remain JSON text and screenshots return an MCP `image` content block with `mimeType: "image/png"`, valid data and a separate dimensions text item; assert no base64 is included in the text item. Verify `taskId` and existing task-state checks still apply.

- [x] **Step 2: Confirm the new integration test fails**

Run: `npx vitest run tests/integration/mcp-server.test.ts`

Expected: FAIL because inbound MCP currently registers only review tools and serializes every result as JSON text.

- [x] **Step 3: Route MCP calls to the project host**

Append the shared Godot tool definitions to `ToolCatalog`. In `ProjectCore.dispatch()`, forward only those parsed tool names to its injected project host. The existing `executeTool()` task wrapper remains the authorization boundary and persists success/failure events as it does for current tools.

- [x] **Step 4: Preserve image content blocks in MCP responses**

In `mcp-server.ts`, detect only a validated `{ mimeType: "image/png", base64, width, height }` result and return an `image` block plus dimension metadata. Keep ordinary outputs on the existing `JSON.stringify` path; strip base64 from the accompanying text block. Transport and project errors remain structured `isError: true` text results.

- [x] **Step 5: Run the official MCP integration tests**

Run: `npx vitest run tests/integration/mcp-server.test.ts tests/integration/mcp-server-drain.test.ts`

Expected: PASS for authentication, tool discovery, scope/task lifecycle, shutdown draining, text response compatibility, and MCP image response shape.

## Task 7: Replace the plugin card and retire old tool presentation

**Files:**
- Modify: `src/renderer/PluginManagementView.tsx`
- Modify: `src/renderer/plugins.css`
- Modify: `src/renderer/ToolsViews.tsx`
- Modify: `src/main/core/tools/catalog.ts`
- Test: `tests/renderer/PluginManagementView.test.tsx`
- Test: `tests/renderer/ToolsViews.test.tsx`

- [x] **Step 1: Add UI tests for confirmation and managed status**

Verify missing state shows “安装并启用”, invokes `window.confirm` with text that says project plugin code will be installed/enabled and Godot must be reloaded, and calls IPC only after acceptance. Verify cancellation makes no IPC call. Verify installed/disabled state asks before enabling; disabling has no install prompt. Verify conflict disables installation and offers directory location. Verify connection and reload-required states are visible and the plugin is not duplicated in the generic Godot plugin list.

- [x] **Step 2: Confirm renderer tests fail**

Run: `npx vitest run tests/renderer/PluginManagementView.test.tsx tests/renderer/ToolsViews.test.tsx`

Expected: FAIL because the renderer still presents “SpecLoom 截图桥” and the old `GodotScreenshot` tool.

- [x] **Step 3: Implement the official plugin card and confirmation gate**

Replace the screenshot card with “SpecLoom Godot MCP”; call `window.confirm()` before both first install and enabling a disabled managed plugin. On confirmation call the single atomic install-and-enable API, then refresh inventory; if the user cancels, leave inventory and filesystem untouched. Show project reload notice only when the IPC result says `restartRequired`. Keep third-party enable/disable and desktop tools unchanged.

- [x] **Step 4: Update status presentation and tool inventory descriptions**

Show installation, enabled, connection, version, conflict and reveal-directory states on the managed card. Remove old screenshot bridge descriptions from `ToolsViews.tsx` and list the eight new read-only names under Godot tools. Keep desktop `screenshot` and input tools displayed.

- [x] **Step 5: Run renderer tests**

Run: `npx vitest run tests/renderer/PluginManagementView.test.tsx tests/renderer/ToolsViews.test.tsx`

Expected: PASS for confirmation acceptance/cancellation, status refresh, conflict handling, and non-duplication.

## Task 8: Update docs, run the full checks, and inspect packaged output

**Files:**
- Create: `docs/plugins/godot-mcp.md`
- Modify: `docs/mcp.md`
- Modify: `docs/plugins/plugin-management.md`
- Modify: `docs/plugins/godot-screenshot.md`
- Modify: `README.md`
- Test: all focused test files listed above

- [x] **Step 1: Document installation, tool allowlist, and migration**

Write `docs/plugins/godot-mcp.md` with Godot version requirement, explicit install confirmation/reload, eight tool schemas and routes, read-only boundary, service-id handshake, 6505–6514 loopback transport, troubleshooting, image handling, and MIT attribution. Change `docs/mcp.md` to explain the eight new inbound tools and that the MCP listener itself remains token-protected on loopback. Update plugin management docs and replace screenshot-bridge documentation with a migration note linking to the new page. Remove obsolete claims that the old screenshot bridge is the supported Godot MCP runtime.

- [x] **Step 2: Run the focused and full test suites**

Check whether a Godot 4.7+ executable is available through `GODOT_EXECUTABLE` or `PATH`. When available, run the addon against a temporary Godot fixture and verify plugin import, service-id handshake, and a screenshot response; otherwise record Godot runtime verification as unavailable in the final result and do not claim it passed.

Run in order:

```powershell
npx vitest run tests/core/godot-mcp-tools.test.ts tests/core/godot-mcp-bridge.test.ts tests/core/godot-mcp-host.test.ts tests/core/godot-mcp-plugin-bundle.test.ts tests/core/godot-mcp-installer.test.ts tests/core/godot-project-plugins.test.ts tests/integration/plugin-management.test.ts tests/integration/hub-module.test.ts tests/integration/workspace-agent.test.ts tests/integration/mcp-server.test.ts tests/integration/mcp-server-drain.test.ts tests/renderer/PluginManagementView.test.tsx tests/renderer/ToolsViews.test.tsx tests/unit/ipc.test.ts
npm run typecheck
npm test
```

Expected: all commands exit 0.
Verification record (2026-10-11): the focused Godot MCP suite passed (14 files, 73 tests), and `npm run typecheck` passed. The serialized full suite completed with 1,256 passed, 11 skipped, and one intermittent renderer failure in `tests/renderer/Races.test.tsx` (saved task continuation); that test passed in isolation and together with `App.test.tsx` (35 tests). Docker-backed suites were skipped because the Docker daemon is unavailable, and no Godot 4.7+ executable was found. The Windows unpacked build completed at `release/verification-godot-mcp/win-unpacked`; all 54 addon files and both license/notice files matched their 56 manifest hashes. If the full suite has unrelated baseline failures, record the failing test names and compare them with the existing dirty-worktree baseline without reverting or resetting any files.

- [x] **Step 3: Build an unpacked package and verify embedded resources**

First inspect whether `release/verification-godot-mcp` exists. If it does, choose a new unused sibling such as `release/verification-godot-mcp-2`. Then run: `npm run build:dir -- --config.directories.output=release/verification-godot-mcp` (replace the output with the unused path chosen above).

Expected: electron-builder completes without replacing existing release artifacts, and the generated packaged resource directory contains the vendored `addons/godot_mcp` files, `manifest.json`, `LICENSE`, and `NOTICE.md`.

- [x] **Step 4: Check the final diff and worktree boundaries**

Run: `git diff --check` and `git status --short`.

Expected: no whitespace errors; only this feature's files are intentionally changed in addition to the pre-existing dirty files. Do not stage, reset, clean, or commit the pre-existing worktree changes.

## Spec coverage

| Approved requirement | Plan coverage |
| --- | --- |
| Exactly eight read-only tools and schemas; no write routes | Tasks 1–2, 5–6 |
| One project bridge shared by Agent and inbound MCP; project isolation | Tasks 2, 5–6 |
| Confirmed install-and-enable, safe updates, conflict reporting, exact old-setting migration | Tasks 4 and 7 |
| Plugin status, reload notice, directory reveal, and separation from third-party plugins | Tasks 4 and 7 |
| MCP authentication/task scope and image content without base64 text/log leakage | Tasks 2 and 6 |
| Preserve desktop screenshot/input tools and remove old Godot polling runtime | Tasks 4–5 and 7 |
| Documentation, full verification, Godot environment honesty, and packaged addon/license | Task 8 |
