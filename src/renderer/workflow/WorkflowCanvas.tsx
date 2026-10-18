import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
  type ReactFlowInstance,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import "@xyflow/react/dist/style.css";
import type { WorkflowDefinition, WorkflowNode } from "../../shared/workflow";
import type { WorkflowNodeStatus } from "../../shared/workflow-api";
import { workflowNodeBadge, workflowNodeStatusLabels } from "./useWorkflow";

/** Everything a canvas card needs; it is rebuilt from the definition each render. */
type WorkflowNodeData = {
  kind: WorkflowNode["type"];
  label: string;
  badge: string;
  summary: string;
  selected: boolean;
  status?: WorkflowNodeStatus;
};

type WorkflowFlowNode = Node<WorkflowNodeData, WorkflowNode["type"]>;

export interface WorkflowCanvasProps {
  definition: WorkflowDefinition;
  selectedNodeId?: string | undefined;
  /** Latest run status per node id; empty when no run matches this definition. */
  nodeStatuses?: Record<string, WorkflowNodeStatus> | undefined;
  readOnly?: boolean;
  onSelectNode?: ((id: string) => void) | undefined;
  onMoveNode?: ((id: string, position: { x: number; y: number }) => void) | undefined;
  onConnect?: ((connection: Connection) => void) | undefined;
  onEdgesDelete?: ((edges: Edge[]) => void) | undefined;
}

function truncate(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > limit ? flat.slice(0, limit) + "…" : flat;
}

/** The one-line configuration summary shown under the node label. */
export function workflowNodeSummary(node: WorkflowNode): string {
  switch (node.type) {
    case "context":
      return "读取运行范围内的资料";
    case "agent":
      return (node.config.access === "write" ? "写入" : "只读") + " · " + truncate(node.config.prompt, 34);
    case "validation":
      return "运行现有校验器";
    case "approval":
      return "允许驳回，需人工批准";
    case "decision":
      return node.config.directory;
  }
}

function WorkflowNodeCard({ data }: NodeProps) {
  const node = data as unknown as WorkflowNodeData;
  const status = node.status;
  const classes = [
    "wf-node-card",
    "wf-node-" + node.kind,
    node.selected ? "is-selected" : "",
    status ? "wf-status-" + status : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes} data-node-type={node.kind} data-node-status={status ?? "idle"}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <header className="wf-node-head">
        <span className="wf-node-badge">{node.badge}</span>
        {status && <span className="wf-node-state">{workflowNodeStatusLabels[status]}</span>}
      </header>
      <strong className="wf-node-label">{node.label}</strong>
      <p className="wf-node-summary" title={node.summary}>
        {node.summary}
      </p>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

// Stable identity: React Flow warns when nodeTypes is recreated on every render.
const nodeTypes: NodeTypes = {
  context: WorkflowNodeCard,
  agent: WorkflowNodeCard,
  validation: WorkflowNodeCard,
  approval: WorkflowNodeCard,
  decision: WorkflowNodeCard,
};

function buildEdges(definition: WorkflowDefinition): Edge[] {
  return definition.edges.map((edge) => {
    const reject = edge.on === "reject";
    return {
      id: edge.id,
      source: edge.from,
      target: edge.to,
      type: "smoothstep",
      ...(reject ? { label: "驳回" } : {}),
      style: reject
        ? { stroke: "var(--danger-text)", strokeDasharray: "6 4" }
        : { stroke: "var(--accent)" },
      labelStyle: { fill: "var(--danger-text)", fontSize: 11 },
      labelBgStyle: { fill: "var(--bg-surface)" },
      markerEnd: { type: MarkerType.ArrowClosed, color: reject ? "var(--danger-text)" : "var(--accent)", width: 16, height: 16 },
    };
  });
}

/**
 * The React Flow canvas. Nodes are derived from the definition so data survives
 * re-renders; only drag positions are written back, on drag stop.
 */
export function WorkflowCanvas({
  definition,
  selectedNodeId,
  nodeStatuses,
  readOnly = false,
  onSelectNode,
  onMoveNode,
  onConnect,
  onEdgesDelete,
}: WorkflowCanvasProps) {
  const nodes = useMemo<WorkflowFlowNode[]>(
    () =>
      definition.nodes.map((node) => {
        const status = nodeStatuses?.[node.id];
        return {
          id: node.id,
          type: node.type,
          position: { x: node.position.x, y: node.position.y },
          data: {
            kind: node.type,
            label: node.label,
            badge: workflowNodeBadge(node),
            summary: workflowNodeSummary(node),
            selected: node.id === selectedNodeId,
            ...(status ? { status } : {}),
          },
          draggable: !readOnly,
          selectable: true,
          focusable: !readOnly,
          ariaLabel: "节点 " + node.label,
        };
      }),
    [definition, selectedNodeId, nodeStatuses, readOnly],
  );

  const edges = useMemo(() => buildEdges(definition), [definition]);

  const frameRef = useRef<HTMLDivElement | null>(null);
  const flowRef = useRef<ReactFlowInstance<WorkflowFlowNode, Edge> | null>(null);
  const fittedIdRef = useRef<string | undefined>(undefined);

  // The page is mounted while its navigation tab is hidden, so fit once the
  // frame actually has a size, and again when another definition is shown.
  const fitCanvas = useCallback(() => {
    const frame = frameRef.current;
    const flow = flowRef.current;
    if (!flow || !frame) return;
    const rect = frame.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return;
    if (fittedIdRef.current === definition.id) return;
    fittedIdRef.current = definition.id;
    void flow.fitView({ padding: 0.18, duration: 0, minZoom: 0.55 });
  }, [definition.id]);

  useEffect(() => {
    fitCanvas();
    const frame = frameRef.current;
    if (!frame || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => fitCanvas());
    observer.observe(frame);
    return () => observer.disconnect();
  }, [fitCanvas]);

  return (
    <div className="workflow-canvas-frame" ref={frameRef}>
      <ReactFlowProvider>
        <ReactFlow<WorkflowFlowNode, Edge>
          aria-label="工作流画布"
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onInit={(instance) => {
            flowRef.current = instance;
            fitCanvas();
          }}
          minZoom={0.55}
          maxZoom={1.6}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          nodesFocusable={!readOnly}
          edgesFocusable={!readOnly}
          elementsSelectable={!readOnly}
          onNodeClick={(_event, node) => onSelectNode?.(node.id)}
          onNodeDragStop={(_event, node) => onMoveNode?.(node.id, { x: node.position.x, y: node.position.y })}
          onConnect={(connection) => onConnect?.(connection)}
          onEdgesDelete={(deleted) => onEdgesDelete?.(deleted)}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable className="workflow-minimap" />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}
