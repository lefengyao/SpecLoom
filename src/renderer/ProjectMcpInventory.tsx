import { useCallback, useEffect, useRef, useState } from "react";
import { Puzzle, RefreshCw } from "lucide-react";
import type { ChatSessionsApi } from "../shared/chat";
import type { PluginManagementApi } from "../shared/desktop-api";
import type { GodotMcpPluginEntry } from "../shared/godot-plugins";
import { errorMessage } from "../shared/error-message";
import { IconButton } from "./ui";
import { useSessionCapabilities } from "./useSessionCapabilities";
import "./capability-views.css";

const labels = { connected: "已连接", error: "连接失败", disabled: "已停用" };
const godotIssueLabels = {
  project_setting_conflict: "项目启用设置与插件状态冲突",
  files_modified: "插件文件与内置版本不一致",
  metadata_invalid: "插件元数据无效",
  bundle_unavailable: "内置插件包不可用",
};

export function GodotMcpStatus({ api, projectPath, onError }: { api: PluginManagementApi; projectPath?: string | undefined; onError: (error: unknown) => void }) {
  const [godotMcp, setGodotMcp] = useState<GodotMcpPluginEntry>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const result = await api.list();
      if (current === generation.current) setGodotMcp(result.godotMcp);
    } catch (failure) {
      if (current === generation.current) { setError(errorMessage(failure)); onError(failure); }
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [api, onError, projectPath]);
  useEffect(() => {
    void refresh();
    return () => { generation.current++; };
  }, [refresh]);

  const status = loading ? "正在检查…" : error ? "状态读取失败" : !godotMcp ? "状态未知" : godotMcp.status === "missing" ? "未安装到当前项目" : godotMcp.status === "conflict" ? "安装状态异常" : !godotMcp.enabled ? "已安装 · 已停用" : godotMcp.connected ? "已启用 · Godot 已连接" : "已启用 · 等待 Godot 连接";
  return <section className="project-mcp-inventory" aria-label="Godot MCP 项目插件">
    <header className="section-heading"><div><h2>Godot MCP 项目插件</h2><p className="field-hint">管理项目中的 SpecLoom Godot MCP 连接。Godot 未打开时，插件仍可安装和启用，但工具会等待编辑器连接。</p></div><IconButton label="刷新 Godot MCP 状态" disabled={loading} onClick={() => void refresh()}><RefreshCw size={16} /></IconButton></header>
    <article className="godot-mcp-card" aria-label="SpecLoom Godot MCP">
      <div className="godot-mcp-icon"><Puzzle size={21} /></div>
      <div className="godot-mcp-content">
        <header><h3>SpecLoom Godot MCP</h3><span className={`mcp-state ${godotMcp?.status === "conflict" ? "mcp-error" : godotMcp?.enabled && godotMcp.connected ? "mcp-connected" : "mcp-disabled"}`}>{status}</span></header>
        {error ? <p className="godot-mcp-issue">{error}</p> : godotMcp?.issue ? <p className="godot-mcp-issue">{godotIssueLabels[godotMcp.issue]}</p> : null}
        <p>只读访问项目资料、场景树、运行节点和 Output 日志，并获取编辑器或游戏截图。</p>
        <small>{godotMcp?.installedVersion ? `GodotMCP-Standalone · v${godotMcp.installedVersion}` : "GodotMCP-Standalone"} · <span>更多启停与目录操作请到插件管理</span></small>
      </div>
    </article>
  </section>;
}

export function ProjectMcpInventory({ api, projectPath, onError }: { api?: ChatSessionsApi | undefined; projectPath?: string | undefined; onError: (error: unknown) => void }) {
  const inventory = useSessionCapabilities(api, projectPath, onError);
  return <section className="project-mcp-inventory" aria-label="外部 MCP 服务状态">
    <header className="section-heading"><div><h2>会话连接状态</h2><p className="field-hint">这里显示智能体本次会话实际连接的外部 MCP 服务及可用工具。</p></div>{api && projectPath !== undefined && <IconButton label="刷新外部 MCP 状态" disabled={inventory.loading} onClick={() => void inventory.refresh()}><RefreshCw size={16} /></IconButton>}</header>
    <p className="field-hint">外部 MCP 服务可在下方管理，或在项目的 <code>.specloom/mcp.json</code>、根目录 <code>.mcp.json</code> 中配置；更改后下一轮会话重新连接。</p>
    {inventory.loading ? <p className="empty-state">正在加载 MCP 状态…</p> : inventory.error ? <p className="empty-state">{inventory.discoveryError ? "MCP 状态加载失败。下一次发送消息会重新加载。" : "MCP 状态加载失败，请重试刷新。"}</p> : inventory.capabilities ? inventory.capabilities.mcp.length ? <div className="capability-browser">{inventory.capabilities.mcp.map((server, index) => <article className="capability-entry" key={`${server.name}:${index}`}><header><strong>{server.name}</strong><span className={`mcp-state mcp-${server.status}`}>{labels[server.status]}</span></header>{server.error && <p>{server.error}</p>}<p>{server.tools.length ? server.tools.join(" · ") : "当前没有可用工具"}</p></article>)}</div> : <p className="empty-state">当前会话没有配置外部 MCP 服务。</p> : <p className="empty-state">新建会话后可查看服务连接状态。</p>}
  </section>;
}
