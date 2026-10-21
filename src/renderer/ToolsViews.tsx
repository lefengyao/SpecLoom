import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopApi } from "../shared/desktop-api";
import type { HookDefinition, HookEvent } from "../shared/hooks";
import type { OfflineDocumentBundle } from "../shared/offline-documents";
import type { ChatSession } from "../shared/chat";
export { AboutView } from "./AboutView";
import { useStateChangeRefresh } from "./useWorkspace";
import { useI18n } from "./i18n";

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function OfflineDocsView({ api, onError }: { api: DesktopApi; onError: (error: unknown) => void }) {
  const tr = useI18n();
  const [bundles, setBundles] = useState<OfflineDocumentBundle[]>([]);
  const [name, setName] = useState("");
  const [version, setVersion] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [setCurrent, setSetCurrent] = useState(false);
  const [importState, setImportState] = useState<"selecting" | "importing">();
  const [importNotice, setImportNotice] = useState("");
  const busy = importState !== undefined;
  const refreshRequest = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++refreshRequest.current;
    try {
      const next = await api.offlineDocuments?.list();
      if (next && request === refreshRequest.current) setBundles(next);
      return next;
    } catch (error) {
      if (request === refreshRequest.current) onError(error);
      return undefined;
    }
  }, [api.offlineDocuments, onError]);
  useEffect(() => {
    const unsubscribe = api.offlineDocuments?.subscribe?.(() => { void refresh(); });
    void refresh();
    return () => { unsubscribe?.(); ++refreshRequest.current; };
  }, [api.offlineDocuments, refresh]);
  async function importFiles(directory: boolean) {
    if (!api.offlineDocuments || busy || !name.trim() || !version.trim()) return;
    setImportNotice("");
    setImportState("selecting");
    try {
      let imported: OfflineDocumentBundle;
      if (directory) {
        const selected = await api.offlineDocuments.selectDirectory?.();
        if (!selected) return;
        setImportState("importing");
        imported = await api.offlineDocuments.importDirectory(selected, name.trim(), version.trim(), enabled, { setCurrent });
      } else {
        const selected = await api.offlineDocuments.selectFiles?.();
        if (!selected?.length) return;
        setImportState("importing");
        imported = await api.offlineDocuments.importFiles(selected, name.trim(), version.trim(), enabled, { setCurrent });
      }
      // Show the completed import immediately and invalidate any older list request.
      ++refreshRequest.current;
      setBundles((current) => {
        const index = current.findIndex((item) => item.id === imported.id);
        if (index < 0) return [...current, imported];
        const next = current.slice();
        next[index] = imported;
        return next;
      });
      setName("");
      setVersion("");
      setImportNotice(`已导入 ${imported.name} · 共 ${imported.versions.length} 个版本`);
      void refresh();
    } catch (error) { onError(error); } finally { setImportState(undefined); }
  }
  return <section className="standard-view">
    <header className="standard-view-header"><div><span className="eyebrow">{tr("工具")}</span><h1>{tr("离线文档")}</h1><p className="subtle">{tr("按版本管理全局离线资料，启用后可供会话按需读取。")}</p></div></header>
    <div className="form-grid compact-form">
      <label>文档包名称<input disabled={busy} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如 Godot 文档" /></label>
      <label>版本号<input disabled={busy} value={version} onChange={(event) => setVersion(event.target.value)} placeholder="例如 4.7.1" /></label>
      <label className="checkbox-label"><input disabled={busy} type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />导入后启用</label>
      <label className="checkbox-label"><input disabled={busy} type="checkbox" checked={setCurrent} onChange={(event) => setSetCurrent(event.target.checked)} />设为当前版本</label>
      <div className="button-row"><button disabled={busy || !name.trim() || !version.trim()} onClick={() => void importFiles(false)}>选择多个文件</button><button disabled={busy || !name.trim() || !version.trim()} onClick={() => void importFiles(true)}>选择目录</button></div>
    </div>
    <p className="subtle">版本号用于区分同一文档包的不同发布版本。同名文档包会合并管理，首次导入自动设为当前版本。</p>
    {(busy || importNotice) && <p className="subtle" role="status">{importState === "selecting" ? "请选择要导入的目录或文件。" : importState === "importing" ? "正在导入文档，请稍候…" : importNotice}</p>}
    <div className="stack-list">{bundles.length === 0 && !busy && <p className="empty-state">还没有导入离线文档。</p>}{bundles.map((bundle) => <article className="settings-card" key={bundle.id}>
      <div className="settings-card-heading"><div><h2>{bundle.name}</h2><p className="subtle">{bundle.versions.length === 0 ? "尚未导入可用版本" : `${bundle.versions.length} 个版本 · 当前版本：${bundle.versions.find((item) => item.id === bundle.activeVersionId)?.label ?? "未选择"}`}</p></div><label className="checkbox-label"><input type="checkbox" checked={bundle.enabled} onChange={() => void api.offlineDocuments?.setEnabled(bundle.id, !bundle.enabled).then(refresh).catch(onError)} />启用</label></div>
      <div className="version-list">{bundle.versions.map((item) => <div className="version-row" key={item.id}><span><strong>{item.label}</strong><small>{item.fileCount} 个文件 · {formatBytes(item.size)}</small></span><span className="button-row"><button disabled={item.id === bundle.activeVersionId} onClick={() => void api.offlineDocuments?.setVersion(bundle.id, item.id).then(refresh).catch(onError)}>{item.id === bundle.activeVersionId ? "当前版本" : "设为当前"}</button><button className="danger-ghost" onClick={() => void api.offlineDocuments?.remove(bundle.id, item.id).then(refresh).catch(onError)}>删除</button></span></div>)}</div>
      <button className="danger-ghost" onClick={() => void api.offlineDocuments?.remove(bundle.id).then(refresh).catch(onError)}>删除文档包</button>
    </article>)}</div>
  </section>;
}

