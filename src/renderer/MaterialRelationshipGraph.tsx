import { ChevronDown, ChevronRight, Maximize2, Minus, Plus } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useI18n } from "./i18n";
import { componentScope, componentScopeLabels, materialScope, resolveMaterial, type DocumentCategory, type MaterialNode, type MaterialSummary } from "./materials-model";
import { layoutMaterialGraph } from "./material-graph-layout";
import "./navigation-materials.css";

export interface MaterialRelationshipGraphProps {
  tree: MaterialNode[];
  materials: MaterialSummary[];
  category?: DocumentCategory | undefined;
  selectedPath?: string | undefined;
  onSelect: (path: string) => void;
  expandedKeys?: ReadonlySet<string> | undefined;
  onExpandedKeysChange?: ((next: Set<string>) => void) | undefined;
}

const typeLabels: Record<string, string> = { entity: "通用实体", character: "角色", enemy: "敌人", item: "物品", system: "系统", event: "事件", component: "组件", setting: "设定", map: "地图", ui: "UI", spec: "规范" };

function selectedAncestors(tree: MaterialNode[], path: string | undefined): string[] {
  if (!path) return [];
  function find(nodes: MaterialNode[], ancestors: string[]): string[] | undefined {
    for (const node of nodes) {
      if (node.material?.path === path) return ancestors;
      const found = find(node.children, [...ancestors, node.key]);
      if (found) return found;
    }
    return undefined;
  }
  return find(tree, []) ?? [];
}

