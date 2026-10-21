import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { useI18n } from "./i18n";
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
  const tr = useI18n();
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

  const metadataHeading = category === "component" ? tr("组件来源") : category === "entity" ? tr("实体类型") : tr("类型");
  function renderNodes(nodes: MaterialNode[], depth: number) {
    return nodes.map((node) => {
      const item = node.material;
      const open = expanded.has(node.key);
      const childrenId = `${id}-children-${encodeURIComponent(node.key)}`;
      const metadataId = `${id}-metadata-${encodeURIComponent(node.key)}`;
      const style = { "--hierarchy-depth": Math.min(depth, 8) } as CSSProperties;
      const parent = item ? resolveMaterial(materials, item.parent) : undefined;
      const parentLabel = item?.parent ? parent?.title ?? tr("缺失父级：{parent}", { parent: item.parent }) : tr("根资料");
      const groupLabel = item?.groupPath || item?.group || tr("未分组");
      const metadata = item ? tr(category === "component" || item.type === "component"
        ? componentScopeLabels[componentScope(item)] : typeLabels[item.type] ?? item.type) : "";
      const accessibleSummary = [
        ...(item?.description ? [tr("说明：{value}", { value: item.description })] : []),
        tr("{label}：{value}", { label: metadataHeading, value: metadata }), tr("父级资料：{value}", { value: parentLabel }), tr("所属分组：{value}", { value: groupLabel }),
        tr("层级：第 {level} 级", { level: depth + 1 }), ...(node.contextOnly ? [tr("路径上下文")] : []),
      ].join("；");

      return <li key={node.key} className="material-hierarchy-node" role="listitem">
        <div className={`material-hierarchy-row${node.contextOnly ? " context-only" : ""}${item && selectedPath === item.path ? " selected" : ""}${item ? "" : " material-hierarchy-bucket"}`} style={style} data-material-path={item?.path}>
          {node.children.length > 0 && <button type="button" className="material-hierarchy-disclosure" aria-label={`${open ? tr("收起") : tr("展开")} ${node.label}`} aria-expanded={open} aria-controls={open ? childrenId : undefined} onClick={() => toggle(node.key)}>
            {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
          </button>}
          {item ? <button type="button" className="material-hierarchy-choice" aria-label={tr("查看 {title}", { title: item.title })} aria-pressed={selectedPath === item.path} aria-describedby={metadataId} title={item.path} onClick={() => onSelect(item.path)}>
            <span className="material-hierarchy-name"><span className="material-hierarchy-title"><strong>{item.title}</strong>{node.contextOnly && <small className="material-context-badge">{tr("路径上下文")}</small>}</span>{item.description && <span className="material-hierarchy-description" title={item.description}>{item.description}</span>}</span>
            <span className="material-hierarchy-metadata" data-label={metadataHeading}><span className={`material-type-badge${item.type === "component" ? ` material-source-${componentScope(item)}` : ""}`}>{metadata}</span></span>
            <span className="material-hierarchy-parent" data-label={tr("父级资料")} title={item.parent ?? tr("根资料")}>{parentLabel}</span>
            <span className="material-hierarchy-group" data-label={tr("所属分组")} title={groupLabel}>{groupLabel}</span>
            <span id={metadataId} className="material-hierarchy-accessible-summary">{accessibleSummary}</span>
          </button> : <span className="material-hierarchy-bucket-label">{tr(node.label)}</span>}
        </div>
        {open && node.children.length > 0 && <ul id={childrenId} className="material-hierarchy-children" role="list" aria-label={tr("{label}的子资料", { label: node.label })}>{renderNodes(node.children, depth + 1)}</ul>}
      </li>;
    });
  }

  return <div className="material-hierarchy-list">
    <div id={`${id}-columns`} className="material-hierarchy-header" role="group" aria-label={tr("资料列说明")}><span>{tr("名称与说明")}</span><span>{metadataHeading}</span><span>{tr("父级资料")}</span><span>{tr("所属分组")}</span></div>
    <ul className="material-hierarchy-roots" role="list" aria-label={tr("资料列表")} aria-describedby={`${id}-columns`}>{renderNodes(tree, 0)}</ul>
  </div>;
}
