# SpecLoom Workflow B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Ship the B workflow loop: visual authoring, the official six-node development review, main-process execution through ProjectCore tasks, approval/reject, decision recording, and persisted runs.

**Architecture:** A main-process WorkflowStore reads project YAML definitions and the read-only official resource. WorkflowRunner snapshots the definition into a run, creates a read-only task for planning and one write task for implementation, and reuses ProjectCore validate/preview/approve/reject. The renderer only edits definitions, starts runs, approves, and renders IPC updates.

**Tech Stack:** TypeScript, Zod, YAML, Electron IPC, ProjectCore, React 19, @xyflow/react, Vitest, Testing Library, Playwright.

---

## Scope

This plan covers workflow B only. The entity visual workbench is a separate plan because it has an independent data flow and UI; the two plans share no implementation code beyond existing material APIs.

B includes: definitions under specs/workflows, the official six-node template, the dual-mode workflow page, the main runner, approvals, decisions, and tests. B excludes parallelism, loops, subprocesses, multiple write agents, node-level scopes, automatic resume, and the workflow entity node.

## File Map

Create:

- src/shared/workflow.ts — Zod schemas, TypeScript types, B graph validation.
- src/main/core/workflow-official.ts — load and validate the official resource.
- resources/workflows/official-development-review.yaml — read-only official template.
- src/main/core/workflow-store.ts — list/read/save/copy/remove workflow YAML.
- src/main/core/workflow-task-adapter.ts — narrow ProjectCore task interface and production adapter.
- src/main/core/workflow-runner.ts — run state machine, node execution, persistence, cancellation.
- src/renderer/WorkflowView.tsx — page shell, mode switch, editor/run composition.
- src/renderer/workflow/WorkflowCanvas.tsx — React Flow canvas and custom nodes.
- src/renderer/workflow/WorkflowInspector.tsx — definition/node inspector and validation errors.
- src/renderer/workflow/WorkflowRunPanel.tsx — run input, timeline, validation, approval.
- src/renderer/workflow/useWorkflow.ts — renderer API hook and event subscription.
- src/renderer/workflow.css — workflow page styling using existing tokens.

Modify:

- package.json and package-lock.json — add @xyflow/react.
- src/shared/desktop-api.ts — WorkflowApi types.
- src/main/ipc.ts — workflow request schemas and handlers.
- src/main/preload.ts — expose workflow API.
- src/renderer/App.tsx — add the Workflow navigation tab and page.
- src/renderer/styles.css — only shared page/nav adjustments if needed; page-specific CSS stays in workflow.css.

Tests:

- tests/core/workflow-schema.test.ts
- tests/core/workflow-store.test.ts
- tests/core/workflow-runner.test.ts
- tests/core/workflow-official.test.ts
- tests/integration/workflow-ipc.test.ts
- tests/renderer/WorkflowView.test.tsx
- tests/e2e/workflow.spec.ts

---

### Task 1: Shared schema and B validator

**Files:**
- Create: src/shared/workflow.ts
- Test: tests/core/workflow-schema.test.ts

- [ ] **Step 1: Write the failing schema test**

~~~ts
import { describe, expect, test } from "vitest";
import { validateWorkflowDefinition } from "../../src/shared/workflow";

const base = {
  schemaVersion: 1,
  id: "wf_test",
  title: "Test",
  description: "",
  version: 1,
  inputs: [],
  nodes: [
    { id: "context", type: "context", label: "Read", position: { x: 0, y: 0 }, config: {} },
    { id: "plan", type: "agent", label: "Plan", position: { x: 1, y: 0 }, config: { access: "read", prompt: "Plan only." } },
    { id: "write", type: "agent", label: "Write", position: { x: 2, y: 0 }, config: { access: "write", prompt: "Write." } },
    { id: "validate", type: "validation", label: "Validate", position: { x: 3, y: 0 }, config: {} },
    { id: "review", type: "approval", label: "Review", position: { x: 4, y: 0 }, config: {} },
    { id: "decide", type: "decision", label: "Decide", position: { x: 5, y: 0 }, config: { directory: "specs/decisions" } },
  ],
  edges: [
    { id: "e1", from: "context", to: "plan", on: "success" },
    { id: "e2", from: "plan", to: "write", on: "success" },
    { id: "e3", from: "write", to: "validate", on: "success" },
    { id: "e4", from: "validate", to: "review", on: "success" },
    { id: "e5", from: "review", to: "decide", on: "success" },
    { id: "e6", from: "review", to: "write", on: "reject" },
  ],
  settings: { maxImplementAttempts: 3 },
};

