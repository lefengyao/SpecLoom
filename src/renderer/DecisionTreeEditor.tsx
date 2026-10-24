import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "@xyflow/react/dist/style.css";
import "./decision-tree.css";
import { Background, Controls, MiniMap, ReactFlow, applyNodeChanges, type Edge, type Node, type OnNodesChange } from "@xyflow/react";
import {
  COMPARATOR_OPERATORS, NODE_KIND_LABELS, NODE_KINDS, composeComparator, findDecisionNode, flattenDecisionTree, insertDecisionNode,
  isComposite, isDecorator, isNodeKind, parseComparator, removeDecisionNode, reorderDecisionNode, updateDecisionNode,
  type DecisionNode, type DecisionNodeKind,
} from "../shared/decision-tree";
import { categoryForPath, componentScope, componentScopeLabels, type MaterialSummary } from "./materials-model";
import { useI18n } from "./i18n";

interface Point { x: number; y: number }

const COLUMN_WIDTH = 240;
const ROW_HEIGHT = 104;
const STORAGE_PREFIX = "specloom.decision-tree.";

function isRoot(value: unknown): value is DecisionNode {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && isNodeKind((value as { kind?: unknown }).kind);
}

function loadPositions(treePath: string): Record<string, Point> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(`${STORAGE_PREFIX}${treePath}`) ?? "{}") as { nodes?: Record<string, Point> };
    const nodes = parsed?.nodes;
    if (!nodes || typeof nodes !== "object") return {};
    return Object.fromEntries(Object.entries(nodes).filter(([, value]) => value && Number.isFinite(value.x) && Number.isFinite(value.y)));
  } catch { return {}; }
}

function savePositions(treePath: string, nodes: Record<string, Point>): void {
  try { window.localStorage.setItem(`${STORAGE_PREFIX}${treePath}`, JSON.stringify({ version: 1, nodes })); } catch { /* best effort */ }
}

/** Depth-first column layout; siblings stay in document order. */
function autoPositions(root: DecisionNode): Record<string, Point> {
  const positions: Record<string, Point> = {};
  const rows = new Map<number, number>();
  for (const { node, depth } of flattenDecisionTree(root)) {
    const row = rows.get(depth) ?? 0;
    rows.set(depth, row + 1);
    positions[node.id] = { x: depth * COLUMN_WIDTH, y: row * ROW_HEIGHT };
  }
  return positions;
}

function nodeLabel(node: DecisionNode): string {
  const detail = node.kind === "condition"
    ? (node.comparator ?? (node.signal ? `${node.signal.from}.${node.signal.name}` : node.event) ?? "")
    : node.kind === "action" ? (node.action ?? "") : "";
  const title = node.title?.trim() ? node.title : node.id;
  return detail ? `${title}\n${detail}` : title;
}

