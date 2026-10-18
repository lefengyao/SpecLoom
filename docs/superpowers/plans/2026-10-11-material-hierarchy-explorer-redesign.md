# Materials Hierarchy Explorer Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all six project material pages easier to browse by adding a parent-aware hierarchy list and horizontal relationship graph, while preserving cards, category filters, group navigation, selection, and existing document editing behavior.

**Architecture:** Derive all three display modes from the already-loaded `MaterialSummary[]`. Keep matching results separate from the projected parent tree so unmatched ancestors can provide context without affecting counts. Add a reusable hierarchy list and a graph renderer backed by a pure layout function; both select through the existing `onSelect` flow. Keep `parent`, `extends`, component bindings, and group assignment as distinct concepts.

**Tech Stack:** React 19, TypeScript, Lucide icons, existing CSS variables, Vitest + Testing Library, Playwright Electron E2E. Do not add graph dependencies or alter material storage formats.

---

## Implementation tasks

### Task 1: Project filtered matches into a parent tree with ancestor context

**Files:**
- Modify `src/renderer/materials-model.ts`
- Add `tests/renderer/materials-model.test.ts`

- [x] **Step 1: Add failing projection tests** for a matching child retaining its unmatched parent as context, multiple matching siblings sharing one context ancestor, matching parents remaining normal nodes, and unrelated branches disappearing.
- [x] **Step 2: Add error-tree tests** for missing parents, cycles, and unparsed materials remaining reachable when their materials match, while synthetic buckets never become parent edges or inflate the match set.
- [x] **Step 3: Extend the tree node shape** with an explicit context-only marker and add a pure projection helper that takes the full `materialTree()` result plus matched material paths. Preserve the source tree and its special error/unparsed buckets; mark only non-matching ancestors as context.
- [x] **Step 4: Run the focused model tests** with `npm test -- tests/renderer/materials-model.test.ts` and confirm the projection semantics.

### Task 2: Add the shared hierarchical list view

**Files:**
- Add `src/renderer/MaterialHierarchyList.tsx`
- Add `tests/renderer/MaterialHierarchyList.test.tsx`
- Modify `src/renderer/navigation-materials.css`

- [x] **Step 1: Add failing list tests** for nested `parent` rows, root labels, collapse/expand behavior, selected-row state, and clicking a row calling the existing path-selection callback.
- [x] **Step 2: Cover row metadata**: entity type on entity pages, official/custom source on component pages, direct parent, and group path. Context ancestors must look subdued and be identified as path context while remaining navigable. Selecting a material must expand its ancestor path.
- [x] **Step 3: Implement the recursive list** with a visible column header, indentation and branch disclosure controls. Reuse native buttons for row selection and preserve keyboard activation; do not infer hierarchy from groups, `extends`, or component bindings.
- [x] **Step 4: Style the list** with the existing theme variables, clear selected/hover states, bounded result scrolling, and a narrow-width layout that keeps hierarchy and metadata readable.
- [x] **Step 5: Run the focused list tests** with `npm test -- tests/renderer/MaterialHierarchyList.test.tsx`.

### Task 3: Build a horizontal parent graph without external dependencies

**Files:**
- Add `src/renderer/material-graph-layout.ts`
- Add `src/renderer/MaterialRelationshipGraph.tsx`
- Add `tests/renderer/material-graph-layout.test.ts`
- Add `tests/renderer/MaterialRelationshipGraph.test.tsx`
- Modify `src/renderer/navigation-materials.css`

