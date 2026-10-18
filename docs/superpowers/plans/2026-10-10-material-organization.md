# SpecLoom Material Organization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add a project-owned hierarchical material-group tree and make every material browser page easier to search, filter, and navigate.

**Architecture:** Store category-specific group nodes in the `materialGroups` field of `specs/project.md` front matter, with stable IDs and parent IDs. Materials store `groupId`; legacy `group` labels resolve to imported root groups through preserved `legacyName` values and are converted to IDs when a material is next saved. Reuse the existing document save/version flow, expose one shared left group tree in `MaterialExplorer`, and have `MaterialsList` resolve the same paths.

**Tech Stack:** TypeScript, React 19, Electron IPC, YAML front matter via `yaml`, Vitest, Testing Library.

---

## File map

- Create `src/shared/material-groups.ts` for group-node schemas, category-specific tree normalization, legacy-label import, path resolution, and descendant membership.
- Modify `src/shared/material-catalog.ts` and `src/shared/project-materials.ts` to carry stable group IDs and resolve display paths without changing parent/extends semantics.
- Modify `src/main/core/project-documents.ts` to reject group IDs outside the document's category tree while preserving existing version checks.
- Modify `src/renderer/DocumentsView.tsx`, `src/renderer/MaterialExplorer.tsx`, `src/renderer/MaterialDetails.tsx`, and `src/renderer/navigation-materials.css`; create `src/renderer/MaterialGroupTree.tsx` for reusable tree controls.
- Modify `src/main/core/tools/material-tool-catalog.ts` and `src/main/core/tools/materials.ts` so list results include group paths/tree data and can filter by nested group or entity type.
- Add `tests/unit/material-groups.test.ts`; extend `tests/integration/project-documents.test.ts`, `tests/core/material-tools.test.ts`, and `tests/renderer/MaterialExplorer.test.tsx` for new behavior.
- Update `docs/architecture.md` and the agent material-tools spec document the shared tree and `MaterialsList` fields. `docs/mcp.md` covers the separate inbound review service and has no material-tool contract to update.

## Task 1: Define and test the hierarchical group model

**Files:**
- Create: `src/shared/material-groups.ts`
- Test: `tests/unit/material-groups.test.ts`
- Modify: `src/shared/material-catalog.ts`

- [x] **Step 1: Write failing model tests.** Cover category isolation, imported legacy labels, parent/child paths, descendants, stable IDs, duplicate siblings, missing parents, and cycles. Example assertions:

```ts
const groups = importLegacyGroups("entity", ["基础实体", "前院"]);
expect(resolveLegacyGroup(groups, "前院")?.name).toBe("前院");
expect(materialGroupPath(groups, "shooters")).toBe("基础实体 / 植物 / 射手");
expect(groupIncludes(groups, "plants", "shooters")).toBe(true);
expect(groupIncludes(groups, "plants", "front-yard")).toBe(false);
expect(validateMaterialGroups([{ id: "a", name: "A", parentId: "b" }, { id: "b", name: "B", parentId: "a" }])).toContain("cycle");
```

- [x] **Step 2: Run the new test and confirm it fails because the group module is missing.**

Run: `npm test -- tests/unit/material-groups.test.ts`

Expected: FAIL with unresolved exports from `src/shared/material-groups.ts`.

- [x] **Step 3: Implement the minimal group model.** Export `MaterialGroup`, `MaterialGroupRegistry`, `normalizeMaterialGroups`, `importLegacyGroups`, `resolveLegacyGroup`, `materialGroupPath`, `groupIncludes`, and `validateMaterialGroups`. Group node fields are `id`, `name`, optional `parentId`, optional `legacyName`, and `order`. Reject blank names, path separators, repeated IDs, duplicate sibling names, missing parents, and cycles.

- [x] **Step 4: Run the focused test and confirm it passes.**

Run: `npm test -- tests/unit/material-groups.test.ts`

Expected: PASS with all group-model assertions green.

- [x] **Step 5: Add group IDs and resolved paths to summaries.** Update `MaterialSummary` with optional `groupId` and `groupPath`; keep `group` as the compatibility display label. `summarizeMaterial(file, groups)` reads `groupId` when present, resolves the full path, and otherwise maps legacy `group` to a root node by `legacyName`.

## Task 2: Persist project group trees and validate assignments

**Files:**
- Modify: `src/shared/project-materials.ts`
- Modify: `src/main/core/project-documents.ts`
- Modify: `src/main/core/validator-markdown.ts`
- Test: `tests/integration/project-documents.test.ts`
- Test: `tests/unit/project-materials.test.ts`

- [x] **Step 1: Write failing front-matter tests.** Verify `materialGroups` round-trips in `specs/project.md`, an existing legacy `group` remains readable until save, a valid `groupId` is accepted, and an ID belonging to another category is rejected. Use `ProjectCore.open(root)` in `tests/integration/project-documents.test.ts` and save entity Markdown with its returned version.

