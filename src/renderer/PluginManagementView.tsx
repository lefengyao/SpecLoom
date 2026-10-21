import { AlertTriangle, Check, FolderOpen, Puzzle, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { DesktopApi } from "../shared/desktop-api";
import type { GodotPluginEntry, PluginInventory, RevealPluginDirectoryTarget } from "../shared/godot-plugins";
import type { ProjectMetadata } from "../shared/contracts";
import { IconButton } from "./ui";
import { useI18n } from "./i18n";
import "./plugins.css";

type PluginFilter = "all" | "enabled" | "disabled" | "attention";
type PluginAction = "godot-mcp-install" | "godot-mcp-toggle" | string;

export function PluginManagementView({ api, project, onError }: { api: DesktopApi; project: ProjectMetadata | undefined; onError: (error: unknown) => void }) {
  const tr = useI18n();
  const [inventory, setInventory] = useState<PluginInventory>();
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PluginFilter>("all");
  const [busy, setBusy] = useState<PluginAction>();
  const [notice, setNotice] = useState("");
  const [failure, setFailure] = useState("");
  const manager = api.pluginManagement;
  const projectPath = project?.path;
  const isGodot = project?.engine === "godot";

  const refresh = useCallback(async () => {
    if (!manager || !projectPath || !isGodot) { setInventory(undefined); return; }
    setLoading(true);
    setFailure("");
    try { setInventory(await manager.list()); }
    catch (error) { setInventory(undefined); setFailure(errorMessage(error)); onError(error); }
    finally { setLoading(false); }
  }, [isGodot, manager, onError, projectPath]);

  useEffect(() => {
    setInventory(undefined);
    setNotice("");
    setFailure("");
    setQuery("");
    setFilter("all");
    void refresh();
  }, [refresh]);

  useEffect(() => api.onStateChanged?.(() => { void refresh(); }), [api, refresh]);

  const plugins = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return (inventory?.plugins ?? []).filter((plugin) => {
      const matchesFilter = filter === "all"
        || (filter === "enabled" && plugin.enabled && plugin.metadataValid)
        || (filter === "disabled" && !plugin.enabled && plugin.metadataValid)
        || (filter === "attention" && !plugin.metadataValid);
      const searchable = [plugin.name, plugin.description, plugin.author, plugin.version, plugin.id].filter(Boolean).join(" ").toLocaleLowerCase();
      return matchesFilter && (!normalizedQuery || searchable.includes(normalizedQuery));
    });
  }, [filter, inventory, query]);

  async function withAction(action: PluginAction, operation: () => Promise<{ restartRequired: boolean }>) {
    setBusy(action);
    setNotice("");
    setFailure("");
    try {
      const result = await operation();
      await refresh();
      if (result.restartRequired) setNotice("插件状态已更新。重新载入 Godot 项目后生效。");
    } catch (error) {
      setFailure(errorMessage(error));
      onError(error);
    } finally { setBusy(undefined); }
  }

  async function reveal(target: RevealPluginDirectoryTarget) {
    if (!manager) return;
    setBusy(`reveal:${target}`);
    setFailure("");
    try { await manager.revealDirectory(target); }
    catch (error) { setFailure(errorMessage(error)); onError(error); }
    finally { setBusy(undefined); }
  }

  if (!project) return <section className="standard-view plugin-management-view"><div className="plugin-empty"><Puzzle size={27} /><h2>{tr("请先打开一个项目")}</h2><p>{tr("插件管理会读取当前项目中的 Godot 插件。")}</p></div></section>;
  if (!isGodot) return <section className="standard-view plugin-management-view"><header className="section-heading"><div><h1>{tr("插件管理")}</h1><span className="subtle">{project.name}</span></div></header><div className="plugin-empty"><AlertTriangle size={27} /><h2>{tr("仅适用于 Godot 项目")}</h2><p>{tr("当前项目不包含 Godot 插件清单。")}</p></div></section>;
  if (!manager) return <section className="standard-view plugin-management-view"><div role="alert" className="plugin-inline-error">当前宿主没有提供插件管理接口。</div></section>;

  const godotMcp = inventory?.godotMcp;
  const enabledCount = inventory?.plugins.filter((plugin) => plugin.enabled).length ?? 0;
  const godotMcpActionDisabled = !!busy || loading || !godotMcp || (!godotMcp.enabled && godotMcp.status === "conflict");
  const confirmGodotMcp = (enable: boolean) => {
    if (!enable) { void withAction("godot-mcp-toggle", () => manager.setGodotMcpEnabled(false)); return; }
    const action = enable ? "安装并启用" : "禁用";
    if (!window.confirm(`${action} SpecLoom Godot MCP？这会${enable ? "把插件代码写入当前 Godot 项目的 addons/ 目录并启用它" : "修改当前项目的插件启用设置"}。重新载入 Godot 项目后生效。`)) return;
    if (enable && godotMcp?.status !== "ready") void withAction("godot-mcp-install", () => manager.installGodotMcp());
    else void withAction("godot-mcp-toggle", () => manager.setGodotMcpEnabled(enable));
  };

  return <section className="standard-view plugin-management-view">
    <header className="section-heading plugin-page-heading">
      <div><h1>{tr("插件管理")}</h1><span className="subtle">{project.name} · Godot {project.godot.features[0] ?? project.godot.configVersion}</span></div>
      <div className="toolbar">
        <button className="button secondary" disabled={!!busy} onClick={() => void reveal("project")}><FolderOpen size={15} />打开项目目录</button>
        <IconButton label="刷新插件列表" disabled={loading || !!busy} onClick={() => void refresh()}><RefreshCw size={16} className={loading ? "plugin-spin" : undefined} /></IconButton>
      </div>
    </header>

    {notice && <div role="status" className="plugin-notice"><Check size={16} />{notice}</div>}
    {failure && <div role="alert" className="plugin-inline-error">{failure}</div>}

    <section className="plugin-bridge-card" aria-labelledby="godot-mcp-heading">
      <div className="plugin-card-icon"><Puzzle size={21} /></div>
      <div className="plugin-bridge-content">
        <div className="plugin-title-line"><h2 id="godot-mcp-heading">SpecLoom Godot MCP</h2><span className={`plugin-status-pill is-${godotMcp?.status ?? "loading"}`}>{godotMcp ? godotMcpStatusLabel(godotMcp.status) : loading ? "读取中" : "未知"}</span></div>
        <p>通过官方 MCP 工具只读检查项目、场景树、运行节点、Output 日志和编辑器/游戏截图。</p>
        <div className="plugin-meta-line"><span>GodotMCP-Standalone · v{godotMcp?.installedVersion ?? "1.1.0"}</span>{godotMcp?.enabled && <span className="plugin-status-enabled">已启用</span>}<span className={godotMcp?.connected ? "plugin-status-enabled" : ""}>{godotMcp?.connected ? "Godot 已连接" : "等待 Godot 连接"}</span></div>
        {godotMcp?.issue && <div className="plugin-warning-line"><AlertTriangle size={14} />{godotMcpIssueLabel(godotMcp.issue)}</div>}
      </div>
      <div className="plugin-actions">
        {!godotMcp?.enabled ? <button className="button primary" disabled={godotMcpActionDisabled} onClick={() => confirmGodotMcp(true)}>{godotMcp?.status === "ready" ? "确认并启用" : "安装并启用"}</button>
          : <button className="button secondary" disabled={godotMcpActionDisabled} onClick={() => confirmGodotMcp(false)}>禁用</button>}
        <button className="button ghost" disabled={!!busy} onClick={() => void reveal("godot-mcp")}>定位目录</button>
      </div>
    </section>

    <section className="plugin-project-section" aria-labelledby="plugin-list-heading">
      <header className="plugin-list-heading">
        <div><h2 id="plugin-list-heading">Godot 项目插件</h2><p>{inventory ? `发现 ${inventory.plugins.length} 个 · ${enabledCount} 个启用` : "读取当前项目 addons/ 目录中的 EditorPlugin"}</p></div>
        {inventory?.scanLimitReached && <span className="plugin-warning-badge"><AlertTriangle size={14} />已达扫描上限，列表可能不完整</span>}
      </header>
      <div className="plugin-toolbar">
        <label className="plugin-search"><Search size={16} /><input aria-label="搜索插件" placeholder="搜索名称、说明、作者或目录" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <div className="plugin-filters" role="group" aria-label="插件状态筛选">
          {([ ["all", "全部"], ["enabled", "已启用"], ["disabled", "已禁用"], ["attention", "异常"] ] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} className={filter === value ? "is-active" : ""} onClick={() => setFilter(value)}>{label}</button>)}
        </div>
      </div>
      {loading && !inventory ? <div className="plugin-empty compact">正在读取插件信息…</div>
        : failure && !inventory ? <div className="plugin-empty compact"><p>插件列表读取失败</p><button className="button secondary" onClick={() => void refresh()}>重试</button></div>
          : plugins.length ? <div className="plugin-list" aria-label="Godot 项目插件列表">{plugins.map((plugin) => <PluginRow key={plugin.id} plugin={plugin} busy={!!busy} onToggle={() => void withAction(plugin.id, () => manager.setGodotPluginEnabled(plugin.id, !plugin.enabled))} onReveal={() => void reveal(plugin.id)} />)}</div>
            : <div className="plugin-empty compact"><Puzzle size={22} /><p>{inventory?.plugins.length ? "没有符合当前搜索或筛选条件的插件" : "当前项目还没有发现 Godot EditorPlugin"}</p>{(query || filter !== "all") && <button className="button ghost" onClick={() => { setQuery(""); setFilter("all"); }}>清除筛选</button>}</div>}
    </section>
  </section>;
}