describe("workflow definition", () => {
  test("accepts a linear B workflow with one write agent and one reject edge", () => {
    expect(validateWorkflowDefinition(base).id).toBe("wf_test");
  });

  test("rejects a second write agent, branch, and unreachable node", () => {
    expect(() => validateWorkflowDefinition({
      ...base,
      nodes: base.nodes.map((node) => node.id === "plan" ? { ...node, config: { access: "write", prompt: "No." } } : node),
    })).toThrow(/exactly one write agent/);
    expect(() => validateWorkflowDefinition({
      ...base,
      edges: [...base.edges, { id: "e7", from: "plan", to: "decide", on: "success" }],
    })).toThrow(/branch/);
  });
});
~~~

- [ ] **Step 2: Run it and verify it fails**

Run: npx vitest run tests/core/workflow-schema.test.ts
Expected: FAIL because ../../src/shared/workflow does not exist.

- [ ] **Step 3: Implement the schema and validator**

Create src/shared/workflow.ts with:

~~~ts
import { z } from "zod";

export const WorkflowNodeTypeSchema = z.enum(["context", "agent", "validation", "approval", "decision"]);
export const WorkflowInputTypeSchema = z.enum(["string", "paths", "model"]);
export const WorkflowNodeSchema = z.object({
  id: z.string().min(1).max(80),
  type: WorkflowNodeTypeSchema,
  label: z.string().min(1).max(120),
  position: z.object({ x: z.number(), y: z.number() }),
  config: z.record(z.string(), z.unknown()).default({}),
}).strict();
export const WorkflowEdgeSchema = z.object({
  id: z.string().min(1).max(80),
  from: z.string().min(1),
  to: z.string().min(1),
  on: z.enum(["success", "reject"]).default("success"),
}).strict();
export const WorkflowInputSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: WorkflowInputTypeSchema,
  required: z.boolean().default(true),
}).strict();
export const WorkflowDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1).max(120),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).default(""),
  version: z.number().int().positive(),
  inputs: z.array(WorkflowInputSchema),
  nodes: z.array(WorkflowNodeSchema).min(1),
  edges: z.array(WorkflowEdgeSchema),
  settings: z.object({ maxImplementAttempts: z.number().int().min(1).max(10).default(3) }).strict(),
}).strict();
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>;

export function validateWorkflowDefinition(input: unknown): WorkflowDefinition {
  const definition = WorkflowDefinitionSchema.parse(input);
  const ids = new Set<string>();
  for (const node of definition.nodes) {
    if (ids.has(node.id)) throw new Error("duplicate node id: " + node.id);
    ids.add(node.id);
    if (node.type === "agent") {
      const access = node.config.access;
      const prompt = node.config.prompt;
      if (access !== "read" && access !== "write") throw new Error("agent access must be read or write: " + node.id);
      if (typeof prompt !== "string" || !prompt.trim()) throw new Error("agent prompt is required: " + node.id);
    }
  }
  const writes = definition.nodes.filter((node) => node.type === "agent" && node.config.access === "write");
  if (writes.length !== 1) throw new Error("B workflow requires exactly one write agent");
  const edgeIds = new Set<string>();
  for (const edge of definition.edges) {
    if (edgeIds.has(edge.id)) throw new Error("duplicate edge id: " + edge.id);
    edgeIds.add(edge.id);
    if (!ids.has(edge.from) || !ids.has(edge.to)) throw new Error("edge references unknown node: " + edge.id);
  }
  const successOutgoing = new Map<string, number>();
  for (const edge of definition.edges) {
    if (edge.on === "success") successOutgoing.set(edge.from, (successOutgoing.get(edge.from) ?? 0) + 1);
  }
  for (const [nodeId, count] of successOutgoing) {
    if (count > 1) throw new Error("B workflow does not support branch nodes: " + nodeId);
  }
  const reject = definition.edges.filter((edge) => edge.on === "reject");
  if (reject.length > 1) throw new Error("B workflow supports at most one reject edge");
  if (reject.length === 1) {
    const source = definition.nodes.find((node) => node.id === reject[0]!.from);
    if (!source || source.type !== "approval") throw new Error("reject edge must start at an approval node");
    if (reject[0]!.to !== writes[0]!.id) throw new Error("reject edge must return to the write agent");
  }
  const contexts = definition.nodes.filter((node) => node.type === "context");
  if (contexts.length !== 1) throw new Error("exactly one context node is required");
  if (definition.nodes.filter((node) => node.type === "validation").length !== 1) throw new Error("exactly one validation node is required");
  if (definition.nodes.filter((node) => node.type === "approval").length !== 1) throw new Error("exactly one approval node is required");
  if (definition.nodes.filter((node) => node.type === "decision").length !== 1) throw new Error("exactly one decision node is required");
  const reachable = new Set<string>();
  const visit = (id: string) => {
    if (reachable.has(id)) return;
    reachable.add(id);
    for (const edge of definition.edges.filter((item) => item.from === id && item.on === "success")) visit(edge.to);
  };
  visit(contexts[0]!.id);
  for (const node of definition.nodes) if (!reachable.has(node.id)) throw new Error("unreachable node: " + node.id);
  return definition;
}
~~~

