import { ChevronDown, ChevronRight, FileText, GitBranch, LayoutGrid, List, PanelLeft, Search } from "lucide-react";
import { useDeferredValue, useMemo, useState, type ReactNode } from "react";
import type { DesktopApi } from "../shared/desktop-api";
import { materialGroupPath, groupIncludes, type MaterialGroup } from "../shared/material-groups";
import { MaterialThumbnail } from "./MaterialImage";
import { MaterialGroupTree, type MaterialGroupSelection } from "./MaterialGroupTree";
import { MaterialHierarchyList } from "./MaterialHierarchyList";
import { MaterialRelationshipGraph } from "./MaterialRelationshipGraph";
import { componentScope, componentScopeLabels, materialTree, projectMaterialTree, resolveMaterial, type DocumentCategory, type MaterialNode, type MaterialSummary } from "./materials-model";
import "./navigation-materials.css";

type View = "icons" | "list" | "graph";
type ComponentSource = "*" | "system" | "user";
const preference = "specloom.materials.view";
const typeLabels: Record<string, string> = { entity: "通用实体", character: "角色", enemy: "敌人", item: "物品", system: "系统", event: "事件", component: "组件", map: "地图", setting: "设定", ui: "UI", spec: "规范" };
const entityTypes = ["entity", "character", "enemy", "item", "system", "event"] as const;
function readView(): View {
  try {
    const stored = localStorage.getItem(preference);
    return stored === "icons" || stored === "list" || stored === "graph" ? stored : "list";
  } catch { return "list"; }
}

