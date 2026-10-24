import { Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "@xyflow/react/dist/style.css";
import { Background, Controls, MiniMap, ReactFlow, type Edge, type Node } from "@xyflow/react";
import type { FileReadResult } from "../shared/contracts";
import type { DesktopApi } from "../shared/desktop-api";
import { bindingIdentity, parseMaterial, readBindings, writeMaterial, type ComponentBinding, type ComponentValue } from "../shared/project-materials";
import { withInheritedComponentFields } from "../shared/component-inheritance";
import { summarizeMaterial, type MaterialSummary } from "../shared/material-catalog";
import { categoryForPath } from "./materials-model";
import { COMPONENT_CARD_SIZE, type EntityPoint } from "./entity-layout";
import { SYSTEM_NODE_ID, autoSystemPositions, loadSystemLayout, saveSystemLayout } from "./system-layout";
import { ComponentBrowserDialog, type BrowserEntry } from "./ComponentBrowserDialog";
import { useI18n } from "./i18n";
import "./system-workbench.css";

interface SystemWorkbenchProps {
  api: DesktopApi;
  projectPath: string;
  onError?: (error: unknown) => void;
  onOpenDetail?: (path: string) => void;
}

function describeError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

function bindingKey(binding: ComponentBinding): string {
  return bindingIdentity(binding.id, binding.key);
}

/**
 * System workbench: mounts components (decision trees included) on one system,
 * edits their values on a canvas, and writes the `mounts` list back.
 */
export function SystemWorkbench({ api, projectPath, onError, onOpenDetail }: SystemWorkbenchProps) {
  const tr = useI18n();
  const [files, setFiles] = useState<FileReadResult[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [selectedPath, setSelectedPath] = useState<string>();
  const [selectedMount, setSelectedMount] = useState<string>();
  const [layout, setLayout] = useState<Record<string, Record<string, EntityPoint>>>(() => loadSystemLayout(projectPath));
  const [browserOpen, setBrowserOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "saved"; text: string }>();
  const mountedRef = useRef(true);
  const requestRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; requestRef.current++; };
  }, []);

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    setMessage(undefined);
    try {
      const listed = await api.documents();
      const targets = listed.filter((document) => ["system", "component", "decision_tree"].includes(categoryForPath(document.path) ?? ""));
      const reads = await Promise.all(targets.map(async (document) => {
        try { return await api.readDocument(document.path, document.version); } catch { return undefined; }
      }));
      if (!mountedRef.current || request !== requestRef.current) return;
      setFiles(reads.filter((item): item is FileReadResult => item !== undefined));
    } catch (error) {
      if (mountedRef.current && request === requestRef.current) setMessage({ kind: "error", text: describeError(error, tr("读取系统资料失败，请刷新重试。")) });
      onError?.(error);
    } finally {
      if (mountedRef.current && request === requestRef.current) setLoading(false);
    }
  }, [api, onError, tr]);

  useEffect(() => { void refresh(); return () => { requestRef.current++; }; }, [refresh]);

  useEffect(() => {
    setLayout(loadSystemLayout(projectPath));
    setSelectedPath(undefined);
    setSelectedMount(undefined);
    setDrafts({});
  }, [projectPath]);

  useEffect(() => { saveSystemLayout(projectPath, layout); }, [layout, projectPath]);

  const components = useMemo(() => {
    const summaries = files
      .filter((file) => categoryForPath(file.path) === "component")
      .map((file) => summarizeMaterial({ path: file.path, version: file.version, content: drafts[file.path] ?? file.content }))
      .filter((item) => !item.invalid && item.type === "component");
    return withInheritedComponentFields(summaries);
  }, [files, drafts]);

  const decisionTrees = useMemo(() => files
    .filter((file) => categoryForPath(file.path) === "decision_tree")
    .map((file) => summarizeMaterial({ path: file.path, version: file.version, content: drafts[file.path] ?? file.content }))
    .filter((item) => !item.invalid), [files, drafts]);

  const systems = useMemo(() => files
    .filter((file) => categoryForPath(file.path) === "system")
    .map((file) => summarizeMaterial({ path: file.path, version: file.version, content: drafts[file.path] ?? file.content }))
    .filter((item) => !item.invalid), [files, drafts]);

  const systemFile = files.find((file) => file.path === selectedPath);
  const system = systems.find((item) => item.path === selectedPath);
  const content = systemFile ? drafts[systemFile.path] ?? systemFile.content : "";
  const parsed = useMemo(() => parseMaterial(content), [content]);
  const data = parsed?.data ?? {};
  const mounts = useMemo(() => readBindings({ components: Array.isArray(data.mounts) ? data.mounts : [] }), [data]);
  const dirty = Boolean(systemFile && drafts[systemFile.path] !== undefined && drafts[systemFile.path] !== systemFile.content);

  const componentOf = (binding: ComponentBinding) => components.find((item) => item.id === binding.id);

  const writeMounts = (next: ComponentBinding[]) => {
    if (!systemFile) return;
    const serialized = next.map((binding) => ({
      id: binding.id,
      ...(binding.key ? { key: binding.key } : {}),
      values: binding.values,
      ...(binding.mount ? { mount: binding.mount } : {}),
    }));
    const nextData = { ...data, mounts: serialized };
    setDrafts((current) => ({ ...current, [systemFile.path]: writeMaterial(nextData, parsed?.body ?? "") }));
    setMessage(undefined);
  };

  const updateValue = (identity: string, key: string, value: ComponentValue) => writeMounts(mounts.map((binding) =>
    bindingKey(binding) === identity ? { ...binding, values: { ...binding.values, [key]: value } } : binding));

  const renameKey = (identity: string, key: string) => {
    const trimmed = key.trim().toLowerCase();
    if (trimmed && !/^[a-z][a-z0-9_]*$/.test(trimmed)) return;
    if (trimmed && mounts.some((binding) => bindingKey(binding) === identity ? false : binding.key === trimmed)) return;
    writeMounts(mounts.map((binding) => bindingKey(binding) === identity
      ? { ...binding, ...(trimmed ? { key: trimmed } : {}) } as ComponentBinding
      : binding));
  };

  const removeMount = (identity: string) => {
    writeMounts(mounts.filter((binding) => bindingKey(binding) !== identity));
    setSelectedMount(undefined);
  };

  const addMount = (component: MaterialSummary) => {
    const used = new Set(mounts.map((binding) => bindingKey(binding)));
    let index = 1;
    let key = `${component.id}_${index}`;
    while (used.has(bindingIdentity(component.id, key))) { index++; key = `${component.id}_${index}`; }
    const values = Object.fromEntries(component.fields.map((field) => [field.key, field.default]));
    const next: ComponentBinding = { id: component.id, key, values };
    writeMounts([...mounts, next]);
    setSelectedMount(bindingKey(next));
    setBrowserOpen(false);
  };

  const selected = mounts.find((binding) => bindingKey(binding) === selectedMount);
  const selectedComponent = selected ? componentOf(selected) : undefined;

  const cards = useMemo(() => mounts.map((binding) => {
    const parent = binding.mount?.parent;
    const parentCard = parent ? mounts.find((item) => item.id === parent || item.key === parent) : undefined;
    return {
      id: bindingKey(binding),
      size: COMPONENT_CARD_SIZE,
      ...(parentCard ? { parent: bindingKey(parentCard) } : {}),
    };
  }), [mounts]);
  const auto = useMemo(() => autoSystemPositions(cards), [cards]);

  const positions = selectedPath ? layout[selectedPath] ?? {} : {};
  const nodes: Node[] = useMemo(() => {
    if (!system) return [];
    const systemNode: Node = {
      id: SYSTEM_NODE_ID,
      position: positions[SYSTEM_NODE_ID] ?? { x: 0, y: 0 },
      data: { label: `${system.title}\n${system.id}` },
      className: "swb-node swb-system",
      type: "default",
    };
    const mountNodes = mounts.map((binding) => {
      const component = componentOf(binding);
      const identity = bindingKey(binding);
      return {
        id: identity,
        position: positions[identity] ?? auto[identity] ?? { x: 0, y: 0 },
        data: { label: `${component?.title ?? binding.id}\n${binding.key ?? binding.id}` },
        className: `swb-node swb-mount${selectedMount === identity ? " is-selected" : ""}`,
        type: "default",
      } as Node;
    });
    return [systemNode, ...mountNodes];
  }, [system, mounts, components, positions, auto, selectedMount]);

  const edges: Edge[] = useMemo(() => mounts.map((binding) => {
    const identity = bindingKey(binding);
    const parent = binding.mount?.parent;
    const parentCard = parent ? mounts.find((item) => item.id === parent || item.key === parent) : undefined;
    return {
      id: `${parentCard ? bindingKey(parentCard) : SYSTEM_NODE_ID}->${identity}`,
      source: parentCard ? bindingKey(parentCard) : SYSTEM_NODE_ID,
      target: identity,
      label: binding.mount?.anchor ? binding.mount.anchor : parent && !parentCard ? tr("缺失父级：{parent}", { parent }) : tr("挂载"),
    } as Edge;
  }), [mounts, tr]);

  const save = async () => {
    if (!systemFile || !dirty || saving) return;
    setSaving(true);
    setMessage(undefined);
    try {
      const saved = await api.saveDocument(projectPath, systemFile.path, drafts[systemFile.path] ?? systemFile.content, systemFile.version);
      if (!mountedRef.current) return;
      setFiles((current) => current.map((file) => file.path === saved.path ? saved : file));
      setDrafts((current) => {
        const next = { ...current };
        delete next[saved.path];
        return next;
      });
      setMessage({ kind: "saved", text: tr("已保存") });
    } catch (error) {
      if (mountedRef.current) setMessage({ kind: "error", text: describeError(error, tr("保存系统资料失败，请重试。")) });
      onError?.(error);
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  const moveNode = (id: string, point: EntityPoint) => {
    if (!selectedPath) return;
    setLayout((current) => ({
      ...current,
      [selectedPath]: { ...(current[selectedPath] ?? {}), [id]: point },
    }));
  };

  const browserEntries = useMemo<BrowserEntry[]>(() => components.map((component) => {
    const parsedComponent = parseMaterial(component.content);
    const notes = Array.isArray(parsedComponent?.data.notes) ? parsedComponent!.data.notes.filter((note): note is string => typeof note === "string") : [];
    return {
      path: component.path,
      id: component.id,
      title: component.title,
      ...(component.description ? { description: component.description } : {}),
      ...(parsedComponent?.body ? { body: parsedComponent.body } : {}),
      ...(notes.length ? { notes } : {}),
      ...(component.extends ? { extendsRef: component.extends } : {}),
      ...(component.scope ? { scope: component.scope } : {}),
      fields: component.fields,
      ...(component.groupPath ? { groupLabel: component.groupPath } : component.group ? { groupLabel: component.group } : {}),
      status: mounts.some((binding) => binding.id === component.id) ? "added" : "available",
    } as BrowserEntry;
  }), [components, mounts]);

  return <section className="swb" aria-label={tr("系统工作台")}>
    <aside className="swb-systems" aria-label={tr("系统列表")}>
      <header>
        <h2>{tr("系统")}</h2>
        <button type="button" aria-label={tr("刷新")} title={tr("刷新")} disabled={loading} onClick={() => void refresh()}><RefreshCw size={14} /></button>
      </header>
      {systems.length ? <ul>{systems.map((item) => <li key={item.path}>
        <button type="button" aria-pressed={selectedPath === item.path} className={selectedPath === item.path ? "is-selected" : ""} onClick={() => { setSelectedPath(item.path); setSelectedMount(undefined); }}>
          <strong>{item.title}</strong><code>{item.id}</code>
          {item.scope === "system" && <span className="swb-badge">{tr("官方")}</span>}
        </button>
      </li>)}</ul> : <p className="subtle">{loading ? tr("读取资料…") : tr("还没有系统资料。")}</p>}
    </aside>
    <div className="swb-canvas">
      {system ? <>
        <header className="swb-toolbar">
          <strong>{system.title}</strong>
          <span className="subtle">{dirty ? tr("未保存") : message?.kind === "saved" ? tr("已保存") : tr("已加载")}</span>
          <button type="button" onClick={() => setBrowserOpen(true)}><Plus size={15} />{tr("添加挂载")}</button>
          <button type="button" onClick={() => setLayout((current) => ({ ...current, [system.path]: autoSystemPositions(cards) }))}>{tr("自动整理")}</button>
          <button type="button" className="primary" disabled={!dirty || saving} onClick={() => void save()}><Save size={15} />{saving ? tr("保存中…") : tr("保存")}</button>
        </header>
        {message?.kind === "error" && <p role="alert" className="swb-error">{message.text}</p>}
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodeClick={(_event, node) => { if (node.id !== SYSTEM_NODE_ID) setSelectedMount(node.id); }}
          onPaneClick={() => setSelectedMount(undefined)}
          onNodeDragStop={(_event, node) => moveNode(node.id, { x: Math.round(node.position.x), y: Math.round(node.position.y) })}
          fitView
          minZoom={0.3}
          maxZoom={1.6}
          nodesConnectable={false}
        >
          <Background />
          <MiniMap pannable zoomable />
          <Controls showInteractive={false} />
        </ReactFlow>
      </> : <div className="swb-empty">{loading ? tr("读取资料…") : tr("选择左侧系统开始挂载组件。")}</div>}
    </div>
    <aside className="swb-inspector" aria-label={tr("系统挂载检查器")}>
      {!selected ? <p className="subtle">{system ? tr("点击画布中的挂载卡片编辑参数。") : tr("先选择一个系统。")}</p> : <>
        <header>
          <h3>{selectedComponent?.title ?? selected.id}</h3>
          {onOpenDetail && <button type="button" onClick={() => onOpenDetail(selectedComponent?.path ?? system?.path ?? "")}>{tr("详情")}</button>}
          <button type="button" aria-label={tr("移除挂载")} onClick={() => removeMount(bindingKey(selected))}><Trash2 size={15} /></button>
        </header>
        <label>{tr("实例 key")}<input aria-label={tr("挂载 key")} maxLength={64} defaultValue={selected.key ?? ""} onBlur={(event) => renameKey(bindingKey(selected), event.target.value)} /></label>
        {selected.id === "decision_tree" && <label>{tr("决策树")}<select aria-label={tr("挂载决策树")} value={String(selected.values.tree ?? "")} onChange={(event) => updateValue(bindingKey(selected), "tree", event.target.value)}>
          <option value="">{tr("选择决策树")}</option>
          {decisionTrees.map((tree) => <option key={tree.id} value={tree.id}>{tree.title}</option>)}
        </select></label>}
        {(selectedComponent?.fields ?? []).filter((field) => !(selected.id === "decision_tree" && field.key === "tree")).map((field) => <label key={field.key}>
          {field.label || field.key}
          {field.type === "boolean"
            ? <input type="checkbox" aria-label={`${selectedComponent?.title ?? selected.id} ${field.key}`} checked={Boolean(selected.values[field.key] ?? field.default)} onChange={(event) => updateValue(bindingKey(selected), field.key, event.target.checked)} />
            : <input
              aria-label={`${selectedComponent?.title ?? selected.id} ${field.key}`}
              type={field.type === "number" ? "number" : "text"}
              value={String(selected.values[field.key] ?? field.default ?? "")}
              onChange={(event) => updateValue(bindingKey(selected), field.key, field.type === "number" ? Number(event.target.value) : event.target.value)}
            />}
        </label>)}
        {!selectedComponent && <p className="swb-error">{tr("组件定义不存在：{id}", { id: selected.id })}</p>}
        {selected.mount && <p className="subtle">{tr("挂载于 {parent} · {anchor}", { parent: selected.mount.parent, anchor: selected.mount.anchor })}</p>}
      </>}
    </aside>
    {browserOpen && <ComponentBrowserDialog
      title="添加组件"
      pickLabel="添加"
      entries={browserEntries}
      projectPath={projectPath}
      recentPrefix="specloom.system-workbench.recent-components."
      favoritePrefix="specloom.system-workbench.favorite-components."
      onPick={(entry) => {
        const component = components.find((item) => item.id === entry.id);
        if (component) addMount(component);
      }}
      onClose={() => setBrowserOpen(false)}
      emptyHint={tr("还没有组件，请先在组件页新建。")}
    />}
  </section>;
}