- [ ] **Step 4: Run the test and verify it passes**

Run: npx vitest run tests/core/workflow-schema.test.ts
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

~~~powershell
git add src/shared/workflow.ts tests/core/workflow-schema.test.ts
git commit -m "feat(workflow): add shared schema and B validator"
~~~

---

### Task 2: Official template resource

**Files:**
- Create: resources/workflows/official-development-review.yaml
- Create: src/main/core/workflow-official.ts
- Test: tests/core/workflow-official.test.ts

- [ ] **Step 1: Write the failing loader test**

~~~ts
import { describe, expect, test } from "vitest";
import { loadOfficialWorkflow } from "../../src/main/core/workflow-official";

describe("official workflow", () => {
  test("loads the six-node development review and validates B rules", async () => {
    const workflow = await loadOfficialWorkflow();
    expect(workflow.id).toBe("wf_official_development_review");
    expect(workflow.nodes.map((node) => node.type)).toEqual(["context", "agent", "agent", "validation", "approval", "decision"]);
    expect(workflow.nodes.filter((node) => node.type === "agent" && node.config.access === "write")).toHaveLength(1);
  });
});
~~~

- [ ] **Step 2: Run it and verify it fails**

Run: npx vitest run tests/core/workflow-official.test.ts
Expected: FAIL because the module and resource do not exist.

- [ ] **Step 3: Add the resource and loader**

Create resources/workflows/official-development-review.yaml with the six nodes, their concrete prompts, the reject edge, and settings from the design spec. Use this exact structure:

~~~yaml
schemaVersion: 1
id: wf_official_development_review
title: 官方开发审查
description: 读取规范、规划、实现、校验、人工审查并记录决策。
version: 1
inputs:
  - { key: goal, label: 目标, type: string, required: true }
  - { key: readPaths, label: 读取范围, type: paths, required: true }
  - { key: writePaths, label: 修改范围, type: paths, required: true }
  - { key: model, label: 模型, type: model, required: false }
nodes:
  - { id: context, type: context, label: 读取规范, position: { x: 80, y: 120 }, config: {} }
  - { id: plan, type: agent, label: 规划, position: { x: 260, y: 120 }, config: { access: read, prompt: "阅读运行范围内的项目资料，输出可执行的实现计划；不得修改文件。" } }
  - { id: implement, type: agent, label: Agent 实现, position: { x: 440, y: 120 }, config: { access: write, prompt: "根据目标和计划实现改动；只写 writePaths 允许的路径；完成后总结改动与验证建议。" } }
  - { id: validate, type: validation, label: 自动校验, position: { x: 620, y: 120 }, config: {} }
  - { id: review, type: approval, label: 人工审查, position: { x: 800, y: 120 }, config: { allowReject: true } }
  - { id: decide, type: decision, label: 记录决策, position: { x: 980, y: 120 }, config: { directory: specs/decisions } }
edges:
  - { id: e1, from: context, to: plan, on: success }
  - { id: e2, from: plan, to: implement, on: success }
  - { id: e3, from: implement, to: validate, on: success }
  - { id: e4, from: validate, to: review, on: success }
  - { id: e5, from: review, to: decide, on: success }
  - { id: e6, from: review, to: implement, on: reject }
settings:
  maxImplementAttempts: 3
~~~

Create src/main/core/workflow-official.ts:

~~~ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { validateWorkflowDefinition } from "../../shared/workflow";

