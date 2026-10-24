import { Image as ImageIcon, ImageOff, LayoutGrid, Plus, RefreshCw, Save, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
  type NodeTypes,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { FileReadResult } from "../shared/contracts";
import type { DesktopApi } from "../shared/desktop-api";
import {
  parseMaterial,
  readAnchors,
  readBindings,
  readFields,
  writeMaterial,
  type ComponentAnchor,
  type ComponentBinding,
  type ComponentField,
  type ComponentMount,
  type ComponentValue,
} from "../shared/project-materials";
import { materialGroupPath, normalizeMaterialGroups } from "../shared/material-groups";
import { resolveComponentAnchors, resolveComponentFields } from "../shared/component-inheritance";
import { categoryForPath, referenceId } from "./materials-model";
import { ComponentBrowserDialog, type BrowserEntry } from "./ComponentBrowserDialog";
import { useI18n, type Translate } from "./i18n";
import "./component-browser.css";
import {
  ENTITY_ANCHOR_SIDES,
  ENTITY_CARD_SIZE,
  COMPONENT_CARD_SIZE,
  ENTITY_NODE_ID,
  ENTITY_ORIGIN,
  defaultEntityPositions,
  createLayoutSaver,
  facingSides,
  mountParentId,
  packMountPositions,
  layoutSize,
  loadEntityLayout,
  nearestFreePosition,
  pruneEntityLayout,
  rectOf,
  rectsOverlap,
  saveEntityLayout,
  type EntityAnchor,
  type EntityAnchorSide,
  type EntityComponentLayout,
  type EntityLayout,
  type EntityPoint,
  type EntityRect,
  type EntitySize,
} from "./entity-layout";
import "./entity-workbench.css";

const COMPONENT_NODE_PREFIX = "component:";
const EMPTY_POSITIONS: Record<string, EntityPoint> = {};
const fieldTypeLabels: Record<ComponentField["type"], string> = { number: "数值", string: "文本", boolean: "布尔" };
const IMAGE_SETTINGS_PREFIX = "specloom.entity-workbench.images.";
const IMAGE_SIZE_MIN = 80;
const IMAGE_SIZE_MAX = 360;
interface WorkbenchImageSettings { show: boolean; size: number }

/** Drop blank per-binding notes and trim the rest before the entity is saved. */
function cleanBindingNotes(content: string): string {
  const parsed = parseMaterial(content);
  if (!parsed || !Array.isArray(parsed.data.components)) return content;
  let changed = false;
  const components = parsed.data.components.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const record = entry as Record<string, unknown>;
    const rawNotes = record.notes;
    if (!Array.isArray(rawNotes)) return entry;
    const notes = rawNotes.filter((note): note is string => typeof note === "string" && note.trim().length > 0).map((note) => note.trim()).slice(0, 32);
    if (notes.length === rawNotes.length && notes.every((note, index) => note === rawNotes[index])) return entry;
    changed = true;
    const next = { ...record };
    if (notes.length) next.notes = notes; else delete next.notes;
    return next;
  });
  return changed ? writeMaterial({ ...parsed.data, components }, parsed.body) : content;
}

function loadImageSettings(projectPath: string): WorkbenchImageSettings {
  try {
    const raw = window.localStorage.getItem(`${IMAGE_SETTINGS_PREFIX}${projectPath.trim()}`);
    if (raw) {
      const value = JSON.parse(raw) as { show?: unknown; size?: unknown };
      const size = typeof value.size === "number" && Number.isFinite(value.size) ? clamp(Math.round(value.size), IMAGE_SIZE_MIN, IMAGE_SIZE_MAX) : 160;
      return { show: value.show !== false, size };
    }
  } catch { /* Storage can be unavailable; keep the defaults. */ }
  return { show: true, size: 160 };
}

function saveImageSettings(projectPath: string, settings: WorkbenchImageSettings): void {
  try { window.localStorage.setItem(`${IMAGE_SETTINGS_PREFIX}${projectPath.trim()}`, JSON.stringify(settings)); }
  catch { /* The preference is best effort. */ }
}

export interface EntityEntry {
  path: string;
  version: FileReadResult["version"];
  id: string;
  title: string;
  extendsRef?: string;
  data: Record<string, unknown>;
  body: string;
  content: string;
  baseline: string;
  bindings: ComponentBinding[];
  anchors?: ComponentAnchor[];
}

interface ComponentEntry {
  path: string;
  id: string;
  title: string;
  fields: ComponentField[];
  description?: string;
  notes?: string[];
  body?: string;
  scope: "system" | "user";
  group?: string;
  groupId?: string;
  extendsRef?: string;
  anchors?: ComponentAnchor[];
}

export interface ResolvedBinding {
  id: string;
  values: Record<string, ComponentValue>;
  notes: string[];
  own: boolean;
  component?: ComponentEntry;
  inheritedFrom?: string;
  mount?: ComponentMount;
}

interface MaterialLookup {
  entitiesById: Map<string, EntityEntry>;
  entitiesByPath: Map<string, EntityEntry>;
  componentsById: Map<string, ComponentEntry>;
  componentsByPath: Map<string, ComponentEntry>;
}

