import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, PanelRightOpen, Workflow } from "lucide-react";
import { toolCounts, toolStatusLabels, type ChatDetailItem, type ChatDetailStage, type ChatTurn, type ToolSidebarSelection } from "./tool-chain";
import "./tool-sidebar.css";
import { toolPreview } from "./tool-preview";

export type { ToolSidebarSelection } from "./tool-chain";

export function TurnSummary({ turn, stage }: { turn: ChatTurn; stage?: ChatDetailStage }) {
  const tools = stage?.tools ?? turn.tools;
  const counts = toolCounts(tools);
  const names = new Map<string, number>();
  for (const tool of tools) names.set(tool.name, (names.get(tool.name) ?? 0) + 1);
  return <details className="run-summary tool-chain-statistics"><summary>{turn.number ? `第 ${turn.number} 轮工具调用` : "历史工具调用"}{stage ? ` · 阶段 ${stage.number}` : ""} · {tools.length} 次 · {counts.failed} 次失败 · {counts.cancelled} 次停止{counts.pending ? ` · ${counts.pending} 次进行中` : ""}</summary>
    {tools.length ? <ul>{[...names].map(([name, count]) => <li key={name}>{name} × {count}</li>)}</ul> : <p>{stage ? "本阶段" : "本轮"}没有调用工具。</p>}
  </details>;
}

/** Compact rows are the only tool payload mounted in the conversation. */
export function ToolChainBox({ turn, stage, multipleStages, live, collapsed, onOpenTools, renderSupplement }: {
  turn: ChatTurn;
  stage: ChatDetailStage;
  multipleStages: boolean;
  live: boolean;
  collapsed: boolean;
  onOpenTools?: ((selection: ToolSidebarSelection) => void) | undefined;
  renderSupplement: (item: Exclude<ChatDetailItem, { kind: "tool" }>, compact: boolean) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(!collapsed);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [unseen, setUnseen] = useState(false);
  const contentId = useId();
  useEffect(() => { setExpanded(!collapsed); }, [collapsed]);
  useEffect(() => {
    if (!expanded || !scroll.current) return;
    if (follow.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    else setUnseen(true);
  }, [stage.details, expanded]);
  const counts = useMemo(() => toolCounts(stage.tools), [stage.tools]);
  const recent = useMemo(() => {
    const latestThinking = [...stage.details].reverse().find(item => item.kind === "thinking");
    const ids = new Set(stage.details.slice(-3).map(item => item.id));
    if (latestThinking) ids.add(latestThinking.id);
    for (const item of stage.tools.filter(tool => ["receiving", "running", "waiting"].includes(tool.status)).slice(-2)) ids.add(item.id);
    return stage.details.filter(item => ids.has(item.id));
  }, [stage.details, stage.tools]);
  const visible = expanded ? stage.details : recent;
  const status = counts.pending ? "进行中" : counts.failed ? "有失败" : live ? "进行中" : "已结束";
  const label = turn.number ? `第 ${turn.number} 轮工具链` : "历史工具链";
  return <section className={`tool-chain-box${live ? " is-live" : ""}`} role="region" aria-label={`${label}${stage.number > 1 ? ` · 阶段 ${stage.number}` : ""}`}>
    <header className="tool-chain-heading">
      <button type="button" className="tool-chain-toggle" aria-label={expanded ? "收起工具链" : "展开工具链"} aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(value => !value)}>
        <Workflow size={15} aria-hidden="true" /><strong>工具步骤{multipleStages ? ` · 阶段 ${stage.number}` : ""}</strong><span className={`tool-chain-state${counts.failed ? " has-error" : ""}`}><i aria-hidden="true" />{status}</span>{expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
      </button>
      {onOpenTools && <button type="button" className="tool-chain-open" aria-label="在侧栏展开工具链" title="在侧栏查看完整工具详情" onClick={() => onOpenTools({ turnId: turn.id })}><PanelRightOpen size={14} aria-hidden="true" /><span>展开</span></button>}
    </header>
    <TurnSummary turn={turn} {...(multipleStages ? { stage } : {})} />
    <div id={contentId} ref={scroll} className={`tool-chain-scroll${expanded ? "" : " is-preview"}`} tabIndex={0} aria-label={expanded ? "本轮工具和思考记录" : "最近执行步骤"} onScroll={() => {
      if (!scroll.current) return;
      follow.current = scroll.current.scrollHeight - scroll.current.scrollTop - scroll.current.clientHeight < 40;
      if (follow.current) setUnseen(false);
    }}>
      {visible.map(item => {
        if (item.kind !== "tool") return renderSupplement(item, !expanded);
        const preview = toolPreview(item);
        return <div key={item.id} className={`tool-chain-step tool-state-${item.status}`}>
          <div className="tool-chain-row"><span className="tool-state-dot" aria-hidden="true" />
            {onOpenTools ? <button type="button" aria-label={`查看 ${item.name} 的工具详情`} title={item.name} onClick={() => onOpenTools({ turnId: turn.id, itemId: item.id })}><span>{preview.title}</span>{preview.title !== item.name && <code>{item.name}</code>}</button> : <span className="tool-step-title">{preview.title}</span>}
            <span className="tool-state-label">{toolStatusLabels[item.status]}</span>
          </div>
          {preview.detail && <code className="tool-step-detail" title={preview.detail}>{preview.detail}</code>}
          {preview.snippet && <pre className="tool-edit-preview" aria-label={item.status === "ok" ? "写入片段" : "拟写入片段"}>{preview.snippet}</pre>}
          {preview.result && <p className="tool-step-result">{preview.result}</p>}
        </div>;
      })}
    </div>
    {expanded && unseen && <button className="tool-chain-latest" type="button" onClick={() => { follow.current = true; setUnseen(false); if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }}>查看最新步骤</button>}
    {!expanded && stage.details.length > recent.length && <p className="tool-chain-earlier">显示最近步骤 · 展开可查看全部 {stage.details.length} 条记录</p>}
  </section>;
}
