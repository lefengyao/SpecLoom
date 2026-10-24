import { ChevronDown, ChevronRight, Puzzle, Search, Star, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ComponentField } from "../shared/project-materials";
import { useI18n } from "./i18n";
import "./entity-workbench.css";

export type BrowserEntryStatus = "available" | "added" | "inherited";

export interface BrowserEntry {
  path: string;
  id: string;
  title: string;
  description?: string;
  body?: string;
  notes?: string[];
  extendsRef?: string;
  scope?: "system" | "user";
  fields: ComponentField[];
  groupLabel?: string;
  groupOrder?: number;
  status: BrowserEntryStatus;
}

interface BrowserSection {
  key: string;
  label: string;
  order: number;
  nodes: { entry: BrowserEntry; depth: number }[];
}

export interface ComponentBrowserDialogProps {
  title: string;
  pickLabel: string;
  entries: BrowserEntry[];
  projectPath: string;
  recentPrefix: string;
  favoritePrefix: string;
  onPick: (entry: BrowserEntry) => void;
  onClose: () => void;
  disabled?: boolean;
  emptyHint?: string;
}

const fieldTypeLabels: Record<ComponentField["type"], string> = { number: "数值", string: "文本", boolean: "布尔" };

function loadPaths(prefix: string, projectPath: string): string[] {
  try {
    const raw = window.localStorage.getItem(`${prefix}${projectPath.trim()}`);
    if (!raw) return [];
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((path): path is string => typeof path === "string" && path.length > 0).slice(0, 32) : [];
  } catch { return []; }
}

function savePaths(prefix: string, projectPath: string, paths: string[]): void {
  try { window.localStorage.setItem(`${prefix}${projectPath.trim()}`, JSON.stringify(paths.slice(0, 32))); } catch { /* best effort */ }
}

