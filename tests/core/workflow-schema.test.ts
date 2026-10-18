import { describe, expect, test } from "vitest";
import {
  WORKFLOW_LIMITS,
  WorkflowValidationError,
  validateWorkflowDefinition,
} from "../../src/shared/workflow";
import { WorkflowRunInputsSchema } from "../../src/shared/workflow-api";

type NodeFixture = {
  id: string;
  type: string;
  label: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
};

type EdgeFixture = { id: string; from: string; to: string; on?: string };
type InputFixture = { key: string; label: string; type: string; required?: boolean };
type DefinitionFixture = {
  schemaVersion: number;
  id: string;
  title: string;
  description: string;
  version: number;
  inputs: InputFixture[];
  nodes: NodeFixture[];
  edges: EdgeFixture[];
  settings: { maxImplementAttempts: number; approvalPolicy?: "manual" | "auto" };
};

const base: DefinitionFixture = {
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

const official: DefinitionFixture = {
  ...base,
  id: "wf_official_development_review",
  title: "官方开发审查",
  description: "读取规范、规划、实现、校验、人工审查并记录决策。",
  inputs: [
    { key: "goal", label: "目标", type: "string", required: true },
    { key: "readPaths", label: "读取范围", type: "paths", required: true },
    { key: "writePaths", label: "修改范围", type: "paths", required: true },
    { key: "model", label: "模型", type: "model", required: false },
  ],
  nodes: [
    { id: "context", type: "context", label: "读取规范", position: { x: 80, y: 120 }, config: {} },
    {
      id: "plan",
      type: "agent",
      label: "规划",
      position: { x: 260, y: 120 },
      config: { access: "read", prompt: "阅读运行范围内的项目资料，输出可执行的实现计划；不得修改文件。" },
    },
    {
      id: "implement",
      type: "agent",
      label: "Agent 实现",
      position: { x: 440, y: 120 },
      config: {
        access: "write",
        prompt: "根据目标和计划实现改动；只写 writePaths 允许的路径；完成后总结改动与验证建议。",
      },
    },
    { id: "validate", type: "validation", label: "自动校验", position: { x: 620, y: 120 }, config: {} },
    { id: "review", type: "approval", label: "人工审查", position: { x: 800, y: 120 }, config: { allowReject: true } },
    { id: "decide", type: "decision", label: "记录决策", position: { x: 980, y: 120 }, config: { directory: "specs/decisions" } },
  ],
  edges: [
    { id: "e1", from: "context", to: "plan", on: "success" },
    { id: "e2", from: "plan", to: "implement", on: "success" },
    { id: "e3", from: "implement", to: "validate", on: "success" },
    { id: "e4", from: "validate", to: "review", on: "success" },
    { id: "e5", from: "review", to: "decide", on: "success" },
    { id: "e6", from: "review", to: "implement", on: "reject" },
  ],
};

function agentNode(id: string): NodeFixture {
  return { id, type: "agent", label: id, position: { x: 0, y: 0 }, config: { access: "read", prompt: "Read." } };
}

function withNode(nodeId: string, patch: Partial<NodeFixture>) {
  return { ...base, nodes: base.nodes.map((node) => (node.id === nodeId ? { ...node, ...patch } : node)) };
}

function withNodes(...added: NodeFixture[]) {
  return { ...base, nodes: [...base.nodes, ...added] };
}

function withEdge(edgeId: string, patch: Partial<EdgeFixture>) {
  return { ...base, edges: base.edges.map((edge) => (edge.id === edgeId ? { ...edge, ...patch } : edge)) };
}

function withEdges(...added: EdgeFixture[]) {
  return { ...base, edges: [...base.edges, ...added] };
}

/** Captures the WorkflowValidationError thrown by build(), failing the test otherwise. */
function captureValidationError(build: () => unknown): WorkflowValidationError {
  try {
    build();
  } catch (error) {
    if (error instanceof WorkflowValidationError) return error;
    throw error;
  }
  throw new Error("expected validateWorkflowDefinition to throw a WorkflowValidationError");
}

/** Asserts a WorkflowValidationError with a readable, path-prefixed (not raw JSON) message. */
function expectReadableError(build: () => unknown, expected: RegExp): void {
  let caught: unknown;
  try {
    build();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(WorkflowValidationError);
  const message = caught instanceof WorkflowValidationError ? caught.message : String(caught);
  expect(message).toMatch(expected);
  expect(message).not.toMatch(/^\s*(\[|\{)/);
}

const invalidCases: { name: string; build: () => unknown; error: RegExp }[] = [
  {
    name: "a success edge that closes a cycle (decide -> write)",
    build: () => withEdges({ id: "e7", from: "decide", to: "write", on: "success" }),
    error: /cycle/,
  },
  {
    name: "a success edge that closes a cycle (decide -> plan)",
    build: () => withEdges({ id: "e7", from: "decide", to: "plan", on: "success" }),
    error: /cycle/,
  },
  {
    name: "a reject edge that does not start at the approval node",
    build: () => withEdge("e6", { from: "validate" }),
    error: /reject edge must start at an approval node/,
  },
  {
    name: "a reject edge that does not return to the write agent",
    build: () => withEdge("e6", { to: "plan" }),
    error: /reject edge must return to the write agent/,
  },
  {
    name: "duplicate node ids",
    build: () => withNodes(agentNode("plan")),
    error: /duplicate node id: plan/,
  },
  {
    name: "duplicate edge ids",
    build: () => withEdges({ id: "e1", from: "decide", to: "write", on: "success" }),
    error: /duplicate edge id: e1/,
  },
  {
    name: "an edge that references an unknown node",
    build: () => withEdges({ id: "e7", from: "decide", to: "missing", on: "success" }),
    error: /unknown node: missing/,
  },
  {
    name: "a whitespace-only node label",
    build: () => withNode("plan", { label: "   " }),
    error: /nodes\.1\.label: node label must not be empty/,
  },
  {
    name: "a whitespace-only agent prompt",
    build: () => withNode("write", { config: { access: "write", prompt: "   " } }),
    error: /nodes\.2\.config\.prompt: agent prompt must not be empty/,
  },
  {
    name: "a whitespace-only workflow title",
    build: () => ({ ...base, title: "   " }),
    error: /title: workflow title must not be empty/,
  },
  {
    name: "a decision directory other than specs/decisions",
    build: () => withNode("decide", { config: { directory: "specs/other" } }),
    error: /nodes\.5\.config\.directory/,
  },
  {
    name: "a non-string agent model",
    build: () => withNode("plan", { config: { access: "read", prompt: "Plan.", model: 5 } }),
    error: /nodes\.1\.config\.model/,
  },
  {
    name: "more than the node limit",
    build: () => ({
      ...base,
      nodes: [
        ...base.nodes,
        ...Array.from({ length: WORKFLOW_LIMITS.nodes - base.nodes.length + 1 }, (_, index) => agentNode("extra_" + index)),
      ],
    }),
    error: /at most 64 nodes are supported/,
  },
  {
    name: "more than the edge limit",
    build: () => ({
      ...base,
      edges: [
        ...base.edges,
        ...Array.from({ length: WORKFLOW_LIMITS.edges - base.edges.length + 1 }, (_, index) => ({
          id: "extra_edge_" + index,
          from: "decide",
          to: "write",
          on: "success",
        })),
      ],
    }),
    error: /at most 128 edges are supported/,
  },
  {
    name: "more than the input limit",
    build: () => ({
      ...base,
      inputs: Array.from({ length: WORKFLOW_LIMITS.inputs + 1 }, (_, index) => ({
        key: "input_" + index,
        label: "Input " + index,
        type: "string",
        required: true,
      })),
    }),
    error: /at most 16 inputs are supported/,
  },
  {
    name: "duplicate input keys after trimming",
    build: () => ({
      ...base,
      inputs: [
        { key: "goal", label: "Goal", type: "string", required: true },
        { key: "  goal  ", label: "Goal again", type: "string", required: true },
      ],
    }),
    error: /duplicate input key: goal/,
  },
];

describe("workflow definition", () => {
  test("accepts a linear B workflow with one write agent and one reject edge", () => {
    expect(validateWorkflowDefinition(base).id).toBe("wf_test");
  });

  test("rejects a second write agent, branch, and unreachable node", () => {
    expect(() => validateWorkflowDefinition(withNode("plan", { config: { access: "write", prompt: "No." } }))).toThrow(
      /exactly one write agent/,
    );
    expect(() => validateWorkflowDefinition(withEdges({ id: "e7", from: "plan", to: "decide", on: "success" }))).toThrow(
      /branch/,
    );
    expect(() => validateWorkflowDefinition(withNodes(agentNode("orphan")))).toThrow(/unreachable node/);
  });

  test("accepts the official six-node development review shape", () => {
    const definition = validateWorkflowDefinition(official);
    expect(definition.id).toBe("wf_official_development_review");
    expect(definition.nodes.map((node) => node.type)).toEqual([
      "context",
      "agent",
      "agent",
      "validation",
      "approval",
      "decision",
    ]);
    expect(
      definition.nodes.filter((node) => node.type === "agent" && node.config.access === "write"),
    ).toHaveLength(1);
    expect(definition.inputs.map((input) => input.key)).toEqual(["goal", "readPaths", "writePaths", "model"]);
    expect(definition.edges.filter((edge) => edge.on === "reject")).toHaveLength(1);

    const approval = definition.nodes.find((node) => node.type === "approval");
    if (!approval || approval.type !== "approval") throw new Error("expected an approval node");
    expect(approval.config.allowReject).toBe(true);

    const decision = definition.nodes.find((node) => node.type === "decision");
    if (!decision || decision.type !== "decision") throw new Error("expected a decision node");
    expect(decision.config.directory).toBe("specs/decisions");
  });

  test("reports each B rule failure as a single issue equal to the error message", () => {
    const cases: { build: () => unknown; error: RegExp }[] = [
      { build: () => withNodes(agentNode("plan")), error: /^duplicate node id: plan$/ },
      { build: () => withEdges({ id: "e7", from: "decide", to: "write", on: "success" }), error: /^cycle detected on success edges/ },
      { build: () => withEdges({ id: "e7", from: "plan", to: "decide", on: "success" }), error: /^B workflow does not support branch nodes: plan$/ },
    ];

    for (const { build, error } of cases) {
      const caught = captureValidationError(() => validateWorkflowDefinition(build()));
      expect(caught.message).toMatch(error);
      expect(caught.issues).toHaveLength(1);
      expect(caught.issues[0]).toBe(caught.message);
    }
  });

  test("keeps schema failures as one formatted path: message issue per Zod problem", () => {
    const caught = captureValidationError(() => validateWorkflowDefinition(withNode("plan", { label: "   " })));
    expect(caught.issues.length).toBeGreaterThan(0);
    expect(caught.issues).toContainEqual("nodes.1.label: node label must not be empty");
    expect(caught.message).toBe(caught.issues.join("; "));
  });

  test("normalizes an empty approval config to allowReject: true", () => {
    const definition = validateWorkflowDefinition(base);
    const approval = definition.nodes.find((node) => node.type === "approval");
    if (!approval || approval.type !== "approval") throw new Error("expected an approval node");
    expect(approval.config.allowReject).toBe(true);
  });

  test("rejects allowReject: false on the approval config", () => {
    const caught = captureValidationError(() =>
      validateWorkflowDefinition(withNode("review", { config: { allowReject: false } })),
    );
    expect(caught.message).toMatch(/nodes\.4\.config\.allowReject/);
    expect(caught.issues.length).toBeGreaterThan(0);
  });

  test("trims ids, titles, labels, descriptions, input keys, and prompts", () => {
    const definition = validateWorkflowDefinition({
      ...base,
      id: "  wf_trim  ",
      title: "  Trimmed  ",
      description: "   ",
      inputs: [{ key: "  goal  ", label: "  Goal  ", type: "string" }],
      nodes: base.nodes.map((node) =>
        node.id === "plan"
          ? { ...node, label: "  Plan  ", config: { access: "read", prompt: "  Plan only.  " } }
          : node,
      ),
    });
    expect(definition.id).toBe("wf_trim");
    expect(definition.title).toBe("Trimmed");
    expect(definition.description).toBe("");
    expect(definition.inputs[0]?.key).toBe("goal");
    expect(definition.inputs[0]?.label).toBe("Goal");

    const plan = definition.nodes.find((node) => node.id === "plan");
    if (!plan || plan.type !== "agent") throw new Error("expected the plan agent node");
    expect(plan.label).toBe("Plan");
    expect(plan.config.prompt).toBe("Plan only.");
  });

  test.each(invalidCases)("rejects $name with a readable error", ({ build, error }) => {
    expectReadableError(() => validateWorkflowDefinition(build()), error);
  });
});

describe("workflow approval policy", () => {
  test("defaults settings.approvalPolicy to manual", () => {
    expect(validateWorkflowDefinition(base).settings.approvalPolicy).toBe("manual");
  });

  test("accepts settings.approvalPolicy auto", () => {
    const definition = validateWorkflowDefinition({
      ...base,
      settings: { ...base.settings, approvalPolicy: "auto" },
    });
    expect(definition.settings.approvalPolicy).toBe("auto");
  });

  test("rejects an unknown approval policy with a readable error", () => {
    expectReadableError(
      () =>
        validateWorkflowDefinition({
          ...base,
          settings: { ...base.settings, approvalPolicy: "sometimes" },
        }),
      /settings\.approvalPolicy/,
    );
  });

  test("keeps the default maxImplementAttempts when approvalPolicy is provided", () => {
    const definition = validateWorkflowDefinition({
      ...base,
      settings: { approvalPolicy: "auto" },
    });
    expect(definition.settings.maxImplementAttempts).toBe(3);
    expect(definition.settings.approvalPolicy).toBe("auto");
  });
});

describe("workflow run inputs", () => {
  const inputs = { goal: "Ship the feature", readPaths: ["src"], writePaths: ["src"] };

  test("accepts an optional context", () => {
    const parsed = WorkflowRunInputsSchema.parse({ ...inputs, context: "previous step summary" });
    expect(parsed.context).toBe("previous step summary");
    expect(WorkflowRunInputsSchema.parse(inputs).context).toBeUndefined();
  });

  test("bounds context to 32768 characters, not bytes", () => {
    const atLimit = "x".repeat(32768);
    expect(WorkflowRunInputsSchema.parse({ ...inputs, context: atLimit }).context).toHaveLength(32768);
    expect(() => WorkflowRunInputsSchema.parse({ ...inputs, context: "x".repeat(32769) })).toThrow(/32768/);
    // Multi-byte characters count as one character each; only the character count is capped.
    const multibyte = "上".repeat(32768);
    expect(WorkflowRunInputsSchema.parse({ ...inputs, context: multibyte }).context).toHaveLength(32768);
  });

  test("trims context and treats an empty or whitespace-only context as absent", () => {
    expect(WorkflowRunInputsSchema.parse({ ...inputs, context: "  previous step  " }).context).toBe("previous step");
    expect(WorkflowRunInputsSchema.parse({ ...inputs, context: "" }).context).toBeUndefined();
    expect(WorkflowRunInputsSchema.parse({ ...inputs, context: "   " }).context).toBeUndefined();
  });
});