function normalizeReference(value: string): string {
  return value.trim().replace(/^res:\/\//i, "").replaceAll("\\", "/").toLowerCase();
}

function describeError(error: unknown, fallback: string): string {
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

function formatValue(value: ComponentValue, tr: Translate): string {
  if (typeof value === "boolean") return value ? tr("是") : tr("否");
  if (value === "") return tr("（空）");
  return String(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isAnchorSide(value: unknown): value is EntityAnchorSide {
  return (ENTITY_ANCHOR_SIDES as readonly unknown[]).includes(value);
}

function anchorPosition(side: EntityAnchorSide): Position {
  return side === "top" ? Position.Top : side === "right" ? Position.Right : side === "bottom" ? Position.Bottom : Position.Left;
}

function anchorOffsetStyle(anchor: EntityAnchor): { left?: string; top?: string } {
  return anchor.side === "top" || anchor.side === "bottom" ? { left: `${anchor.offset}%` } : { top: `${anchor.offset}%` };
}

const anchorSideLabels: Record<EntityAnchorSide, string> = { top: "上", right: "右", bottom: "下", left: "左" };
function newAnchorId(): string {
  const suffix = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `custom-${suffix}`;
}

/** A stored value only counts when it matches the declared field type. */
function readFieldValue(binding: ResolvedBinding, field: ComponentField): ComponentValue {
  const value = binding.values[field.key];
  switch (field.type) {
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? value : typeof field.default === "number" ? field.default : 0;
    case "boolean":
      return typeof value === "boolean" ? value : field.default === true;
    case "string":
      return typeof value === "string" ? value : typeof field.default === "string" ? field.default : "";
  }
}

function bindingSummary(binding: ResolvedBinding, tr: Translate): string {
  const component = binding.component;
  if (!component) return tr("组件定义缺失");
  const fields = component.fields.slice(0, 3).map((field) => `${field.label ?? field.key} ${formatValue(readFieldValue(binding, field), tr)}`);
  return fields.length ? fields.join(" · ") : tr("没有字段");
}

function resolveEntityReference(reference: string | undefined, lookup: MaterialLookup): EntityEntry | undefined {
  if (!reference) return undefined;
  const direct = lookup.entitiesById.get(reference.trim());
  if (direct) return direct;
  const normalized = normalizeReference(reference);
  return lookup.entitiesByPath.get(normalized) ?? lookup.entitiesByPath.get(normalized.replace(/\.md$/, ""));
}

function resolveComponentReference(reference: string, lookup: MaterialLookup): ComponentEntry | undefined {
  const trimmed = reference.trim();
  if (!trimmed) return undefined;
  const direct = lookup.componentsById.get(trimmed);
  if (direct) return direct;
  const normalized = normalizeReference(reference);
  return lookup.componentsByPath.get(normalized) ?? lookup.componentsByPath.get(normalized.replace(/\.md$/, ""));
}

/** Ancestors of one entity, base-first and cycle safe. */
function entityAncestors(entity: EntityEntry, lookup: MaterialLookup): EntityEntry[] {
  const chain: EntityEntry[] = [];
  const seen = new Set<string>([entity.path]);
  let cursor = resolveEntityReference(entity.extendsRef, lookup);
  while (cursor && !seen.has(cursor.path)) {
    seen.add(cursor.path);
    chain.unshift(cursor);
    cursor = resolveEntityReference(cursor.extendsRef, lookup);
  }
  return chain;
}

/**
 * Merge bindings down the extends chain, base-first. A child binding overrides
 * inherited values for the same component and always wins the binding kind.
 */
function resolveEntityBindings(entity: EntityEntry, lookup: MaterialLookup): ResolvedBinding[] {
  const ancestors = entityAncestors(entity, lookup);
  const identify = (reference: string): string => resolveComponentReference(reference, lookup)?.id ?? normalizeReference(reference);
  const order: string[] = [];
  const ids = new Map<string, string>();
  const values = new Map<string, Record<string, ComponentValue>>();
  const notes = new Map<string, string[]>();
  const inheritedFrom = new Map<string, string>();
  const mounts = new Map<string, ComponentMount>();
  const ownIdentities = new Set(entity.bindings.map((binding) => identify(binding.id)));
  for (const source of [...ancestors, entity]) {
    for (const binding of source.bindings) {
      const identity = identify(binding.id);
      if (!values.has(identity)) order.push(identity);
      ids.set(identity, binding.id);
      values.set(identity, { ...values.get(identity), ...binding.values });
      if (binding.mount) mounts.set(identity, binding.mount);
      if (source === entity) {
        inheritedFrom.delete(identity);
        notes.set(identity, binding.notes ?? []);
      } else inheritedFrom.set(identity, source.title);
    }
  }
  return order.map((identity) => {
    const id = ids.get(identity) ?? identity;
    const component = resolveComponentReference(id, lookup);
    const inheritedTitle = ownIdentities.has(identity) ? undefined : inheritedFrom.get(identity);
    const mount = mounts.get(identity);
    return {
      id,
      values: values.get(identity) ?? {},
      notes: notes.get(identity) ?? [],
      own: ownIdentities.has(identity),
      ...(component ? { component } : {}),
      ...(inheritedTitle ? { inheritedFrom: inheritedTitle } : {}),
      ...(mount ? { mount } : {}),
    };
  });
}

type WorkbenchNodeData = {
  kind: "entity" | "component";
  title: string;
  meta: string;
  summary?: string;
  path?: string;
  inherited?: boolean;
  inheritedFrom?: string;
  selected?: boolean;
  missing?: boolean;
  imageUrl?: string;
  imageMaxHeight?: number;
  anchors?: EntityAnchor[];
  /** Attach points declared by the spec; `anchors` above stays canvas-only. */
  specAnchors?: ComponentAnchor[];
  mount?: ComponentMount;
};

type WorkbenchFlowNode = Node<WorkbenchNodeData>;

function EntityCard({ data }: NodeProps) {
  const tr = useI18n();
  const card = data as unknown as WorkbenchNodeData;
  const inheritance = card.inheritedFrom ? tr("继承自 {source}", { source: card.inheritedFrom }) : undefined;
  return (
    <div className="ewb-card ewb-card-entity" title={[card.path, inheritance].filter(Boolean).join("\n") || undefined}>
      {card.imageUrl && <img className="ewb-card-image" src={card.imageUrl} alt={tr("{title}配图", { title: card.title })} style={{ maxHeight: card.imageMaxHeight ?? 160 }} />}
      <span className="ewb-card-kicker">{tr("实体")}</span>
      <strong className="ewb-card-title">{card.title}</strong>
      {inheritance && <span className="ewb-card-inheritance">{inheritance}</span>}
      <span className="ewb-card-meta">{card.meta}</span>
      {card.specAnchors?.length ? <span className="ewb-card-spec-anchors">{tr("锚点")}: {card.specAnchors.map((anchor) => anchor.name).join(" · ")}</span> : null}
      {card.path && <code className="ewb-card-path">{card.path}</code>}
      <Handle type="source" position={Position.Top} id="source-top" className="ewb-handle" />
      <Handle type="source" position={Position.Bottom} id="source-bottom" className="ewb-handle" />
      <Handle type="source" position={Position.Left} id="source-left" className="ewb-handle" />
      <Handle type="source" position={Position.Right} id="source-right" className="ewb-handle" />
    </div>
  );
}

function ComponentCard({ data }: NodeProps) {
  const tr = useI18n();
  const card = data as unknown as WorkbenchNodeData;
  const classes = ["ewb-card", "ewb-card-component", card.inherited ? "is-inherited" : "", card.selected ? "is-selected" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes} title={card.inherited ? tr("继承自 {source}", { source: card.inheritedFrom ?? tr("父实体") }) : undefined}>
      <button type="button" className="ewb-card-select" aria-label={tr("选择组件 {title}", { title: card.title })}>
        <strong className="ewb-card-title">{card.title}</strong>
        <span className="ewb-card-meta">{card.meta}</span>
        {card.summary && <span className="ewb-card-summary">{card.summary}</span>}
        {card.mount && <span className="ewb-card-mount">{tr("挂载")}: {card.mount.parent === "__entity__" ? tr("实体") : card.mount.parent} · {card.mount.anchor}</span>}
        {card.specAnchors?.length ? <span className="ewb-card-spec-anchors">{tr("锚点")}: {card.specAnchors.map((anchor) => anchor.name).join(" · ")}</span> : null}
      </button>
      {card.inherited && (
        <span className="ewb-badge" title={card.inheritedFrom ? tr("继承自 {source}", { source: card.inheritedFrom }) : tr("继承组件")}>
          {tr("继承")}
        </span>
      )}
      <Handle type="target" position={Position.Top} id="target-top" className="ewb-handle" />
      <Handle type="target" position={Position.Bottom} id="target-bottom" className="ewb-handle" />
      <Handle type="target" position={Position.Left} id="target-left" className="ewb-handle" />
      <Handle type="target" position={Position.Right} id="target-right" className="ewb-handle" />
      {/* Components can host mounted children, so they expose source sides too. */}
      <Handle type="source" position={Position.Top} id="source-top" className="ewb-handle" />
      <Handle type="source" position={Position.Bottom} id="source-bottom" className="ewb-handle" />
      <Handle type="source" position={Position.Left} id="source-left" className="ewb-handle" />
      <Handle type="source" position={Position.Right} id="source-right" className="ewb-handle" />
      {(card.anchors ?? []).map((anchor) => (
        <Handle
          key={anchor.id}
          type="target"
          position={anchorPosition(anchor.side)}
          id={`target-${anchor.id}`}
          className="ewb-handle ewb-handle-custom"
          style={anchorOffsetStyle(anchor)}
        />
      ))}
    </div>
  );
}

// Stable identity: React Flow warns when nodeTypes is recreated on every render.
const nodeTypes: NodeTypes = { entity: EntityCard, component: ComponentCard };

function componentNodeId(bindingId: string): string {
  return `${COMPONENT_NODE_PREFIX}${bindingId}`;
}

function EntityCanvas({
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

function FieldEditor({
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

function matchesQuery(query: string, values: string[]): boolean {
  const needle = query.trim().toLocaleLowerCase();
  return !needle || values.some((value) => value.toLocaleLowerCase().includes(needle));
}

export interface EntityWorkbenchProps {
  api: DesktopApi;
  projectPath: string;
  onError?: (error: unknown) => void;
  /** Explicit "open full detail" action from the inspector. */
  onOpenDetail?: (path: string) => void;
}

/**
 * Entity workbench: mounts component bindings on one entity at a time. Own and
 * inherited bindings are merged for display, drafts stay in component state,
 * and saving writes the entity file through the versioned document API.
 */
export interface ComponentFillPanelProps {
  binding: ResolvedBinding | undefined;
  component: ResolvedBinding["component"];
  fields: ComponentField[];
  anchors?: EntityAnchor[];
  mount?: ComponentMount | undefined;
  mountParents?: { id: string; label: string; anchors: { name: string; label?: string }[] }[] | undefined;
  onMountChange?: ((mount: ComponentMount | undefined) => void) | undefined;
  sourceAnchor?: EntityAnchorSide | undefined;
  targetAnchor?: string | undefined;
  onConnectionChange?: (patch: { sourceAnchor?: EntityAnchorSide | null; targetAnchor?: string | null }) => void;
  onAddAnchor?: (side: EntityAnchorSide, offset: number) => void;
  onRemoveAnchor?: (id: string) => void;
  rangeEnabled?: boolean;
  currentFieldKey?: string | undefined;
  range?: { current: number; max: number } | undefined;
  onChange: (binding: ResolvedBinding, field: ComponentField, value: ComponentValue) => void;
  onRemove: (binding: ResolvedBinding) => void;
  onOverride: (binding: ResolvedBinding) => void;
  onNotesChange?: (notes: string[]) => void;
  onClose?: () => void;
  onOpenDetail?: (path: string) => void;
}

/** Reusable field-fill and inheritance panel for one mounted component binding. */
export function ComponentFillPanel({
  binding,
  component,
  fields,
  anchors = [],
  mount,
  mountParents,
  onMountChange,
  sourceAnchor,
  targetAnchor,
  onConnectionChange,
  onAddAnchor,
  onRemoveAnchor,
  rangeEnabled = false,
  currentFieldKey,
  range,
  onChange,
  onRemove,
  onOverride,
  onNotesChange,
  onClose,
  onOpenDetail,
}: ComponentFillPanelProps) {
  const tr = useI18n();
  const [anchorSide, setAnchorSide] = useState<EntityAnchorSide>("right");
  const [anchorOffset, setAnchorOffset] = useState(25);
  const declaredAnchors = mountParents?.find((item) => item.id === mount?.parent)?.anchors ?? [];
  return (
    <section className="ewb-panel ewb-inspector" role="complementary" aria-label={tr("组件检查器")}>
      <header className="ewb-panel-head">
        <h2>{tr("组件检查器")}</h2>
        <div className="ewb-inspector-head-actions">
          {onOpenDetail && binding?.component?.path && <button type="button" onClick={() => onOpenDetail(binding.component!.path)}>{tr("详情")}</button>}
          {onClose && <button type="button" className="ewb-drawer-close" aria-label={tr("收起组件详情")} title={tr("收起组件详情")} onClick={onClose}><X size={15} /></button>}
        </div>
      </header>
      {!binding ? (
        <p className="ewb-empty">{tr("选择画布中的组件查看字段")}</p>
      ) : (
        <>
          <div className="ewb-inspector-title">
            <strong>{component?.title ?? binding.id}</strong>
            <span className={binding.own ? "ewb-badge is-own" : "ewb-badge"}>
              {binding.own ? tr("本实体") : tr("继承自") + " " + (binding.inheritedFrom ?? tr("父实体"))}
            </span>
          </div>
          <code className="ewb-inspector-path">{component?.path ?? tr("找不到组件定义")}</code>
          {mountParents && mountParents.length > 0 && onMountChange && (
            <section className="ewb-mount-editor" aria-label={tr("挂载")}>
              <h3>{tr("挂载")}</h3>
              <label>{tr("父级")}
                <select
                  aria-label={tr("挂载父级")}
                  value={mount ? mount.parent : ""}
                  onChange={(event) => {
                    const parentId = event.target.value;
                    if (!parentId) { onMountChange(undefined); return; }
                    const anchor = mountParents.find((item) => item.id === parentId)?.anchors[0]?.name;
                    if (anchor) onMountChange({ parent: parentId, anchor });
                  }}
                >
                  <option value="">{tr("不挂载")}</option>
                  {mountParents.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
              </label>
              {mount && <label>{tr("锚点")}
                <select
                  aria-label={tr("挂载锚点")}
                  value={mount.anchor}
                  onChange={(event) => onMountChange({ parent: mount.parent, anchor: event.target.value })}
                >
                  {declaredAnchors.map((anchor) => <option key={anchor.name} value={anchor.name}>{anchor.label ?? anchor.name}</option>)}
                  {!declaredAnchors.some((anchor) => anchor.name === mount.anchor) && <option value={mount.anchor}>{mount.anchor}（{tr("未声明")}）</option>}
                </select>
              </label>}
              {mount && declaredAnchors.length === 0 && <p className="ewb-inspector-hint">{tr("该父级没有声明锚点，请先在组件里添加。")}</p>}
            </section>
          )}
          {component && (component.description?.trim() || component.body?.trim()) && (
            <section className="ewb-component-notes" aria-label={tr("组件说明")}>
              <h3>{tr("组件说明")}</h3>
              {component.description?.trim() && <p>{component.description}</p>}
              {component.notes?.length ? <ul className="ewb-component-note-list">{component.notes.map((note, index) => <li key={index}>{note}</li>)}</ul> : null}
              {component.body?.trim() && <pre>{component.body}</pre>}
            </section>
          )}
          {!binding.component ? (
            <p className="ewb-inspector-hint">{tr("组件定义不存在，无法编辑字段。请检查项目资料中的组件文件。")}</p>
          ) : fields.length === 0 ? (
            <p className="ewb-inspector-hint">{tr("该组件没有字段。")}</p>
          ) : (
            <div className="ewb-fields">
              {fields.map((field) => (
                <FieldEditor
                  key={field.key}
                  field={field}
                  value={readFieldValue(binding, field)}
                  disabled={!binding.component}
                  {...(rangeEnabled && field.key === currentFieldKey
                    ? { range: { current: range?.current ?? 0, max: range?.max ?? 0 } }
                    : {})}
                  onChange={(value) => onChange(binding, field, value)}
                />
              ))}
            </div>
          )}
          {onNotesChange && (
            <section className="ewb-binding-notes" aria-label={tr("补充描述")}>
              <header className="ewb-binding-notes-head">
                <h3>{tr("补充描述")}</h3>
                <button type="button" disabled={binding.notes.length >= 32} onClick={() => onNotesChange([...binding.notes, ""])}><Plus size={13} />{tr("添加描述")}</button>
              </header>
              <p className="ewb-inspector-hint">{tr("用于记录字段表达不清的规则、约定或备注，仅作用于当前实体。")}</p>
              {binding.notes.length ? (
                <ul>
                  {binding.notes.map((note, index) => (
                    <li key={index}>
                      <textarea
                        aria-label={tr("描述 {index}", { index: index + 1 })}
                        rows={2}
                        maxLength={2000}
                        value={note}
                        onChange={(event) => {
                          const next = [...binding.notes];
                          next[index] = event.target.value;
                          onNotesChange(next);
                        }}
                      />
                      <button type="button" aria-label={tr("移除描述 {index}", { index: index + 1 })} onClick={() => onNotesChange(binding.notes.filter((_, position) => position !== index))}><Trash2 size={12} /></button>
                    </li>
                  ))}
                </ul>
              ) : <p className="ewb-inspector-hint">{tr("还没有补充描述。")}</p>}
            </section>
          )}
          {onConnectionChange && (
            <section className="ewb-anchors" aria-label={tr("连接锚点")}>
              <h3>{tr("连接锚点")}</h3>
              <div className="ewb-anchor-grid">
                <label>
                  <span>{tr("实体侧")}</span>
                  <select value={sourceAnchor ?? ""} onChange={(event) => onConnectionChange({ sourceAnchor: event.target.value ? event.target.value as EntityAnchorSide : null })}>
                    <option value="">{tr("自动")}</option>
                    {ENTITY_ANCHOR_SIDES.map((side) => <option key={side} value={side}>{tr(anchorSideLabels[side])}</option>)}
                  </select>
                </label>
                <label>
                  <span>{tr("组件侧")}</span>
                  <select value={targetAnchor ?? ""} onChange={(event) => onConnectionChange({ targetAnchor: event.target.value || null })}>
                    <option value="">{tr("自动")}</option>
                    {ENTITY_ANCHOR_SIDES.map((side) => <option key={side} value={side}>{tr(anchorSideLabels[side])}</option>)}
                    {anchors.map((anchor) => <option key={anchor.id} value={anchor.id}>{tr("{side}侧 {offset}%", { side: tr(anchorSideLabels[anchor.side]), offset: anchor.offset })}</option>)}
                  </select>
                </label>
              </div>
              <p className="field-hint">{tr("也可直接从实体卡片的锚点拖到组件锚点")}</p>
              {onAddAnchor && (
                <div className="ewb-anchor-add">
                  <select aria-label={tr("新锚点位置")} value={anchorSide} onChange={(event) => setAnchorSide(event.target.value as EntityAnchorSide)}>
                    {ENTITY_ANCHOR_SIDES.map((side) => <option key={side} value={side}>{tr(anchorSideLabels[side])}</option>)}
                  </select>
                  <input aria-label={tr("新锚点偏移")} type="number" min={5} max={95} step={5} value={anchorOffset} onChange={(event) => setAnchorOffset(Number(event.target.value))} />
                  <button type="button" onClick={() => onAddAnchor(anchorSide, Number.isFinite(anchorOffset) ? anchorOffset : 50)}>{tr("添加锚点")}</button>
                </div>
              )}
              {anchors.length > 0 && (
                <ul className="ewb-anchor-list" aria-label={tr("自定义锚点")}>
                  {anchors.map((anchor) => (
                    <li key={anchor.id}>
                      <span>{tr("{side}侧 {offset}%", { side: tr(anchorSideLabels[anchor.side]), offset: anchor.offset })}</span>
                      {onRemoveAnchor && <button type="button" aria-label={tr("移除锚点")} onClick={() => onRemoveAnchor(anchor.id)}><Trash2 size={12} /></button>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          <div className="ewb-inspector-actions">
            {binding.own ? (
              <button type="button" className="danger-ghost" onClick={() => onRemove(binding)}>
                <Trash2 size={13} />
                {tr("移除组件")}
              </button>
            ) : (
              <button type="button" onClick={() => onOverride(binding)}>
                {tr("覆盖继承组件")}
              </button>
            )}
          </div>
          {!binding.own && (
            <p className="ewb-inspector-hint">
              {tr("继承组件的字段可直接编辑；首次修改会自动覆盖为当前实体的自有绑定。")}
            </p>
          )}
        </>
      )}
    </section>
  );
}

function EntityDetailsPanel({
  entity,
  inheritsFrom,
  imageUrl,
  imageMaxHeight,
  onClose,
  onOpenDetail,
}: {
  entity: EntityEntry;
  inheritsFrom?: string | undefined;
  imageUrl?: string | undefined;
  imageMaxHeight: number;
  onClose: () => void;
  onOpenDetail?: ((path: string) => void) | undefined;
}) {
  const tr = useI18n();
  const data = entity.data;
  const rows: [string, string][] = [];
  if (inheritsFrom) rows.push([tr("继承"), inheritsFrom]);
  if (typeof data.type === "string" && data.type) rows.push([tr("类型"), data.type]);
  if (typeof data.status === "string" && data.status) rows.push([tr("状态"), data.status]);
  const group = typeof data.group === "string" ? data.group : typeof data.groupId === "string" ? data.groupId : "";
  if (group) rows.push([tr("分组"), group]);
  if (typeof data.parent === "string" && data.parent) rows.push([tr("父级资料"), data.parent]);
  rows.push([tr("组件"), String(entity.bindings.length)]);
  const description = typeof data.description === "string" ? data.description.trim() : "";
  return (
    <section className="ewb-panel ewb-inspector ewb-entity-details" role="complementary" aria-label={tr("实体详情")}>
      <header className="ewb-panel-head">
        <h2>{tr("实体详情")}</h2>
        <div className="ewb-inspector-head-actions">
          {onOpenDetail && <button type="button" onClick={() => onOpenDetail(entity.path)}>{tr("详情")}</button>}
          <button type="button" className="ewb-drawer-close" aria-label={tr("收起详情")} title={tr("收起详情")} onClick={onClose}><X size={15} /></button>
        </div>
      </header>
      {imageUrl && <img className="ewb-entity-detail-image" src={imageUrl} alt={tr("{title}配图", { title: entity.title })} style={{ maxHeight: imageMaxHeight }} />}
      <div className="ewb-entity-heading">
        <strong>{entity.title}</strong>
        <code>{entity.path}</code>
      </div>
      {description && <p className="ewb-entity-description">{description}</p>}
      <dl className="ewb-entity-facts">
        {rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
      <p className="ewb-inspector-hint">{tr("在画布中点击组件查看组件字段；点“详情”打开完整编辑页。")}</p>
    </section>
  );
}

/** Reusable field-fill and inheritance panel for one mounted component binding. */
export function EntityWorkbench({ api, projectPath, onError, onOpenDetail }: EntityWorkbenchProps) {
  const tr = useI18n();
  const [files, setFiles] = useState<FileReadResult[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [layout, setLayout] = useState<EntityLayout>(() => loadEntityLayout(projectPath));
  const [imageSettings, setImageSettings] = useState<WorkbenchImageSettings>(() => loadImageSettings(projectPath));
  const [entityImages, setEntityImages] = useState<Record<string, string>>({});
  const [selectedEntityPath, setSelectedEntityPath] = useState<string | undefined>(undefined);
  const [selectedBindingId, setSelectedBindingId] = useState<string | undefined>(undefined);
  const [componentDrawerOpen, setComponentDrawerOpen] = useState(false);
  const [componentBrowserOpen, setComponentBrowserOpen] = useState(false);
  useEffect(() => {
    if (selectedBindingId) setComponentDrawerOpen(true);
  }, [selectedBindingId]);
  useEffect(() => {
    if (!componentBrowserOpen) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setComponentBrowserOpen(false); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [componentBrowserOpen]);
  const [entityQuery, setEntityQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [savedNotice, setSavedNotice] = useState(false);
  const mountedRef = useRef(true);
  const requestRef = useRef(0);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  // Measurements and drops can fire several saves in a burst; the sidecar is written one at a time.
  const saveLayout = useMemo(() => {
    const target = api.entityLayout;
    return target ? createLayoutSaver((next) => target.save(next), (error) => onErrorRef.current?.(error)) : undefined;
  }, [api.entityLayout]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current++;
    };
  }, []);

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    setLoadError(undefined);
    setSaveError(undefined);
    setSavedNotice(false);
    try {
      const listed = await api.documents();
      const targets = listed.filter((document) => {
        const category = categoryForPath(document.path);
        return category === "entity" || category === "component" || document.path.toLowerCase() === "specs/project.md";
      });
      const failed: string[] = [];
      const reads = await Promise.all(
        targets.map(async (document) => {
          try {
            return await api.readDocument(document.path, document.version);
          } catch {
            failed.push(document.path);
            return undefined;
          }
        }),
      );
      if (!mountedRef.current || request !== requestRef.current) return;
      const nextFiles = reads.filter((item): item is FileReadResult => item !== undefined);
      setFiles(nextFiles);
      setDrafts((current) => {
        const available = new Set(nextFiles.map((file) => file.path));
        const kept = Object.entries(current).filter(([path]) => available.has(path));
        return kept.length === Object.keys(current).length ? current : Object.fromEntries(kept);
      });
      if (failed.length) setLoadError(tr("有 {count} 份资料读取失败，请刷新重试。", { count: failed.length }));
    } catch (error) {
      if (!mountedRef.current || request !== requestRef.current) return;
      setLoadError(describeError(error, tr("读取项目资料失败，请刷新重试。")));
      onError?.(error);
    } finally {
      if (mountedRef.current && request === requestRef.current) setLoading(false);
    }
  }, [api, onError, tr]);

  useEffect(() => {
    void refresh();
    return () => {
      requestRef.current++;
    };
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    setLayout(loadEntityLayout(projectPath));
    setImageSettings(loadImageSettings(projectPath));
    setComponentBrowserOpen(false);
    setDrafts({});
    setSelectedEntityPath(undefined);
    setSelectedBindingId(undefined);
    if (!api.entityLayout) return;
    void api.entityLayout.read()
      .then((next) => { if (!cancelled) setLayout(next); })
      .catch((error) => { if (!cancelled) onError?.(error); });
    return () => { cancelled = true; };
  }, [api, projectPath, onError]);

  const parsedFiles = useMemo(() => {
    return files.flatMap((file) => {
      const category = categoryForPath(file.path);
      if (category !== "entity" && category !== "component") return [];
      const content = drafts[file.path] ?? file.content;
      const parsed = parseMaterial(content);
      if (!parsed || typeof parsed.data.id !== "string" || !parsed.data.id.trim()) return [];
      const heading = /^#\s+(.+)$/m.exec(parsed.body)?.[1]?.trim();
      const title =
        typeof parsed.data.title === "string" && parsed.data.title.trim()
          ? parsed.data.title.trim()
          : heading && heading.length > 0
            ? heading
            : (file.path.split("/").pop() ?? file.path);
      return [{ file, content, parsed, category, id: parsed.data.id.trim(), title }];
    });
  }, [files, drafts]);

  const entityEntries = useMemo(() => {
    return parsedFiles
      .filter((item) => item.category === "entity")
      .map((item): EntityEntry => {
        const extendsRef = referenceId(item.parsed.data.extends);
        return {
          path: item.file.path,
          version: item.file.version,
          id: item.id,
          title: item.title,
          ...(extendsRef ? { extendsRef } : {}),
          data: item.parsed.data,
          body: item.parsed.body,
          content: item.content,
          baseline: item.file.content,
          bindings: readBindings(item.parsed.data),
          anchors: readAnchors(item.parsed.data),
        };
      })
      .sort((left, right) => left.title.localeCompare(right.title) || left.path.localeCompare(right.path));
  }, [parsedFiles]);

  const imageKey = useMemo(
    () => [...new Set(entityEntries.flatMap((entry) => typeof entry.data.image === "string" && entry.data.image ? [entry.data.image] : []))].sort().join("|"),
    [entityEntries],
  );
  const imagePaths = useMemo(() => imageKey ? imageKey.split("|") : [], [imageKey]);
  useEffect(() => {
    if (!imagePaths.length || typeof api.readMaterialImage !== "function") { setEntityImages({}); return; }
    let cancelled = false;
    void Promise.all(imagePaths.map(async (path) => {
      try { return [path, await api.readMaterialImage(projectPath, path)] as const; }
      catch { return undefined; }
    })).then((pairs) => {
      if (!cancelled) setEntityImages(Object.fromEntries(pairs.filter((pair): pair is readonly [string, string] => pair !== undefined)));
    });
    return () => { cancelled = true; };
  }, [api, projectPath, imagePaths]);

  const componentEntries = useMemo(() => {
    const entries = parsedFiles
      .filter((item) => item.category === "component")
      .map((item): ComponentEntry => {
        const extendsRef = referenceId(item.parsed.data.extends);
        const notes = Array.isArray(item.parsed.data.notes)
          ? item.parsed.data.notes.filter((note): note is string => typeof note === "string").map((note) => note.trim()).filter(Boolean).slice(0, 32)
          : [];
        return {
          path: item.file.path,
          id: item.id,
          title: item.title,
          fields: readFields(item.parsed.data),
          anchors: readAnchors(item.parsed.data),
          scope: item.parsed.data.scope === "system" ? "system" : "user",
          ...(typeof item.parsed.data.description === "string" ? { description: item.parsed.data.description } : {}),
          ...(notes.length ? { notes } : {}),
          ...(item.parsed.body.trim() ? { body: item.parsed.body.trim() } : {}),
          ...(typeof item.parsed.data.group === "string" && item.parsed.data.group.trim() ? { group: item.parsed.data.group.trim() } : {}),
          ...(typeof item.parsed.data.groupId === "string" && item.parsed.data.groupId.trim() ? { groupId: item.parsed.data.groupId.trim() } : {}),
          ...(extendsRef ? { extendsRef } : {}),
        };
      });
    const definitions = entries.map((entry) => ({ path: entry.path, id: entry.id, data: { extends: entry.extendsRef, fields: entry.fields, anchors: entry.anchors } }));
    const byPath = new Map(definitions.map((definition) => [normalizeReference(definition.path), definition]));
    const effective = entries.map((entry) => {
      const definition = byPath.get(normalizeReference(entry.path));
      return definition ? { ...entry, fields: resolveComponentFields(definitions, definition).fields, anchors: resolveComponentAnchors(definitions, definition).anchors } : entry;
    });
    return effective.sort((left, right) => left.title.localeCompare(right.title) || left.path.localeCompare(right.path));
  }, [parsedFiles]);

  const componentGroups = useMemo(() => {
    const project = files.find((file) => file.path.toLowerCase() === "specs/project.md");
    if (!project) return [];
    return normalizeMaterialGroups(parseMaterial(project.content)?.data.materialGroups).component ?? [];
  }, [files]);

  const lookup = useMemo<MaterialLookup>(() => {
    const entitiesById = new Map<string, EntityEntry>();
    const entitiesByPath = new Map<string, EntityEntry>();
    for (const entry of entityEntries) {
      if (!entitiesById.has(entry.id)) entitiesById.set(entry.id, entry);
      entitiesByPath.set(normalizeReference(entry.path), entry);
      entitiesByPath.set(normalizeReference(entry.path).replace(/\.md$/, ""), entry);
    }
    const componentsById = new Map<string, ComponentEntry>();
    const componentsByPath = new Map<string, ComponentEntry>();
    for (const entry of componentEntries) {
      if (!componentsById.has(entry.id)) componentsById.set(entry.id, entry);
      componentsByPath.set(normalizeReference(entry.path), entry);
      componentsByPath.set(normalizeReference(entry.path).replace(/\.md$/, ""), entry);
    }
    return { entitiesById, entitiesByPath, componentsById, componentsByPath };
  }, [entityEntries, componentEntries]);

  const entity = entityEntries.find((item) => item.path === selectedEntityPath) ?? entityEntries[0];
  const inheritsFrom = entity?.extendsRef ? (resolveEntityReference(entity.extendsRef, lookup)?.title ?? entity.extendsRef) : undefined;
  const selectedImage = entity && typeof entity.data.image === "string" ? entityImages[entity.data.image] : undefined;
  const imageUrl = imageSettings.show ? selectedImage : undefined;
  const bindings = useMemo(() => (entity ? resolveEntityBindings(entity, lookup) : []), [entity, lookup]);
  /** Anchor-bearing parents a component can mount on: the entity itself plus bound components. */
  const mountParents = useMemo(() => {
    if (!entity) return [];
    const options: { id: string; label: string; anchors: { name: string; label?: string }[] }[] = [];
    const entityAnchors = readAnchors(entity.data);
    if (entityAnchors.length) options.push({ id: "__entity__", label: entity.title, anchors: entityAnchors });
    const selectedIdentity = selectedBindingId;
    for (const binding of bindings) {
      // A component cannot mount on itself.
      if (selectedIdentity && binding.id === selectedIdentity) continue;
      const anchors = binding.component?.anchors ?? [];
      if (!anchors.length) continue;
      options.push({ id: binding.component?.id ?? binding.id, label: binding.component?.title ?? binding.id, anchors });
    }
    return options;
  }, [entity, bindings, selectedBindingId]);
  const bindingIdentity = useCallback(
    (reference: string): string => resolveComponentReference(reference, lookup)?.id ?? normalizeReference(reference),
    [lookup],
  );

  const draft = entity ? drafts[entity.path] : undefined;
  const dirty = Boolean(entity && draft !== undefined && draft !== entity.baseline);
  const errorMessage = saveError ?? loadError;

  const filteredEntities = useMemo(
    () => entityEntries.filter((item) => matchesQuery(entityQuery, [item.title, item.id, item.path])),
    [entityEntries, entityQuery],
  );
  const entityGroups = useMemo(() => {
    const groups = new Map<string, EntityEntry[]>();
    for (const item of filteredEntities) {
      const directory = item.path.split("/").slice(0, -1).join("/") || "specs";
      groups.set(directory, [...(groups.get(directory) ?? []), item]);
    }
    return [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([directory, entries]) => ({
        directory,
        entries: [...entries].sort((left, right) => left.title.localeCompare(right.title) || left.path.localeCompare(right.path)),
      }));
  }, [filteredEntities]);

  const selectedBinding = selectedBindingId ? bindings.find((item) => item.id === selectedBindingId) : undefined;
  const selectedEntry = entity && selectedBinding ? layout[entity.id]?.[selectedBinding.id] : undefined;
  const selectedAnchors = selectedEntry?.anchors ?? [];
  const selectedSourceAnchor = isAnchorSide(selectedEntry?.sourceAnchor) ? selectedEntry.sourceAnchor : undefined;
  const selectedTargetAnchor = selectedEntry?.targetAnchor && (isAnchorSide(selectedEntry.targetAnchor) || selectedAnchors.some((anchor) => anchor.id === selectedEntry.targetAnchor)) ? selectedEntry.targetAnchor : undefined;
  const selectedComponent = selectedBinding?.component;
  const componentFields = selectedComponent?.fields ?? [];
  const currentField = componentFields.find((field) => field.key === "current" && field.type === "number");
  const maxField = componentFields.find((field) => field.key === "max" && field.type === "number");
  const rangeEnabled = Boolean(currentField && maxField);
  const rangeMax = selectedBinding && maxField ? Number(readFieldValue(selectedBinding, maxField)) : 0;
  const rangeCurrent = selectedBinding && currentField ? Number(readFieldValue(selectedBinding, currentField)) : 0;
  const progressMax = Number.isFinite(rangeMax) && rangeMax > 0 ? rangeMax : 1;

  const effectiveBindingFor = (component: ComponentEntry): ResolvedBinding | undefined =>
    bindings.find((item) => item.component?.id === component.id || item.id === component.id);

  function selectBinding(bindingId: string | undefined): void {
    setSelectedBindingId(bindingId);
    if (bindingId === undefined) setComponentDrawerOpen(true);
  }

  const componentStatus = (component: ComponentEntry): "added" | "inherited" | "available" => {
    const binding = effectiveBindingFor(component);
    return binding?.own ? "added" : binding ? "inherited" : "available";
  };
  /** The shared browser only needs flat entries; grouping and nesting happen inside it. */
  const browserEntries = useMemo<BrowserEntry[]>(() => componentEntries.map((component) => {
    const registry = component.groupId ? componentGroups.find((group) => group.id === component.groupId) : undefined;
    const groupLabel = component.groupId
      ? materialGroupPath(componentGroups, component.groupId) || component.group || component.groupId
      : component.group;
    return {
      path: component.path,
      id: component.id,
      title: component.title,
      ...(component.description ? { description: component.description } : {}),
      ...(component.body ? { body: component.body } : {}),
      ...(component.notes?.length ? { notes: component.notes } : {}),
      ...(component.extendsRef ? { extendsRef: component.extendsRef } : {}),
      ...(component.scope ? { scope: component.scope } : {}),
      fields: component.fields,
      ...(groupLabel ? { groupLabel } : {}),
      ...(registry ? { groupOrder: componentGroups.indexOf(registry) } : {}),
      status: componentStatus(component),
    } as BrowserEntry;
  }), [componentEntries, componentGroups, bindings]);

  function openComponentBrowser(): void {
    setComponentBrowserOpen(true);
    setComponentDrawerOpen(false);
  }

  function createBrowserComponent(component: ComponentEntry | undefined): void {
    if (!component || componentStatus(component) === "added") return;
    addComponent(component);
    setComponentBrowserOpen(false);
  }


  function writeEntityBindings(nextBindings: ComponentBinding[]) {
    if (!entity) return;
    const components = nextBindings.map((binding) => ({
      id: binding.id,
      values: binding.values,
      ...(binding.notes && binding.notes.length ? { notes: binding.notes } : {}),
      ...(binding.mount ? { mount: binding.mount } : {}),
    }));
    const content = writeMaterial({ ...entity.data, components }, entity.body);
    setDrafts((current) => ({ ...current, [entity.path]: content }));
  }

  function addComponent(component: ComponentEntry) {
    if (!entity) return;
    const existing = effectiveBindingFor(component);
    if (existing?.own) return;
    const defaults: Record<string, ComponentValue> = {};
    for (const field of component.fields) defaults[field.key] = field.default;
    const values: Record<string, ComponentValue> = { ...defaults, ...(existing?.values ?? {}) };
    const identity = component.id;
    const remaining = entity.bindings.filter((binding) => bindingIdentity(binding.id) !== identity);
    writeEntityBindings([...remaining, { id: identity, values }]);
    setSelectedBindingId(identity);
  }

  function overrideBinding(binding: ResolvedBinding) {
    if (!entity) return;
    const component = binding.component;
    const defaults: Record<string, ComponentValue> = {};
    if (component) for (const field of component.fields) defaults[field.key] = field.default;
    const values: Record<string, ComponentValue> = { ...defaults, ...binding.values };
    const identity = component?.id ?? bindingIdentity(binding.id);
    const remaining = entity.bindings.filter((ownBinding) => bindingIdentity(ownBinding.id) !== identity);
    writeEntityBindings([...remaining, { id: identity, values, ...(binding.notes.length ? { notes: binding.notes } : {}), ...(binding.mount ? { mount: binding.mount } : {}) }]);
    setSelectedBindingId(identity);
  }

  function updateBindingValue(binding: ResolvedBinding, field: ComponentField, value: ComponentValue) {
    if (!entity) return;
    const identity = bindingIdentity(binding.id);
    if (binding.own) {
      const nextBindings = entity.bindings.map((ownBinding) =>
        bindingIdentity(ownBinding.id) === identity
          ? { ...ownBinding, values: { ...ownBinding.values, [field.key]: value } }
          : ownBinding,
      );
      writeEntityBindings(nextBindings);
      return;
    }
    // Editing an inherited field materializes an explicit override for this entity.
    const defaults: Record<string, ComponentValue> = {};
    if (binding.component) for (const item of binding.component.fields) defaults[item.key] = item.default;
    const remaining = entity.bindings.filter((ownBinding) => bindingIdentity(ownBinding.id) !== identity);
    const id = binding.component?.id ?? identity;
    writeEntityBindings([...remaining, { id, values: { ...defaults, ...binding.values, [field.key]: value }, ...(binding.notes.length ? { notes: binding.notes } : {}), ...(binding.mount ? { mount: binding.mount } : {}) }]);
    setSelectedBindingId(id);
  }

  function updateBindingNotes(binding: ResolvedBinding, notes: string[]): void {
    if (!entity) return;
    const identity = bindingIdentity(binding.id);
    if (binding.own) {
      writeEntityBindings(entity.bindings.map((ownBinding) =>
        bindingIdentity(ownBinding.id) === identity ? { ...ownBinding, notes } : ownBinding,
      ));
      return;
    }
    const defaults: Record<string, ComponentValue> = {};
    if (binding.component) for (const item of binding.component.fields) defaults[item.key] = item.default;
    const remaining = entity.bindings.filter((ownBinding) => bindingIdentity(ownBinding.id) !== identity);
    const id = binding.component?.id ?? identity;
    writeEntityBindings([...remaining, { id, values: { ...defaults, ...binding.values }, ...(notes.length ? { notes } : {}), ...(binding.mount ? { mount: binding.mount } : {}) }]);
    setSelectedBindingId(id);
  }

  function updateBindingMount(binding: ResolvedBinding, mount: ComponentMount | undefined): void {
    if (!entity) return;
    const identity = bindingIdentity(binding.id);
    const rebound = (item: ComponentBinding): ComponentBinding => ({
      id: item.id,
      values: item.values,
      ...(item.notes?.length ? { notes: item.notes } : {}),
      ...(mount ? { mount } : {}),
    });
    if (binding.own) {
      writeEntityBindings(entity.bindings.map((ownBinding) => bindingIdentity(ownBinding.id) === identity ? rebound(ownBinding) : ownBinding));
      return;
    }
    // Editing an inherited mount materializes an explicit binding for this entity.
    const defaults: Record<string, ComponentValue> = {};
    if (binding.component) for (const item of binding.component.fields) defaults[item.key] = item.default;
    const remaining = entity.bindings.filter((ownBinding) => bindingIdentity(ownBinding.id) !== identity);
    const id = binding.component?.id ?? identity;
    writeEntityBindings([...remaining, rebound({ id, values: { ...defaults, ...binding.values }, ...(binding.notes.length ? { notes: binding.notes } : {}) })]);
    setSelectedBindingId(id);
  }

  function persistLayout(next: EntityLayout): void {
    saveEntityLayout(projectPath, next);
    saveLayout?.(next);
  }

  function updateImageSettings(next: WorkbenchImageSettings): void {
    setImageSettings(next);
    saveImageSettings(projectPath, next);
  }

  function removeBinding(binding: ResolvedBinding) {
    if (!entity) return;
    const identity = bindingIdentity(binding.id);
    const remaining = entity.bindings.filter((ownBinding) => bindingIdentity(ownBinding.id) !== identity);
    writeEntityBindings(remaining);
    setSelectedBindingId(undefined);
    const activeIds = resolveEntityBindings({ ...entity, bindings: remaining }, lookup).map((item) => item.id);
    setLayout((current) => {
      const pruned = pruneEntityLayout(current, entity.id, activeIds);
      persistLayout(pruned);
      return pruned;
    });
  }

  function moveBinding(bindingId: string, position: EntityPoint) {
    if (!entity) return;
    setLayout((current) => {
      const entityLayout = current[entity.id] ?? {};
      const next: EntityLayout = {
        ...current,
        [entity.id]: {
          ...entityLayout,
          [bindingId]: { ...(entityLayout[bindingId] ?? {}), x: Math.round(position.x), y: Math.round(position.y) },
        },
      };
      persistLayout(next);
      return next;
    });
  }

  /** Persist a measured card size so overlap always reasons about real rectangles. */
  function measureNode(nodeId: string, size: EntitySize) {
    if (!entity) return;
    setLayout((current) => {
      const entityLayout = current[entity.id] ?? {};
      const entry = entityLayout[nodeId] ?? { x: 0, y: 0 };
      const unchanged = entry.size && Math.abs(entry.size.width - size.width) < 1 && Math.abs(entry.size.height - size.height) < 1;
      if (unchanged) return current;
      const next: EntityLayout = {
        ...current,
        [entity.id]: { ...entityLayout, [nodeId]: { ...entry, size: { width: Math.round(size.width), height: Math.round(size.height) } } },
      };
      persistLayout(next);
      return next;
    });
  }

  /** Re-pack every component around the entity using the measured sizes. */
  function arrangeComponents() {
    if (!entity) return;
    setLayout((current) => {
      const entityLayout = current[entity.id] ?? {};
      const entitySize = layoutSize(entityLayout[ENTITY_NODE_ID], ENTITY_CARD_SIZE);
      const boundIds = new Set(bindings.map((binding) => binding.id));
      const cards = bindings.map((binding) => {
        const parent = mountParentId(binding.id, binding.mount?.parent, boundIds);
        return { id: binding.id, size: layoutSize(entityLayout[binding.id], COMPONENT_CARD_SIZE), ...(parent ? { parent } : {}) };
      });
      const positions = packMountPositions(cards, entitySize);
      const nextEntity: Record<string, EntityComponentLayout> = {
        ...entityLayout,
        [ENTITY_NODE_ID]: { ...(entityLayout[ENTITY_NODE_ID] ?? { x: 0, y: 0 }), x: 0, y: 0, size: entitySize },
      };
      for (const [id, position] of Object.entries(positions)) nextEntity[id] = { ...(entityLayout[id] ?? {}), x: position.x, y: position.y };
      const next: EntityLayout = { ...current, [entity.id]: nextEntity };
      persistLayout(next);
      return next;
    });
  }

  function updateBindingLayout(bindingId: string, update: (entry: EntityComponentLayout) => EntityComponentLayout): void {
    if (!entity) return;
    setLayout((current) => {
      const entityLayout = current[entity.id] ?? {};
      const entitySize = layoutSize(entityLayout[ENTITY_NODE_ID], ENTITY_CARD_SIZE);
      const sizes: Record<string, EntitySize> = {};
      for (const binding of bindings) sizes[binding.id] = layoutSize(entityLayout[binding.id], COMPONENT_CARD_SIZE);
      const defaults = defaultEntityPositions(bindings.map((binding) => binding.id), sizes, entitySize);
      const entry = entityLayout[bindingId] ?? { ...(defaults[bindingId] ?? { x: entitySize.width + 24, y: 0 }) };
      const next: EntityLayout = { ...current, [entity.id]: { ...entityLayout, [bindingId]: update(entry) } };
      persistLayout(next);
      return next;
    });
  }

  function setConnection(bindingId: string, patch: { sourceAnchor?: EntityAnchorSide | null; targetAnchor?: string | null }): void {
    updateBindingLayout(bindingId, (entry) => {
      const next = { ...entry };
      if ("sourceAnchor" in patch) {
        if (patch.sourceAnchor) next.sourceAnchor = patch.sourceAnchor;
        else delete next.sourceAnchor;
      }
      if ("targetAnchor" in patch) {
        if (patch.targetAnchor) next.targetAnchor = patch.targetAnchor;
        else delete next.targetAnchor;
      }
      return next;
    });
  }

  function addAnchor(bindingId: string, side: EntityAnchorSide, offset: number): void {
    updateBindingLayout(bindingId, (entry) => ({
      ...entry,
      anchors: [...(entry.anchors ?? []), { id: newAnchorId(), side, offset: Number.isFinite(offset) ? clamp(Math.round(offset), 5, 95) : 50 }],
    }));
  }

  function removeAnchor(bindingId: string, id: string): void {
    updateBindingLayout(bindingId, (entry) => {
      const anchors = (entry.anchors ?? []).filter((anchor) => anchor.id !== id);
      const next = { ...entry };
      if (anchors.length) next.anchors = anchors;
      else delete next.anchors;
      if (next.targetAnchor === id) delete next.targetAnchor;
      return next;
    });
  }

  function connectAnchor(bindingId: string, sourceAnchor: EntityAnchorSide, targetAnchor: string): void {
    updateBindingLayout(bindingId, (entry) => ({ ...entry, sourceAnchor, targetAnchor }));
  }

  async function save() {
    if (!entity || !dirty || saving) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      const saved = await api.saveDocument(projectPath, entity.path, cleanBindingNotes(entity.content), entity.version);
      if (!mountedRef.current) return;
      setFiles((current) => current.map((file) => (file.path === saved.path ? saved : file)));
      setDrafts((current) => {
        const next = { ...current };
        delete next[saved.path];
        return next;
      });
      setSavedNotice(true);
    } catch (error) {
      if (!mountedRef.current) return;
      setSaveError(describeError(error, tr("保存资料失败，请重新读取后再试。")));
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }

  return (
    <section className="entity-workbench" aria-label={tr("实体工作台")}>
      <header className="ewb-header">
        <div className="ewb-heading">
          <h1>{tr("实体工作台")}</h1>
          <p className="ewb-subtitle subtle">
            {entity ? (
              <>
                <strong>{entity.title}</strong>
                {entity.extendsRef && (
                  <span className="ewb-subtitle-inherit">
                    {tr("继承自 {source}", { source: resolveEntityReference(entity.extendsRef, lookup)?.title ?? entity.extendsRef })}
                  </span>
                )}
                <code>{entity.path}</code>
              </>
            ) : (
              tr("选择实体后编辑它的组件绑定")
            )}
          </p>
        </div>
        <div className="ewb-toolbar">
          {savedNotice && !dirty && <span className="ewb-saved">{tr("已保存")}</span>}
          {dirty && <span className="ewb-dirty">{tr("未保存")}</span>}
          <button
            type="button"
            disabled={!entity}
            aria-label={tr("自动整理组件")}
            title={tr("按挂载层级重新摆放组件")}
            onClick={arrangeComponents}
          >
            <LayoutGrid size={15} />{tr("自动整理")}
          </button>
          <div className="ewb-image-controls" role="group" aria-label={tr("配图显示")}>
            <button
              type="button"
              aria-pressed={imageSettings.show}
              title={imageSettings.show ? tr("隐藏配图") : tr("显示配图")}
              onClick={() => updateImageSettings({ ...imageSettings, show: !imageSettings.show })}
            >
              {imageSettings.show ? <ImageIcon size={15} /> : <ImageOff size={15} />}
              {tr("配图")}
            </button>
            {imageSettings.show && (
              <label className="ewb-image-size">
                <span>{tr("大小")}</span>
                <input
                  type="range"
                  min={IMAGE_SIZE_MIN}
                  max={IMAGE_SIZE_MAX}
                  step={20}
                  value={imageSettings.size}
                  aria-label={tr("配图大小")}
                  onChange={(event) => updateImageSettings({ ...imageSettings, size: Number(event.target.value) })}
                />
              </label>
            )}
          </div>
          <button
            type="button"
            className="primary"
            disabled={!entity || !dirty || saving || loading}
            onClick={() => {
              void save();
            }}
          >
            <Save size={15} />
            {saving ? tr("保存中…") : tr("保存资料")}
          </button>
          <button
            type="button"
            disabled={loading || saving}
            title={tr("重新读取实体和组件")}
            onClick={() => {
              void refresh();
            }}
          >
            <RefreshCw size={15} />
            {tr("刷新")}
          </button>
        </div>
      </header>

      {errorMessage && (
        <div className="ewb-error" role="alert">
          <span>{errorMessage}</span>
          <button
            type="button"
            onClick={() => {
              setSaveError(undefined);
              setLoadError(undefined);
            }}
          >
            {tr("关闭")}
          </button>
        </div>
      )}

      <div className={"ewb-layout" + (componentDrawerOpen ? " is-drawer-open" : "")}>
        <aside className="ewb-panel ewb-entities" aria-label={tr("实体列表")}>
          <header className="ewb-panel-head">
            <h2>{tr("实体")}</h2>
            <span className="subtle">
              {tr("实体 {entities} · 组件 {components}", { entities: entityEntries.length, components: componentEntries.length })}
            </span>
          </header>
          <input
            type="search"
            aria-label={tr("搜索实体")}
            placeholder={tr("搜索实体")}
            value={entityQuery}
            onChange={(event) => setEntityQuery(event.target.value)}
          />
          {filteredEntities.length === 0 ? (
            <p className="ewb-empty">
              {loading
                ? tr("正在读取资料…")
                : entityEntries.length
                  ? tr("没有匹配的实体")
                  : tr("还没有实体。可在项目资料的实体页新建实体。")}
            </p>
          ) : (
            <div className="ewb-tree">
              {entityGroups.map((group) => (
                <section key={group.directory} className="ewb-tree-group" aria-label={tr("分组 {name}", { name: group.directory })}>
                  <h3 className="ewb-group-heading">
                    <code>{group.directory}</code>
                    <span>{group.entries.length}</span>
                  </h3>
                  <ul>
                    {group.entries.map((item) => {
                      const itemDraft = drafts[item.path];
                      const itemDirty = itemDraft !== undefined && itemDraft !== item.baseline;
                      const base = item.extendsRef ? resolveEntityReference(item.extendsRef, lookup) : undefined;
                      const inheritance = item.extendsRef ? tr("继承自 {source}", { source: base?.title ?? item.extendsRef }) : undefined;
                      return (
                        <li key={item.path}>
                          <button
                            type="button"
                            className="ewb-entity-item"
                            aria-pressed={entity?.path === item.path}
                            title={inheritance ? `${item.path}\n${inheritance}` : item.path}
                            onClick={() => {
                              setSelectedEntityPath(item.path);
                              selectBinding(undefined);
                            }}
                          >
                            <span className="ewb-item-title">{item.title}</span>
                            <span className="ewb-item-meta">
                              {item.id}
                              {inheritance ? " · " + inheritance : ""}
                              {itemDirty && <span className="ewb-badge is-own">{tr("未保存")}</span>}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </aside>

        <section className="ewb-canvas" aria-label={tr("实体画布")}>
          {entity && (
            <button
              type="button"
              className="ewb-canvas-add"
              aria-label={tr("添加组件")}
              title={tr("添加组件")}
              onClick={openComponentBrowser}
            >
              <Plus size={18} />
            </button>
          )}
          {entity ? (
            <EntityComponentBoard
              key={componentDrawerOpen ? "drawer-open" : "drawer-closed"}
              entity={entity}
              bindings={bindings}
              storedPositions={layout[entity.id] ?? EMPTY_POSITIONS}
              selectedBindingId={selectedBindingId}
              imageUrl={imageUrl}
              imageMaxHeight={imageSettings.size}
              inheritsFrom={inheritsFrom}
              onSelectBinding={selectBinding}
              onMoveBinding={moveBinding}
              onMeasure={measureNode}
              onConnectAnchor={connectAnchor}
            />
          ) : (
            <p className="ewb-empty">
              {loading ? tr("正在读取资料…") : tr("还没有实体。可在项目资料的实体页新建实体，再回来挂载组件。")}
            </p>
          )}
        </section>

        {componentDrawerOpen && (
          <aside className="ewb-drawer" aria-label={tr("详情")}>
            {selectedBinding ? (
              <ComponentFillPanel
                binding={selectedBinding}
                component={selectedBinding?.component}
                fields={componentFields}
                anchors={selectedAnchors}
                mount={selectedBinding.mount}
                mountParents={mountParents}
                onMountChange={(nextMount) => {
                  if (selectedBinding) updateBindingMount(selectedBinding, nextMount);
                }}
                sourceAnchor={selectedSourceAnchor}
                targetAnchor={selectedTargetAnchor}
                onConnectionChange={(patch) => {
                  if (selectedBinding) setConnection(selectedBinding.id, patch);
                }}
                onAddAnchor={(side, offset) => {
                  if (selectedBinding) addAnchor(selectedBinding.id, side, offset);
                }}
                onRemoveAnchor={(id) => {
                  if (selectedBinding) removeAnchor(selectedBinding.id, id);
                }}
                rangeEnabled={rangeEnabled}
                currentFieldKey={currentField?.key}
                range={rangeEnabled ? { current: rangeCurrent, max: progressMax } : undefined}
                onChange={updateBindingValue}
                onRemove={removeBinding}
                onOverride={overrideBinding}
                onNotesChange={(notes) => {
                  if (selectedBinding) updateBindingNotes(selectedBinding, notes);
                }}
                onClose={() => setComponentDrawerOpen(false)}
                {...(onOpenDetail ? { onOpenDetail } : {})}
              />
            ) : entity ? (
              <EntityDetailsPanel
                entity={entity}
                inheritsFrom={inheritsFrom}
                imageUrl={imageUrl}
                imageMaxHeight={imageSettings.size}
                onClose={() => setComponentDrawerOpen(false)}
                {...(onOpenDetail ? { onOpenDetail } : {})}
              />
            ) : null}
          </aside>
        )}
      </div>

      {componentBrowserOpen && entity && <ComponentBrowserDialog
        title="创建组件"
        pickLabel="创建"
        entries={browserEntries}
        projectPath={projectPath}
        recentPrefix="specloom.entity-workbench.recent-components."
        favoritePrefix="specloom.entity-workbench.favorite-components."
        onPick={(entry) => createBrowserComponent(componentEntries.find((component) => component.path === entry.path))}
        onClose={() => setComponentBrowserOpen(false)}
        disabled={saving}
      />}
    </section>
  );
}