export function MaterialRelationshipGraph({ tree, materials, category, selectedPath, onSelect, expandedKeys, onExpandedKeysChange }: MaterialRelationshipGraphProps) {
  const tr = useI18n();
  const id = useId();
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | undefined>(undefined);
  const wheelAnchor = useRef<{ x: number; y: number; worldX: number; worldY: number } | undefined>(undefined);
  const ancestors = useMemo(() => selectedAncestors(tree, selectedPath), [tree, selectedPath]);
  const roots = tree.filter((node) => node.material && node.children.length > 0).map((node) => node.key);
  const [localExpanded, setLocalExpanded] = useState(() => new Set([...roots, ...ancestors]));
  const [zoom, setZoom] = useState(1);
  const expanded = expandedKeys ?? localExpanded;
  const knownRoots = useRef(new Set(roots));
  const expansion = useRef({ expanded, roots, ancestors, onExpandedKeysChange, controlled: expandedKeys !== undefined });
  expansion.current = { expanded, roots, ancestors, onExpandedKeysChange, controlled: expandedKeys !== undefined };
  const rootSignature = JSON.stringify(roots);
  const ancestorSignature = JSON.stringify(ancestors);

  useEffect(() => {
    const current = expansion.current;
    const newRoots = current.roots.filter((key) => !knownRoots.current.has(key));
    for (const key of newRoots) knownRoots.current.add(key);
    if (!current.controlled && newRoots.length) setLocalExpanded((previous) => new Set([...previous, ...newRoots]));
  }, [rootSignature]);

  useEffect(() => {
    const current = expansion.current;
    if (current.ancestors.every((key) => current.expanded.has(key))) return;
    const next = new Set([...current.expanded, ...current.ancestors]);
    if (!current.controlled) setLocalExpanded((previous) => new Set([...previous, ...current.ancestors]));
    current.onExpandedKeysChange?.(next);
  }, [selectedPath, ancestorSignature]);

  const layout = useMemo(() => layoutMaterialGraph(tree, expanded), [tree, expanded]);

  useLayoutEffect(() => {
    const anchor = wheelAnchor.current;
    const element = viewport.current;
    if (!anchor || !element) return;
    element.scrollLeft = anchor.worldX * zoom - anchor.x;
    element.scrollTop = anchor.worldY * zoom - anchor.y;
    wheelAnchor.current = undefined;
  }, [zoom]);

  function toggle(key: string) {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key); else next.add(key);
    if (expandedKeys === undefined) setLocalExpanded(next);
    onExpandedKeysChange?.(next);
  }

  function fit() {
    const element = viewport.current;
    if (!element) return;
    wheelAnchor.current = undefined;
    const scale = Math.min(element.clientWidth / layout.width, element.clientHeight / layout.height, 1);
    if (scale > 0) setZoom(scale);
    element.scrollLeft = 0;
    element.scrollTop = 0;
  }

  function panStart(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    event.currentTarget.focus();
  }

  function panMove(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    event.currentTarget.scrollLeft = drag.current.left + drag.current.x - event.clientX;
    event.currentTarget.scrollTop = drag.current.top + drag.current.y - event.clientY;
  }

  function panEnd(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = undefined;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture?.(event.pointerId);
  }

  function zoomAtPointer(event: React.WheelEvent<HTMLDivElement>) {
    const element = viewport.current;
    if (!element || layout.nodes.length === 0) return;
    event.preventDefault();
    const rect = element.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * element.clientHeight : event.deltaY;
    const next = Math.max(0.1, Math.min(2, zoom * Math.exp(-delta * 0.0012)));
    if (Math.abs(next - zoom) < 0.001) return;
    wheelAnchor.current = { x, y, worldX: (element.scrollLeft + x) / zoom, worldY: (element.scrollTop + y) / zoom };
    setZoom(next);
  }

  function panKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    const directions: Record<string, [number, number]> = { ArrowLeft: [-48, 0], ArrowRight: [48, 0], ArrowUp: [0, -48], ArrowDown: [0, 48] };
    const direction = directions[event.key];
    if (!direction) return;
    event.preventDefault();
    event.currentTarget.scrollLeft += direction[0];
    event.currentTarget.scrollTop += direction[1];
  }

  return <div className="material-relationship-graph">
    <div className="material-graph-toolbar">
      <span id={`${id}-hint`} className="material-graph-hint">{tr("连线表示父级资料；滚轮缩放，按住空白处拖动画布，方向键平移")}</span>
      <div className="material-graph-controls" role="group" aria-label={tr("关系图视图控制")}>
        <button type="button" aria-label={tr("适配视图")} onClick={fit}><Maximize2 size={14} aria-hidden="true" /><span>{tr("适配视图")}</span></button>
        <button type="button" aria-label={tr("缩小关系图")} disabled={zoom <= 0.1} onClick={() => { wheelAnchor.current = undefined; setZoom((previous) => Math.max(0.1, Math.round((previous - 0.2) * 100) / 100)); }}><Minus size={14} aria-hidden="true" /></button>
        <output aria-label={tr("关系图缩放比例")}>{Math.round(zoom * 100)}%</output>
        <button type="button" aria-label={tr("放大关系图")} disabled={zoom >= 2} onClick={() => { wheelAnchor.current = undefined; setZoom((previous) => Math.min(2, Math.round((previous + 0.2) * 100) / 100)); }}><Plus size={14} aria-hidden="true" /></button>
      </div>
    </div>
    <div ref={viewport} className="material-graph-viewport" style={{ height: Math.min(480, Math.max(220, layout.height * zoom)) }} role="region" aria-label={tr("父级关系画布")} aria-describedby={`${id}-hint`} tabIndex={0} onPointerDown={panStart} onPointerMove={panMove} onPointerUp={panEnd} onPointerCancel={panEnd} onLostPointerCapture={() => { drag.current = undefined; }} onWheel={zoomAtPointer} onKeyDown={panKeyboard}>
      {layout.nodes.length > 0 ? <div className="material-graph-scroll-area" style={{ width: layout.width * zoom, height: layout.height * zoom }}>
        <div className="material-graph-canvas" style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}>
          <svg className="material-graph-connectors" width={layout.width} height={layout.height} aria-hidden="true">
            {layout.edges.map((edge) => {
              const middle = (edge.start.x + edge.end.x) / 2;
              return <path key={`${edge.source}-${edge.target}`} className="material-graph-edge" data-source={edge.source} data-target={edge.target} d={`M ${edge.start.x} ${edge.start.y} C ${middle} ${edge.start.y}, ${middle} ${edge.end.y}, ${edge.end.x} ${edge.end.y}`} />;
            })}
          </svg>
          {layout.nodes.map(({ node, x, y, width, height }) => {
            const item = node.material!;
            const parent = resolveMaterial(materials, item.parent);
            const parentLabel = item.parent ? parent?.title ?? tr("缺失父级：{parent}", { parent: item.parent }) : tr("根资料");
            const group = item.groupPath || item.group || tr("未分组");
            const component = category === "component" || item.type === "component";
            const metadata = tr(materialScope(item) === "system" && !component ? "官方" : component ? componentScopeLabels[componentScope(item)] : typeLabels[item.type] ?? item.type);
            const open = expanded.has(node.key);
            const metadataId = `${id}-metadata-${encodeURIComponent(node.key)}`;
            const summary = [
              tr("{label}：{value}", { label: component ? tr("组件来源") : category === "entity" ? tr("实体类型") : tr("类型"), value: metadata }),
              tr("父级资料：{value}", { value: parentLabel }),
              tr("所属分组：{value}", { value: group }),
              tr("{count} 个子项", { count: node.children.length }),
              ...(node.contextOnly ? [tr("路径上下文")] : []),
              ...(item.description ? [tr("说明：{value}", { value: item.description })] : []),
            ].join("；");
            return <div key={node.key} className={`material-graph-node${node.contextOnly ? " context-only" : ""}${selectedPath === item.path ? " selected" : ""}`} data-material-path={item.path} style={{ left: x, top: y, width, height }}>
              <button type="button" className="material-graph-choice" aria-label={tr("查看 {title}", { title: item.title })} aria-pressed={selectedPath === item.path} aria-describedby={metadataId} title={item.path} onClick={() => onSelect(item.path)}>
                <strong title={item.title}>{item.title}</strong>
                <span className="material-graph-badges"><span className={`material-type-badge${component ? ` material-source-${componentScope(item)}` : ""}`}>{metadata}</span>{node.contextOnly && <small className="material-context-badge">{tr("路径上下文")}</small>}</span>
                {item.description && <span className="material-graph-description" title={item.description}>{item.description}</span>}
                <span className="material-graph-parent" title={parentLabel}>{item.parent ? tr("父级资料：{value}", { value: parentLabel }) : tr("根资料")}</span>
                <span className="material-graph-group" title={group}>{tr("所属分组：{value}", { value: group })}</span>
                <span className="material-graph-child-count">{tr("{count} 个子项", { count: node.children.length })}</span>
                <span id={metadataId} className="material-hierarchy-accessible-summary">{summary}</span>
              </button>
              {node.children.length > 0 && <button type="button" className="material-graph-disclosure" aria-label={`${open ? tr("收起") : tr("展开")} ${item.title}`} aria-expanded={open} onClick={() => toggle(node.key)}>{open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}</button>}
            </div>;
          })}
        </div>
      </div> : <p className="material-graph-empty">{tr("暂无可展示的父级关系")}</p>}
    </div>
    {layout.repairGroups.map((group) => <section key={group.key} className="material-graph-repairs" aria-label={tr(group.label)}>
      <h4>{tr(group.label)}</h4>
      <p>{group.key === "__relations__" ? tr("这些资料的父级关系需要修复。选择资料打开现有编辑入口。") : tr("这些资料尚未解析。选择资料打开源码修复入口。")}</p>
      <ul>{group.materials.map((node) => <li key={node.key}><button type="button" aria-label={tr("查看 {title}", { title: node.material!.title })} aria-pressed={selectedPath === node.material!.path} onClick={() => onSelect(node.material!.path)}><strong>{node.material!.title}</strong>{node.contextOnly && <small className="material-context-badge">{tr("路径上下文")}</small>}<span>{node.material!.path}</span></button></li>)}</ul>
    </section>)}
  </div>;
}