/** Node graph editor for one decision tree spec; every edit rewrites `root`. */
export function DecisionTreeEditor({ root, treePath, catalog = [], onChange, disabled = false }: {
  root: unknown;
  treePath: string;
  catalog?: MaterialSummary[];
  onChange: (root: DecisionNode) => void;
  disabled?: boolean;
}) {
  const tr = useI18n();
  const tree = isRoot(root) ? root : undefined;
  const [selectedId, setSelectedId] = useState<string>();
  const [positions, setPositions] = useState<Record<string, Point>>({});
  const loadedFor = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!tree) { setPositions({}); return; }
    if (loadedFor.current === treePath) return;
    loadedFor.current = treePath;
    setPositions({ ...autoPositions(tree), ...loadPositions(treePath) });
  }, [tree, treePath]);

  const positioned = useMemo(() => {
    if (!tree) return {};
    const fallback = autoPositions(tree);
    return Object.fromEntries(flattenDecisionTree(tree).map(({ node }) => [node.id, positions[node.id] ?? fallback[node.id] ?? { x: 0, y: 0 }]));
  }, [tree, positions]);

  const nodes = useMemo<Node[]>(() => {
    if (!tree) return [];
    return flattenDecisionTree(tree).map(({ node }) => ({
      id: node.id,
      position: positioned[node.id] ?? { x: 0, y: 0 },
      data: { label: nodeLabel(node) },
      className: `dtree-node dtree-${node.kind}${selectedId === node.id ? " is-selected" : ""}`,
    }));
  }, [tree, positioned, selectedId]);

  const edges = useMemo<Edge[]>(() => {
    if (!tree) return [];
    return flattenDecisionTree(tree).flatMap(({ node, parent }) => parent
      ? [{ id: `${parent}->${node.id}`, source: parent, target: node.id } as Edge]
      : []);
  }, [tree]);

  const onNodesChange: OnNodesChange = useCallback((changes) => {
    const moved = applyNodeChanges(changes, nodes);
    setPositions((current) => {
      const next = { ...current };
      for (const node of moved) next[node.id] = { x: Math.round(node.position.x), y: Math.round(node.position.y) };
      return next;
    });
  }, [nodes]);

  useEffect(() => { if (loadedFor.current === treePath) savePositions(treePath, positions); }, [positions, treePath]);

  const selected = tree && selectedId ? findDecisionNode(tree, selectedId) : undefined;
  const patch = (change: Partial<DecisionNode>) => {
    if (!tree || !selected) return;
    onChange(updateDecisionNode(tree, selected.id, change));
  };
  const conditionComponents = catalog.filter((item) => !item.invalid && item.type === "component" && categoryForPath(item.path) === "component");
  const conditionEntities = catalog.filter((item) => !item.invalid && categoryForPath(item.path) === "entity");
  const signalSources = catalog.filter((item) => !item.invalid && ["entity", "system"].includes(categoryForPath(item.path) ?? ""));
  const parsedComparator = selected?.kind === "condition" && selected.comparator ? parseComparator(selected.comparator) : undefined;
  const activeComponent = conditionComponents.find((item) => item.id === parsedComparator?.component);
  const activeField = activeComponent?.fields.find((field) => field.key === parsedComparator?.field);
  const signalSource = selected?.signal ? signalSources.find((item) => item.id === selected.signal?.from) : undefined;
  const conditionMode: "comparator" | "event" | "signal" = selected?.comparator !== undefined ? "comparator" : selected?.signal !== undefined ? "signal" : "event";
  /** Compose a comparator from the pickers; changing component or field resets the literal to its default. */
  const compose = (change: { owner?: string; component?: string; field?: string; operator?: string; literal?: string }) => {
    if (!selected) return;
    const owner = change.owner ?? selected.owner ?? "";
    const component = change.component ?? parsedComparator?.component ?? conditionComponents[0]?.id ?? "";
    const definition = conditionComponents.find((item) => item.id === component);
    const field = change.field ?? (change.component ? definition?.fields[0]?.key : parsedComparator?.field) ?? definition?.fields[0]?.key ?? "";
    const fieldDefinition = definition?.fields.find((item) => item.key === field);
    const operator = change.operator ?? parsedComparator?.operator ?? "<=";
    const literal = change.literal ?? (change.component || change.field ? String(fieldDefinition?.default ?? "") : parsedComparator?.literal ?? String(fieldDefinition?.default ?? ""));
    patch({ comparator: composeComparator(component, field, operator, literal), owner });
  };
  const addChild = () => {
    if (!tree || !selected) return;
    const used = new Set(flattenDecisionTree(tree).map(({ node }) => node.id));
    let index = used.size + 1;
    let id = `node_${index}`;
    while (used.has(id)) { index++; id = `node_${index}`; }
    onChange(insertDecisionNode(tree, selected.id, { id, kind: "action", action: "do_something" }));
    setSelectedId(id);
  };

  if (!tree) {
    return <section className="dtree-editor" aria-label={tr("决策树工作区")}>
      <header className="dtree-toolbar">
        <strong>{tr("决策树")}</strong><span className="subtle">{tr("当前文件还没有 root 节点。")}</span>
        <button type="button" disabled={disabled} onClick={() => onChange({ id: "root", kind: "selector", title: tr("根节点"), children: [] })}><Plus size={15} />{tr("创建根节点")}</button>
      </header>
    </section>;
  }

  return <section className="dtree-editor" aria-label={tr("决策树工作区")}>
    <header className="dtree-toolbar">
      <strong>{tr("决策树")}</strong>
      <span className="subtle">{tr("{count} 个节点", { count: flattenDecisionTree(tree).length })}</span>
      <button type="button" disabled={disabled} onClick={() => setPositions(autoPositions(tree))}>{tr("自动整理")}</button>
      <button type="button" disabled={disabled || !selected} onClick={addChild}><Plus size={15} />{tr("添加子节点")}</button>
      <button type="button" disabled={disabled || !selected || selected.id === tree.id} onClick={() => {
        if (!selected || !tree) return;
        onChange(removeDecisionNode(tree, selected.id));
        setSelectedId(undefined);
      }}><Trash2 size={15} />{tr("删除节点")}</button>
      <button type="button" aria-label={tr("上移节点")} disabled={disabled || !selected} onClick={() => { if (selected && tree) onChange(reorderDecisionNode(tree, selected.id, -1)); }}><ChevronUp size={15} /></button>
      <button type="button" aria-label={tr("下移节点")} disabled={disabled || !selected} onClick={() => { if (selected && tree) onChange(reorderDecisionNode(tree, selected.id, 1)); }}><ChevronDown size={15} /></button>
    </header>
    <div className="dtree-body">
      <div className="dtree-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onNodeClick={(_event, node) => setSelectedId(node.id)}
          onPaneClick={() => setSelectedId(undefined)}
          fitView
          minZoom={0.3}
          maxZoom={1.6}
          nodesConnectable={false}
          edgesFocusable={false}
        >
          <Background />
          <MiniMap pannable zoomable />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <aside className="dtree-inspector" aria-label={tr("决策节点检查器")}>
        {!selected ? <p className="ewb-empty">{tr("选择画布中的节点编辑条件与动作")}</p> : <>
          <h3>{tr("节点")}<code>{selected.id}</code></h3>
          <label>{tr("类型")}<select aria-label={tr("节点类型")} disabled={disabled} value={selected.kind} onChange={(event) => patch({ kind: event.target.value as DecisionNodeKind })}>
            {NODE_KINDS.map((kind) => <option key={kind} value={kind}>{tr(NODE_KIND_LABELS[kind])}</option>)}
          </select></label>
          <label>{tr("标题")}<input aria-label={tr("节点标题")} disabled={disabled} value={selected.title ?? ""} maxLength={100} onChange={(event) => patch({ title: event.target.value })} /></label>
          {selected.kind === "condition" && <>
            <label>{tr("条件类型")}<select aria-label={tr("条件类型")} disabled={disabled} value={conditionMode} onChange={(event) => {
              const mode = event.target.value;
              if (mode === "comparator") patch({ comparator: composeComparator(conditionComponents[0]?.id ?? "component", conditionComponents[0]?.fields[0]?.key ?? "value", "<=", String(conditionComponents[0]?.fields[0]?.default ?? 0)), owner: "" });
              else if (mode === "signal") {
                const source = signalSources.find((item) => (item.signals?.length ?? 0) > 0) ?? signalSources[0];
                patch({ signal: source ? { from: source.id, name: source.signals?.[0] ?? "signal_raised" } : { from: "", name: "" } });
              } else patch({ event: "enemy_in_range" });
            }}>
              <option value="comparator">{tr("字段比较")}</option>
              <option value="event">{tr("事件名")}</option>
              <option value="signal">{tr("信号")}</option>
            </select></label>
            {conditionMode === "signal" ? <>
              <label>{tr("信号来源")}<select aria-label={tr("信号来源")} disabled={disabled} value={selected.signal?.from ?? ""} onChange={(event) => {
                const source = signalSources.find((item) => item.id === event.target.value);
                patch({ signal: { from: event.target.value, name: source?.signals?.[0] ?? "" } });
              }}>
                <option value="">{tr("选择实体或系统")}</option>
                {signalSources.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
              </select></label>
              <label>{tr("信号")}{(signalSource?.signals?.length ?? 0) > 0
                ? <select aria-label={tr("信号名")} disabled={disabled} value={selected.signal?.name ?? ""} onChange={(event) => patch({ signal: { from: selected.signal?.from ?? "", name: event.target.value } })}>
                    {(signalSource?.signals ?? []).map((name) => <option key={name} value={name}>{name}</option>)}
                  </select>
                : <input aria-label={tr("信号名")} disabled={disabled} placeholder="alarm_raised" value={selected.signal?.name ?? ""} onChange={(event) => patch({ signal: { from: selected.signal?.from ?? "", name: event.target.value } })} />}</label>
              {signalSource && !(signalSource.signals?.length) && <p className="subtle">{tr("该来源还没有声明 signals；可先在资料里添加。")}</p>}
              {selected.signal && <code className="dtree-comparator">{selected.signal.from}.{selected.signal.name}</code>}
            </> : conditionMode === "comparator" ? <>
              <label>{tr("引用实体")}<select aria-label={tr("引用实体")} disabled={disabled} value={selected.owner ?? ""} onChange={(event) => compose({ owner: event.target.value })}>
                <option value="">{tr("当前实体")}</option>
                {conditionEntities.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
              </select></label>
              <label>{tr("组件")}<select aria-label={tr("条件组件")} disabled={disabled} value={parsedComparator?.component ?? ""} onChange={(event) => compose({ component: event.target.value })}>
                <option value="">{tr("选择组件")}</option>
                {(["system", "user"] as const).map((scope) => {
                  const items = conditionComponents.filter((item) => componentScope(item) === scope);
                  return items.length ? <optgroup key={scope} label={tr(componentScopeLabels[scope])}>{items.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</optgroup> : null;
                })}
              </select></label>
              <label>{tr("字段")}<select aria-label={tr("条件字段")} disabled={disabled || !activeComponent?.fields.length} value={parsedComparator?.field ?? ""} onChange={(event) => compose({ field: event.target.value })}>
                {(activeComponent?.fields ?? []).map((field) => <option key={field.key} value={field.key}>{field.label || field.key}</option>)}
              </select></label>
              <div className="dtree-condition-row">
                <label>{tr("运算符")}<select aria-label={tr("运算符")} disabled={disabled} value={parsedComparator?.operator ?? "<="} onChange={(event) => compose({ operator: event.target.value })}>
                  {COMPARATOR_OPERATORS.map((operator) => <option key={operator} value={operator}>{operator}</option>)}
                </select></label>
                <label>{tr("值")}{activeField?.type === "boolean"
                  ? <select aria-label={tr("比较值")} disabled={disabled} value={parsedComparator?.literal ?? "true"} onChange={(event) => compose({ literal: event.target.value })}><option value="true">true</option><option value="false">false</option></select>
                  : <input aria-label={tr("比较值")} disabled={disabled} type={activeField?.type === "number" ? "number" : "text"} value={parsedComparator?.literal ?? ""} onChange={(event) => compose({ literal: event.target.value })} />}</label>
              </div>
              {selected.comparator && <code className="dtree-comparator">{selected.comparator}</code>}
            </> : <label>{tr("事件名")}<input aria-label={tr("事件名")} disabled={disabled} placeholder="enemy_in_range" value={selected.event ?? ""} onChange={(event) => patch({ event: event.target.value })} /></label>}
          </>}
          {selected.kind === "action" && <label>{tr("动作")}<input aria-label={tr("动作名")} disabled={disabled} placeholder="move_away" value={selected.action ?? ""} onChange={(event) => patch({ action: event.target.value })} /></label>}
          {selected.kind === "cooldown" && <label>{tr("冷却秒数")}<input aria-label={tr("冷却秒数")} type="number" min={0} step={0.1} disabled={disabled} value={selected.seconds ?? 1} onChange={(event) => patch({ seconds: Number(event.target.value) })} /></label>}
          {selected.kind === "retry" && <label>{tr("重试次数")}<input aria-label={tr("重试次数")} type="number" min={1} step={1} disabled={disabled} value={selected.count ?? 1} onChange={(event) => patch({ count: Math.max(1, Math.round(Number(event.target.value))) })} /></label>}
          {(isComposite(selected.kind) || isDecorator(selected.kind)) && <p className="subtle">{tr("选中后点「添加子节点」追加子节点。")}</p>}
        </>}
      </aside>
    </div>
  </section>;
}
