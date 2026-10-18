# SpecLoom Plugin Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add a first-class plugin page that safely manages the SpecLoom screenshot bridge and lists, filters, enables/disables, and reveals installed Godot project plugins.

**Architecture:** A main-process `GodotProjectPluginManager` scans and updates the currently open Godot project with `PathPolicy`, bounded metadata parsing, and optimistic file comparisons. Strict shared contracts bridge that service through IPC and the existing Trailblazer Hub runtime; the renderer adds a dedicated navigation page with local search and status filters. Release the completed feature as SpecLoom 0.1.6 and rebuild the Hub module.

**Tech Stack:** TypeScript, Node `fs/promises`, Zod, Electron IPC/shell, React, Vitest, Vite, electron-builder.

---

## Scope and file map

- `src/shared/godot-plugins.ts` — strict inventory and mutation argument/result schemas and shared types.
- `src/main/core/plugins/godot-project-plugins.ts` — bounded scanner, metadata parser, status resolution, safe settings edits, and screenshot bridge orchestration.
- `src/main/desktop-controller.ts` — bind all manager requests to `currentCore()` and reject non-Godot projects.
- `src/main/ipc.ts` — strict operations, dispatch, and main-process reveal callback; the renderer sends IDs, never paths.
- `src/main/main.ts`, `src/main/hub-module.ts` — both hosts wire validated directory reveal to Electron `shell.showItemInFolder`.
- `src/shared/desktop-api.ts`, `src/main/preload.ts` — typed and context-isolated plugin management API.
- `src/renderer/App.tsx` — add the independent “插件” navigation entry and retained page route.
- `src/renderer/PluginManagementView.tsx`, `src/renderer/plugins.css` — built-in bridge card, project plugin list, search, filters, empty/error states, action feedback.
- `tests/core/godot-project-plugins.test.ts` — parser, bounds, path safety, inventory, and mutation tests using temporary projects.
- `tests/unit/ipc.test.ts`, `tests/integration/plugin-management.test.ts`, `tests/integration/hub-module.test.ts` — IPC validation, desktop controller behavior, and Hub parity.
- `tests/renderer/PluginManagementView.test.tsx`, `tests/renderer/App.test.tsx` — controls, filtering, navigation, and project-change behavior.
- `docs/plugins/plugin-management.md`, `docs/trailblazer-hub-module.md`, `docs/release-0.1.6.md` — user-facing scope, module version, release record and checksums.
- `package.json`, `package-lock.json` — bump the app and module release version from 0.1.5 to 0.1.6.

The checkout already contains extensive unrelated dirty and untracked files, including changes in several planned files. Do not stage or commit whole existing files during inline execution; preserve the current shared working tree and record the release artifacts and validation in docs.

## Task 1: Define plugin contracts and a bounded Godot project scanner

**Files:**
- Create: `src/shared/godot-plugins.ts`
- Create: `src/main/core/plugins/godot-project-plugins.ts`
- Test: `tests/core/godot-project-plugins.test.ts`

- [x] **Step 1: Add failing inventory and parser tests.** Create temporary Godot fixtures containing `project.godot`, standard and malformed `plugin.cfg` files, a disabled addon, an enabled addon, and an enabled reference to a missing config. Verify only addon directories with a config or an enabled reference are returned.

```ts
it("lists project plugins and retains an enabled reference whose config disappeared", async () => {
  const manager = new GodotProjectPluginManager(root);
  const inventory = await manager.list();
  expect(inventory.plugins.map(({ id }) => id)).toEqual([
    "addons/dialogue/plugin.cfg",
    "addons/missing/plugin.cfg",
    "addons/texture/plugin.cfg",
  ]);
  expect(inventory.plugins.find(({ id }) => id.includes("missing"))).toMatchObject({
    enabled: true, metadataValid: false, issue: "missing_config",
  });
});
```

- [x] **Step 2: Run the focused test and confirm it fails before implementation.**

Run: `npx vitest run tests/core/godot-project-plugins.test.ts`

Expected: FAIL because the manager and schemas do not exist.

- [x] **Step 3: Add strict shared schemas and scanner types.** Define `GodotPluginEntrySchema`, `ScreenshotBridgeEntrySchema`, `PluginInventorySchema`, and bounded request schemas. The inventory contains `screenshotBridge`, `plugins`, and `scanLimitReached`; plugin IDs are project-relative `addons/<one direct child>/plugin.cfg` identifiers. Do not include project absolute paths or raw config text.

