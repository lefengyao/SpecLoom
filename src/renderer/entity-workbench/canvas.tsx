import { useCallback, useEffect, useMemo, useRef } from "react";
import { Background, Controls, ReactFlow, ReactFlowProvider, type Connection, type Edge, type ReactFlowInstance } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { type ComponentField, type ComponentValue } from "../../shared/project-materials";
import { useI18n } from "../i18n";
import { ENTITY_CARD_SIZE, COMPONENT_CARD_SIZE, ENTITY_NODE_ID, ENTITY_ORIGIN, facingSides, mountParentId, packMountPositions, layoutSize, nearestFreePosition, rectOf, rectsOverlap, type EntityAnchorSide, type EntityComponentLayout, type EntityPoint, type EntityRect, type EntitySize } from "../entity-layout";
import "../component-browser.css";
import { BackgroundVariant, MarkerType, useEdgesState, useNodesState, type NodeChange } from "@xyflow/react";
import { COMPONENT_NODE_PREFIX, componentNodeId, nodeTypes, type WorkbenchFlowNode } from "./cards";
import { bindingSummary, clamp, fieldTypeLabels, formatValue, isAnchorSide, type EntityEntry, type ResolvedBinding } from "./model";
export function EntityCanvas({
  entity,
  bindings,
  storedPositions,
  selectedBindingId,
  imageUrl,
  imageMaxHeight = 160,
  inheritsFrom,
  onSelectBinding,
  onMoveBinding,
  onMeasure,
  onConnectAnchor,
}: {
  entity: EntityEntry;
  bindings: ResolvedBinding[];
  storedPositions: Record<string, EntityComponentLayout>;
  selectedBindingId: string | undefined;
  imageUrl?: string | undefined;
  imageMaxHeight?: number;
  inheritsFrom?: string | undefined;
  onSelectBinding: (bindingId: string | undefined) => void;
  onMoveBinding: (bindingId: string, position: EntityPoint) => void;
  onMeasure?: ((nodeId: string, size: EntitySize) => void) | undefined;
  onConnectAnchor?: ((bindingId: string, sourceAnchor: EntityAnchorSide, targetAnchor: string) => void) | undefined;
}) {
  const tr = useI18n();
  const model = useMemo(() => {
    const selfSize = layoutSize(storedPositions[ENTITY_NODE_ID], ENTITY_CARD_SIZE);
    const boundIds = new Set(bindings.map((binding) => binding.id));
    const sizes: Record<string, EntitySize> = {};
    for (const binding of bindings) sizes[binding.id] = layoutSize(storedPositions[binding.id], COMPONENT_CARD_SIZE);
    // Default placement follows the mount tree: direct mounts beside the entity, nested mounts outward.
    const defaults = packMountPositions(bindings.map((binding) => {
      const parent = mountParentId(binding.id, binding.mount?.parent, boundIds);
      return { id: binding.id, size: sizes[binding.id]!, ...(parent ? { parent } : {}) };
    }), selfSize);
    const inheritedCount = bindings.filter((binding) => !binding.own).length;
    const rects: Record<string, EntityRect> = { [ENTITY_NODE_ID]: rectOf(ENTITY_ORIGIN, selfSize) };
    const positions = new Map<string, EntityPoint>();
    for (const binding of bindings) {
      const stored = storedPositions[binding.id];
      const position = stored ? { x: stored.x, y: stored.y } : defaults[binding.id] ?? { x: selfSize.width + 24, y: 0 };
      positions.set(binding.id, position);
      rects[binding.id] = rectOf(position, sizes[binding.id]!);
    }
    // Overlap is judged from the layout rectangles, so cards are flagged as soon as they collide.
    const overlapping = new Set<string>();
    for (const [id, rect] of Object.entries(rects)) {
      if (Object.entries(rects).some(([otherId, other]) => otherId !== id && rectsOverlap(rect, other))) overlapping.add(id);
    }
    const nodes: WorkbenchFlowNode[] = [
      {
        id: ENTITY_NODE_ID,
        type: "entity",
        position: { ...ENTITY_ORIGIN },
        data: {
          kind: "entity",
          title: entity.title,
          meta: `${bindings.length} ${tr("个组件")}${inheritedCount ? ` · ${tr("{count} 个继承", { count: inheritedCount })}` : ""}`,
          path: entity.path,
          ...(entity.anchors?.length ? { specAnchors: entity.anchors } : {}),
          ...(imageUrl ? { imageUrl, imageMaxHeight } : {}),
          ...(inheritsFrom ? { inheritedFrom: inheritsFrom } : {}),
        },
        draggable: false,
        selectable: false,
        focusable: true,
        ariaLabel: tr("实体 {title}", { title: entity.title }),
        ...(overlapping.has(ENTITY_NODE_ID) ? { className: "ewb-overlap" } : {}),
      },
    ];
    const entityRect = rects[ENTITY_NODE_ID]!;
    const edges: Edge[] = [];
    for (const binding of bindings) {
      const title = binding.component?.title ?? binding.id;
      const meta = binding.component ? tr("{count} 个字段", { count: binding.component.fields.length }) : tr("组件定义缺失");
      const stored = storedPositions[binding.id];
      const position = positions.get(binding.id)!;
      const rect = rects[binding.id]!;
      const anchors = stored?.anchors ?? [];
      // A mount on another component draws parent → child; the entity is only the
      // fallback when the mount names the entity or a component that is not bound.
      const parentId = mountParentId(binding.id, binding.mount?.parent, boundIds);
      const sourceRect = parentId ? rects[parentId]! : entityRect;
      const sides = facingSides(sourceRect, rect);
      const sourceAnchor = parentId ? sides.source : isAnchorSide(stored?.sourceAnchor) ? stored.sourceAnchor : sides.source;
      const chosenTarget = stored?.targetAnchor;
      const targetAnchor = isAnchorSide(chosenTarget) || anchors.some((anchor) => anchor.id === chosenTarget) ? chosenTarget! : sides.target;
      nodes.push({
        id: componentNodeId(binding.id),
        type: "component",
        position,
        data: {
          kind: "component",
          title,
          meta,
          summary: bindingSummary(binding, tr),
          selected: binding.id === selectedBindingId,
          inherited: !binding.own,
          ...(binding.inheritedFrom ? { inheritedFrom: binding.inheritedFrom } : {}),
          ...(binding.component ? {} : { missing: true }),
          ...(anchors.length ? { anchors } : {}),
          ...(binding.component?.anchors?.length ? { specAnchors: binding.component.anchors } : {}),
          ...(binding.mount ? { mount: binding.mount } : {}),
        },
        draggable: true,
        selectable: true,
        focusable: true,
        ariaLabel: tr("组件 {title}", { title }),
        ...(overlapping.has(binding.id) ? { className: "ewb-overlap" } : {}),
      });
      edges.push({
        id: parentId ? `mount-edge:${binding.id}` : `entity-edge:${binding.id}`,
        source: parentId ? componentNodeId(parentId) : ENTITY_NODE_ID,
        sourceHandle: `source-${sourceAnchor}`,
        target: componentNodeId(binding.id),
        targetHandle: `target-${targetAnchor}`,
        type: "default",
        ...(parentId && binding.mount ? {
          label: binding.mount.anchor,
          labelStyle: { fill: "var(--text-subtle)", fontSize: 10 },
          labelBgStyle: { fill: "var(--bg-surface)", fillOpacity: 0.9 },
        } : {}),
        style: binding.own
          ? { stroke: "var(--accent)" }
          : { stroke: "var(--text-faint)", strokeDasharray: "5 4" },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color: binding.own ? "var(--accent)" : "var(--text-faint)",
        },
        ariaLabel: parentId
          ? tr("{parent} 的 {anchor} 挂载 {child}", { parent: parentId, anchor: binding.mount?.anchor ?? "", child: title })
          : tr("{source} 到 {target}", { source: entity.title, target: title }),
      });
    }
    return { nodes, edges, rects };
  }, [entity, bindings, storedPositions, selectedBindingId, imageUrl, imageMaxHeight, inheritsFrom, tr]);

  const [nodes, setNodes, onNodesChange] = useNodesState<WorkbenchFlowNode>(model.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(model.edges);
  // Measured card sizes flow back into the layout so overlap uses real rectangles.
  const changeNodes = useCallback((changes: NodeChange<WorkbenchFlowNode>[]) => {
    onNodesChange(changes);
    if (!onMeasure) return;
    for (const change of changes) {
      if (change.type !== "dimensions" || !change.dimensions) continue;
      const { width, height } = change.dimensions;
      if (width > 0 && height > 0) onMeasure(change.id, { width: Math.round(width), height: Math.round(height) });
    }
  }, [onNodesChange, onMeasure]);
  const draggingRef = useRef(false);
  const draggedRef = useRef(false);
  const connectingRef = useRef(false);

  useEffect(() => {
    // React Flow owns node positions while dragging; syncing the stored model
    // mid-drag would snap the card back and make the canvas flicker.
    setNodes((current) => draggingRef.current ? current : model.nodes);
    setEdges(model.edges);
  }, [model, setNodes, setEdges]);

  const frameRef = useRef<HTMLDivElement | null>(null);
  const flowRef = useRef<ReactFlowInstance<WorkbenchFlowNode, Edge> | null>(null);
  const fittedEntityRef = useRef<string | undefined>(undefined);

  // The page can mount while its navigation tab is hidden, so fit only once the
  // frame has a real size, and again when another entity is shown.
  const fitCanvas = useCallback(() => {
    const frame = frameRef.current;
    const flow = flowRef.current;
    if (!frame || !flow) return;
    const rect = frame.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return;
    if (fittedEntityRef.current === entity.id) return;
    fittedEntityRef.current = entity.id;
    void flow.fitView({ padding: 0.18, duration: 0, minZoom: 0.4 });
  }, [entity.id]);

  useEffect(() => {
    fitCanvas();
    const frame = frameRef.current;
    if (!frame || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => fitCanvas());
    observer.observe(frame);
    return () => observer.disconnect();
  }, [fitCanvas]);

  const selectNode = (node: WorkbenchFlowNode) => {
    if (node.id === ENTITY_NODE_ID) {
      onSelectBinding(undefined);
      return;
    }
    if (draggedRef.current) {
      draggedRef.current = false;
      return;
    }
    if (connectingRef.current) return;
    const bindingId = node.id.slice(COMPONENT_NODE_PREFIX.length);
    onSelectBinding(selectedBindingId === bindingId ? undefined : bindingId);
  };
  const connect = (connection: Connection) => {
    if (connection.source !== ENTITY_NODE_ID || !connection.target?.startsWith(COMPONENT_NODE_PREFIX)) return;
    const bindingId = connection.target.slice(COMPONENT_NODE_PREFIX.length);
    const sourceAnchor = connection.sourceHandle?.replace(/^source-/, "");
    const targetAnchor = connection.targetHandle?.replace(/^target-/, "");
    if (!isAnchorSide(sourceAnchor) || !targetAnchor) return;
    onConnectAnchor?.(bindingId, sourceAnchor, targetAnchor);
  };
  const moveNode = (node: WorkbenchFlowNode) => {
    if (node.id === ENTITY_NODE_ID) return;
    const bindingId = node.id.slice(COMPONENT_NODE_PREFIX.length);
    const known = model.rects[bindingId];
    const size: EntitySize = {
      width: Math.round(node.measured?.width ?? known?.width ?? COMPONENT_CARD_SIZE.width),
      height: Math.round(node.measured?.height ?? known?.height ?? COMPONENT_CARD_SIZE.height),
    };
    const desired = { x: node.position.x, y: node.position.y };
    const obstacles = Object.entries(model.rects).filter(([id]) => id !== bindingId).map(([, rect]) => rect);
    const blocked = obstacles.some((obstacle) => rectsOverlap(rectOf(desired, size), obstacle));
    onMoveBinding(bindingId, blocked ? nearestFreePosition(desired, size, obstacles) : desired);
  };

  return (
    <div className="ewb-canvas-frame" ref={frameRef}>
      <ReactFlowProvider>
        <ReactFlow<WorkbenchFlowNode, Edge>
          aria-label={tr("{title} 组件画布", { title: entity.title })}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={changeNodes}
          onEdgesChange={onEdgesChange}
          minZoom={0.4}
          maxZoom={1.6}
          snapToGrid
          snapGrid={[16, 16]}
          nodesConnectable
          edgesFocusable={false}
          onConnect={connect}
          onReconnect={(_edge, connection) => connect(connection)}
          onConnectStart={() => { connectingRef.current = true; }}
          onConnectEnd={() => { setTimeout(() => { connectingRef.current = false; }, 0); }}
          onReconnectStart={() => { connectingRef.current = true; }}
          onReconnectEnd={() => { setTimeout(() => { connectingRef.current = false; }, 0); }}
          onInit={(instance) => {
            flowRef.current = instance;
            fitCanvas();
          }}
          onNodeClick={(_event, node) => selectNode(node)}
          onPaneClick={() => onSelectBinding(undefined)}
          onNodeDragStart={() => { draggedRef.current = false; }}
          onNodeDrag={(_event, node) => {
            draggingRef.current = true;
            draggedRef.current = true;
            if (node.id === ENTITY_NODE_ID) return;
            // Live feedback: outline the card as soon as it collides, before the drop repairs it.
            const known = model.rects[node.id];
            const size: EntitySize = {
              width: Math.round(node.measured?.width ?? known?.width ?? COMPONENT_CARD_SIZE.width),
              height: Math.round(node.measured?.height ?? known?.height ?? COMPONENT_CARD_SIZE.height),
            };
            const rect = rectOf(node.position, size);
            const blocked = Object.entries(model.rects).some(([id, other]) => id !== node.id && rectsOverlap(rect, other));
            setNodes((current) => current.map((item) => item.id === node.id ? { ...item, className: blocked ? "ewb-overlap" : "" } : item));
          }}
          onNodeDragStop={(_event, node) => {
            const moved = draggedRef.current;
            draggingRef.current = false;
            if (moved) moveNode(node);
            setTimeout(() => { draggedRef.current = false; }, 0);
          }}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}

export interface EntityComponentBoardProps {
  entity: EntityEntry;
  bindings: ResolvedBinding[];
  storedPositions: Record<string, EntityComponentLayout>;
  selectedBindingId: string | undefined;
  imageUrl?: string | undefined;
  imageMaxHeight?: number;
  inheritsFrom?: string | undefined;
  onSelectBinding: (bindingId: string | undefined) => void;
  onMoveBinding: (bindingId: string, position: EntityPoint) => void;
  onMeasure?: ((nodeId: string, size: EntitySize) => void) | undefined;
  onConnectAnchor?: ((bindingId: string, sourceAnchor: EntityAnchorSide, targetAnchor: string) => void) | undefined;
}

/** Reusable entity-centered component board (entity card + derived component nodes). */
export function EntityComponentBoard(props: EntityComponentBoardProps) {
  return <EntityCanvas {...props} />;
}

export function FieldEditor({
  field,
  value,
  disabled,
  range,
  onChange,
}: {
  field: ComponentField;
  value: ComponentValue;
  disabled: boolean;
  range?: { current: number; max: number };
  onChange: (value: ComponentValue) => void;
}) {
  const tr = useI18n();
  const inputId = `ewb-field-${field.key}`;
  const label = field.label ?? field.key;
  return (
    <div className="ewb-field">
      <label className="ewb-field-label" htmlFor={inputId}>
        {label}
      </label>
      <span className="ewb-field-meta">
        {tr(fieldTypeLabels[field.type])} · {tr("默认")} {formatValue(field.default, tr)}
      </span>
      {field.type === "number" && (
        <input
          id={inputId}
          type="number"
          inputMode="numeric"
          value={typeof value === "number" ? String(value) : String(field.default)}
          disabled={disabled}
          onChange={(event) => {
            const raw = event.target.value;
            if (raw === "") {
              onChange(field.default);
              return;
            }
            const next = Number(raw);
            if (Number.isFinite(next)) onChange(next);
          }}
        />
      )}
      {field.type === "string" && (
        <input
          id={inputId}
          type="text"
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {field.type === "boolean" && (
        <span className="ewb-switch">
          <input
            id={inputId}
            type="checkbox"
            checked={value === true}
            disabled={disabled}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span>{value === true ? tr("开启") : tr("关闭")}</span>
        </span>
      )}
      {range && (
        <span className="ewb-range">
          <progress aria-label={tr("{label} 范围", { label })} max={range.max} value={clamp(range.current, 0, range.max)} />
          <span className="subtle">
            {range.current} / {range.max}
          </span>
        </span>
      )}
    </div>
  );
}