export async function loadOfficialWorkflow() {
  const resource = path.join(process.cwd(), "resources", "workflows", "official-development-review.yaml");
  const source = await readFile(resource, "utf8");
  return validateWorkflowDefinition(parse(source));
}
~~~

- [ ] **Step 4: Run the test and verify it passes**

Run: npx vitest run tests/core/workflow-official.test.ts
Expected: PASS, 1 test.

- [ ] **Step 5: Commit**

~~~powershell
git add resources/workflows/official-development-review.yaml src/main/core/workflow-official.ts tests/core/workflow-official.test.ts
git commit -m "feat(workflow): add official development review template"
~~~

---

### Task 3: WorkflowStore

**Files:**
- Create: src/main/core/workflow-store.ts
- Test: tests/core/workflow-store.test.ts

- [ ] **Step 1: Write the failing store test**

~~~ts
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { FileStore } from "../../src/main/core/file-store";
import { WorkflowStore } from "../../src/main/core/workflow-store";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function root() {
  const value = await mkdtemp(path.join(os.tmpdir(), "specloom-workflows-"));
  roots.push(value);
  return value;
}

describe("workflow store", () => {
  test("lists, saves with version checks, reads, and removes project workflows", async () => {
    const dir = await root();
    const store = new WorkflowStore(new FileStore(dir));
    const validYaml = [
      "schemaVersion: 1",
      "id: wf_demo",
      "title: Demo",
      "description: demo",
      "version: 1",
      "inputs: []",
      "nodes:",
      "  - { id: context, type: context, label: Read, position: { x: 0, y: 0 }, config: {} }",
      "  - { id: plan, type: agent, label: Plan, position: { x: 1, y: 0 }, config: { access: read, prompt: Plan } }",
      "  - { id: write, type: agent, label: Write, position: { x: 2, y: 0 }, config: { access: write, prompt: Write } }",
      "  - { id: validate, type: validation, label: Validate, position: { x: 3, y: 0 }, config: {} }",
      "  - { id: review, type: approval, label: Review, position: { x: 4, y: 0 }, config: {} }",
      "  - { id: decide, type: decision, label: Decide, position: { x: 5, y: 0 }, config: { directory: specs/decisions } }",
      "edges:",
      "  - { id: e1, from: context, to: plan, on: success }",
      "  - { id: e2, from: plan, to: write, on: success }",
      "  - { id: e3, from: write, to: validate, on: success }",
      "  - { id: e4, from: validate, to: review, on: success }",
      "  - { id: e5, from: review, to: decide, on: success }",
      "  - { id: e6, from: review, to: write, on: reject }",
      "settings: { maxImplementAttempts: 3 }",
    ].join("\n");
    await store.save("wf_demo", validYaml, "absent");
    const listed = await store.list();
    expect(listed.some((item) => item.id === "wf_demo")).toBe(true);
    await expect(store.save("wf_demo", "changed", "absent")).rejects.toThrow();
    await store.remove("wf_demo");
    expect((await store.list()).some((item) => item.id === "wf_demo")).toBe(false);
  });
});
~~~

- [ ] **Step 2: Run it and verify it fails**

Run: npx vitest run tests/core/workflow-store.test.ts
Expected: FAIL because WorkflowStore does not exist.

- [ ] **Step 3: Implement the store**

Create src/main/core/workflow-store.ts with a class that:
- Uses FileStore.listFiles("specs/workflows"), readCurrentText, write, and remove.
- Restricts ids to /^[a-z0-9_]+$/ and paths to specs/workflows/<id>.yaml.
- Parses YAML with the yaml package and validates with validateWorkflowDefinition.
- Returns summaries with id, title, nodeCount, writeCount, version.
- copyOfficial(id) reads loadOfficialWorkflow and writes it with expectedVersion "absent"; rejects if the target exists.
- Surfaces ProjectError codes VERSION_CONFLICT and VALIDATION_FAILED.
- Never creates directories outside specs/workflows.

Keep all public methods async: list, read, save, remove, copyOfficial.

- [ ] **Step 4: Run the test and verify it passes**

Run: npx vitest run tests/core/workflow-store.test.ts
Expected: PASS, 1 test.

- [ ] **Step 5: Commit**

~~~powershell
git add src/main/core/workflow-store.ts tests/core/workflow-store.test.ts
git commit -m "feat(workflow): add workflow definition store"
~~~

---

### Task 4: Workflow task adapter