function PluginRow({ plugin, busy, onToggle, onReveal }: { plugin: GodotPluginEntry; busy: boolean; onToggle: () => void; onReveal: () => void }) {
  const status = plugin.issue === "missing_config" ? "配置缺失" : plugin.issue === "invalid_config" ? "配置异常" : plugin.enabled ? "已启用" : "已禁用";
  return <article className={`plugin-row${plugin.metadataValid ? "" : " is-invalid"}`}>
    <div className="plugin-row-main">
      <div className="plugin-row-title"><h3>{plugin.name}</h3><span className={`plugin-status-pill ${plugin.metadataValid ? plugin.enabled ? "is-ready" : "is-disabled" : "is-attention"}`}>{status}</span></div>
      <p>{plugin.description || (plugin.metadataValid ? "此插件未提供说明。" : plugin.issue === "missing_config" ? "启用列表仍引用该插件，但配置文件已不存在。" : "插件配置缺少有效的必需字段。")}</p>
      <div className="plugin-meta-line">{plugin.author && <span>{plugin.author}</span>}{plugin.version && <span>v{plugin.version}</span>}<code>{plugin.id.slice(0, -"/plugin.cfg".length)}</code></div>
    </div>
    <div className="plugin-row-actions">
      <button type="button" role="switch" aria-checked={plugin.enabled} aria-label={`${plugin.enabled ? "禁用" : "启用"} ${plugin.name}`} disabled={busy || (!plugin.enabled && !plugin.metadataValid)} className={`plugin-switch${plugin.enabled ? " is-on" : ""}`} onClick={onToggle}><span /></button>
      <button type="button" className="button ghost" aria-label={`定位 ${plugin.name} 目录`} disabled={busy} onClick={onReveal}><FolderOpen size={15} /><span>定位</span></button>
    </div>
  </article>;
}

function godotMcpStatusLabel(status: NonNullable<PluginInventory["godotMcp"]>["status"]): string {
  return status === "ready" ? "已安装" : status === "missing" ? "未安装" : "存在冲突";
}
function godotMcpIssueLabel(issue: NonNullable<PluginInventory["godotMcp"]>["issue"]): string {
  return issue === "project_setting_conflict" ? "旧 SpecLoomCapture 自动加载名称与项目设置冲突。" : issue === "files_modified" ? "Godot MCP 文件已被项目修改，SpecLoom 不会覆盖。" : issue === "bundle_unavailable" ? "安装资源缺失或校验失败，请修复 SpecLoom 安装。" : "Godot MCP 插件文件不完整。";
}
function errorMessage(error: unknown): string {
  return typeof error === "object" && error !== null && "message" in error ? String(error.message) : "插件操作失败，请刷新后重试。";
}
