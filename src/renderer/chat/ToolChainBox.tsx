import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, PanelRightOpen, Workflow } from "lucide-react";
import { toolCounts, toolStatusLabels, type ChatDetailItem, type ChatDetailStage, type ChatTurn, type ToolSidebarSelection } from "./tool-chain";
import "./tool-sidebar.css";
import { useI18n } from "../i18n";
import { toolPreview } from "./tool-preview";

export type { ToolSidebarSelection } from "./tool-chain";

export function TurnSummary({ turn, stage }: { turn: ChatTurn; stage?: ChatDetailStage }) {
  const tr = useI18n();
  const tools = stage?.tools ?? turn.tools;
  const counts = toolCounts(tools);
  const names = new Map<string, number>();
  for (const tool of tools) names.set(tool.name, (names.get(tool.name) ?? 0) + 1);
  return <details className="run-summary tool-chain-statistics"><summary>{turn.number ? tr("第 {round} 轮工具调用", { round: turn.number }) : tr("历史工具调用")}{stage ? ` · ${tr("阶段 {number}", { number: stage.number })}` : ""} · {tr("{count} 次", { count: tools.length })} · {tr("{count} 次失败", { count: counts.failed })} · {tr("{count} 次停止", { count: counts.cancelled })}{counts.pending ? ` · ${tr("{count} 次进行中", { count: counts.pending })}` : ""}</summary>
    {tools.length ? <ul>{[...names].map(([name, count]) => <li key={name}>{name} × {count}</li>)}</ul> : <p>{stage ? tr("本阶段没有调用工具。") : tr("本轮没有调用工具。")}</p>}
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
  const tr = useI18n();
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
  const status = counts.pending ? tr("进行中") : counts.failed ? tr("有失败") : live ? tr("进行中") : tr("已结束");
  const label = turn.number ? tr("第 {round} 轮工具链", { round: turn.number }) : tr("历史工具链");
  return <section className={`tool-chain-box${live ? " is-live" : ""}`} role="region" aria-label={`${label}${stage.number > 1 ? ` · ${tr("阶段 {number}", { number: stage.number })}` : ""}`}>
    <header className="tool-chain-heading">
      <button type="button" className="tool-chain-toggle" aria-label={expanded ? tr("收起工具链") : tr("展开工具链")} aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(value => !value)}>
        <Workflow size={15} aria-hidden="true" /><strong>{tr("工具步骤")}{multipleStages ? ` · ${tr("阶段 {number}", { number: stage.number })}` : ""}</strong><span className={`tool-chain-state${counts.failed ? " has-error" : ""}`}><i aria-hidden="true" />{status}</span>{expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
      </button>
      {onOpenTools && <button type="button" className="tool-chain-open" aria-label={tr("在侧栏展开工具链")} title={tr("在侧栏查看完整工具详情")} onClick={() => onOpenTools({ turnId: turn.id })}><PanelRightOpen size={14} aria-hidden="true" /><span>{tr("展开")}</span></button>}
    </header>
    <TurnSummary turn={turn} {...(multipleStages ? { stage } : {})} />
    <div id={contentId} ref={scroll} className={`tool-chain-scroll${expanded ? "" : " is-preview"}`} tabIndex={0} aria-label={expanded ? tr("本轮工具和思考记录") : tr("最近执行步骤")} onScroll={() => {
      if (!scroll.current) return;
      follow.current = scroll.current.scrollHeight - scroll.current.scrollTop - scroll.current.clientHeight < 40;
      if (follow.current) setUnseen(false);
    }}>
      {visible.map(item => {
        if (item.kind !== "tool") return renderSupplement(item, !expanded);
        const preview = toolPreview(item);
        return <div key={item.id} className={`tool-chain-step tool-state-${item.status}`}>
          <div className="tool-chain-row"><span className="tool-state-dot" aria-hidden="true" />
            {onOpenTools ? <button type="button" aria-label={tr("查看 {name} 的工具详情", { name: item.name })} title={item.name} onClick={() => onOpenTools({ turnId: turn.id, itemId: item.id })}><span>{tr(preview.title)}</span>{preview.title !== item.name && <code>{item.name}</code>}</button> : <span className="tool-step-title">{tr(preview.title)}</span>}
            <span className="tool-state-label">{tr(toolStatusLabels[item.status])}</span>
          </div>
          {preview.detail && <code className="tool-step-detail" title={preview.detail}>{preview.detail}</code>}
          {preview.snippet && <pre className="tool-edit-preview" aria-label={item.status === "ok" ? tr("写入片段") : tr("拟写入片段")}>{preview.snippet}</pre>}
          {preview.result && <p className="tool-step-result">{preview.result}</p>}
        </div>;
      })}
    </div>
    {expanded && unseen && <button className="tool-chain-latest" type="button" onClick={() => { follow.current = true; setUnseen(false); if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }}>{tr("查看最新步骤")}</button>}
    {!expanded && stage.details.length > recent.length && <p className="tool-chain-earlier">{tr("显示最近步骤 · 展开可查看全部 {count} 条记录", { count: stage.details.length })}</p>}
  </section>;
}