- [x] **Step 4: Implement the scanner and safe metadata parser.** `GodotProjectPluginManager.list()` must:
  - verify `project.godot` is a supported Godot project;
  - read at most 1 MiB of project settings and parse at most 1,024 enabled entries;
  - inspect at most 512 direct children of `addons/` and at most 64 KiB per `plugin.cfg`;
  - parse only string keys in `[plugin]`, enforce the spec's name/author/version/description length limits, and never evaluate the `script` value;
  - reject symlinks, junctions, traversal, and paths outside the project root through `PathPolicy`;
  - return a malformed or missing-config warning row without failing the rest of the inventory;
  - keep the screenshot bridge out of the ordinary plugin list and report its file and project-setting status separately.

- [x] **Step 5: Add scanner tests for malformed, over-limit, and unsafe project inputs.** Assert a malformed plugin does not hide valid siblings, oversized files and scan overflow are surfaced safely, non-Godot projects fail clearly, and traversal/reparse points are never returned as usable plugin IDs.

- [x] **Step 6: Run the focused scanner suite.**

Run: `npx vitest run tests/core/godot-project-plugins.test.ts`

Expected: PASS with bounded metadata only.

## Task 2: Implement conflict-safe plugin toggles and screenshot bridge lifecycle

**Files:**
- Modify: `src/main/core/plugins/godot-project-plugins.ts`
- Modify: `src/main/core/plugins/godot-screenshot.ts`
- Test: `tests/core/godot-project-plugins.test.ts`
- Test: `tests/core/godot-screenshot.test.ts`

- [x] **Step 1: Add failing settings mutation tests.** Cover enabling/disabling one addon while preserving other entries and unrelated settings, duplicate idempotence, malformed `PackedStringArray` rejection, and a concurrent project-file change between read and write.

```ts
it("toggles only the selected addon and preserves the other enabled entries", async () => {
  const manager = new GodotProjectPluginManager(root);
  await manager.setPluginEnabled("addons/dialogue/plugin.cfg", true);
  const settings = await readFile(path.join(root, "project.godot"), "utf8");
  expect(settings).toContain('"res://addons/other/plugin.cfg"');
  expect(settings).toContain('"res://addons/dialogue/plugin.cfg"');
  expect(settings).toContain('config/name="Fixture"');
});
```

- [x] **Step 2: Run the focused tests and verify they fail.**

Run: `npx vitest run tests/core/godot-project-plugins.test.ts tests/core/godot-screenshot.test.ts`

Expected: FAIL because safe toggle operations are missing.

- [x] **Step 3: Implement safe `PackedStringArray` updates.** Parse a bounded, supported Godot array syntax into string entries; reject unknown syntax rather than overwriting it. Change only the selected exact `res://addons/.../plugin.cfg` entry. Compare the original file bytes before atomic replacement; return a conflict error if another writer changed the file. Preserve all other plugin entries and unrelated settings.

- [x] **Step 4: Add screenshot bridge enable/disable and missing install behavior.** Reuse `GodotScreenshotPlugin.install()` for the bundled bridge. Enabling registers its editor plugin and owned `SpecLoomCapture` autoload; disabling removes only the bridge entry and the autoload value that exactly matches the bridge-owned value. Never delete plugin files. Distinguish missing, ready, incomplete, and conflicting resources; do not overwrite changed files or a conflicting autoload.

- [x] **Step 5: Test bridge status, toggles, idempotence, conflicts, and ownership.** Verify another autoload survives disable, modified bridge files block install, missing bridge files can be installed without overwriting existing entries, and failed writes leave project settings unchanged.

- [x] **Step 6: Run the focused core suites.**

Run: `npx vitest run tests/core/godot-project-plugins.test.ts tests/core/godot-screenshot.test.ts`

Expected: PASS.

## Task 3: Bind management to the active project and expose strict IPC in both hosts

**Files:**
- Modify: `src/main/desktop-controller.ts`
- Modify: `src/main/ipc.ts`
- Modify: `src/main/main.ts`
- Modify: `src/main/hub-module.ts`
- Modify: `src/main/preload.ts`
- Modify: `src/shared/desktop-api.ts`
- Modify: `tests/unit/ipc.test.ts`
- Create: `tests/integration/plugin-management.test.ts`
- Modify: `tests/integration/hub-module.test.ts`