```ts
expect(parseMaterial(writeMaterial({ id: "p", materialGroups: registry }, "# P"))?.data.materialGroups).toEqual(registry);
const core = await ProjectCore.open(root);
await expect(core.saveDocument("specs/entities/hero.md", writeMaterial({ schemaVersion: 1, id: "hero", title: "Hero", type: "entity", description: "", groupId: "setting-group" }, "# Hero"), "absent"))
  .rejects.toMatchObject({ code: "VALIDATION_FAILED" });
```

- [x] **Step 2: Run the focused tests and confirm the missing validation fails.**

Run: `npm test -- tests/unit/project-materials.test.ts tests/integration/project-documents.test.ts`

Expected: FAIL because `groupId` is not yet parsed or checked against the project registry.

- [x] **Step 3: Implement category-aware assignment resolution and validation.** Read `specs/project.md` through the existing versioned document flow, parse its `materialGroups`, infer category using `categoryForPath`, and validate any submitted `groupId` against that category. Resolve legacy `group` labels through a node's preserved `legacyName`; do not rewrite every project material on open. On a successful manual or agent save, write the resolved `groupId` and remove the old `group` field; do not change the file path or `parent` / `extends` fields. Saving the project registry validates its tree before persistence.

- [x] **Step 4: Run focused tests and verify version conflicts still pass through unchanged.**

Run: `npm test -- tests/unit/project-materials.test.ts tests/integration/project-documents.test.ts`

Expected: PASS, including the pre-existing version-conflict and Markdown-validation cases.

## Task 3: Build the reusable group tree and browser filters

**Files:**
- Create: `src/renderer/MaterialGroupTree.tsx`
- Modify: `src/renderer/MaterialExplorer.tsx`
- Modify: `src/renderer/DocumentsView.tsx`
- Modify: `src/renderer/navigation-materials.css`
- Test: `tests/renderer/MaterialExplorer.test.tsx`

- [x] **Step 1: Add failing browser behavior tests.** Verify an entity with `type: enemy` appears after selecting the enemy filter, group and type filters intersect, a parent selection includes descendants, counts include descendants, and empty groups remain visible with a zero count.

```tsx
fireEvent.click(screen.getByRole("treeitem", { name: /基础实体/ }));
fireEvent.change(screen.getByLabelText("实体类型"), { target: { value: "enemy" } });
expect(screen.getByRole("button", { name: "查看 前院守卫" })).toBeVisible();
expect(screen.queryByRole("button", { name: "查看 主角" })).not.toBeInTheDocument();
expect(screen.queryByRole("button", { name: "查看 长剑" })).not.toBeInTheDocument();
```

- [x] **Step 2: Run the renderer test and confirm it fails on the missing tree/type controls.**

Run: `npm test -- tests/renderer/MaterialExplorer.test.tsx`

Expected: FAIL because the explorer has no nested tree or entity-type selector.

- [x] **Step 3: Implement the two-pane browser.** Put search, the entity type selector, component source filter, and grid/list buttons above the content area. Render `MaterialGroupTree` as a left pane with “全部资料” and “未分组”, expandable parent nodes, descendant counts, selected state, and explicit empty states. Filter by text, selected group plus descendants, and entity type as an intersection. Keep the official/custom component identity independent from group selection. Load `specs/project.md` in every category catalog so all pages read the same registry.

- [x] **Step 4: Style the desktop layout and preserve narrow-window behavior.** In `navigation-materials.css`, use a fixed-width group pane and a `minmax(0, 1fr)` content pane; below the existing desktop breakpoint collapse the group pane behind an accessible toggle. Preserve card/list styles and the current selected-material behavior.

- [x] **Step 5: Run the focused renderer test and confirm it passes.**

Run: `npm test -- tests/renderer/MaterialExplorer.test.tsx`

Expected: PASS for nested filtering, legacy group display, empty groups, type facets, component source facets, and saved view mode.

## Task 4: Add group-tree management and hierarchical assignment UI

**Files:**
- Modify: `src/renderer/MaterialGroupTree.tsx`
- Modify: `src/renderer/MaterialExplorer.tsx`
- Modify: `src/renderer/MaterialDetails.tsx`
- Modify: `src/renderer/DocumentsView.tsx`
- Test: `tests/renderer/MaterialExplorer.test.tsx`
- Test: `tests/renderer/Materials.test.tsx`

- [x] **Step 1: Add failing management and assignment tests.** Cover creating a root group and child group, rename by stable ID, moving a subtree without changing assigned IDs, blocking delete when a node contains materials or children, and choosing nested groups in the details editor.

```tsx
fireEvent.click(screen.getByRole("button", { name: "新建子分组" }));
fireEvent.change(screen.getByLabelText("分组名称"), { target: { value: "射手" } });
fireEvent.click(screen.getByRole("button", { name: "创建分组" }));
expect(await screen.findByRole("treeitem", { name: /射手/ })).toBeVisible();
```

- [x] **Step 2: Run the renderer tests and verify the group-management controls are absent.**

Run: `npm test -- tests/renderer/MaterialExplorer.test.tsx tests/renderer/Materials.test.tsx`

Expected: FAIL on the new management controls and hierarchical selector.