- [x] **Step 1: Add failing layout tests** for deterministic left-to-right depth columns, sibling ordering, parent-centered vertical placement, and edges connecting only real parent/child material nodes.
- [x] **Step 2: Add graph-renderer tests** for node metadata, selection, branch collapse, context-only ancestors, fit/zoom controls, and bounded internal panning/scrolling.
- [x] **Step 3: Implement a pure graph layout function** that assigns node positions by depth and leaf order, then emits connector endpoints for the `parent` tree. Exclude synthetic error/unparsed buckets from graph edges and expose those materials in a separate repair list within the graph view.
- [x] **Step 4: Implement the graph canvas** using SVG connectors and positioned HTML nodes. Keep zoom and horizontal/vertical scrolling inside the canvas, provide fit and zoom controls, and reuse shared expansion/selection state supplied by `MaterialExplorer`.
- [x] **Step 5: Keep relationship semantics explicit**: graph edges represent only `parent`; context ancestors are visually subdued and excluded from result counts; error and unparsed entries link to their existing editable material paths without drawing invalid edges.
- [x] **Step 6: Run the focused graph tests** with `npm test -- tests/renderer/material-graph-layout.test.ts tests/renderer/MaterialRelationshipGraph.test.tsx`.

### Task 4: Integrate the three views and unify category filtering

**Files:**
- Modify `src/renderer/MaterialExplorer.tsx`
- Modify `src/renderer/DocumentsView.tsx`
- Modify `src/renderer/navigation-materials.css`
- Modify `tests/renderer/MaterialExplorer.test.tsx`
- Modify `tests/renderer/NavigationMaterials.test.tsx`

- [x] **Step 1: Add failing explorer tests** that render the same controls for entity, component, setting, map, UI, and spec pages; verify list as the default when no preference is stored, valid persisted `icons`/`list`/`graph` preferences, and invalid preference fallback to `list`.
- [x] **Step 2: Test shared state across mode changes**: the same search, entity type or component source, group selection, selected material, group-tree expansion, and relationship branch state remain in effect when switching views; the switch makes no additional `documents`, `projectTree`, or `readDocument` calls.
- [x] **Step 3: Test ancestor context and counts** for a child matched by search/type/source with an unmatched parent. The list and graph show the parent as context, the count reports only matches, and cards contain only matches.
- [x] **Step 4: Replace the two-value view state** with `icons | list | graph`; read/write `specloom.materials.view`, default safely to `list`, retain existing stored `icons` and `list` choices, and add a graph toolbar control.
- [x] **Step 5: Derive matching materials once** from the existing search, category-specific filters, and group selection. Feed the same matches and the full category parent tree to each hierarchy renderer; use the projection from Task 1 for ancestor context.
- [x] **Step 6: Remove official/custom component tree partitioning** from both the explorer and the category semantic tree in `DocumentsView`. Keep the parent tree continuous across source boundaries and show the same source badge in cards, list rows, and graph nodes; filter using existing `componentScope` values.
- [x] **Step 7: Preserve counts, group paths, and empty states** for all/ungrouped/empty-group selections and filtered results. Show current group path and match count, plus total catalog count when extra filters are active. Keep the group registry/tree independent from the material parent tree and retain existing selection and file-open callbacks.
- [x] **Step 8: Update component-browser tests** that currently expect separate official/custom sections; assert one continuous parent hierarchy with source labels instead.
- [x] **Step 9: Run integration tests** with `npm test -- tests/renderer/MaterialExplorer.test.tsx tests/renderer/NavigationMaterials.test.tsx`.

### Task 5: Clarify relationship semantics in material details

**Files:**
- Modify `src/renderer/MaterialDetails.tsx`
- Modify `src/renderer/materials.css`
- Modify `tests/renderer/Materials.test.tsx`

- [x] **Step 1: Add failing details tests** asserting that the UI explains `父级资料` as list/graph hierarchy, `继承自` as entity-template inheritance, `分组` as independent filing/filtering, and component bindings as composition rather than parent hierarchy.
- [x] **Step 2: Add a persistence regression test** that edits each relation independently and verifies `parent`, `extends`, and group assignment continue to save to their existing fields without changing component bindings.
- [x] **Step 3: Visually separate the relationship controls** with concise helper copy and section styling. Keep current candidate validation, cycle prevention, save flow, and data fields unchanged.
- [x] **Step 4: Run the focused detail tests** with `npm test -- tests/renderer/Materials.test.tsx`.