- [x] **Step 1: Add failing controller and IPC tests.** Assert each call targets `currentCore().metadata.path`, generic projects are rejected, unknown IDs and arbitrary path payloads are rejected, and reveal uses only a backend-resolved path.

```ts
it("rejects absolute paths instead of accepting renderer-selected reveal targets", async () => {
  const reply = await call("pluginsRevealDirectory", { id: "C:\\private" });
  expect(reply).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
  expect(showItemInFolder).not.toHaveBeenCalled();
});
```

- [x] **Step 2: Run focused IPC/controller tests and confirm they fail.**

Run: `npx vitest run tests/unit/ipc.test.ts tests/integration/plugin-management.test.ts`

Expected: FAIL because the operations and controller methods are absent.

- [x] **Step 3: Add desktop API and validated IPC operations.** Add a `pluginManagement` API with `list`, `setGodotPluginEnabled`, `setScreenshotBridgeEnabled`, `installScreenshotBridge`, and `revealDirectory`, backed by IPC operations `pluginsList`, `pluginsSetGodotPluginEnabled`, `pluginsSetScreenshotBridgeEnabled`, `pluginsInstallScreenshotBridge`, and `pluginsRevealDirectory`. Use strict schemas with bounded plugin IDs and booleans. Reveal targets are exactly `project`, `screenshot-bridge`, or a scanned plugin ID. Keep the active project root in the controller; do not accept a project path from the renderer.

- [x] **Step 4: Wire safe directory reveal in standalone and Hub.** Have the controller resolve an ID to the project root or a verified addon directory. Extend `IpcOptions` with a main-process reveal callback and pass `shell.showItemInFolder` from `main.ts` and `hub-module.ts`. The callback receives only the verified path and the path is never returned across IPC.

- [x] **Step 5: Implement dispatch and controller methods.** Recreate the manager from the current core path for each operation, reject generic projects, dispatch each strict request, and return only the inventory/mutation result. Keep Hub per-window request-controller behavior and operation serialization intact.

- [x] **Step 6: Add Hub parity tests.** Exercise listing, one project plugin toggle, screenshot bridge status, and reveal callback in the Hub runtime test harness; assert no request accepts an arbitrary path.

- [x] **Step 7: Run focused integration checks.**

Run: `npx vitest run tests/unit/ipc.test.ts tests/integration/plugin-management.test.ts tests/integration/hub-module.test.ts`

Expected: PASS for standalone controller and Hub module APIs.

## Task 4: Add the independent plugin page and project navigation

**Files:**
- Create: `src/renderer/PluginManagementView.tsx`
- Create: `src/renderer/plugins.css`
- Modify: `src/renderer/App.tsx`
- Test: `tests/renderer/PluginManagementView.test.tsx`
- Test: `tests/renderer/App.test.tsx`

- [x] **Step 1: Add failing renderer tests.** Cover the separate screenshot bridge card, project plugin rows, search over name/description/author/path, all/enabled/disabled/attention filters, disabled invalid entries, missing-project and empty states, refresh, locate, and mutation feedback.

```tsx
it("filters by metadata and status without changing plugin files", async () => {
  render(<PluginManagementView api={pluginApi} project={godotProject} onError={onError} />);
  await screen.findByText("Dialogue Manager");
  await user.type(screen.getByPlaceholderText("搜索名称、说明、作者或目录"), "对话");
  expect(screen.getByText("Dialogue Manager")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "已禁用" }));
  expect(screen.queryByText("Dialogue Manager")).not.toBeInTheDocument();
});
```

- [x] **Step 2: Run the renderer test and verify it fails.**

Run: `npx vitest run tests/renderer/PluginManagementView.test.tsx`

Expected: FAIL because the page does not exist.

- [x] **Step 3: Implement the retained navigation route.** Add a `plugins` tab entry to `App.tsx`, position it in the existing “工具” navigation group, and mount it through `NavigationPage`. Key page data by the current project path so switching projects invalidates prior state.

