import { memo, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, Copy, Info, PanelRightClose, Workflow } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatItem, ChatSession } from "../../shared/chat";
import { splitChatTurns, toolCounts, toolStatusLabels, type ChatToolItem, type ToolSidebarSelection } from "./tool-chain";
import "./tool-sidebar.css";

export type AgentSidebarSection = { id: string; label: string; content: ReactNode };
export type AgentSidebarProps = {
  session: ChatSession;
  selection?: ToolSidebarSelection | undefined;
  onClose: () => void;
  /** Additional sections share the same keyboard navigation and scrolling surface. */
  sections?: AgentSidebarSection[] | undefined;
};

const sessionStatusLabels: Record<ChatSession["status"], string> = {
  idle: "准备就绪", running: "运行中", waiting: "等待你处理", completed: "已完成", error: "运行失败", cancelled: "已停止", interrupted: "已中断",
};

function Payload({ title, value, empty }: { title: string; value: string; empty: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const formatted = useMemo(() => {
    try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
  }, [value]);
  useEffect(() => { setCopied(false); setFailed(false); }, [value]);
  async function copy() {
    try { await navigator.clipboard.writeText(value); setCopied(true); setFailed(false); }
    catch { setCopied(false); setFailed(true); }
  }
  return <section className="tool-detail-payload" aria-label={title}>
    <header><h4>{title}</h4>{value && <button type="button" aria-label={`复制${title}`} onClick={() => void copy()}>{copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}{copied ? "已复制" : failed ? "复制失败" : "复制"}</button>}</header>
    {value ? <pre>{formatted}</pre> : <p className="tool-detail-empty">{empty}</p>}
  </section>;
}

function ToolDetail({ tool }: { tool: ChatToolItem }) {
  const truncated = tool.arguments.includes('"truncated":true') || tool.output.includes('"truncated":true');
  return <article className={`agent-sidebar-tool-detail tool-state-${tool.status}`} aria-label="选中工具详情">
    <header><h3><code>{tool.name}</code></h3><span className="tool-detail-status">{toolStatusLabels[tool.status]}</span></header>
    <p className="tool-detail-identity">{tool.callId}</p>
    {truncated && <p className="tool-detail-truncated">这条记录的内容已截断。</p>}
    <Payload title="参数（已脱敏）" value={tool.arguments} empty={tool.status === "receiving" ? "正在接收参数…" : "无参数"} />
    <Payload title="结果（已脱敏）" value={tool.output} empty={["receiving", "running", "waiting"].includes(tool.status) ? "等待工具返回结果…" : "没有返回内容"} />
  </article>;
}

const SidebarReasoning = memo(function SidebarReasoning({ item }: { item: Extract<ChatItem, { kind: "thinking" }> }) {
  const [expanded, setExpanded] = useState(false);
  return <details className="agent-sidebar-thinking" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>模型思考{item.partial ? " · 部分内容" : ""}</summary>
    {expanded && <div className="bubble-content"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{item.content}</ReactMarkdown></div>}
  </details>;
});

export function AgentSidebar({ session, selection, onClose, sections = [] }: AgentSidebarProps) {
  const sidebar = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const prefix = useId();
  const [tab, setTab] = useState("tools");
  const [diagnosticCopied, setDiagnosticCopied] = useState(false);
  const [turnId, setTurnId] = useState(selection?.turnId ?? "");
  const [toolId, setToolId] = useState<string | undefined>(selection?.itemId);
  const turns = useMemo(() => splitChatTurns(session.items), [session.items]);
  const latestToolTurn = useMemo(() => [...turns].reverse().find(candidate => candidate.tools.length > 0), [turns]);
  const turn = turns.find(candidate => candidate.id === turnId) ?? latestToolTurn ?? turns.at(-1);
  const selectedTool = turn?.tools.find(tool => tool.id === toolId) ?? turn?.tools.at(-1);
  const counts = toolCounts(turn?.tools ?? []);
  const pendingActions = session.items.filter(item => (item.kind === "question" || item.kind === "approval") && item.status === "waiting").length;
  const tabs = [{ id: "tools", label: "工具链" }, { id: "overview", label: "会话概览" }, ...sections.filter(section => section.id !== "tools" && section.id !== "overview")];
  const activeTab = tabs.some(candidate => candidate.id === tab) ? tab : "tools";

  useEffect(() => {
    setTurnId(selection?.turnId ?? ""); setToolId(selection?.itemId); setTab("tools");
  }, [session.id, selection]);
  useEffect(() => { setDiagnosticCopied(false); }, [session.diagnosticId]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    close.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [session.id]);

  function navigateTabs(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const nextIndex = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index - 1 + tabs.length) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : undefined;
    if (nextIndex === undefined) return;
    event.preventDefault(); setTab(tabs[nextIndex]!.id);
    sidebar.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus();
  }
  function keyboard(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") { event.stopPropagation(); onClose(); return; }
    if (event.key !== "Tab" || !window.matchMedia?.("(max-width: 1200px)").matches) return;
    const controls = [...(sidebar.current?.querySelectorAll<HTMLElement>('button:not([disabled]):not([tabindex="-1"]), select, textarea, a[href], [tabindex="0"]') ?? [])];
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  return <aside id="agent-sidebar" ref={sidebar} className="agent-sidebar" aria-label="智能体侧栏" onKeyDown={keyboard}>
    <header className="agent-sidebar-header"><div><span className="agent-sidebar-eyebrow"><Workflow size={12} aria-hidden="true" />会话工作台</span><h2>智能体侧栏</h2><p title={session.title}>{session.title}</p></div><button type="button" ref={close} className="agent-sidebar-close" aria-label="关闭智能体侧栏" title="关闭侧栏 · Esc" onClick={onClose}><PanelRightClose size={17} aria-hidden="true" /></button></header>
    <div className="agent-sidebar-tabs" role="tablist" aria-label="侧栏内容">
      {tabs.map((entry, index) => <button key={entry.id} id={`${prefix}-tab-${entry.id}`} type="button" role="tab" aria-selected={activeTab === entry.id} aria-controls={`${prefix}-panel-${entry.id}`} tabIndex={activeTab === entry.id ? 0 : -1} onClick={() => setTab(entry.id)} onKeyDown={event => navigateTabs(event, index)}>{entry.id === "tools" ? <Workflow size={13} aria-hidden="true" /> : entry.id === "overview" ? <Info size={13} aria-hidden="true" /> : null}{entry.label}</button>)}
    </div>
    <div className="agent-sidebar-content" id={`${prefix}-panel-${activeTab}`} role="tabpanel" aria-labelledby={`${prefix}-tab-${activeTab}`} tabIndex={0}>
      {activeTab === "tools" ? <>
        {turns.length > 0 && <div className="agent-sidebar-turn"><label htmlFor={`${prefix}-turn`}>查看轮次</label><select id={`${prefix}-turn`} value={turn?.id ?? ""} onChange={event => { setTurnId(event.target.value); setToolId(undefined); }}>{turns.map(entry => <option key={entry.id} value={entry.id}>{entry.number ? `第 ${entry.number} 轮` : "历史记录"} · {entry.tools.length} 次调用</option>)}</select></div>}
        <dl className="agent-sidebar-stats"><div><dt>工具调用</dt><dd>{turn?.tools.length ?? 0}</dd></div><div><dt>已完成</dt><dd>{counts.completed}</dd></div><div className={counts.failed ? "has-error" : undefined}><dt>失败</dt><dd>{counts.failed}</dd></div></dl>
        {pendingActions > 0 && <p className="agent-sidebar-pending">有 {pendingActions} 项等待你处理，请在对话中审批或回答。</p>}
        {turn?.tools.length ? <><h3 className="agent-sidebar-section-title">调用记录{counts.pending ? ` · ${counts.pending} 项进行中` : ""}</h3><div className="agent-sidebar-tool-list" aria-label="工具调用记录">{turn.tools.map((tool, index) => <button key={tool.id} type="button" className={`tool-state-${tool.status}`} aria-label={`查看 ${tool.name} 的工具详情`} aria-pressed={selectedTool?.id === tool.id} title={tool.name} onClick={() => setToolId(tool.id)}><span className="tool-call-index">{index + 1}</span><span className="tool-state-dot" aria-hidden="true" /><code>{tool.name}</code><span className="tool-state-label">{toolStatusLabels[tool.status]}</span></button>)}</div>{selectedTool && <ToolDetail key={selectedTool.id} tool={selectedTool} />}</> : <div className="agent-sidebar-empty"><Workflow size={23} aria-hidden="true" /><p>本轮还没有工具调用</p><small>调用发生后会在这里显示状态与详情。</small></div>}
        {turn?.details.some(item => item.kind !== "tool") && <><h3 className="agent-sidebar-section-title">思考与活动</h3>{turn.details.map(item => item.kind === "thinking" ? <SidebarReasoning key={item.id} item={item} /> : item.kind === "activity" ? <p key={item.id} className="agent-sidebar-activity">{item.content}</p> : null)}</>}
      </> : activeTab === "overview" ? <dl className="agent-sidebar-overview">
        <div><dt>当前状态</dt><dd>{sessionStatusLabels[session.status]}{session.archived && " · 已归档"}</dd></div>
        <div><dt>会话</dt><dd>{session.title}<br />{turns.filter(entry => entry.number > 0).length} 轮对话 · {session.items.filter(item => item.kind === "tool").length} 次工具调用</dd></div>
        {session.model && <div><dt>使用模型</dt><dd>{session.model.model}</dd></div>}
        {session.activity && <div><dt>最近活动</dt><dd>{session.activity}</dd></div>}
        {session.taskId && <div><dt>关联任务</dt><dd>{session.taskId}</dd></div>}
        {session.capabilities && <div><dt>会话能力</dt><dd>{session.capabilities.tools.length} 个工具 · {session.capabilities.skills.length} 个技能<br />{session.capabilities.mcp.filter(server => server.status === "connected").length} 个 MCP 已连接 · {session.capabilities.plugins.length} 个插件</dd></div>}
        {session.usage && <div><dt>最近一次用量</dt><dd>输入 {session.usage.promptTokens.toLocaleString()} · 输出 {session.usage.completionTokens.toLocaleString()} tokens</dd></div>}
        {session.error && <div><dt>运行信息</dt><dd>{session.error}</dd></div>}
        {session.diagnosticId && <div><dt>诊断编号</dt><dd><code>{session.diagnosticId}</code><button type="button" aria-label="复制诊断编号" onClick={() => void navigator.clipboard.writeText(session.diagnosticId!).then(() => setDiagnosticCopied(true), () => setDiagnosticCopied(false))}>{diagnosticCopied ? "已复制" : "复制"}</button></dd></div>}
      </dl> : sections.find(section => section.id === activeTab)?.content}
    </div>
    <footer className="agent-sidebar-footer"><span className="tool-state-dot" aria-hidden="true" />{sessionStatusLabels[session.status]}<span>·</span><span>Esc 关闭</span></footer>
  </aside>;
}