export function MaterialExplorer({ materials, groups, groupsSaving, onGroupsChange, selectedPath, onSelect, api, projectPath, loading, category }: {
  materials: MaterialSummary[]; groups: MaterialGroup[]; selectedPath?: string | undefined; onSelect: (path: string) => void;
  groupsSaving: boolean; onGroupsChange: (groups: MaterialGroup[]) => Promise<void>;
  api: DesktopApi; projectPath: string; loading: boolean; category?: DocumentCategory;
}) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [selection, setSelection] = useState<MaterialGroupSelection>({ kind: "all" });
  const [entityType, setEntityType] = useState("*");
  const [componentSource, setComponentSource] = useState<ComponentSource>("*");
  const [groupPaneOpen, setGroupPaneOpen] = useState(() => typeof window.matchMedia !== "function" || !window.matchMedia("(max-width: 900px)").matches);
  const [view, setView] = useState(readView);
  // Both hierarchy renderers seed root expansion until the first explicit change.
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>();
  const group = useMemo(() => selection.kind === "group" ? groups.find((item) => item.id === selection.id) : undefined, [groups, selection]);
  const visible = useMemo(() => {
    const search = deferredQuery.trim().toLocaleLowerCase();
    return materials.filter((item) => (selection.kind === "all"
      || (selection.kind === "ungrouped" ? !item.groupId : Boolean(item.groupId && groupIncludes(groups, selection.id, item.groupId))))
      && (category !== "entity" || entityType === "*" || item.type === entityType)
      && (category !== "component" || componentSource === "*" || componentScope(item) === componentSource)
      && `${item.title} ${item.description ?? ""} ${item.id} ${item.path} ${item.groupPath ?? item.group ?? ""}`.toLocaleLowerCase().includes(search))
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [materials, groups, selection, category, entityType, componentSource, deferredQuery]);
  const tree = useMemo(() => materialTree(materials), [materials]);
  const projectedTree = useMemo(() => projectMaterialTree(tree, new Set(visible.map((item) => item.path))), [tree, visible]);
  const defaultIconExpandedKeys = useMemo(() => {
    const keys = new Set<string>();
    function collect(nodes: MaterialNode[]) {
      for (const node of nodes) {
        if (node.children.length) keys.add(node.key);
        collect(node.children);
      }
    }
    collect(projectedTree);
    return keys;
  }, [projectedTree]);
  const iconExpandedKeys = expandedKeys ?? defaultIconExpandedKeys;
  const selectedGroupHasItems = selection.kind === "group" && materials.some((item) => item.groupId && groupIncludes(groups, selection.id, item.groupId));
  const hasAdditionalFilters = Boolean(query || entityType !== "*" || componentSource !== "*");
  const groupTitle = selection.kind === "all" ? "全部资料" : selection.kind === "ungrouped" ? "未分组" : materialGroupPath(groups, selection.id) || group?.name || "分组";
  function changeView(value: View) { setView(value); try { localStorage.setItem(preference, value); } catch { /* best effort */ } }
  function toggleIconBranch(key: string) {
    const next = new Set(iconExpandedKeys);
    if (next.has(key)) next.delete(key); else next.add(key);
    setExpandedKeys(next);
  }
  function renderIconNodes(nodes: MaterialNode[], depth: number): ReactNode[] {
    return nodes.map((node) => {
      const childrenId = `material-icon-children-${encodeURIComponent(node.key)}`;
      const open = iconExpandedKeys.has(node.key);
      if (!node.material) return <li key={node.key} className="material-icon-bucket" role="listitem">
        <div className="material-icon-bucket-heading">
          {node.children.length > 0 && <button type="button" className="material-icon-disclosure" aria-label={`${open ? "收起" : "展开"} ${node.label}`} aria-expanded={open} aria-controls={open ? childrenId : undefined} onClick={() => toggleIconBranch(node.key)}>{open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}</button>}
          <strong>{node.label}</strong><span>{node.children.length} 项</span>
        </div>
        {open && node.children.length > 0 && <ul id={childrenId} className="material-icon-children" role="list" aria-label={`${node.label}的子资料`}>{renderIconNodes(node.children, depth + 1)}</ul>}
      </li>;

      const item = node.material;
      const description = item.description || typeLabels[item.type] || "资料";
      const groupLabel = item.groupPath || item.group || "未分组";
      const parent = resolveMaterial(materials, item.parent);
      const parentLabel = item.parent ? parent?.title ?? `缺失父级：${item.parent}` : "根资料";
      const isComponent = category === "component" || item.type === "component";
      const metadata = isComponent ? componentScopeLabels[componentScope(item)] : typeLabels[item.type] ?? item.type;
      const summaryId = `material-icon-summary-${encodeURIComponent(item.path)}`;
      const accessibleSummary = [
        `类型：${metadata}`, `父级：${parentLabel}`, `所属分组：${groupLabel}`, `层级：第 ${depth + 1} 级`,
        ...(node.contextOnly ? ["路径上下文"] : []), ...(item.description ? [`说明：${item.description}`] : []),
      ].join("；");
      return <li key={node.key} className={`material-icon-node${node.contextOnly ? " context-only" : ""}`} role="listitem" data-material-path={item.path}>
        <div className="material-icon-row">
          {node.children.length > 0 ? <button type="button" className="material-icon-disclosure" aria-label={`${open ? "收起" : "展开"} ${node.label}`} aria-expanded={open} aria-controls={open ? childrenId : undefined} onClick={() => toggleIconBranch(node.key)}>{open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}</button>
            : <span className="material-icon-disclosure-placeholder" aria-hidden="true" />}
          <button type="button" className={`material-item material-icon-card ${selectedPath === item.path ? "selected" : ""}`} aria-label={`查看 ${item.title}`} aria-describedby={summaryId} aria-pressed={selectedPath === item.path} title={item.path} onClick={() => onSelect(item.path)}>
            <span className="material-thumbnail">{item.image ? <MaterialThumbnail api={api} projectPath={projectPath} path={item.image} title={item.title} /> : <FileText size={30} />}</span>
            <span className="material-item-text material-item-text-icons"><strong title={item.title}>{item.title}{node.contextOnly && <small className="material-context-badge">路径上下文</small>}</strong><span title={description}>{description}</span></span>
            <span className="material-card-tags">
              <span className={`material-type-badge${isComponent ? ` material-source-${componentScope(item)}` : ""}`} title={isComponent ? "组件来源" : "资料类型"}>{metadata}</span>
              <span className="material-group-tag" title={groupLabel}>{groupLabel}</span>
            </span>
            <span className="material-icon-parent" title={`父级：${parentLabel}`}>父级：{parentLabel}</span>
            <span id={summaryId} className="material-hierarchy-accessible-summary">{accessibleSummary}</span>
          </button>
        </div>
        {open && node.children.length > 0 && <ul id={childrenId} className="material-icon-children" role="list" aria-label={`${node.label}的子资料`}>{renderIconNodes(node.children, depth + 1)}</ul>}
      </li>;
    });
  }
  return <section className={`material-explorer ${groupPaneOpen ? "group-pane-open" : "group-pane-closed"}`} aria-label="资料浏览器">
    <div className="explorer-toolbar">
      <button type="button" className="group-pane-toggle" aria-label={groupPaneOpen ? "收起分组栏" : "展开分组栏"} aria-expanded={groupPaneOpen} onClick={() => setGroupPaneOpen((open) => !open)}><PanelLeft size={16} /></button>
      <label className="material-search"><Search size={16} /><input aria-label="搜索资料" placeholder="搜索名称、说明或分组" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      {category === "entity" && <select aria-label="筛选实体类型" value={entityType} onChange={(event) => setEntityType(event.target.value)}><option value="*">全部实体类型</option>{entityTypes.map((type) => <option key={type} value={type}>{typeLabels[type]}</option>)}</select>}
      {category === "component" && <select aria-label="组件来源" value={componentSource} onChange={(event) => setComponentSource(event.target.value as ComponentSource)}><option value="*">全部组件</option><option value="system">官方组件</option><option value="user">自定义组件</option></select>}
      <div className="toolbar material-view-controls" role="group" aria-label="资料显示方式"><button type="button" aria-label="图标显示" title="图标显示" aria-pressed={view === "icons"} onClick={() => changeView("icons")}><LayoutGrid size={16} /></button><button type="button" aria-label="列表显示" title="列表显示" aria-pressed={view === "list"} onClick={() => changeView("list")}><List size={16} /></button><button type="button" aria-label="关系图显示" title="关系图显示" aria-pressed={view === "graph"} onClick={() => changeView("graph")}><GitBranch size={16} /></button></div>
    </div>
    <div className="material-explorer-layout">
      <div className="material-group-pane" hidden={!groupPaneOpen} inert={!groupPaneOpen}>
        <MaterialGroupTree groups={groups} materials={materials} selection={selection} onSelect={setSelection} groupsSaving={groupsSaving} onGroupsChange={onGroupsChange} />
      </div>
      <div className="material-results">
        <header className="material-results-heading"><div><h3>{groupTitle}</h3>{selection.kind === "group" && <span className="subtle">{groupTitle}</span>}</div><span className="subtle">{visible.length} 项</span></header>
        {view === "icons" && <ul className="material-items material-items-icons material-icon-tree" role="list" aria-label="资料图标层级">{renderIconNodes(projectedTree, 0)}</ul>}
        {/* Retain panels so switching modes does not repeat selected-path expansion. */}
        <div className="material-view-panel" hidden={view !== "list"} inert={view !== "list"}>
          <MaterialHierarchyList tree={projectedTree} materials={materials} category={category} selectedPath={selectedPath} onSelect={onSelect} expandedKeys={expandedKeys} onExpandedKeysChange={setExpandedKeys} />
        </div>
        <div className="material-view-panel" hidden={view !== "graph" || !visible.length} inert={view !== "graph" || !visible.length}>
          <MaterialRelationshipGraph tree={projectedTree} materials={materials} category={category} selectedPath={selectedPath} onSelect={onSelect} expandedKeys={expandedKeys} onExpandedKeysChange={setExpandedKeys} />
        </div>
        {!visible.length && <div className="empty-state">{loading ? <p>读取资料…</p> : selection.kind === "group" && !selectedGroupHasItems
          ? <p>这是一个空分组。可在左侧为它新建子分组，或在资料详情中分配资料。</p>
          : selection.kind === "ungrouped" && !materials.some((item) => !item.groupId)
            ? <p>目前没有未分组资料。</p>
            : materials.length ? <><p>没有符合条件的资料，可调整搜索或筛选条件。</p>{hasAdditionalFilters && <button type="button" onClick={() => { setQuery(""); setEntityType("*"); setComponentSource("*"); }}>清除其他筛选</button>}</>
              : <p>还没有资料，点击上方新建开始整理。</p>}</div>}
        <p className="explorer-count">{visible.length} 项{query || selection.kind !== "all" || entityType !== "*" || componentSource !== "*" ? ` / 共 ${materials.length} 项` : ""}</p>
      </div>
    </div>
  </section>;
}
