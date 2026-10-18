import { ZodError, z } from "zod";

/**
 * Hard caps for a workflow definition. They are enforced by the schema before any
 * graph traversal so malformed or hostile input cannot exhaust memory.
 */
export const WORKFLOW_LIMITS = {
  nodes: 64,
  edges: 128,
  inputs: 16,
} as const;

/**
 * The single readable error thrown for every invalid workflow definition.
 *
 * Its message is a "; "-joined list of "path: message" entries (or a B rule
 * message) and its issues property exposes the same entries one by one.
 */
export class WorkflowValidationError extends Error {
  readonly issues: readonly string[];

  constructor(message: string, issues: readonly string[] = []) {
    super(message);
    this.name = "WorkflowValidationError";
    this.issues = issues;
  }
}

export const WorkflowNodeTypeSchema = z.enum(["context", "agent", "validation", "approval", "decision"]);
export const WorkflowInputTypeSchema = z.enum(["string", "paths", "model"]);
/** How the approval node is handled: wait for a person (manual) or approve automatically (auto). */
export const WorkflowApprovalPolicySchema = z.enum(["manual", "auto"]);
export type WorkflowApprovalPolicy = z.infer<typeof WorkflowApprovalPolicySchema>;

const WorkflowPositionSchema = z.object({ x: z.number(), y: z.number() }).strict();

const nodeIdentity = {
  id: z.string().trim().min(1, "node id must not be empty").max(80, "node id must be at most 80 characters"),
  label: z.string().trim().min(1, "node label must not be empty").max(120, "node label must be at most 120 characters"),
  position: WorkflowPositionSchema,
};

/** Context and validation nodes take no configuration at all. */
export const WorkflowEmptyConfigSchema = z.object({}).strict().prefault({});

export const WorkflowAgentConfigSchema = z
  .object({
    access: z.enum(["read", "write"]),
    prompt: z.string().trim().min(1, "agent prompt must not be empty"),
    model: z
      .string()
      .trim()
      .min(1, "agent model must not be empty")
      .max(120, "agent model must be at most 120 characters")
      .optional(),
  })
  .strict();

export const WorkflowApprovalConfigSchema = z
  .object({ allowReject: z.literal(true).default(true) })
  .strict()
  .prefault({});

export const WorkflowDecisionConfigSchema = z
  .object({ directory: z.literal("specs/decisions") })
  .strict();

/**
 * Definition settings. `approvalPolicy` is optional in a saved definition and
 * defaults to "manual" when the definition is parsed, so existing files keep
 * their current (manual) behaviour.
 */
export const WorkflowDefinitionSettingsSchema = z
  .object({
    maxImplementAttempts: z.number().int().min(1).max(10).default(3),
    approvalPolicy: WorkflowApprovalPolicySchema.default("manual"),
  })
  .strict();

export interface WorkflowDefinitionSettings {
  maxImplementAttempts: number;
  approvalPolicy?: WorkflowApprovalPolicy;
}

const WorkflowContextNodeSchema = z
  .object({ ...nodeIdentity, type: z.literal("context"), config: WorkflowEmptyConfigSchema })
  .strict();
const WorkflowAgentNodeSchema = z
  .object({ ...nodeIdentity, type: z.literal("agent"), config: WorkflowAgentConfigSchema })
  .strict();
const WorkflowValidationNodeSchema = z
  .object({ ...nodeIdentity, type: z.literal("validation"), config: WorkflowEmptyConfigSchema })
  .strict();
const WorkflowApprovalNodeSchema = z
  .object({ ...nodeIdentity, type: z.literal("approval"), config: WorkflowApprovalConfigSchema })
  .strict();
const WorkflowDecisionNodeSchema = z
  .object({ ...nodeIdentity, type: z.literal("decision"), config: WorkflowDecisionConfigSchema })
  .strict();

export const WorkflowNodeSchema = z.discriminatedUnion("type", [
  WorkflowContextNodeSchema,
  WorkflowAgentNodeSchema,
  WorkflowValidationNodeSchema,
  WorkflowApprovalNodeSchema,
  WorkflowDecisionNodeSchema,
]);

export const WorkflowEdgeSchema = z
  .object({
    id: z.string().trim().min(1, "edge id must not be empty").max(80, "edge id must be at most 80 characters"),
    from: z.string().trim().min(1, "edge source must not be empty"),
    to: z.string().trim().min(1, "edge target must not be empty"),
    on: z.enum(["success", "reject"]).default("success"),
  })
  .strict();

export const WorkflowInputSchema = z
  .object({
    key: z.string().trim().min(1, "input key must not be empty"),
    label: z.string().trim().min(1, "input label must not be empty").max(120, "input label must be at most 120 characters"),
    type: WorkflowInputTypeSchema,
    required: z.boolean().default(true),
  })
  .strict();

export const WorkflowDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().trim().min(1, "workflow id must not be empty").max(120, "workflow id must be at most 120 characters"),
    title: z
      .string()
      .trim()
      .min(1, "workflow title must not be empty")
      .max(200, "workflow title must be at most 200 characters"),
    description: z.string().trim().max(2000, "workflow description must be at most 2000 characters").default(""),
    version: z.number().int().positive(),
    inputs: z
      .array(WorkflowInputSchema)
      .max(WORKFLOW_LIMITS.inputs, "at most " + WORKFLOW_LIMITS.inputs + " inputs are supported"),
    nodes: z
      .array(WorkflowNodeSchema)
      .min(1)
      .max(WORKFLOW_LIMITS.nodes, "at most " + WORKFLOW_LIMITS.nodes + " nodes are supported"),
    edges: z
      .array(WorkflowEdgeSchema)
      .max(WORKFLOW_LIMITS.edges, "at most " + WORKFLOW_LIMITS.edges + " edges are supported"),
    settings: WorkflowDefinitionSettingsSchema,
  })
  .strict();

