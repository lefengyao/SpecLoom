import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from "../../shared/workflow";

/**
 * B-aware graph edits. B workflows are linear: every node except approval has
 * one success edge, approval additionally has the single reject edge back to
 * the write agent. The palette therefore adds/removes only read-only agent
 * nodes; the required singleton nodes and the single write agent stay fixed.
 */
export function canRemoveNode(definition: WorkflowDefinition, nodeId: string): boolean {
  const node = definition.nodes.find((candidate) => candidate.id === nodeId);
  return node?.type === "agent" && node.config.access === "read" && node.id !== "plan";
}

export function addReadAgent(definition: WorkflowDefinition, id: string): { definition: WorkflowDefinition; nodeId: string } | undefined {
  const write = definition.nodes.find((node) => node.type === "agent" && node.config.access === "write");
  if (!write || definition.nodes.some((node) => node.id === id)) return undefined;
  const incoming = definition.edges.find((edge) => edge.on === "success" && edge.to === write.id);
  if (!incoming) return undefined;
  const predecessor = definition.nodes.find((node) => node.id === incoming.from);
  if (!predecessor) return undefined;
  const node: WorkflowNode = {
    id,
    type: "agent",
    label: "只读 Agent",
    position: { x: predecessor.position.x + 90, y: predecessor.position.y + 150 },
    config: { access: "read", prompt: "阅读运行范围内的资料，输出补充分析；不得修改文件。" },
  };
  const edges = definition.edges.filter((edge) => edge.id !== incoming.id);
  const nextEdges: WorkflowEdge[] = [
    ...edges,
    { id: "e_" + id + "_in", from: predecessor.id, to: id, on: "success" },
    { id: "e_" + id + "_out", from: id, to: write.id, on: "success" },
  ];
  return {
    definition: { ...definition, nodes: [...definition.nodes, node], edges: nextEdges },
    nodeId: id,
  };
}

export function removeReadAgent(definition: WorkflowDefinition, nodeId: string): WorkflowDefinition | undefined {
  if (!canRemoveNode(definition, nodeId)) return undefined;
  const incoming = definition.edges.find((edge) => edge.on === "success" && edge.to === nodeId);
  const outgoing = definition.edges.find((edge) => edge.on === "success" && edge.from === nodeId);
  if (!incoming || !outgoing) return undefined;
  const edges = definition.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId);
  edges.push({ id: "e_" + incoming.from + "_" + outgoing.to + "_bridge", from: incoming.from, to: outgoing.to, on: "success" });
  return { ...definition, nodes: definition.nodes.filter((node) => node.id !== nodeId), edges };
}

/** Rewire one success edge, replacing whatever source/target previously used. */
export function connectSuccess(definition: WorkflowDefinition, source: string, target: string, id: string): WorkflowDefinition | undefined {
  if (source === target || !definition.nodes.some((node) => node.id === source) || !definition.nodes.some((node) => node.id === target)) return undefined;
  const edges = definition.edges.filter((edge) => !(edge.on === "success" && (edge.from === source || edge.to === target)));
  edges.push({ id, from: source, to: target, on: "success" });
  return { ...definition, edges };
}

export function deleteEdges(definition: WorkflowDefinition, edgeIds: string[]): WorkflowDefinition {
  const removed = new Set(edgeIds);
  return { ...definition, edges: definition.edges.filter((edge) => !removed.has(edge.id)) };
}
