import { ArrowUp, Plus, Square } from "lucide-react";
import { useEffect, useState } from "react";
import type { ChangeReview, TaskView } from "../shared/desktop-api";
import type { ModelProfile, ModelReference, ProviderPublic, ReasoningPreference, SessionModelPreference } from "../shared/contracts";
import { useI18n } from "./i18n";
import { ReviewPane } from "./ReviewPane";
import { IconButton, isTerminal, Status } from "./ui";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}
type ModelOption = {
  key: string;
  label: string;
  reference: string | ModelReference;
  approved: boolean;
};

function AgentComposer({
  prompt,
  setPrompt,
  model,
  options,
  reasoning,
  running,
  terminal,
  busy,
  empty,
  onSend,
  onCancel,
  onProviders,
  onSessionModel,
  onModelChange,
  onStartConversation,
}: {
  prompt: string;
  setPrompt: (value: string) => void;
  model: ModelOption | undefined;
  options: ModelOption[];
  reasoning: ReasoningPreference;
  running: boolean;
  terminal: boolean;
  busy: boolean;
  empty?: boolean;
  onSend: (modelId: string | ModelReference, prompt: string) => Promise<void>;
  onCancel: () => void;
  onProviders: () => void;
  onSessionModel: ((preference: SessionModelPreference | null) => Promise<void>) | undefined;
  onModelChange: (key: string, nextReasoning?: ReasoningPreference) => void;
  onStartConversation: ((model: string | ModelReference, prompt: string) => void | Promise<void>) | undefined;
}) {
  const tr = useI18n();
  const blocked = running || terminal;
  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (!model || !model.approved || !prompt.trim() || blocked || (empty && !onStartConversation)) return;
        const content = prompt.trim();
        setPrompt("");
        if (empty) {
          void onStartConversation?.(model.reference, content);
          return;
        }
        void onSend(model.reference, content);
      }}
    >
      <textarea
        aria-label={tr("任务消息")}
        placeholder={empty ? tr("输入消息") : tr("输入任务消息")}
        rows={3}
        value={prompt}
        disabled={blocked}
        onChange={(event) => setPrompt(event.target.value)}
      />
      <footer>
        <div className="model-control">
          <select
            aria-label={tr("选择模型")}
            value={model?.key ?? ""}
            disabled={blocked}
            onChange={(event) => onModelChange(event.target.value)}
          >
            <option value="" disabled>
              {tr("选择模型")}
            </option>
            {options.map((item) => (
              <option value={item.key} key={item.key}>
                {item.label}
                {item.approved ? "" : ` · ${tr("未授权")}`}
              </option>
            ))}
          </select>
          {model?.reference && typeof model.reference !== "string" && onSessionModel && (
            <select
              aria-label={tr("思考偏好")}
              value={reasoning}
              disabled={blocked}
              onChange={(event) => onModelChange(model.key, event.target.value as ReasoningPreference)}
            >
              {(["inherit", "off", "low", "medium", "high"] as const).map((level) => <option key={level} value={level}>{level === "inherit" ? tr("思考：继承模型默认") : tr("思考：{level}", { level })}</option>)}
            </select>
          )}
          {!options.length && (
            <button type="button" onClick={onProviders}>
              {tr("配置供应商")}
            </button>
          )}
          {options.length > 0 && !model && <span className="field-hint">{tr("当前模型引用不可用，请重新选择")}</span>}
        </div>
        {running ? (
          <button type="button" onClick={onCancel}>
            <Square size={14} />
            {tr("停止")}
          </button>
        ) : (
          <button
            className="primary"
            disabled={
              busy || terminal || !model?.approved || !prompt.trim() || (empty && !onStartConversation)
            }
          >
            <ArrowUp size={16} />
            {tr("发送")}
          </button>
        )}
      </footer>
    </form>
  );
}