const hookEvents: HookEvent[] = ["session.before", "session.after", "tool.before", "tool.after"];
export function HooksView({ api, onError, active = true }: { api: DesktopApi; onError: (error: unknown) => void; active?: boolean }) {
  const tr = useI18n();
  const [hooks, setHooks] = useState<HookDefinition[]>([]); const [editing, setEditing] = useState<Partial<HookDefinition>>({ event: "session.before", timeoutMs: 30000, enabled: true }); const [busy, setBusy] = useState(false);
  const requestSeq = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++requestSeq.current;
    try {
      const next = await api.hooks?.list();
      if (next && request === requestSeq.current) setHooks(next);
    } catch (error) { if (request === requestSeq.current) onError(error); }
  }, [api.hooks, onError]);
  useStateChangeRefresh(api.onStateChanged, refresh);
  useEffect(() => {
    if (active) void refresh();
    return () => { requestSeq.current++; };
  }, [active, refresh]);
  async function save() { if (!api.hooks || !editing.name || !editing.command || !editing.event) return; setBusy(true); try { await api.hooks.save({ id: editing.id, name: editing.name, event: editing.event, command: editing.command, shell: editing.shell, timeoutMs: editing.timeoutMs ?? 30000, enabled: editing.enabled ?? true }); setEditing({ event: "session.before", timeoutMs: 30000, enabled: true }); await refresh(); } catch (error) { onError(error); } finally { setBusy(false); } }
  return <section className="standard-view"><header className="standard-view-header"><div><span className="eyebrow">{tr("工具")}</span><h1>Hooks</h1><p className="subtle">{tr("在会话和工具调用前后运行本地命令。失败会记录状态，不会阻断主流程。")}</p></div></header>
    <div className="settings-card"><div className="form-grid compact-form"><label>名称<input value={editing.name ?? ""} onChange={(event) => setEditing({ ...editing, name: event.target.value })} /></label><label>事件<select value={editing.event ?? "session.before"} onChange={(event) => setEditing({ ...editing, event: event.target.value as HookEvent })}>{hookEvents.map((item) => <option key={item}>{item}</option>)}</select></label><label>命令<input value={editing.command ?? ""} onChange={(event) => setEditing({ ...editing, command: event.target.value })} placeholder="读取 stdin 中的 JSON" /></label><label>超时（毫秒）<input type="number" value={editing.timeoutMs ?? 30000} onChange={(event) => setEditing({ ...editing, timeoutMs: Number(event.target.value) })} /></label><label className="checkbox-label"><input type="checkbox" checked={editing.enabled ?? true} onChange={(event) => setEditing({ ...editing, enabled: event.target.checked })} />启用</label></div><button className="primary" disabled={busy || !editing.name || !editing.command} onClick={() => void save()}>保存 Hook</button></div>
    <div className="stack-list">{hooks.map((hook) => <article className="settings-card" key={hook.id}><div className="settings-card-heading"><div><h2>{hook.name}</h2><p className="subtle">{hook.event} · {hook.command}</p></div><label className="checkbox-label"><input type="checkbox" checked={hook.enabled} onChange={() => void api.hooks?.setEnabled(hook.id, !hook.enabled).then(refresh).catch(onError)} />启用</label></div><p className="subtle">{hook.lastRun ? `${hook.lastRun.ok ? "成功" : "失败"} · ${hook.lastRun.message}` : "尚未运行"}</p><div className="button-row"><button onClick={() => void api.hooks?.test(hook.id).then(refresh).catch(onError)}>测试运行</button><button className="danger-ghost" onClick={() => void api.hooks?.remove(hook.id).then(refresh).catch(onError)}>删除</button></div></article>)}</div>
  </section>;
}

