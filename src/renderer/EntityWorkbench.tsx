import { ChevronRight, Puzzle, RefreshCw, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { FileReadResult } from "../shared/contracts";
import type { DesktopApi } from "../shared/desktop-api";
import {
  parseMaterial,
  readBindings,
  readFields,
  writeMaterial,
  type ComponentBinding,
  type ComponentField,
  type ComponentValue,
} from "../shared/project-materials";
import { categoryForPath, referenceId } from "./materials-model";
import {
  ENTITY_CENTER,
  ENTITY_NODE_ID,
  defaultEntityPositions,
  loadEntityLayout,
  pruneEntityLayout,
  saveEntityLayout,
  type EntityLayout,
  type EntityPoint,
} from "./entity-layout";
import "./entity-workbench.css";

const COMPONENT_NODE_PREFIX = "component:";
const EMPTY_POSITIONS: Record<string, EntityPoint> = {};
const fieldTypeLabels: Record<ComponentField["type"], string> = { number: "数值", string: "文本", boolean: "布尔" };

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
}

interface ComponentEntry {
  path: string;
  id: string;
  title: string;
  fields: ComponentField[];
}

export interface ResolvedBinding {
  id: string;
  values: Record<string, ComponentValue>;
  own: boolean;
  component?: ComponentEntry;
  inheritedFrom?: string;
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

function formatValue(value: ComponentValue): string {
  if (typeof value === "boolean") return value ? "是" : "否";
  if (value === "") return "（空）";
  return String(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
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

function bindingSummary(binding: ResolvedBinding): string {
  const component = binding.component;
  if (!component) return "组件定义缺失";
  const fields = component.fields.slice(0, 3).map((field) => `${field.label ?? field.key} ${formatValue(readFieldValue(binding, field))}`);
  return fields.length ? fields.join(" · ") : "没有字段";
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
  const inheritedFrom = new Map<string, string>();
  const ownIdentities = new Set(entity.bindings.map((binding) => identify(binding.id)));
  for (const source of [...ancestors, entity]) {
    for (const binding of source.bindings) {
      const identity = identify(binding.id);
      if (!values.has(identity)) order.push(identity);
      ids.set(identity, binding.id);
      values.set(identity, { ...values.get(identity), ...binding.values });
      if (source === entity) inheritedFrom.delete(identity);
      else inheritedFrom.set(identity, source.title);
    }
  }
  return order.map((identity) => {
    const id = ids.get(identity) ?? identity;
    const component = resolveComponentReference(id, lookup);
    const inheritedTitle = ownIdentities.has(identity) ? undefined : inheritedFrom.get(identity);
    return {
      id,
      values: values.get(identity) ?? {},
      own: ownIdentities.has(identity),
      ...(component ? { component } : {}),
      ...(inheritedTitle ? { inheritedFrom: inheritedTitle } : {}),
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
};

type WorkbenchFlowNode = Node<WorkbenchNodeData>;

function EntityCard({ data }: NodeProps) {
  const card = data as unknown as WorkbenchNodeData;
  return (
    <div className="ewb-card ewb-card-entity">
      <span className="ewb-card-kicker">实体</span>
      <strong className="ewb-card-title">{card.title}</strong>
      <span className="ewb-card-meta">{card.meta}</span>
      {card.path && <code className="ewb-card-path">{card.path}</code>}
    </div>
  );
}

function ComponentCard({ data }: NodeProps) {
  const card = data as unknown as WorkbenchNodeData;
  const classes = ["ewb-card", "ewb-card-component", card.inherited ? "is-inherited" : "", card.selected ? "is-selected" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes}>
      <button type="button" className="ewb-card-select" aria-label={`选择组件 ${card.title}`}>
        <strong className="ewb-card-title">{card.title}</strong>
        <span className="ewb-card-meta">{card.meta}</span>
        {card.summary && <span className="ewb-card-summary">{card.summary}</span>}
      </button>
      {card.inherited && (
        <span className="ewb-badge" title={card.inheritedFrom ? `继承自 ${card.inheritedFrom}` : "继承组件"}>
          继承
        </span>
      )}
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
  onSelectBinding,
  onMoveBinding,
}: {
  entity: EntityEntry;
  bindings: ResolvedBinding[];
  storedPositions: Record<string, EntityPoint>;
  selectedBindingId: string | undefined;
  onSelectBinding: (bindingId: string | undefined) => void;
  onMoveBinding: (bindingId: string, position: EntityPoint) => void;
}) {
  const model = useMemo(() => {
    const defaults = defaultEntityPositions(entity.id, bindings.map((binding) => binding.id));
    const inheritedCount = bindings.filter((binding) => !binding.own).length;
    const nodes: WorkbenchFlowNode[] = [
      {
        id: ENTITY_NODE_ID,
        type: "entity",
        position: { ...ENTITY_CENTER },
        data: {
          kind: "entity",
          title: entity.title,
          meta: `${bindings.length} 个组件${inheritedCount ? ` · ${inheritedCount} 个继承` : ""}`,
          path: entity.path,
        },
        draggable: false,
        selectable: false,
        focusable: true,
        ariaLabel: `实体 ${entity.title}`,
      },
    ];
    const edges: Edge[] = [];
    for (const binding of bindings) {
      const title = binding.component?.title ?? binding.id;
      const meta = binding.component ? `${binding.component.fields.length} 个字段` : "组件定义缺失";
      nodes.push({
        id: componentNodeId(binding.id),
        type: "component",
        position: storedPositions[binding.id] ?? defaults[binding.id] ?? { x: ENTITY_CENTER.x, y: ENTITY_CENTER.y + 220 },
        data: {
          kind: "component",
          title,
          meta,
          summary: bindingSummary(binding),
          selected: binding.id === selectedBindingId,
          inherited: !binding.own,
          ...(binding.inheritedFrom ? { inheritedFrom: binding.inheritedFrom } : {}),
          ...(binding.component ? {} : { missing: true }),
        },
        draggable: true,
        selectable: true,
        focusable: true,
        ariaLabel: `组件 ${title}`,
      });
      edges.push({
        id: `entity-edge:${binding.id}`,
        source: ENTITY_NODE_ID,
        target: componentNodeId(binding.id),
        type: "default",
        style: binding.own
          ? { stroke: "var(--accent)" }
          : { stroke: "var(--text-faint)", strokeDasharray: "5 4" },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color: binding.own ? "var(--accent)" : "var(--text-faint)",
        },
        ariaLabel: `${entity.title} 到 ${title}`,
      });
    }
    return { nodes, edges };
  }, [entity, bindings, storedPositions, selectedBindingId]);

  const [nodes, setNodes, onNodesChange] = useNodesState<WorkbenchFlowNode>(model.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(model.edges);

  useEffect(() => {
    setNodes(model.nodes);
    setEdges(model.edges);
  }, [model, setNodes, setEdges]);

  const frameRef = useRef<HTMLDivElement | null>(null);
  const flowRef = useRef<ReactFlowInstance<WorkbenchFlowNode, Edge> | null>(null);
  const fittedEntityRef = useRef<string | undefined>(undefined);
  const fittedSizeRef = useRef<{ width: number; height: number } | undefined>(undefined);

  // The page can mount while its navigation tab is hidden, so fit only once the
  // frame has a real size, and again when another entity is shown.
  const fitCanvas = useCallback(() => {
    const frame = frameRef.current;
    const flow = flowRef.current;
    if (!frame || !flow) return;
    const rect = frame.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return;
    const sizeChanged =
      fittedSizeRef.current === undefined ||
      Math.abs(fittedSizeRef.current.width - rect.width) > 16 ||
      Math.abs(fittedSizeRef.current.height - rect.height) > 16;
    if (fittedEntityRef.current === entity.id && !sizeChanged) return;
    fittedEntityRef.current = entity.id;
    fittedSizeRef.current = { width: rect.width, height: rect.height };
    const fit = () => void flow.fitView({ padding: 0.2, duration: 0, minZoom: 0.4 });
    fit();
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(fit);
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
    const bindingId = node.id.slice(COMPONENT_NODE_PREFIX.length);
    onSelectBinding(selectedBindingId === bindingId ? undefined : bindingId);
  };
  const moveNode = (node: WorkbenchFlowNode) => {
    if (node.id === ENTITY_NODE_ID) return;
    onMoveBinding(node.id.slice(COMPONENT_NODE_PREFIX.length), { x: node.position.x, y: node.position.y });
  };

  return (
    <div className="ewb-canvas-frame" ref={frameRef}>
      <ReactFlowProvider>
        <ReactFlow<WorkbenchFlowNode, Edge>
          aria-label={`${entity.title} 组件画布`}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          minZoom={0.4}
          maxZoom={1.6}
          nodesConnectable={false}
          edgesFocusable={false}
          onInit={(instance) => {
            flowRef.current = instance;
            fitCanvas();
          }}
          onNodeClick={(_event, node) => selectNode(node)}
          onPaneClick={() => onSelectBinding(undefined)}
          onNodeDrag={(_event, node) => moveNode(node)}
          onNodeDragStop={(_event, node) => moveNode(node)}
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
  storedPositions: Record<string, EntityPoint>;
  selectedBindingId: string | undefined;
  onSelectBinding: (bindingId: string | undefined) => void;
  onMoveBinding: (bindingId: string, position: EntityPoint) => void;
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
  const inputId = `ewb-field-${field.key}`;
  const label = field.label ?? field.key;
  return (
    <div className="ewb-field">
      <label className="ewb-field-label" htmlFor={inputId}>
        {label}
      </label>
      <span className="ewb-field-meta">
        {fieldTypeLabels[field.type]} · 默认 {formatValue(field.default)}
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
          <span>{value === true ? "开启" : "关闭"}</span>
        </span>
      )}
      {range && (
        <span className="ewb-range">
          <progress aria-label={`${label} 范围`} max={range.max} value={clamp(range.current, 0, range.max)} />
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
  rangeEnabled?: boolean;
  currentFieldKey?: string | undefined;
  range?: { current: number; max: number } | undefined;
  onChange: (binding: ResolvedBinding, field: ComponentField, value: ComponentValue) => void;
  onRemove: (binding: ResolvedBinding) => void;
  onOverride: (binding: ResolvedBinding) => void;
}

/** Reusable field-fill and inheritance panel for one mounted component binding. */
export function ComponentFillPanel({
  binding,
  component,
  fields,
  rangeEnabled = false,
  currentFieldKey,
  range,
  onChange,
  onRemove,
  onOverride,
}: ComponentFillPanelProps) {
  return (
    <section className="ewb-panel ewb-inspector" role="complementary" aria-label="组件检查器">
      <header className="ewb-panel-head">
        <h2>组件检查器</h2>
      </header>
      {!binding ? (
        <p className="ewb-empty">选择画布中的组件查看字段</p>
      ) : (
        <>
          <div className="ewb-inspector-title">
            <strong>{component?.title ?? binding.id}</strong>
            <span className={binding.own ? "ewb-badge is-own" : "ewb-badge"}>
              {binding.own ? "本实体" : "继承自 " + (binding.inheritedFrom ?? "父实体")}
            </span>
          </div>
          <code className="ewb-inspector-path">{component?.path ?? "找不到组件定义"}</code>
          {!binding.component ? (
            <p className="ewb-inspector-hint">组件定义不存在，无法编辑字段。请检查项目资料中的组件文件。</p>
          ) : fields.length === 0 ? (
            <p className="ewb-inspector-hint">该组件没有字段。</p>
          ) : (
            <div className="ewb-fields">
              {fields.map((field) => (
                <FieldEditor
                  key={field.key}
                  field={field}
                  value={readFieldValue(binding, field)}
                  disabled={!binding.own}
                  {...(rangeEnabled && field.key === currentFieldKey
                    ? { range: { current: range?.current ?? 0, max: range?.max ?? 0 } }
                    : {})}
                  onChange={(value) => onChange(binding, field, value)}
                />
              ))}
            </div>
          )}
          <div className="ewb-inspector-actions">
            {binding.own ? (
              <button type="button" className="danger-ghost" onClick={() => onRemove(binding)}>
                <Trash2 size={13} />
                移除组件
              </button>
            ) : (
              <button type="button" onClick={() => onOverride(binding)}>
                覆盖继承组件
              </button>
            )}
          </div>
          {!binding.own && (
            <p className="ewb-inspector-hint">
              继承组件的字段只读；覆盖后会为当前实体追加自有绑定，字段沿用当前值并可以继续编辑。
            </p>
          )}
        </>
      )}
    </section>
  );
}

/** Reusable field-fill and inheritance panel for one mounted component binding. */
export function EntityWorkbench({ api, projectPath, onError }: EntityWorkbenchProps) {
  const [files, setFiles] = useState<FileReadResult[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [layout, setLayout] = useState<EntityLayout>(() => loadEntityLayout(projectPath));
  const [selectedEntityPath, setSelectedEntityPath] = useState<string | undefined>(undefined);
  const [selectedBindingId, setSelectedBindingId] = useState<string | undefined>(undefined);
  const [componentDrawerOpen, setComponentDrawerOpen] = useState(false);
  useEffect(() => {
    if (selectedBindingId) setComponentDrawerOpen(true);
  }, [selectedBindingId]);
  const [entityQuery, setEntityQuery] = useState("");
  const [componentQuery, setComponentQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [savedNotice, setSavedNotice] = useState(false);
  const mountedRef = useRef(true);
  const requestRef = useRef(0);

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
        return category === "entity" || category === "component";
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
      if (failed.length) setLoadError(`有 ${failed.length} 份资料读取失败，请刷新重试。`);
    } catch (error) {
      if (!mountedRef.current || request !== requestRef.current) return;
      setLoadError(describeError(error, "读取项目资料失败，请刷新重试。"));
      onError?.(error);
    } finally {
      if (mountedRef.current && request === requestRef.current) setLoading(false);
    }
  }, [api, onError]);

  useEffect(() => {
    void refresh();
    return () => {
      requestRef.current++;
    };
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    setLayout(loadEntityLayout(projectPath));
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
        };
      })
      .sort((left, right) => left.title.localeCompare(right.title) || left.path.localeCompare(right.path));
  }, [parsedFiles]);

  const componentEntries = useMemo(() => {
    return parsedFiles
      .filter((item) => item.category === "component")
      .map((item): ComponentEntry => ({
        path: item.file.path,
        id: item.id,
        title: item.title,
        fields: readFields(item.parsed.data),
      }))
      .sort((left, right) => left.title.localeCompare(right.title) || left.path.localeCompare(right.path));
  }, [parsedFiles]);

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
  const bindings = useMemo(() => (entity ? resolveEntityBindings(entity, lookup) : []), [entity, lookup]);
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

  const filteredComponents = useMemo(
    () => componentEntries.filter((item) => matchesQuery(componentQuery, [item.title, item.id, item.path])),
    [componentEntries, componentQuery],
  );

  const selectedBinding = selectedBindingId ? bindings.find((item) => item.id === selectedBindingId) : undefined;
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

  function writeEntityBindings(nextBindings: ComponentBinding[]) {
    if (!entity) return;
    const content = writeMaterial(
      { ...entity.data, components: nextBindings.map((binding) => ({ id: binding.id, values: binding.values })) },
      entity.body,
    );
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
    writeEntityBindings([...remaining, { id: identity, values }]);
    setSelectedBindingId(identity);
  }

  function updateBindingValue(binding: ResolvedBinding, field: ComponentField, value: ComponentValue) {
    if (!entity || !binding.own) return;
    const identity = bindingIdentity(binding.id);
    const nextBindings = entity.bindings.map((ownBinding) =>
      bindingIdentity(ownBinding.id) === identity
        ? { ...ownBinding, values: { ...ownBinding.values, [field.key]: value } }
        : ownBinding,
    );
    writeEntityBindings(nextBindings);
  }

  function persistLayout(next: EntityLayout): void {
    saveEntityLayout(projectPath, next);
    if (api.entityLayout) void api.entityLayout.save(next).catch((error) => onError?.(error));
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
      const next: EntityLayout = {
        ...current,
        [entity.id]: {
          ...(current[entity.id] ?? {}),
          [bindingId]: { x: Math.round(position.x), y: Math.round(position.y) },
        },
      };
      persistLayout(next);
      return next;
    });
  }

  async function save() {
    if (!entity || !dirty || saving) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      const saved = await api.saveDocument(projectPath, entity.path, entity.content, entity.version);
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
      setSaveError(describeError(error, "保存资料失败，请重新读取后再试。"));
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }

  return (
    <section className="entity-workbench" aria-label="实体工作台">
      <header className="ewb-header">
        <div className="ewb-heading">
          <h1>实体工作台</h1>
          <p className="ewb-subtitle subtle">
            {entity ? (
              <>
                <strong>{entity.title}</strong>
                <code>{entity.path}</code>
              </>
            ) : (
              "选择实体后编辑它的组件绑定"
            )}
          </p>
        </div>
        <div className="ewb-toolbar">
          {savedNotice && !dirty && <span className="ewb-saved">已保存</span>}
          {dirty && <span className="ewb-dirty">未保存</span>}
          <button
            type="button"
            className="ewb-drawer-toggle"
            aria-pressed={componentDrawerOpen}
            aria-label={componentDrawerOpen ? "收起组件栏" : "打开组件栏"}
            title={componentDrawerOpen ? "收起组件栏" : "打开组件栏"}
            onClick={() => setComponentDrawerOpen((value) => !value)}
          >
            <Puzzle size={15} />
            组件
            <span className="ewb-drawer-count">{componentEntries.length}</span>
          </button>
          <button
            type="button"
            className="primary"
            disabled={!entity || !dirty || saving || loading}
            onClick={() => {
              void save();
            }}
          >
            <Save size={15} />
            {saving ? "保存中…" : "保存资料"}
          </button>
          <button
            type="button"
            disabled={loading || saving}
            title="重新读取实体和组件"
            onClick={() => {
              void refresh();
            }}
          >
            <RefreshCw size={15} />
            刷新
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
            关闭
          </button>
        </div>
      )}

      <div className={"ewb-layout" + (componentDrawerOpen ? " is-drawer-open" : "")}>
        <aside className="ewb-panel ewb-entities" aria-label="实体列表">
          <header className="ewb-panel-head">
            <h2>实体</h2>
            <span className="subtle">
              实体 {entityEntries.length} · 组件 {componentEntries.length}
            </span>
          </header>
          <input
            type="search"
            aria-label="搜索实体"
            placeholder="搜索实体"
            value={entityQuery}
            onChange={(event) => setEntityQuery(event.target.value)}
          />
          {filteredEntities.length === 0 ? (
            <p className="ewb-empty">
              {loading
                ? "正在读取资料…"
                : entityEntries.length
                  ? "没有匹配的实体"
                  : "还没有实体。可在项目资料的实体页新建实体。"}
            </p>
          ) : (
            <div className="ewb-tree">
              {entityGroups.map((group) => (
                <section key={group.directory} className="ewb-tree-group" aria-label={`分组 ${group.directory}`}>
                  <h3 className="ewb-group-heading">
                    <code>{group.directory}</code>
                    <span>{group.entries.length}</span>
                  </h3>
                  <ul>
                    {group.entries.map((item) => {
                      const itemDraft = drafts[item.path];
                      const itemDirty = itemDraft !== undefined && itemDraft !== item.baseline;
                      return (
                        <li key={item.path}>
                          <button
                            type="button"
                            className="ewb-entity-item"
                            aria-pressed={entity?.path === item.path}
                            title={item.path}
                            onClick={() => {
                              setSelectedEntityPath(item.path);
                              setSelectedBindingId(undefined);
                            }}
                          >
                            <span className="ewb-item-title">{item.title}</span>
                            <span className="ewb-item-meta">
                              {item.id}
                              {item.extendsRef ? " · 继承" : ""}
                              {itemDirty && <span className="ewb-badge is-own">未保存</span>}
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

        <section className="ewb-canvas" aria-label="实体画布">
          {entity ? (
            <EntityComponentBoard
              entity={entity}
              bindings={bindings}
              storedPositions={layout[entity.id] ?? EMPTY_POSITIONS}
              selectedBindingId={selectedBindingId}
              onSelectBinding={setSelectedBindingId}
              onMoveBinding={moveBinding}
            />
          ) : (
            <p className="ewb-empty">
              {loading ? "正在读取资料…" : "还没有实体。可在项目资料的实体页新建实体，再回来挂载组件。"}
            </p>
          )}
        </section>

        {componentDrawerOpen && (
          <aside className="ewb-drawer" aria-label="组件栏">
            <section className="ewb-panel ewb-library" role="complementary" aria-label="组件库">
          <header className="ewb-panel-head">
            <h2>组件库</h2>
            <span className="subtle">{componentEntries.length} 个组件</span>
              <button type="button" className="ewb-drawer-close" aria-label="收起组件栏" title="收起组件栏" onClick={() => setComponentDrawerOpen(false)}><ChevronRight size={15} /></button>
          </header>
          <input
            type="search"
            aria-label="搜索组件"
            placeholder="搜索组件"
            value={componentQuery}
            onChange={(event) => setComponentQuery(event.target.value)}
          />
          {componentEntries.length === 0 ? (
            <p className="ewb-empty">{loading ? "正在读取资料…" : "还没有组件。可在项目资料的组件页新建组件。"}</p>
          ) : filteredComponents.length === 0 ? (
            <p className="ewb-empty">没有匹配的组件</p>
          ) : (
            <ul className="ewb-library-list" aria-label="组件列表">
              {filteredComponents.map((component) => {
                const binding = effectiveBindingFor(component);
                const own = binding?.own === true;
                const inherited = Boolean(binding && !binding.own);
                return (
                  <li key={component.path}>
                    <button
                      type="button"
                      className="ewb-library-item"
                      disabled={!entity || own}
                      title={
                        !entity
                          ? "先选择实体"
                          : own
                            ? "已添加到当前实体"
                            : inherited
                              ? "已继承，点击覆盖为当前实体的组件"
                              : "添加到当前实体"
                      }
                      onClick={() => addComponent(component)}
                    >
                      <span className="ewb-item-title">
                        <Puzzle size={13} />
                        {component.title}
                      </span>
                      <span className="ewb-item-meta">
                        {component.fields.length} 个字段
                        {inherited && <span className="ewb-badge">已继承</span>}
                        {own && <span className="ewb-badge is-own">已添加</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
            </section>
            <ComponentFillPanel
          binding={selectedBinding}
          component={selectedBinding?.component}
          fields={componentFields}
          rangeEnabled={rangeEnabled}
          currentFieldKey={currentField?.key}
          range={rangeEnabled ? { current: rangeCurrent, max: progressMax } : undefined}
          onChange={updateBindingValue}
          onRemove={removeBinding}
          onOverride={overrideBinding}
        />
          </aside>
        )}
      </div>
    </section>
  );
}