**Files:**
- Create: src/main/core/workflow-task-adapter.ts
- Create: tests/helpers/fake-workflow-task-adapter.ts
- Test: tests/core/workflow-runner.test.ts

- [ ] **Step 1: Write the failing adapter test**

~~~ts
import { describe, expect, test } from "vitest";
import { FakeWorkflowTaskAdapter } from "../helpers/fake-workflow-task-adapter";

describe("workflow task adapter", () => {
  test("records the read task and write task with distinct scopes", async () => {
    const adapter = new FakeWorkflowTaskAdapter();
    const read = await adapter.createTask({ title: "plan", readPaths: ["specs"], writePaths: [] });
    const write = await adapter.createTask({ title: "implement", readPaths: ["specs"], writePaths: ["specs/entities"] });
    expect(read.scope.writePaths).toEqual([]);
    expect(write.scope.writePaths).toEqual(["specs/entities"]);
    expect(adapter.created).toHaveLength(2);
  });
});
~~~

- [ ] **Step 2: Run it and verify it fails**

Run: npx vitest run tests/core/workflow-runner.test.ts
Expected: FAIL because the interface/fake do not exist.

- [ ] **Step 3: Define the adapter and implement the ProjectCore adapter**

Create tests/helpers/fake-workflow-task-adapter.ts with arrays created, scopes, agents, a digest, and methods that satisfy the interface. Define in src/main/core/workflow-task-adapter.ts:

~~~ts
export interface WorkflowTaskScope {
  title: string;
  readPaths: string[];
  writePaths: string[];
}
export interface WorkflowTaskAdapter {
  createTask(scope: WorkflowTaskScope): Promise<{ id: string; scope: WorkflowTaskScope }>;
  removeTask(taskId: string): Promise<void>;
  runAgent(taskId: string, profile: ModelProfile, prompt: string, signal: AbortSignal): Promise<{ summary: string }>;
  validate(taskId: string, signal: AbortSignal): Promise<ValidationResult>;
  preview(taskId: string): Promise<ChangeReview>;
  approve(taskId: string, digest: string): Promise<void>;
  reject(taskId: string): Promise<void>;
}
~~~

Implement ProjectCoreWorkflowTaskAdapter with a ProjectCore reference and a ModelProfile resolver callback; createTask maps to core.createTask with generated id and TaskScopeSpec mode manual, allowDelete false; runAgent maps to core.agentMessage; validate/preview/approve/reject map directly; removeTask maps to core.removeTask.

- [ ] **Step 4: Run the adapter test and verify it passes**

Run: npx vitest run tests/core/workflow-runner.test.ts
Expected: PASS for the adapter test.

- [ ] **Step 5: Commit**

~~~powershell
git add src/main/core/workflow-task-adapter.ts tests/core/workflow-runner.test.ts tests/helpers/fake-workflow-task-adapter.ts
git commit -m "feat(workflow): add ProjectCore task adapter"
~~~

---

### Task 5: Run state and persistence

**Files:**
- Create: src/main/core/workflow-runner.ts
- Test: tests/core/workflow-runner.test.ts

- [ ] **Step 1: Add failing state-machine tests**

Append to tests/core/workflow-runner.test.ts:

~~~ts
import { WorkflowRunner } from "../../src/main/core/workflow-runner";

test("persists a run and rejects a second active run", async () => {
  const adapter = new FakeWorkflowTaskAdapter();
  const runner = new WorkflowRunner({ adapter, root: "/tmp/project" });
  const workflow = await loadOfficialWorkflow();
  const run = runner.createRun(workflow, { goal: "g", readPaths: ["specs"], writePaths: ["specs"], model: "m" });
  await runner.start(run.runId);
  await expect(runner.start(run.runId)).rejects.toThrow(/active/);
  expect((await runner.getRun(run.runId)).status).toBe("running");
});
~~~

Use a minimal workflow fixture or loadOfficialWorkflow.

- [ ] **Step 2: Run it and verify it fails**

Run: npx vitest run tests/core/workflow-runner.test.ts
Expected: FAIL because WorkflowRunner does not exist.

- [ ] **Step 3: Implement run creation and persistence**