### Task 6: Verify the complete material browsing experience

**Files:**
- Modify `src/renderer/MaterialExplorer.tsx`
- Modify `src/renderer/navigation-materials.css`
- Modify `src/renderer/materials.css`
- Modify `tests/renderer/MaterialExplorer.test.tsx`
- Modify `tests/e2e/navigation-materials.spec.ts`
- Modify any affected tests from Tasks 1–5 only where the final visual/accessibility behavior requires it

- [x] **Step 1: Add an Electron E2E scenario** that opens a project with nested entities and mixed official/custom components, switches list → graph → cards, filters by entity type and component source, selects a node, and verifies the correct existing details editor opens.
- [x] **Step 2: Verify the graph boundary and responsive layout** in the E2E scenario: graph edges follow `parent` only; the page has no horizontal overflow at a narrow desktop viewport; graph scrolling remains inside its canvas; the group pane starts collapsed at the narrow breakpoint and can be expanded or collapsed manually.
- [x] **Step 3: Refine shared visual states** for toolbar selection, context ancestors, root rows, error/unparsed repair items, counts, and no-results/empty-group messages across all six categories.
- [x] **Step 4: Run focused renderer tests** with `npm test -- tests/renderer/materials-model.test.ts tests/renderer/material-graph-layout.test.ts tests/renderer/MaterialHierarchyList.test.tsx tests/renderer/MaterialRelationshipGraph.test.tsx tests/renderer/MaterialExplorer.test.tsx tests/renderer/Materials.test.tsx tests/renderer/NavigationMaterials.test.tsx`.
- [x] **Step 5: Run type checking** with `npm run typecheck`.
- [x] **Step 6: Run the material navigation E2E test** with `npm run test:e2e -- tests/e2e/navigation-materials.spec.ts`.
- [x] **Step 7: Run the full unit suite** with `npm test` and fix any regressions caused by replacing split component sections or changing the default view.

## Acceptance checklist

- [x] Entity, component, setting, map, UI, and spec pages share the group tree, search, category-appropriate filters, and card/list/graph controls; a new installation defaults to the hierarchy list.
- [x] The hierarchy list shows the real `parent` tree with clear indentation, collapse controls, metadata, and selectable rows.
- [x] The graph lays out real `parent` relationships left-to-right. Group membership, entity `extends`, and component bindings never appear as parent edges.
- [x] Entity type and component source filters combine with keyword and group filters. Context ancestors are visible but excluded from counts, while card mode shows matches only.
- [x] Invalid relationships and unparsed materials remain reachable through repair entries in list and graph modes.
- [x] Switching views does not issue document-read IPC calls or lose the selected path, query, filters, group selection, or expanded relationship branches.
- [x] The group pane collapses at narrow widths; graph scrolling stays inside its canvas and the page does not overflow horizontally.
- [x] Detail copy distinguishes `parent`, `extends`, group assignment, and component composition while existing save and validation behavior remains intact.

## Self-review

- Spec coverage: Tasks 1–6 cover all six categories, three views, parent-only structure, ancestor context and count semantics, filters, error recovery, detail semantics, responsiveness, and no-refetch behavior.
- Type consistency: all view modes use one discriminated `View` union; context-only is a presentation property on projected tree nodes; graph layout accepts the same projected parent-tree nodes.
- Scope control: no material migration, IPC/API change, package dependency, app-shell redesign, or editing-flow rewrite is planned.
- Test coverage: pure projection/layout behavior has unit tests; view behavior has Testing Library coverage; Electron navigation, editor selection, and responsive constraints have E2E coverage.

## Execution choice

Choose **Subagent-Driven** to execute each independent task in separate delegated work, or **Inline Execution** to implement the tasks sequentially in this session.
