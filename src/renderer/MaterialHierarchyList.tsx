import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { componentScope, componentScopeLabels, resolveMaterial, type DocumentCategory, type MaterialNode, type MaterialSummary } from "./materials-model";
import "./navigation-materials.css";

export interface MaterialHierarchyListProps {
  tree: MaterialNode[];
  materials: MaterialSummary[];
  category?: DocumentCategory | undefined;
  selectedPath?: string | undefined;
  onSelect: (path: string) => void;
  expandedKeys?: ReadonlySet<string> | undefined;
  onExpandedKeysChange?: ((next: Set<string>) => void) | undefined;
}

const typeLabels: Record<string, string> = {
  entity: "通用实体", character: "角色", enemy: "敌人", item: "物品", system: "系统", event: "事件",
  component: "组件", setting: "设定", map: "地图", ui: "UI", spec: "规范",
};

function selectedAncestors(tree: MaterialNode[], selectedPath: string | undefined): string[] {
  if (!selectedPath) return [];
  function find(nodes: MaterialNode[], ancestors: string[]): string[] | undefined {
    for (const node of nodes) {
      if (node.material?.path === selectedPath) return ancestors;
      const found = find(node.children, [...ancestors, node.key]);
      if (found) return found;
    }
    return undefined;
  }
  return find(tree, []) ?? [];
}

export function MaterialHierarchyList({ tree, materials, category, selectedPath, onSelect, expandedKeys, onExpandedKeysChange }: MaterialHierarchyListProps) {
  const id = useId();
  const ancestors = useMemo(() => selectedAncestors(tree, selectedPath), [tree, selectedPath]);
  const rootBranches = tree.filter((node) => node.children.length > 0).map((node) => node.key);
  const [localExpanded, setLocalExpanded] = useState(() => new Set([
    ...rootBranches, ...ancestors,
  ]));
  const knownRoots = useRef(new Set(rootBranches));
  const expanded = expandedKeys ?? localExpanded;
  const expansion = useRef({ expanded, ancestors, rootBranches, onExpandedKeysChange, controlled: expandedKeys !== undefined });
  expansion.current = { expanded, ancestors, rootBranches, onExpandedKeysChange, controlled: expandedKeys !== undefined };
  const ancestorSignature = JSON.stringify(ancestors);
  const rootSignature = JSON.stringify(rootBranches);

  useEffect(() => {
    const current = expansion.current;
    const newRoots = current.rootBranches.filter((key) => !knownRoots.current.has(key));
    for (const key of newRoots) knownRoots.current.add(key);
    if (!current.controlled && newRoots.length) setLocalExpanded((previous) => new Set([...previous, ...newRoots]));
  }, [rootSignature]);

  useEffect(() => {
    const current = expansion.current;
    const keys = current.ancestors;
    if (keys.every((key) => current.expanded.has(key))) return;
    const next = new Set(current.expanded);
    for (const key of keys) next.add(key);
    if (!current.controlled) setLocalExpanded((previous) => new Set([...previous, ...keys]));
    current.onExpandedKeysChange?.(next);
  }, [selectedPath, ancestorSignature]);

  function toggle(key: string) {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key); else next.add(key);
    if (expandedKeys === undefined) setLocalExpanded(next);
    onExpandedKeysChange?.(next);
  }

  const metadataHeading = category === "component" ? "组件来源" : category === "entity" ? "实体类型" : "类型";
  function renderNodes(nodes: MaterialNode[], depth: number) {
    return nodes.map((node) => {
      const item = node.material;
      const open = expanded.has(node.key);
      const childrenId = `${id}-children-${encodeURIComponent(node.key)}`;
      const metadataId = `${id}-metadata-${encodeURIComponent(node.key)}`;
      const style = { "--hierarchy-depth": Math.min(depth, 8) } as CSSProperties;
      const parent = item ? resolveMaterial(materials, item.parent) : undefined;
      const parentLabel = item?.parent ? parent?.title ?? `缺失父级：${item.parent}` : "根资料";
      const groupLabel = item?.groupPath || item?.group || "未分组";
      const metadata = item ? category === "component" || item.type === "component"
        ? componentScopeLabels[componentScope(item)] : typeLabels[item.type] ?? item.type : "";
      const accessibleSummary = [
        ...(item?.description ? [`说明：${item.description}`] : []),
        `${metadataHeading}：${metadata}`, `父级资料：${parentLabel}`, `所属分组：${groupLabel}`,
        `层级：第 ${depth + 1} 级`, ...(node.contextOnly ? ["路径上下文"] : []),
      ].join("；");

      return <li key={node.key} className="material-hierarchy-node" role="listitem">
        <div className={`material-hierarchy-row${node.contextOnly ? " context-only" : ""}${item && selectedPath === item.path ? " selected" : ""}${item ? "" : " material-hierarchy-bucket"}`} style={style} data-material-path={item?.path}>
          {node.children.length > 0 && <button type="button" className="material-hierarchy-disclosure" aria-label={`${open ? "收起" : "展开"} ${node.label}`} aria-expanded={open} aria-controls={open ? childrenId : undefined} onClick={() => toggle(node.key)}>
            {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
          </button>}
          {item ? <button type="button" className="material-hierarchy-choice" aria-label={`查看 ${item.title}`} aria-pressed={selectedPath === item.path} aria-describedby={metadataId} title={item.path} onClick={() => onSelect(item.path)}>
            <span className="material-hierarchy-name"><span className="material-hierarchy-title"><strong>{item.title}</strong>{node.contextOnly && <small className="material-context-badge">路径上下文</small>}</span>{item.description && <span className="material-hierarchy-description" title={item.description}>{item.description}</span>}</span>
            <span className="material-hierarchy-metadata" data-label={metadataHeading}><span className={`material-type-badge${item.type === "component" ? ` material-source-${componentScope(item)}` : ""}`}>{metadata}</span></span>
            <span className="material-hierarchy-parent" data-label="父级资料" title={item.parent ?? "根资料"}>{parentLabel}</span>
            <span className="material-hierarchy-group" data-label="所属分组" title={groupLabel}>{groupLabel}</span>
            <span id={metadataId} className="material-hierarchy-accessible-summary">{accessibleSummary}</span>
          </button> : <span className="material-hierarchy-bucket-label">{node.label}</span>}
        </div>
        {open && node.children.length > 0 && <ul id={childrenId} className="material-hierarchy-children" role="list" aria-label={`${node.label}的子资料`}>{renderNodes(node.children, depth + 1)}</ul>}
      </li>;
    });
  }

  return <div className="material-hierarchy-list">
    <div id={`${id}-columns`} className="material-hierarchy-header" role="group" aria-label="资料列说明"><span>名称与说明</span><span>{metadataHeading}</span><span>父级资料</span><span>所属分组</span></div>
    <ul className="material-hierarchy-roots" role="list" aria-label="资料列表" aria-describedby={`${id}-columns`}>{renderNodes(tree, 0)}</ul>
  </div>;
}