Create src/main/core/workflow-runner.ts with:
- WorkflowRun and WorkflowNodeState types matching the design.
- createRun(definition, inputs): snapshot definition, validate inputs, set status queued, persist to .specloom/workflows/runs/<runId>.json.
- start(runId): reject if another run is active; set running; call execute(runId); persist.
- getRun/listRuns/load: read run files atomically; reject malformed.
- cancel(runId): abort controller; set cancelled; persist; leave write task staged.
- retry(runId, action): allowed only when status failed; set running and execute the requested node.
- approve(runId, digest): assert waiting_approval and matching digest; call adapter.approve; write decision; complete.
- reject(runId): assert waiting_approval; adapter.reject; rerun implement within max attempts.
- A private execute loop that advances the B graph in the order context -> plan -> implement -> validate -> review -> decide; store node states and attempts.
- A per-run AbortController; no global runner state.
- Active run tracking per project root in memory; reject parallel starts.

- [ ] **Step 4: Run the state tests and verify they pass**

Run: npx vitest run tests/core/workflow-runner.test.ts
Expected: PASS for the state tests; node execution tests remain for Task 6.

- [ ] **Step 5: Commit**

~~~powershell
git add src/main/core/workflow-runner.ts tests/core/workflow-runner.test.ts
git commit -m "feat(workflow): add run state and persistence"
~~~

---

### Task 6: Execute the official six nodes

**Files:**
- Modify: src/main/core/workflow-runner.ts
- Test: tests/core/workflow-runner.test.ts

- [ ] **Step 1: Add failing execution tests**

~~~ts
test("runs plan read-only, implementation, validation, approval, decision", async () => {
  const adapter = new FakeWorkflowTaskAdapter();
  const runner = new WorkflowRunner({ adapter, root: "/tmp/project" });
  const run = runner.createRun(await loadOfficialWorkflow(), { goal: "g", readPaths: ["specs"], writePaths: ["specs/entities"], model: "m" });
  await runner.start(run.runId);
  expect(adapter.agents).toEqual(["plan", "implement"]);
  expect(adapter.scopes[0].writePaths).toEqual([]);
  expect(adapter.scopes[1].writePaths).toEqual(["specs/entities"]);
  expect((await runner.getRun(run.runId)).status).toBe("waiting_approval");
  await runner.approve(run.runId, adapter.digest);
  const completed = await runner.getRun(run.runId);
  expect(completed.status).toBe("completed");
  expect(completed.decisionPath).toMatch(/specs\/decisions/);
});
~~~

Add reject test: approval reject calls reject, reruns implement, then approve completes.

- [ ] **Step 2: Run it and verify it fails**

Run: npx vitest run tests/core/workflow-runner.test.ts
Expected: FAIL because execution is not implemented.

- [ ] **Step 3: Implement node execution**

In WorkflowRunner:
- context: ensure readPaths exist, record count; no task.
- plan: adapter.createTask with writePaths empty; adapter.runAgent; remove task; save output.
- implement: adapter.createTask with run writePaths; runAgent with goal + plan; save writeTaskId.
- validate: adapter.validate; store ValidationResult; on failure status failed with retry action validate or implement.
- review: adapter.preview; store digest; status waiting_approval.
- decide: write a Markdown file under specs/decisions using the existing ProjectDocuments/FileStore write path; content includes run id, goal, plan summary, validation status, approved digest, model, timestamps; set completed.
- Reject: adapter.reject; increment attempts; rerun implement; cap 3.
- Cancellation: abort active signal; persist cancelled; do not delete write task.
- Agent errors: set failed and store a bounded error string; do not expose secrets.

- [ ] **Step 4: Run all runner tests and verify they pass**

Run: npx vitest run tests/core/workflow-runner.test.ts
Expected: PASS; includes success, reject loop, validation failure, cancel, retry.

- [ ] **Step 5: Commit**

~~~powershell
git add src/main/core/workflow-runner.ts tests/core/workflow-runner.test.ts
git commit -m "feat(workflow): execute official review nodes"
~~~

---

### Task 7: IPC and preload API

**Files:**
- Modify: src/shared/desktop-api.ts
- Modify: src/main/ipc.ts
- Modify: src/main/preload.ts
- Test: tests/integration/workflow-ipc.test.ts

- [ ] **Step 1: Write the failing IPC test**

~~~ts
import { describe, expect, test } from "vitest";
import { WorkflowSaveRequestSchema } from "../../src/main/ipc";

test("accepts a valid workflow save request and rejects path traversal", () => {
  expect(WorkflowSaveRequestSchema.safeParse({ id: "wf_demo", content: "schemaVersion: 1", expectedVersion: "absent" }).success).toBe(true);
  expect(WorkflowSaveRequestSchema.safeParse({ id: "../escape", content: "x", expectedVersion: "absent" }).success).toBe(false);
});
~~~

