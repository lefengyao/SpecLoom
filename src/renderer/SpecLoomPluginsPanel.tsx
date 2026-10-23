import { useEffect, useState } from "react";
import { AlertTriangle, FolderOpen, PackagePlus, Puzzle, RefreshCw, Trash2 } from "lucide-react";
import type { DesktopApi } from "../shared/desktop-api";
import type { PluginInventory, PluginSummary } from "../shared/plugins";
import { IconButton } from "./ui";

export function SpecLoomPluginsPanel({ api, onError }: { api: DesktopApi; onError: (error: unknown) => void }) {
  const manager = api.plugins;
  const [inventory, setInventory] = useState<PluginInventory>();
  const [busy, setBusy] = useState<string>();
  const [failure, setFailure] = useState("");

  async function refresh() {
    if (!manager) return;
    try { setInventory(await manager.list()); }
    catch (error) { setFailure(errorMessage(error)); onError(error); }
  }
  useEffect(() => { void refresh(); }, [manager]);
  useEffect(() => api.onStateChanged?.(() => { void refresh(); }), [api, manager]);

  if (!manager) return null;

  async function action(id: string, operation: () => Promise<PluginInventory>) {
    setBusy(id); setFailure("");
    try {
      setInventory(await operation());
      window.dispatchEvent(new Event("specloom:plugins-changed"));
    } catch (error) { setFailure(errorMessage(error)); onError(error); }
    finally { setBusy(undefined); }
  }

  const plugins = inventory?.plugins ?? [];
  return <section className="plugin-project-section spec-plugins-section" aria-labelledby="spec-plugins-heading">
    <header className="plugin-list-heading">
      <div><h2 id="spec-plugins-heading">SpecLoom 插件</h2><p>扩展 SpecLoom 的主进程能力和页面。插件以本地可信代码运行。</p></div>
      <div className="toolbar">
        <button className="button secondary" disabled={!!busy} onClick={() => void action("install", () => manager.install())}><PackagePlus size={15} />安装本地插件</button>
        <IconButton label="刷新 SpecLoom 插件" disabled={!!busy} onClick={() => void refresh()}><RefreshCw size={16} /></IconButton>
      </div>
    </header>
    <div className="plugin-warning-line"><AlertTriangle size={14} />可信插件可访问本机文件和项目；只安装你信任来源的插件。</div>
    {failure && <div role="alert" className="plugin-inline-error">{failure}</div>}
    {plugins.length ? <div className="plugin-list" aria-label="SpecLoom 插件列表">{plugins.map((plugin) => <SpecPluginRow key={plugin.id} plugin={plugin} busy={!!busy} onToggle={() => void action(plugin.id, () => manager.setEnabled(plugin.id, !plugin.enabled))} onReveal={() => void manager.reveal(plugin.id).catch(onError)} onUninstall={() => { if (!window.confirm(`卸载插件 ${plugin.name}？`)) return; void action(plugin.id, () => manager.uninstall(plugin.id)); }} />)}</div>
      : <div className="plugin-empty compact"><Puzzle size={22} /><p>还没有发现 SpecLoom 插件。</p></div>}
  </section>;
}

function SpecPluginRow({ plugin, busy, onToggle, onReveal, onUninstall }: { plugin: PluginSummary; busy: boolean; onToggle: () => void; onReveal: () => void; onUninstall: () => void }) {
  const status = plugin.status === "error" ? "异常" : plugin.enabled ? "已启用" : "已禁用";
  return <article className={`plugin-row${plugin.status === "error" ? " is-invalid" : ""}`}>
    <div className="plugin-row-main">
      <div className="plugin-row-title"><h3>{plugin.name}</h3><span className={`plugin-status-pill ${plugin.status === "error" ? "is-attention" : plugin.enabled ? "is-ready" : "is-disabled"}`}>{status}</span>{plugin.official && <span className="plugin-status-pill is-ready">官方</span>}</div>
      <p>{plugin.error || plugin.description || "此插件未提供说明。"}</p>
      <div className="plugin-meta-line"><span>v{plugin.version}</span><span>{plugin.source === "builtin" ? "内置" : "本地安装"}</span><span>{plugin.nativePages.length} 个页面</span><code>{plugin.id}</code></div>
    </div>
    <div className="plugin-row-actions">
      <button type="button" role="switch" aria-checked={plugin.enabled} aria-label={`${plugin.enabled ? "禁用" : "启用"} ${plugin.name}`} disabled={busy} className={`plugin-switch${plugin.enabled ? " is-on" : ""}`} onClick={onToggle}><span /></button>
      <button type="button" className="button ghost" disabled={busy} onClick={onReveal}><FolderOpen size={15} />定位</button>
      {plugin.source === "user" && <button type="button" className="button danger-ghost" disabled={busy} onClick={onUninstall}><Trash2 size={15} />卸载</button>}
    </div>
  </article>;
}

function errorMessage(error: unknown): string {
  return typeof error === "object" && error !== null && "message" in error ? String(error.message) : "插件操作失败。";
}