function formatDefault(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/**
 * Shared component browser used by the entity and system workbenches: favorites,
 * recents, search, status filter, grouped list with inheritance nesting, details.
 */
export function ComponentBrowserDialog({
  title, pickLabel, entries, projectPath, recentPrefix, favoritePrefix, onPick, onClose, disabled = false, emptyHint,
}: ComponentBrowserDialogProps) {
  const tr = useI18n();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "available" | "added" | "inherited">("all");
  const [selectedPath, setSelectedPath] = useState<string>();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [recent, setRecent] = useState<string[]>(() => loadPaths(recentPrefix, projectPath));
  const [favorites, setFavorites] = useState<string[]>(() => loadPaths(favoritePrefix, projectPath));

  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [onClose]);

  const visible = useMemo(() => {
    const text = query.trim().toLowerCase();
    return entries.filter((entry) => {
      if (filter === "available" && entry.status !== "available") return false;
      if (filter === "added" && entry.status !== "added") return false;
      if (filter === "inherited" && entry.status !== "inherited") return false;
      if (!text) return true;
      return `${entry.title} ${entry.id} ${entry.path} ${entry.description ?? ""} ${entry.groupLabel ?? ""}`.toLowerCase().includes(text);
    });
  }, [entries, filter, query]);

  const sections = useMemo<BrowserSection[]>(() => {
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const resolve = (reference: string): BrowserEntry | undefined => byPath.get(reference) ?? byPath.get(`${reference}.md`) ?? byId.get(reference) ?? byId.get(reference.replace(/^res:\/\//, "").replace(/\.md$/, ""));
    const groups = new Map<string, { key: string; label: string; order: number; items: BrowserEntry[] }>();
    for (const entry of visible) {
      const label = entry.groupLabel?.trim() || tr("未分组");
      const bucket = groups.get(label) ?? { key: label, label, order: entry.groupOrder ?? 9999, items: [] };
      bucket.items.push(entry);
      groups.set(label, bucket);
    }
    const byTitle = (left: BrowserEntry, right: BrowserEntry) => left.title.localeCompare(right.title) || left.path.localeCompare(right.path);
    const result: BrowserSection[] = [];
    for (const group of [...groups.values()].sort((left, right) => left.order - right.order || left.label.localeCompare(right.label))) {
      const inGroup = new Set(group.items.map((entry) => entry.path));
      const children = new Map<string, BrowserEntry[]>();
      const isChild = new Set<string>();
      for (const entry of group.items) {
        const base = entry.extendsRef ? resolve(entry.extendsRef) : undefined;
        if (!base || base.path === entry.path || !inGroup.has(base.path)) continue;
        children.set(base.path, [...(children.get(base.path) ?? []), entry]);
        isChild.add(entry.path);
      }
      const nodes: BrowserSection["nodes"] = [];
      const push = (entry: BrowserEntry, depth: number, seen: Set<string>) => {
        if (seen.has(entry.path) || depth > 12) return;
        seen.add(entry.path);
        nodes.push({ entry, depth });
        for (const child of [...(children.get(entry.path) ?? [])].sort(byTitle)) push(child, depth + 1, seen);
      };
      for (const root of group.items.filter((entry) => !isChild.has(entry.path)).sort(byTitle)) push(root, 0, new Set());
      if (!nodes.length) for (const entry of [...group.items].sort(byTitle)) nodes.push({ entry, depth: 0 });
      result.push({ key: group.key, label: group.label, order: group.order, nodes });
    }
    return result;
  }, [visible, entries, tr]);

  const selected = entries.find((entry) => entry.path === selectedPath);
  const favoriteItems = favorites.map((path) => entries.find((entry) => entry.path === path)).filter((entry): entry is BrowserEntry => Boolean(entry));
  const recentItems = recent.map((path) => entries.find((entry) => entry.path === path)).filter((entry): entry is BrowserEntry => Boolean(entry));
  const isFavorite = favoriteItems.some((entry) => entry.path === selectedPath);

  const pick = (entry: BrowserEntry | undefined) => {
    if (!entry || disabled || entry.status === "added") return;
    setRecent((current) => {
      const next = [entry.path, ...current.filter((item) => item !== entry.path)].slice(0, 16);
      savePaths(recentPrefix, projectPath, next);
      return next;
    });
    onPick(entry);
  };

  return <div className="ewb-create-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="ewb-create-dialog" role="dialog" aria-modal="true" aria-label={tr(title)}>
      <header className="ewb-create-head">
        <h2>{tr(title)}</h2>
        <button type="button" className="ewb-drawer-close" aria-label={tr("关闭")} title={tr("关闭")} onClick={onClose}><X size={16} /></button>
      </header>
      <div className="ewb-create-body">
        <aside className="ewb-create-side">
          <section>
            <h3>{tr("收藏")}</h3>
            {favoriteItems.length ? <ul>{favoriteItems.map((entry) => (
              <li key={entry.path}><button type="button" className={selectedPath === entry.path ? "is-selected" : ""} onClick={() => setSelectedPath(entry.path)}>{entry.title}</button></li>
            ))}</ul> : <p className="ewb-empty">{tr("暂无收藏")}</p>}
          </section>
          <section>
            <h3>{tr("最近使用")}</h3>
            {recentItems.length ? <ul>{recentItems.map((entry) => (
              <li key={entry.path}><button type="button" className={selectedPath === entry.path ? "is-selected" : ""} onClick={() => setSelectedPath(entry.path)}>{entry.title}</button></li>
            ))}</ul> : <p className="ewb-empty">{tr("暂无最近使用")}</p>}
          </section>
        </aside>
        <div className="ewb-create-main">
          <div className="ewb-create-search">
            <Search size={16} aria-hidden="true" />
            <input autoFocus aria-label={tr("搜索组件")} placeholder={tr("搜索组件")} value={query} onChange={(event) => setQuery(event.target.value)} />
            <button
              type="button"
              className="ewb-create-star"
              aria-label={isFavorite ? tr("取消收藏") : tr("收藏")}
              aria-pressed={isFavorite}
              disabled={!selected}
              onClick={() => {
                if (!selectedPath) return;
                setFavorites((current) => {
                  const next = current.includes(selectedPath) ? current.filter((item) => item !== selectedPath) : [selectedPath, ...current];
                  savePaths(favoritePrefix, projectPath, next);
                  return next;
                });
              }}
            ><Star size={16} fill={isFavorite ? "currentColor" : "none"} /></button>
          </div>
          <div className="ewb-create-match">
            <span>{tr("匹配项")} · {visible.length}</span>
            <label className="ewb-create-filter">
              {tr("筛选")}
              <select aria-label={tr("筛选")} value={filter} onChange={(event) => setFilter(event.target.value as "all" | "available" | "added" | "inherited")}>
                <option value="all">{tr("全部")}</option>
                <option value="available">{tr("未添加")}</option>
                <option value="inherited">{tr("已继承")}</option>
                <option value="added">{tr("已添加")}</option>
              </select>
            </label>
          </div>
          <ul className="ewb-create-list" aria-label={tr("组件列表")}>
            {sections.map((section) => (
              <li key={section.key} className="ewb-create-group">
                <button
                  type="button"
                  className="ewb-create-group-head"
                  aria-expanded={!collapsed.has(section.key)}
                  onClick={() => setCollapsed((current) => {
                    const next = new Set(current);
                    if (next.has(section.key)) next.delete(section.key); else next.add(section.key);
                    return next;
                  })}
                >
                  {collapsed.has(section.key) ? <ChevronRight size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
                  <span>{section.label}</span><span>{section.nodes.length}</span>
                </button>
                {!collapsed.has(section.key) && <ul>
                  {section.nodes.map(({ entry, depth }) => {
                    const base = entry.extendsRef ? entries.find((item) => item.path === entry.extendsRef || item.id === entry.extendsRef) : undefined;
                    const inheritance = entry.extendsRef ? tr("继承自 {source}", { source: base?.title ?? entry.extendsRef }) : undefined;
                    return <li key={entry.path}>
                      <button
                        type="button"
                        className={"ewb-create-item" + (selectedPath === entry.path ? " is-selected" : "")}
                        data-depth={depth}
                        style={{ paddingLeft: `${20 + depth * 16}px` }}
                        title={[entry.description, inheritance, entry.path].filter(Boolean).join("\n")}
                        onClick={() => setSelectedPath(entry.path)}
                        onDoubleClick={() => pick(entry)}
                      >
                        <Puzzle size={14} aria-hidden="true" />
                        <span className="ewb-create-item-title">{entry.title}</span>
                        {entry.status !== "available" && <span className={"ewb-badge" + (entry.status === "added" ? " is-own" : "")}>{entry.status === "added" ? tr("已添加") : tr("已继承")}</span>}
                      </button>
                    </li>;
                  })}
                </ul>}
              </li>
            ))}
          </ul>
          {visible.length === 0 && <p className="ewb-empty">{entries.length ? tr("没有匹配的组件") : emptyHint ?? tr("还没有组件。可在项目资料的组件页新建组件。")}</p>}
          <section className="ewb-create-description" aria-label={tr("描述")}>
            <h3>{tr("描述")}</h3>
            {selected ? <>
              <div className="ewb-create-description-head"><strong>{selected.title}</strong><code>{selected.path}</code></div>
              {selected.description && <p>{selected.description}</p>}
              {selected.notes?.length ? <ul className="ewb-component-note-list">{selected.notes.map((note, index) => <li key={index}>{note}</li>)}</ul> : null}
              {selected.body && <pre className="ewb-create-body-text">{selected.body}</pre>}
              <dl>
                {selected.groupLabel && <div><dt>{tr("分组")}</dt><dd>{selected.groupLabel}</dd></div>}
                {selected.extendsRef && <div><dt>{tr("继承")}</dt><dd>{entries.find((item) => item.path === selected.extendsRef || item.id === selected.extendsRef)?.title ?? selected.extendsRef}</dd></div>}
                <div><dt>{tr("ID")}</dt><dd>{selected.id}</dd></div>
                <div><dt>{tr("范围")}</dt><dd>{selected.scope === "system" ? tr("系统") : tr("用户")}</dd></div>
                <div><dt>{tr("字段")}</dt><dd>{selected.fields.length}</dd></div>
              </dl>
              {selected.fields.length > 0 && <ul className="ewb-create-fields">
                {selected.fields.map((field) => <li key={field.key}>
                  <code>{field.key}</code>
                  <span>{field.label ?? field.key}</span>
                  <span>{tr(fieldTypeLabels[field.type])} · {tr("默认")} {formatDefault(field.default)}</span>
                </li>)}
              </ul>}
            </> : <p className="ewb-empty">{tr("选择一个组件查看描述")}</p>}
          </section>
        </div>
      </div>
      <footer className="ewb-create-actions">
        <button type="button" className="primary" disabled={disabled || !selected || selected.status === "added"} onClick={() => pick(selected)}>{tr(pickLabel)}</button>
        <button type="button" onClick={onClose}>{tr("取消")}</button>
      </footer>
    </section>
  </div>;
}