- [x] **Step 4: Implement plugin controls and display states.** Load the inventory on first visit, project change, and manual refresh. Filter/sort the safe list locally. Disable mutation controls while an action is pending; after a successful action reload inventory and show the required Godot reload notice. Use `aria-label`/`aria-pressed` on status controls and toggles.

- [x] **Step 5: Add matching light/dark styles and responsive list behavior.** Use existing theme tokens (`--bg-surface`, `--border`, `--accent`, `--text-muted`) and ensure the columns wrap or become stacked at narrow content widths.

- [x] **Step 6: Run focused renderer tests.**

Run: `npx vitest run tests/renderer/PluginManagementView.test.tsx tests/renderer/App.test.tsx`

Expected: PASS, including collapsed navigation labels and route activation.

## Task 5: Document scope and prepare the 0.1.6 release

**Files:**
- Create: `docs/plugins/plugin-management.md`
- Modify: `docs/trailblazer-hub-module.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `docs/release-0.1.6.md`

- [x] **Step 1: Document the feature and its limits.** Explain the screenshot bridge's built-in setup, how project plugin metadata is read, the search/status controls, where enable state is written, the Godot reload requirement, and that third-party installation/uninstallation is not supported.

- [x] **Step 2: Bump both root package version fields to 0.1.6.** Update only the `version` field in `package.json` and the root package record in `package-lock.json`; preserve existing dependency selections.

- [x] **Step 3: Update the Hub module release documentation.** Record module version 0.1.6, the existing host API/minimum-host requirements, multi-instance support, and the plugin manager's use of the verified Electron shell action.

- [x] **Step 4: Run schema, docs, and build-input checks.**

Run: `npm run typecheck`

Expected: PASS before packaging.

## Task 6: Verify the implementation and produce release artifacts

**Files:**
- Modify: `docs/release-0.1.6.md`
- Build output: `release/0.1.6/`
- Build output: `../TraiblazerHub/exports/specloom-module-0.1.6.zip`

- [x] **Step 1: Run focused tests for core, IPC, Hub and renderer.**

Run: `npx vitest run tests/core/godot-project-plugins.test.ts tests/core/godot-screenshot.test.ts tests/unit/ipc.test.ts tests/integration/plugin-management.test.ts tests/integration/hub-module.test.ts tests/renderer/PluginManagementView.test.tsx tests/renderer/App.test.tsx`

Expected: all targeted tests pass.

- [ ] **Step 2: Run project checks.**

Run: `npm run typecheck`

Expected: all three TypeScript projects pass.

Run: `npm run lint`

Expected: no lint errors.

Run: `npm test`

Result: typecheck and lint pass. The full suite ran with 89 files passing, 19 failing, 5 skipped; 1,185 tests passed, 56 failed, 14 skipped, with 2 unhandled errors. The failure areas are recorded in `docs/release-0.1.6.md`; plugin-management focused tests pass.

- [x] **Step 3: Build the desktop release and Hub module.**

Run: `npm run build -- --config.directories.output=release/0.1.6`

Expected: installer and portable x64 artifacts are produced with version 0.1.6.

Run: `npm run module:build`

Expected: `../TraiblazerHub/exports/specloom-module-0.1.6.zip` is built and its manifest declares version 0.1.6, host API 2, minimum host 0.1.6, and `multiInstance: true`.

- [x] **Step 4: Verify checksums and update release notes.** Record artifact size, SHA-256, module manifest fields, validation commands/results, and any known suite caveats in `docs/release-0.1.6.md`; verify the Windows installer reports product/file version 0.1.6 and leave the previous 0.1.5 release artifacts intact.

## Plan self-review

- Spec coverage: independent navigation and two plugin sections are Task 4; bounded scan and metadata rules are Task 1; project-setting toggles, bridge ownership, and conflicts are Task 2; active-project scope, IPC validation, directory reveal, and Hub parity are Task 3; limits and reload feedback are Tasks 4–5; tests and packaging are Task 6.
- Type consistency: the manager inventory shape is `screenshotBridge`, `plugins`, and `scanLimitReached`; each plugin row uses an `addons/.../plugin.cfg` ID; separate mutation methods distinguish ordinary project plugins and the built-in bridge. IPC carries IDs only, while the controller resolves absolute paths internally.
- Commit safety: this shared checkout already has extensive unrelated dirty changes in many planned files. Do not create implementation commits that would capture those changes; keep edits reviewable and report the exact modified files.