- [ ] **Step 2: Run it and verify it fails**

Run: npx vitest run tests/integration/workflow-ipc.test.ts
Expected: FAIL because the schema does not exist.

- [ ] **Step 3: Add IPC schemas, handlers, and preload methods**

Add request schemas:
- workflowList, workflowRead, workflowSave, workflowRemove, workflowCopyOfficial
- workflowStart, workflowRetry, workflowCancel, workflowApprove, workflowReject, workflowGetRun, workflowListRuns

Handlers call DesktopController/ProjectCore-backed WorkflowStore/Runner. Add WorkflowApi to desktop-api.ts with the same method names. Expose it in preload as window.specLoom.workflow. Validate ids with /^[a-z0-9_]+$/; run ids with the existing id schema. Push workflow:update after every runner transition using the existing window event mechanism.

- [ ] **Step 4: Run the IPC test and typecheck**

Run: npx vitest run tests/integration/workflow-ipc.test.ts
Expected: PASS.
Run: npm run typecheck
Expected: exit 0.

- [ ] **Step 5: Commit**

~~~powershell
git add src/shared/desktop-api.ts src/main/ipc.ts src/main/preload.ts tests/integration/workflow-ipc.test.ts
git commit -m "feat(workflow): expose workflow IPC"
~~~

---

### Task 8: Renderer API hook and page shell

**Files:**
- Create: src/renderer/workflow/useWorkflow.ts
- Create: src/renderer/WorkflowView.tsx
- Modify: src/renderer/App.tsx
- Test: tests/renderer/WorkflowView.test.tsx

- [ ] **Step 1: Write the failing page test**

~~~tsx
import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { WorkflowView } from "../../src/renderer/WorkflowView";

test("renders official and custom workflow sections and the run mode switch", async () => {
  render(<WorkflowView api={fakeApi} projectPath="E:/demo" onError={vi.fn()} />);
  expect(await screen.findByText("官方开发审查")).toBeVisible();
  expect(screen.getByRole("button", { name: "编排" })).toBeVisible();
  expect(screen.getByRole("button", { name: "运行" })).toBeVisible();
});
~~~

- [ ] **Step 2: Run it and verify it fails**

Run: npx vitest run tests/renderer/WorkflowView.test.tsx
Expected: FAIL because WorkflowView does not exist.

- [ ] **Step 3: Implement the hook and shell**

- useWorkflow loads list/runs, subscribes to workflow:update, exposes refresh, save, remove, copyOfficial, start, retry, cancel, approve, reject.
- WorkflowView owns mode (build/run), selected workflow, selected run, dirty guard.
- Build mode composes a left list, WorkflowCanvas, WorkflowInspector.
- Run mode composes a run list, WorkflowCanvas read-only, WorkflowRunPanel.
- Add a Workflow tab to App.tsx with a distinct icon and label; mount WorkflowView when active.
- Use existing api null/error patterns and onError.

- [ ] **Step 4: Run the page test**

Run: npx vitest run tests/renderer/WorkflowView.test.tsx
Expected: PASS for the shell test; canvas tests come next.

- [ ] **Step 5: Commit**

~~~powershell
git add src/renderer/workflow/useWorkflow.ts src/renderer/WorkflowView.tsx src/renderer/App.tsx tests/renderer/WorkflowView.test.tsx
git commit -m "feat(workflow): add renderer shell and data hook"
~~~

---

### Task 9: React Flow canvas and node palette

**Files:**
- Modify: package.json
- Create: src/renderer/workflow/WorkflowCanvas.tsx
- Create: src/renderer/workflow/WorkflowNodes.tsx
- Create: src/renderer/workflow.css
- Test: tests/renderer/WorkflowCanvas.test.tsx

- [ ] **Step 1: Install the dependency**

Run: npm install @xyflow/react
Expected: package.json and package-lock.json updated; @xyflow/react is in dependencies.

- [ ] **Step 2: Write the failing canvas test**

Test that five palette buttons exist, clicking one adds a node via onChange, and the official graph renders six node labels plus a reject edge. Use React Flow test mocks for ResizeObserver and getBoundingClientRect.

- [ ] **Step 3: Implement the canvas**

