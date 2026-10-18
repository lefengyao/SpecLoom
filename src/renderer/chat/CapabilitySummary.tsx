import type { SessionCapabilities } from "../../shared/chat";

const mcpLabels = { connected: "已连接", error: "连接失败", disabled: "已停用" };

export function CapabilitySummary({ capabilities, error }: { capabilities?: SessionCapabilities | undefined; error?: string | undefined }) {
  if (!capabilities) return <section className="capability-summary" aria-label="会话能力清单"><strong>会话能力</strong>{error ? <p role="status">能力清单加载失败：{error}。发送消息时会重新加载。</p> : <p role="status">正在加载工具、Skills、MCP 与插件，可先输入消息…</p>}</section>;
  return <section className="capability-summary" aria-label="会话能力清单">
    <header><strong>会话能力</strong><span>当前会话可调用的工具与扩展</span></header>
    <div className="capability-groups">
      <details><summary>工具 · {capabilities.tools.length}</summary>{capabilities.tools.length ? <ul>{capabilities.tools.map((tool, index) => <li key={`${tool.name}:${index}`}><code>{tool.name}</code><p>{tool.description}</p></li>)}</ul> : <p>当前没有可用工具。</p>}</details>
      <details><summary>Skills · {capabilities.skills.length}</summary>{capabilities.skills.length ? <ul>{capabilities.skills.map((skill) => <li key={skill.id}><strong>{skill.name}</strong><p>{skill.purpose}</p></li>)}</ul> : <p>当前没有可用Skill。</p>}</details>
      <details><summary>MCP · {capabilities.mcp.length}</summary>{capabilities.mcp.length ? <ul>{capabilities.mcp.map((server, index) => <li key={`${server.name}:${index}`}><strong>{server.name}</strong><span className={`mcp-state mcp-${server.status}`}>{mcpLabels[server.status]}</span>{server.error && <p>{server.error}</p>}<p>{server.tools.length ? server.tools.join(" · ") : "当前没有可用工具"}</p></li>)}</ul> : <p>当前没有配置MCP服务。</p>}</details>
      <details><summary>插件 · {capabilities.plugins.length}</summary>{capabilities.plugins.length ? <ul>{capabilities.plugins.map((plugin, index) => <li key={`${plugin.name}:${index}`}><strong>{plugin.name}</strong><p>{plugin.description}</p></li>)}</ul> : <p>当前没有启用插件。</p>}</details>
    </div>
  </section>;
}
