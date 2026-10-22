import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { validateAnswer, type ChatItem, type QuestionAnswer } from "../../shared/chat";
import { errorMessage } from "../../shared/error-message";
import type { Preferences } from "../../shared/preferences";
import { Avatar } from "../Avatar";
import { useI18n } from "../i18n";
import { ToolChainBox, TurnSummary, type ToolSidebarSelection } from "./ToolChainBox";
import { splitChatTurns, splitTurnBlocks } from "./tool-chain";
import { FileChangesSummary } from "./FileChangesSummary";

type ChatDisplayPreferences = Pick<Preferences, "userAvatar" | "assistantAvatar" | "hideAgentDetails" | "showOutputRate" | "showFirstTokenLatency" | "showThinkingDuration">;

/** Native collapsed details still mount their children; defer expensive history until opened. */
function LazyDetails({ children, summary, collapsed = false, ...props }: { children: React.ReactNode; summary: React.ReactNode; collapsed?: boolean; className?: string; "aria-label"?: string }) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { if (collapsed) setExpanded(false); }, [collapsed]);
  return <div className="thinking-step"><details {...props} open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
    {summary}{expanded && children}
  </details></div>;
}

function Copy({ text, kind = "message" }: { text: string; kind?: "message" | "code" | "user" | "ai" }) {
  const tr = useI18n();
  const label = kind === "code" ? tr("复制代码") : kind === "user" ? tr("复制用户消息") : kind === "ai" ? tr("复制AI回复") : tr("复制消息");
  const [status, setStatus] = useState("");
  return <button type="button" className="copy-message" aria-label={label} onClick={() => { void Promise.resolve().then(() => navigator.clipboard.writeText(text)).then(() => setStatus(tr("已复制")), () => setStatus(tr("复制失败"))); }}>{status || label}</button>;
}
const replyMarkdownComponents: React.ComponentProps<typeof ReactMarkdown>["components"] = {
  pre: ({ children }) => {
    const element = children as React.ReactElement<{ children?: string }>;
    return <div className="code-block"><Copy text={String(element.props?.children ?? "")} kind="code" /><pre>{children}</pre></div>;
  },
  a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
};
const MarkdownContent = memo(function MarkdownContent({ content, reply = false }: { content: string; reply?: boolean }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={reply ? replyMarkdownComponents : undefined}>{content}</ReactMarkdown>;
});
function answerLabel(field: Extract<ChatItem, { kind: "question" }>["question"]["fields"][number], value: string | string[] | undefined, empty: string): string {
  if (value === undefined) return empty;
  const label = (id: string) => field.type === "text" ? id : field.options?.find((option) => option.id === id)?.label ?? id;
  return Array.isArray(value) ? value.map(label).join("、") : label(value);
}
function formatDuration(ms: number): string { return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`; }

const approvalStatusLabel: Record<Extract<ChatItem, { kind: "approval" }>["status"], string> = {
  waiting: "等待批准", approved: "已批准", denied: "已拒绝", interrupted: "运行已中断", cancelled: "已取消",
};

export function ApprovalCard({ item, enabled, onApprove }: {
  item: Extract<ChatItem, { kind: "approval" }>;
  enabled: boolean;
  onApprove: (approved: boolean) => Promise<void>;
}) {
  const tr = useI18n();
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<boolean>();
  const pending = useRef(false);
  const [error, setError] = useState("");
  const waiting = item.status === "waiting";
  async function respond(approved: boolean) {
    if (!enabled || !waiting || pending.current || submitted !== undefined) return;
    pending.current = true; setSubmitting(true); setError("");
    try { await onApprove(approved); setSubmitted(approved); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { pending.current = false; setSubmitting(false); }
  }
  const { request } = item;
  const status = submitting ? tr("提交中…") : waiting && submitted !== undefined ? submitted ? tr("已批准") : tr("已拒绝") : tr(approvalStatusLabel[item.status]);
  return <article className={`approval-card approval-${item.status}`} aria-label={tr("审批请求")}>
    <header><strong>{tr("需要审批：{tool}", { tool: request.toolName })}</strong><span>{status}</span></header>
    <dl className="approval-details">
      <div><dt>{tr("原因")}</dt><dd>{request.reason}</dd></div>
      <div><dt>{tr("风险")}</dt><dd>{request.risk === "high" ? tr("高风险") : tr("标准操作")}</dd></div>
    </dl>
    <pre aria-label={tr("操作参数")}>{request.arguments || tr("无")}</pre>
    {error && <p role="alert" className="event-fail">{error}</p>}
    {waiting && submitted === undefined && <footer><button type="button" disabled={submitting || !enabled} onClick={() => void respond(false)}>{tr("拒绝")}</button><button type="button" className="primary" disabled={submitting || !enabled} onClick={() => void respond(true)}>{tr("批准")}</button></footer>}
  </article>;
}

export const MessageBubble = memo(function MessageBubble({ item, avatars, preferences, progress = false, streaming = false }: { item: Extract<ChatItem, { kind: "message" }>; avatars?: Pick<ChatDisplayPreferences, "userAvatar" | "assistantAvatar"> | undefined; preferences?: ChatDisplayPreferences | undefined; progress?: boolean; streaming?: boolean }) {
  const tr = useI18n();
  return <article className={`message-bubble chat-${item.role}${progress ? " chat-progress" : ""}`} data-message-id={item.id}>
    <div className="bubble-label"><Avatar role={item.role} source={item.role === "user" ? avatars?.userAvatar : avatars?.assistantAvatar} /><span>{item.role === "user" ? tr("你") : progress ? tr("智能体 · 进度说明") : tr("智能体")}{streaming ? ` · ${tr("生成中")}` : item.partial && !progress ? ` · ${tr("部分回复")}` : ""}</span></div>
    <div className="bubble-content">{item.role === "user" ? <p>{item.content}</p> : <MarkdownContent content={item.content} reply />}</div>
    {item.role === "assistant" && !progress && item.metrics && preferences && <div className="response-metrics"><span>{tr("总耗时 {duration}", { duration: formatDuration(item.metrics.durationMs) })}</span>{preferences.showOutputRate && <span>{tr("输出 {rate} token/s", { rate: item.metrics.outputRate.toFixed(1) })}</span>}{preferences.showFirstTokenLatency && <span>{tr("首字 {duration}", { duration: formatDuration(item.metrics.firstTokenMs) })}</span>}{preferences.showThinkingDuration && <span>{tr("思考 {duration}", { duration: formatDuration(item.metrics.thinkingMs) })}</span>}</div>}
    {item.content && <Copy text={item.content} kind={item.role === "user" ? "user" : "ai"} />}
  </article>;
});

export function QuestionCard({ item, onAnswer }: { item: Extract<ChatItem, { kind: "question" }>; onAnswer: (answer: QuestionAnswer) => Promise<void> }) {
  const tr = useI18n();
  const [answers, setAnswers] = useState<QuestionAnswer>(() => Object.fromEntries(item.question.fields.filter((f) => f.defaultValue !== undefined).map((f) => [f.id, f.defaultValue!])));
  const [deferred, setDeferred] = useState(false); const [submitting, setSubmitting] = useState(false); const [error, setError] = useState("");
  const waiting = item.status === "waiting";
  async function submit() {
    if (submitting) return;
    try { validateAnswer(item.question, answers); setError(""); setSubmitting(true); await onAnswer(answers); }
    catch (e) { setError(errorMessage(e)); }
    finally { setSubmitting(false); }
  }
  return <article className="question-card" aria-label={tr("需求问答")}>
    <header><strong>{item.question.title}</strong><span>{waiting ? tr("等待回答") : item.status === "answered" ? tr("已回答") : tr("运行已中断")}</span></header>
    {item.question.description && <p>{item.question.description}</p>}
    {!waiting ? <div>{item.answer ? <dl>{item.question.fields.map((f) => <div key={f.id}><dt>{f.label}</dt><dd>{answerLabel(f, item.answer?.[f.id], tr("未填写"))}</dd></div>)}</dl> : <p>{tr("请重新发送以继续任务。")}</p>}</div> : deferred ? <button type="button" onClick={() => setDeferred(false)}>{tr("继续回答")}</button> : <>
      {item.question.fields.map((field) => <fieldset key={field.id} disabled={submitting}><legend>{field.label}{field.required ? tr("（必填）") : ""}</legend>
        {field.type === "text" ? <textarea aria-label={`${field.label}${field.required ? tr("（必填）") : ""}`} value={typeof answers[field.id] === "string" ? answers[field.id] as string : ""} onChange={(e) => setAnswers((current) => ({ ...current, [field.id]: e.target.value }))} /> : field.options?.map((option) => {
          const current = answers[field.id]; const selected = field.type === "multi" ? Array.isArray(current) && current.includes(option.id) : current === option.id;
          return <label key={option.id}><input name={`${item.id}:${field.id}`} type={field.type === "multi" ? "checkbox" : "radio"} checked={selected} onChange={() => setAnswers((previous) => ({ ...previous, [field.id]: field.type === "single" ? option.id : selected ? (Array.isArray(previous[field.id]) ? previous[field.id] as string[] : []).filter((v) => v !== option.id) : [...(Array.isArray(previous[field.id]) ? previous[field.id] as string[] : []), option.id] }))} /><span>{option.label}{option.description && <small>{option.description}</small>}</span></label>;
        })}
      </fieldset>)}
      {error && <p role="alert" className="event-fail">{error}</p>}
      <footer><button type="button" disabled={submitting} onClick={() => setDeferred(true)}>{tr("稍后处理")}</button><button type="button" className="primary" disabled={submitting} onClick={() => void submit()}>{submitting ? tr("提交中…") : tr("提交回答")}</button></footer>
    </>}
  </article>;
}

function ThinkingCard({ item, live, compact }: { item: Extract<ChatItem, { kind: "thinking" }>; live: boolean; compact: boolean }) {
  const tr = useI18n();
  return <LazyDetails className="thinking-card" aria-label={tr("模型返回的思考")} collapsed={compact}
    summary={<summary>{live ? tr("模型思考 · 思考中") : item.partial ? tr("模型思考 · 部分内容") : tr("模型思考")}<span>{tr("供应商返回")}</span></summary>}>
    <div className="bubble-content"><MarkdownContent content={item.content} /></div>
  </LazyDetails>;
}

export function nearBottom(element: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">): boolean { return element.scrollHeight - element.scrollTop - element.clientHeight < 80; }
export function ChatTimeline({ items, sessionId, runId, running = false, children, introduction, avatars, preferences, onAnswer, onApprove, onOpenTools }: { items: ChatItem[]; sessionId: string; runId?: string | undefined; running?: boolean; children?: React.ReactNode; introduction?: React.ReactNode; avatars?: Pick<ChatDisplayPreferences, "userAvatar" | "assistantAvatar"> | undefined; preferences?: ChatDisplayPreferences | undefined; onAnswer: (item: Extract<ChatItem, { kind: "question" }>, answer: QuestionAnswer) => Promise<void>; onApprove?: (item: Extract<ChatItem, { kind: "approval" }>, approved: boolean) => Promise<void>; onOpenTools?: ((selection: ToolSidebarSelection) => void) | undefined }) {
  const tr = useI18n();
  const ref = useRef<HTMLDivElement>(null); const follow = useRef(true); const [unseen, setUnseen] = useState(false);
  useEffect(() => { follow.current = true; setUnseen(false); if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [sessionId]);
  useEffect(() => { if (!ref.current) return; if (follow.current) ref.current.scrollTop = ref.current.scrollHeight; else setUnseen(true); }, [items, children]);
  const turns = useMemo(() => splitChatTurns(items).map(turn => {
    const blocks = splitTurnBlocks(turn);
    return { turn, blocks, stageCount: blocks.filter(block => block.kind === "details").length };
  }), [items]);
  // Guidance is appended while the same model response can still be streaming.
  let latest: ChatItem | undefined;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    if (item.kind === "message" && item.role === "user" && item.guidance) continue;
    latest = item;
    break;
  }
  const thinkingId = running && latest?.kind === "thinking" && latest.partial && runId && latest.id.startsWith(`${runId}:`) ? latest.id : undefined;
  return <div className="timeline-shell"><div className="conversation-timeline" ref={ref} role="log" aria-label={tr("对话时间线")} onScroll={() => { if (ref.current) { follow.current = nearBottom(ref.current); if (follow.current) setUnseen(false); } }}>
    {introduction}
    {turns.map(({ turn, blocks, stageCount }, index) => <Fragment key={turn.id}>
      {blocks.map((block, blockIndex) => {
        if (block.kind === "details") return <ToolChainBox key={`chain:${block.stage.id}`} turn={turn} stage={block.stage} multipleStages={stageCount > 1} live={running && index === turns.length - 1 && blockIndex === blocks.length - 1} collapsed={preferences?.hideAgentDetails ?? false} onOpenTools={onOpenTools} renderSupplement={(detail, compact) => detail.kind === "thinking" ? <ThinkingCard key={detail.id} item={detail} live={thinkingId === detail.id} compact={compact} /> : <p key={detail.id} className="activity-item">{compact ? detail.content.slice(-220) : detail.content}</p>} />;
        const { item, progress } = block;
        if (item.kind === "message") {
          const streaming = running && !!runId && !!item.partial && item.role === "assistant" && latest?.id === item.id && item.id.startsWith(`${runId}:`);
          return <Fragment key={item.id}>{(item.content || !item.fileChanges) && <MessageBubble item={item} progress={progress} streaming={streaming} avatars={avatars} {...(preferences ? { preferences } : {})} />}</Fragment>;
        }
        if (item.kind === "question") return <QuestionCard key={item.id} item={item} onAnswer={(answer) => onAnswer(item, answer)} />;
        return <ApprovalCard key={item.id} item={item} enabled={!!onApprove && running && item.request.sessionId === sessionId && item.request.runId === runId} onApprove={(approved) => onApprove ? onApprove(item, approved) : Promise.reject(new Error(tr("审批暂不可用")))} />;
      })}
      {turn.items.filter((item): item is Extract<ChatItem, { kind: "message" }> => item.kind === "message" && !!item.fileChanges).map(item => <FileChangesSummary key={`${item.id}:files`} report={item.fileChanges!} />)}
      {!turn.details.length && !!turn.number && <TurnSummary turn={turn} />}
    </Fragment>)}
    {children}
  </div>{unseen && <button className="return-latest" type="button" onClick={() => { follow.current = true; setUnseen(false); if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }}>{tr("回到最新")}</button>}</div>;
}