export function AuditEvents({ task }: { task: TaskView }) {
  const tr = useI18n();
  return (
    <ol className="audit-events">
      {task.events.map((event, index) => (
        <li key={index}>
          <time>
            {new Date(event.time).toLocaleTimeString("zh-CN", {
              hour12: false,
            })}
          </time>
          <code>{event.tool}</code>
          <span className={event.ok ? "event-ok" : "event-fail"}>
            {event.ok ? tr("完成") : tr("失败")}
          </span>
          <span>{event.message}</span>
        </li>
      ))}
    </ol>
  );
}
export function WorkspaceView({
  tasks,
  selected,
  onSelect,
  onNew,
  onRestart,
  providers = [],
  defaultModel,
  sessionModel,
  review,
  busy,
  running,
  messages,
  onSend,
  onCancel,
  onRefresh,
  onValidate,
  onApprove,
  onReject,
  onProviders,
  onSessionModel,
  onStartConversation,
}: {
  tasks: TaskView[];
  selected: TaskView | undefined;
  onSelect: (id: string) => void;
  onNew: () => void;
  models: ModelProfile[];
  providers?: ProviderPublic[];
  defaultModel?: ModelReference;
  sessionModel?: SessionModelPreference;
  review: ChangeReview | undefined;
  busy: boolean;
  running: boolean;
  messages: ChatMessage[];
  onSend: (modelId: string | ModelReference, prompt: string) => Promise<void>;
  onCancel: () => void;
  onRefresh: () => void;
  onValidate: () => void;
  onApprove: () => void;
  onReject: () => void;
  onProviders: () => void;
  onSessionModel?: (preference: SessionModelPreference | null) => Promise<void>;
  onStartConversation?: (model: string | ModelReference, prompt: string) => void | Promise<void>;
  onRestart: () => void;
}) {
  const tr = useI18n();
  const [prompt, setPrompt] = useState("");
  const preferredModel = sessionModel ?? defaultModel;
  const [modelId, setModelId] = useState(preferredModel ? `${preferredModel.providerId}:${preferredModel.model}` : "");
  const [reasoning, setReasoning] = useState<ReasoningPreference>(sessionModel?.reasoning ?? "inherit");
  useEffect(() => {
    const preferred = sessionModel ?? defaultModel;
    if (preferred) setModelId(`${preferred.providerId}:${preferred.model}`);
  }, [defaultModel?.providerId, defaultModel?.model, sessionModel?.providerId, sessionModel?.model]);
  useEffect(() => {
    setReasoning(sessionModel?.reasoning ?? "inherit");
  }, [sessionModel?.providerId, sessionModel?.model, sessionModel?.reasoning]);
  const providerModels: ModelOption[] = providers.flatMap((provider) => provider.models.map((model) => ({ key: `${provider.id}:${model}`, label: `${provider.name} / ${model}`, reference: { providerId: provider.id, model } as ModelReference, approved: true })));
  // Legacy model profiles remain in WorkspaceState for migration/runtime compatibility,
  // but are no longer selectable. Provider references are the only supported UI path.
  const options = providerModels;
  const model = options.find((item) => item.key === modelId) ?? options.find((item) => item.approved);
  const terminal = !!selected && isTerminal(selected.status);
  function updateSessionModel(key: string, nextReasoning = reasoning): void {
    const item = options.find((candidate) => candidate.key === key);
    if (!item) return;
    setModelId(key);
    if (typeof item.reference !== "string" && onSessionModel) {
      setReasoning(nextReasoning);
      void onSessionModel({ ...item.reference, reasoning: nextReasoning });
    }
  }
  useEffect(() => {
    if (selected) setPrompt("");
  }, [selected?.id]);
  return (
    <div className="workspace-grid">
      <aside className="task-sidebar">
        <header className="section-heading">
          <h2>{tr("任务")}</h2>
          <IconButton label={tr("新建任务")} onClick={onNew} disabled={busy}>
            <Plus size={18} />
          </IconButton>
        </header>
        <div className="task-list">
          {tasks.map((task) => (
            <button
              key={task.id}
              className={`task-row ${selected?.id === task.id ? "selected" : ""}`}
              onClick={() => onSelect(task.id)}
            >
              <strong>{task.scope.title}</strong>
              <Status status={task.status} running={task.running} />
            </button>
          ))}
        </div>
        {!tasks.length && <p className="empty-state">{tr("尚无任务")}</p>}
      </aside>
      {!selected ? (
        <div className="workspace-empty">
          <section className="agent-section workspace-empty-agent">
            <header className="section-heading">
              <h2>{tr("智能体对话")}</h2>
              <span className="subtle">{tr("项目智能体会话")}</span>
            </header>
            <p className="subtle">{tr("会话可以使用项目工具与扩展；工具调用和文件变更会保留记录。")}</p>
            <div className="chat-messages" aria-live="polite">
              {messages.map((message, index) => (
                <article key={index} className={`chat-${message.role}`}>
                  <strong>{message.role === "user" ? tr("你") : tr("智能体")}</strong>
                  <p>{message.content}</p>
                </article>
              ))}
              {running && <p className="running-indicator">{tr("智能体正在思考…")}</p>}
            </div>
            <AgentComposer
              prompt={prompt}
              setPrompt={setPrompt}
              model={model}
              options={options}
              reasoning={reasoning}
              running={running}
              terminal={false}
              busy={busy}
              empty
              onSend={onSend}
              onCancel={onCancel}
              onProviders={onProviders}
              onSessionModel={onSessionModel}
              onModelChange={updateSessionModel}
              onStartConversation={onStartConversation}
            />
            <button type="button" onClick={onNew} disabled={busy}>
              <Plus size={16} />
              {tr("只创建任务")}
            </button>
          </section>
        </div>
      ) : (
        <div className="task-content">
          <header className="task-heading">
            <div>
              <h1>{selected.scope.title}</h1>
              <code>{selected.id}</code>
            </div>
            <div className="task-heading-actions">
              <Status status={selected.status} running={running} />
              {terminal && (
                <button disabled={busy} onClick={onRestart}>
                  <Plus size={14} />
                  {tr("重新创建任务")}
                </button>
              )}
            </div>
          </header>
          <details className="scope-summary">
            <summary>{tr("已授权范围")}</summary>
            <dl>
              <dt>{tr("目标")}</dt>
              <dd>{selected.scope.goal ?? selected.scope.title}</dd>
              <dt>{tr("读取")}</dt>
              <dd>
                {selected.scope.readPaths.map((path) => (
                  <code key={path}>{path}</code>
                ))}
              </dd>
              <dt>{tr("写入")}</dt>
              <dd>
                {selected.scope.writePaths.length
                  ? selected.scope.writePaths.map((path) => (
                      <code key={path}>{path}</code>
                    ))
                  : tr("无")}
              </dd>
              <dt>{tr("删除")}</dt>
              <dd>
                {selected.scope.allowDelete ? tr("允许删除") : tr("禁止删除")}
              </dd>
            </dl>
          </details>
          <section className="agent-section">
            <header className="section-heading">
              <h2>{tr("智能体")}</h2>
              <span className="subtle">{running ? tr("执行中") : tr("就绪")}</span>
            </header>
            <div className="chat-messages" aria-live="polite">
              {messages.map((message, index) => (
                <article key={index} className={`chat-${message.role}`}>
                  <strong>{message.role === "user" ? tr("你") : tr("智能体")}</strong>
                  <p>{message.content}</p>
                </article>
              ))}
              {!messages.length && selected.summary && (
                <article className="chat-assistant">
                  <strong>{tr("智能体")}</strong>
                  <p>{selected.summary}</p>
                </article>
              )}
              {running && (
                <p className="running-indicator">{tr("智能体正在处理任务…")}</p>
              )}
            </div>
            <AgentComposer
              prompt={prompt}
              setPrompt={setPrompt}
              model={model}
              options={options}
              reasoning={reasoning}
              running={running}
              terminal={terminal}
              busy={busy}
              onSend={onSend}
              onCancel={onCancel}
              onProviders={onProviders}
              onSessionModel={onSessionModel}
              onModelChange={updateSessionModel}
              onStartConversation={undefined}
            />
            {selected.events.length > 0 && (
              <details className="audit-section" open={running}>
                <summary>{tr("工具记录 · {count}", { count: selected.events.length })}</summary>
                <AuditEvents task={selected} />
              </details>
            )}
          </section>
          <ReviewPane
            review={review}
            running={running}
            busy={busy}
            onRefresh={onRefresh}
            onValidate={onValidate}
            onApprove={onApprove}
            onReject={onReject}
          />
        </div>
      )}
    </div>
  );
}