const builtinTools = [
  ["Read / Write / Edit", "读取、创建和精确修改项目文件。"], ["Glob / Grep", "按模式查找文件和搜索内容。"], ["Bash", "在项目隔离环境中运行受控命令。"], ["Godot MCP", "官方插件提供 8 个只读工具：诊断、Output 日志、编辑器/游戏截图、项目信息和场景/运行节点检查。"], ["Skill / Agent", "加载项目技能并委派子任务。"], ["OfflineDocsList / OfflineDocsRead", "访问已启用离线文档的索引和文本内容。"],
] as const;
export function ToolDocsView({ api, projectPath }: { api?: DesktopApi; projectPath?: string }) {
  const tr = useI18n();
  const [dynamic, setDynamic] = useState<string[]>([]);
  useEffect(() => {
    if (!api?.sessions || !projectPath) return;
    let alive = true;
    const entries = new Map<string, { revision: number; names: string[] }>();
    const apply = (session: ChatSession) => {
      if ((entries.get(session.id)?.revision ?? -1) >= session.revision) return;
      entries.set(session.id, { revision: session.revision, names: [...(session.capabilities?.tools ?? []).map(tool => tool.name), ...(session.capabilities?.mcp ?? []).flatMap(server => server.tools)] });
    };
    const publish = () => { if (alive) setDynamic([...new Set([...entries.values()].flatMap(entry => entry.names))].sort()); };
    const unsubscribe = api.sessions.subscribe(event => {
      if (event.projectPath !== projectPath || event.sessionId !== event.session.id) return;
      const previous = entries.get(event.sessionId)?.names.join("|");
      apply(event.session);
      if (previous !== entries.get(event.sessionId)?.names.join("|")) publish();
    });
    void api.sessions.list(projectPath).then(sessions => { if (alive) { sessions.forEach(apply); publish(); } }).catch(() => undefined);
    return () => { alive = false; unsubscribe(); };
  }, [api?.sessions, projectPath]);
  return <section className="standard-view"><header className="standard-view-header"><div><span className="eyebrow">{tr("工具")}</span><h1>{tr("工具说明")}</h1><p className="subtle">{tr("模型会搜索可用工具，加载参数，执行调用，接收结果后继续推理。")}</p></div></header><div className="tool-flow"><span>搜索工具</span><span>加载参数</span><span>执行工具</span><span>接收结果</span><span>继续推理</span></div><div className="stack-list">{builtinTools.map(([name, description]) => <article className="settings-card" key={name}><h2>{name}</h2><p>{description}</p><code>{`{ "name": "${name.split(" /")[0]}", "input": { ... } }`}</code></article>)}{dynamic.map((name) => <article className="settings-card" key={`dynamic-${name}`}><h2>{name}</h2><p>来自当前会话能力或 MCP 连接的动态工具。</p></article>)}</div></section>; }