- [x] **Step 3: Implement group operations through versioned project-document saves.** Read the latest `specs/project.md` before each mutation and save with its current version. Reject duplicate siblings, cycles, cross-category moves, and deletion of non-empty groups. Preserve the current editor draft if registry persistence returns `VERSION_CONFLICT`.

- [x] **Step 4: Replace the details free-text group field with a category-scoped hierarchical selector.** Show indented full paths, support “未分组”, resolve legacy names to imported root nodes, and save `groupId` only after choosing a valid node.

- [x] **Step 5: Run both focused renderer test files and verify all interaction tests pass.**

Run: `npm test -- tests/renderer/MaterialExplorer.test.tsx tests/renderer/Materials.test.tsx`

Expected: PASS with non-empty deletion blocked and assignment preserved after reload.

## Task 5: Keep agent material queries on the same group model

**Files:**
- Modify: `src/main/core/tools/material-tool-catalog.ts`
- Modify: `src/main/core/tools/materials.ts`
- Modify: `src/main/core/agent-prompts.ts`
- Test: `tests/core/material-tools.test.ts`

- [x] **Step 1: Add failing tool tests.** Verify `MaterialsList` returns full group paths, nested/empty group nodes, and stable IDs; filtering by group ID includes descendants; filtering by entity type intersects with category, group, and query. Verify create/update accept only IDs from the material's category.

```ts
const result = await materials.list({ category: "entity", groupId: "basic", entityType: "enemy" });
expect(result.groupTree).toEqual(expect.arrayContaining([expect.objectContaining({ id: "basic", children: expect.any(Array) })]));
expect(result.items.map((item) => item.id)).toEqual(["front-yard-guard"]);
```

- [x] **Step 2: Run the material-tool tests and confirm they fail because nested groups are not returned or filtered.**

Run: `npm test -- tests/core/material-tools.test.ts`

Expected: FAIL on missing nested `groupTree` results and `groupId` / `entityType` filtering.

- [x] **Step 3: Implement tool parity.** Parse the same `specs/project.md` registry and enrich summaries with resolved paths. Keep the existing `groups` string array and `group` text filter compatible; add a structured `groupTree` including empty nodes, add `groupId` plus full `groupPath` to item summaries, and accept `groupId` and `entityType` on `MaterialsList` (selecting a parent ID includes descendants). Add `groupId` to `MaterialCreate` / `MaterialUpdate`; reject assignments to missing or cross-category IDs. Update the agent prompt to tell the agent to use group IDs and paths returned by `MaterialsList`.

- [x] **Step 4: Run the focused material-tool tests.**

Run: `npm test -- tests/core/material-tools.test.ts`

Expected: PASS for nested groups, empty groups, category validation, legacy string filters, group-ID filtering, and entity-type filtering.

## Task 6: Verify integration and update user documentation

**Files:**
- Modify: `docs/architecture.md`
- Modify: `docs/mcp.md`
- Test: `tests/renderer/MaterialExplorer.test.tsx`
- Test: `tests/core/material-tools.test.ts`
- Test: existing `tests/integration/project-documents.test.ts`

- [x] **Step 1: Add an integration regression for a legacy project.** Load entity files with only `group` labels and no registry, then verify labels appear as root groups, search and filtering work, first material save replaces `group` with a stable `groupId`, and reopening resolves the same path.
- [x] **Step 2: Run focused tests for each changed subsystem.**

Run: `npm test -- tests/unit/material-groups.test.ts tests/unit/project-materials.test.ts tests/integration/project-documents.test.ts tests/core/material-tools.test.ts tests/renderer/MaterialExplorer.test.tsx tests/renderer/Materials.test.tsx`

Expected: PASS with all listed test files green.

- [x] **Step 3: Run static verification.**

Run: `npm run typecheck`

Expected: main, renderer, and tool TypeScript checks pass.

- [x] **Step 4: Document persistence and tool behavior.** Explain the category-specific group tree, `groupId` assignment, legacy `group` compatibility, `MaterialsList.groupId` descendant semantics, and entity `type` filter in the architecture and agent material-tools documentation. `docs/mcp.md` covers the separate inbound review service and contains no material-tool contract to update.

## Review checklist

- Every design goal maps to Tasks 1–6.
- Resource file paths and `parent` / `extends` remain unchanged.
- Group mutations use existing expected-version checks; group deletion cannot discard assigned materials.
- Entity filters use the existing type metadata; other categories do not gain invented subtype fields.
- Agent listing and the renderer resolve the same registry and group paths.
- Do not commit automatically: this checkout already contains unrelated user changes, so leave the task as a scoped, reviewable diff.

## Implementation verification

- Focused material suite: 6 files, 77 tests passed; after the final lint fixes, the changed group model, tool, and explorer suites passed again (3 files, 35 tests).
- `npm run typecheck` passed for main, renderer, and tools; ESLint passed for the changed TypeScript sources and tests.
- A full-suite attempt encountered worker timeouts in session and hub tests, so it is not recorded as a clean full-suite pass.