- Wrap ReactFlow in ReactFlowProvider.
- Define node types for context, agent, validation, approval, decision.
- Map WorkflowNode position/type to React Flow nodes; edges from definition.
- onNodesChange/onEdgesChange/onConnect update the draft definition; React Flow positions are persisted in the definition.
- Disable branching in B: reject connections that would create a second outgoing success edge; show an inline error.
- Add a palette with the five types; drag/drop or click to add at a deterministic position.
- Read-only prop for run mode; no drag/connect/delete.
- Use paper tokens, node status classes, reduced-motion-safe transitions.

- [ ] **Step 4: Run the canvas test**

Run: npx vitest run tests/renderer/WorkflowCanvas.test.tsx
Expected: PASS.

- [ ] **Step 5: Commit**

~~~powershell
git add package.json package-lock.json src/renderer/workflow/WorkflowCanvas.tsx src/renderer/workflow/WorkflowNodes.tsx src/renderer/workflow.css tests/renderer/WorkflowCanvas.test.tsx
git commit -m "feat(workflow): add visual canvas"
~~~

---

### Task 10: Inspector, run mode, approval, and end-to-end acceptance

**Files:**
- Create: src/renderer/workflow/WorkflowInspector.tsx
- Create: src/renderer/workflow/WorkflowRunPanel.tsx
- Modify: src/renderer/WorkflowView.tsx
- Test: tests/renderer/WorkflowView.test.tsx
- Test: tests/e2e/workflow.spec.ts

- [ ] **Step 1: Write failing inspector/run tests**

- Selecting a node shows its label, type, and type-specific fields; editing prompt/access calls onChange.
- Invalid B graph shows the exact validation message from validateWorkflowDefinition and disables Save/Run.
- Run mode shows the six node states, validation result, approval digest, and approval/reject controls.
- A failed validation run shows Retry validation and Return to implementation buttons.

- [ ] **Step 2: Implement the inspector and run panel**

Inspector:
- Workflow settings (title, description, maxImplementAttempts).
- Node fields: label, type-specific config, prompt/access/model for agent; directory for decision; reject allowed for approval.
- Save/Copy/Delete/Run; dirty guard; version conflict message.

Run panel:
- Input form for goal, readPaths, writePaths, model; required validation.
- Status timeline with node states; current node; attempts; error text.
- Validation checks and diff summary.
- Approve with digest; Reject; Retry validation/implementation/plan; Cancel.
- Link to write task and decision file.

- [ ] **Step 3: Run focused renderer tests**

Run: npx vitest run tests/renderer/WorkflowView.test.tsx tests/renderer/WorkflowCanvas.test.tsx
Expected: PASS.

- [ ] **Step 4: Add the E2E scenario**

Use the existing Electron E2E harness and a test model stand-in. Open the sample project, open Workflow, copy the official template, start it with specs and specs/entities scopes, approve the digest, assert the decision file exists and the run is completed. Assert the read-only plan task does not appear as a writable task and a second start is rejected while active.

- [ ] **Step 5: Run acceptance commands**

~~~powershell
npm run typecheck
npm run lint
npx vitest run tests/core/workflow-schema.test.ts tests/core/workflow-official.test.ts tests/core/workflow-store.test.ts tests/core/workflow-runner.test.ts tests/integration/workflow-ipc.test.ts tests/renderer/WorkflowView.test.tsx tests/renderer/WorkflowCanvas.test.tsx
npm run test:e2e -- --grep workflow
~~~

Expected: all pass; report any environment skip separately.

- [ ] **Step 6: Commit**

~~~powershell
git add src/renderer/workflow/WorkflowInspector.tsx src/renderer/workflow/WorkflowRunPanel.tsx src/renderer/WorkflowView.tsx tests/renderer/WorkflowView.test.tsx tests/e2e/workflow.spec.ts
git commit -m "feat(workflow): add inspector, run mode, and approval"
~~~

---

## Self-Review

Spec coverage for Workflow B:

- Definition schema, storage, official template: Tasks 1-3.
- Runtime, read-only plan, write task, validation, approval, decision: Tasks 4-6.
- IPC, preload, event: Task 7.
- Page shell, dual mode, canvas, inspector, run/approval: Tasks 8-10.
- Security, error cases, tests, acceptance: Tasks 5, 6, 7, 10.

Deferred to the separate entity workbench plan:

- Entity workbench layout, component assembly, field widgets, inheritance, layout sidecar, and its tests.
- C runtime (parallel/loop/subprocess/multiple write agents/recovery) and the workflow entity node.

No task in this plan changes entity/component data formats. No packaging command is run.