export function ArchivedSessionsView({ api, projectPath, onError, onSelect }: { api: DesktopApi; projectPath: string; onError: (error: unknown) => void; onSelect: (session: ChatSession) => void }) {
  const tr = useI18n();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const eventSnapshots = useRef(new Map<string, ChatSession>());
  const refreshRequest = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++refreshRequest.current;
    const baseline = new Map([...eventSnapshots.current].map(([id, session]) => [id, session.revision]));
    try {
      const items = await api.sessions?.list(projectPath);
      if (!items || request !== refreshRequest.current) return;
      const next = new Map(items.map((item) => [item.id, item]));
      for (const [id, event] of eventSnapshots.current) {
        const saved = next.get(id);
        if (saved ? saved.revision < event.revision : event.revision > (baseline.get(id) ?? -1)) next.set(id, event);
        else eventSnapshots.current.delete(id);
      }
      setSessions([...next.values()].filter((item) => item.archived).map((item) => ({ ...item, items: [] })));
    } catch (error) { if (request === refreshRequest.current) onError(error); }
  }, [api.sessions, projectPath, onError]);
  useEffect(() => {
    let alive = true; let queued = false;
    eventSnapshots.current.clear();
    setSessions([]);
    const unsubscribe = api.sessions?.subscribe((event) => {
      if (event.projectPath !== projectPath || event.sessionId !== event.session.id || event.seq !== event.session.seq || event.runId !== event.session.runId) return;
      if ((eventSnapshots.current.get(event.sessionId)?.revision ?? -1) >= event.session.revision) return;
      // The retained archive page needs metadata, never a second copy of transcripts.
      const snapshot = { ...event.session, items: [] };
      eventSnapshots.current.set(snapshot.id, snapshot);
      setSessions((current) => {
        const previous = current.find((item) => item.id === snapshot.id);
        if ((previous?.revision ?? -1) >= snapshot.revision) return current;
        if (!snapshot.archived) return previous ? current.filter((item) => item.id !== snapshot.id) : current;
        return previous ? current.map((item) => item.id === snapshot.id ? snapshot : item) : [...current, snapshot];
      });
    });
    const unsubscribeChanges = api.sessions?.subscribeChanges?.((changedProject) => {
      if (changedProject !== projectPath || queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (alive) void refresh();
      });
    });
    void refresh();
    return () => { alive = false; unsubscribe?.(); unsubscribeChanges?.(); ++refreshRequest.current; };
  }, [api.sessions, projectPath, refresh]);
  function download(value: string, session: ChatSession) { const blob = new Blob([value], { type: "application/json" }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${session.title.replace(/[\\/:*?"<>|]/g, "_") || "session"}.json`; anchor.click(); URL.revokeObjectURL(url); }
  return <section className="standard-view"><header className="standard-view-header"><div><span className="eyebrow">{tr("工具")}</span><h1>{tr("归档会话")}</h1><p className="subtle">{tr("恢复、导出或永久删除当前项目的归档会话。")}</p></div></header><div className="stack-list">{sessions.length === 0 && <p className="empty-state">{tr("没有归档会话。")}</p>}{sessions.map((session) => <article className="settings-card" key={session.id}><div className="settings-card-heading"><div><h2>{session.title}</h2><p className="subtle">更新于 {new Date(session.updatedAt).toLocaleString()}</p></div></div><div className="button-row"><button onClick={() => void api.sessions?.patch(projectPath, session.id, { archived: false }).then((updated) => { eventSnapshots.current.set(updated.id, { ...updated, items: [] }); onSelect(updated); void refresh(); }).catch(onError)}>{tr("恢复")}</button><button onClick={() => void api.sessions?.export(projectPath, session.id).then((value) => download(value, session)).catch(onError)}>{tr("导出")}</button><button className="danger-ghost" onClick={() => { if (window.confirm("永久删除此会话？")) void api.sessions?.remove(projectPath, session.id).then(() => { eventSnapshots.current.delete(session.id); void refresh(); }).catch(onError); }}>{tr("永久删除")}</button></div></article>)}</div></section>;
}