export type WorkflowDefinition = Omit<z.infer<typeof WorkflowDefinitionSchema>, "settings"> & {
  settings: WorkflowDefinitionSettings;
};
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>;
export type WorkflowInput = z.infer<typeof WorkflowInputSchema>;

function fail(message: string): never {
  // Every B rule reports exactly one issue; the message is that issue verbatim.
  throw new WorkflowValidationError(message, [message]);
}

function formatZodIssues(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map((part) => String(part)).join(".") : "(root)";
    return path + ": " + issue.message;
  });
}

function parseDefinition(input: unknown): WorkflowDefinition {
  try {
    return WorkflowDefinitionSchema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      const issues = formatZodIssues(error);
      throw new WorkflowValidationError(issues.join("; "), issues);
    }
    throw error;
  }
}

function assertUniqueInputKeys(inputs: readonly WorkflowInput[]): void {
  const keys = new Set<string>();
  for (const input of inputs) {
    if (keys.has(input.key)) fail("duplicate input key: " + input.key);
    keys.add(input.key);
  }
}

function countNodes(nodes: readonly WorkflowNode[], type: WorkflowNode["type"]): number {
  return nodes.filter((node) => node.type === type).length;
}

/** Success edges only: reject edges are the one intentional approval -> write back-edge. */
function buildSuccessAdjacency(edges: readonly WorkflowEdge[]): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.on !== "success") continue;
    const targets = adjacency.get(edge.from);
    if (targets) targets.push(edge.to);
    else adjacency.set(edge.from, [edge.to]);
  }
  return adjacency;
}

/** Iterative Kahn topological sort: any node left with incoming degree > 0 is in a cycle. */
function assertNoSuccessCycle(nodes: readonly WorkflowNode[], adjacency: ReadonlyMap<string, readonly string[]>): void {
  const indegree = new Map<string, number>();
  for (const node of nodes) indegree.set(node.id, 0);
  for (const targets of adjacency.values()) {
    for (const target of targets) indegree.set(target, (indegree.get(target) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [id, degree] of indegree) {
    if (degree === 0) queue.push(id);
  }

  let visited = 0;
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (current === undefined) continue;
    visited += 1;
    for (const next of adjacency.get(current) ?? []) {
      const degree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, degree);
      if (degree === 0) queue.push(next);
    }
  }

  if (visited === nodes.length) return;
  const cycleNodes = nodes.filter((node) => (indegree.get(node.id) ?? 0) > 0).map((node) => node.id);
  fail("cycle detected on success edges involving: " + cycleNodes.join(", "));
}

/** Iterative reachability walk from the context node over success edges. */
function assertAllReachable(
  nodes: readonly WorkflowNode[],
  adjacency: ReadonlyMap<string, readonly string[]>,
  startId: string,
): void {
  const reachable = new Set<string>([startId]);
  const pending: string[] = [startId];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    for (const next of adjacency.get(current) ?? []) {
      if (reachable.has(next)) continue;
      reachable.add(next);
      pending.push(next);
    }
  }
  for (const node of nodes) {
    if (!reachable.has(node.id)) fail("unreachable node: " + node.id);
  }
}

export function validateWorkflowDefinition(input: unknown): WorkflowDefinition {
  const definition = parseDefinition(input);

  assertUniqueInputKeys(definition.inputs);

  const nodesById = new Map<string, WorkflowNode>();
  for (const node of definition.nodes) {
    if (nodesById.has(node.id)) fail("duplicate node id: " + node.id);
    nodesById.set(node.id, node);
  }

  const edgeIds = new Set<string>();
  for (const edge of definition.edges) {
    if (edgeIds.has(edge.id)) fail("duplicate edge id: " + edge.id);
    edgeIds.add(edge.id);
    if (!nodesById.has(edge.from)) fail("edge \"" + edge.id + "\" references unknown node: " + edge.from);
    if (!nodesById.has(edge.to)) fail("edge \"" + edge.id + "\" references unknown node: " + edge.to);
  }

  const writeAgents = definition.nodes.filter((node) => node.type === "agent" && node.config.access === "write");
  const writeAgent = writeAgents[0];
  if (!writeAgent || writeAgents.length !== 1) fail("B workflow requires exactly one write agent");

  if (countNodes(definition.nodes, "context") !== 1) fail("exactly one context node is required");
  if (countNodes(definition.nodes, "validation") !== 1) fail("exactly one validation node is required");
  if (countNodes(definition.nodes, "approval") !== 1) fail("exactly one approval node is required");
  if (countNodes(definition.nodes, "decision") !== 1) fail("exactly one decision node is required");

  const successAdjacency = buildSuccessAdjacency(definition.edges);
  assertNoSuccessCycle(definition.nodes, successAdjacency);

  for (const [nodeId, targets] of successAdjacency) {
    if (targets.length > 1) fail("B workflow does not support branch nodes: " + nodeId);
  }

  const rejectEdges = definition.edges.filter((edge) => edge.on === "reject");
  if (rejectEdges.length > 1) fail("B workflow supports at most one reject edge");
  const rejectEdge = rejectEdges[0];
  if (rejectEdge) {
    const source = nodesById.get(rejectEdge.from);
    if (source?.type !== "approval") fail("reject edge must start at an approval node");
    if (rejectEdge.to !== writeAgent.id) fail("reject edge must return to the write agent");
  }

  const context = definition.nodes.find((node) => node.type === "context");
  if (!context) fail("exactly one context node is required");
  assertAllReachable(definition.nodes, successAdjacency, context.id);

  return definition;
}
