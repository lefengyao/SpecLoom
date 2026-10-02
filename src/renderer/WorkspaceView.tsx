import { ArrowUp, Plus, Square } from "lucide-react";
import { useState } from "react";
import type { ChangeReview, TaskView } from "../shared/desktop-api";
import type { ModelProfile } from "../shared/contracts";
import { ReviewPane } from "./ReviewPane";
import { IconButton, isTerminal, Status } from "./ui";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}
export function AuditEvents({ task }: { task: TaskView }) {
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
            {event.ok ? "完成" : "失败"}
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
  models,
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
  onModels,
}: {
  tasks: TaskView[];
  selected: TaskView | undefined;
  onSelect: (id: string) => void;
  onNew: () => void;
  models: ModelProfile[];
  review: ChangeReview | undefined;
  busy: boolean;
  running: boolean;
  messages: ChatMessage[];
  onSend: (modelId: string, prompt: string) => Promise<void>;
  onCancel: () => void;
  onRefresh: () => void;
  onValidate: () => void;
  onApprove: () => void;
  onReject: () => void;
  onModels: () => void;
  onRestart: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [modelId, setModelId] = useState("");
  const model =
    models.find((item) => item.id === modelId) ??
    models.find((item) => item.approved);
  const terminal = !!selected && isTerminal(selected.status);
  return (
    <div className="workspace-grid">
      <aside className="task-sidebar">
        <header className="section-heading">
          <h2>任务</h2>
          <IconButton label="新建任务" onClick={onNew} disabled={busy}>
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
              <span className="subtle">
                {task.scope.mode === "manual" ? "手动审查" : "自动提交"}
              </span>
            </button>
          ))}
        </div>
        {!tasks.length && <p className="empty-state">尚无任务</p>}
      </aside>
      {!selected ? (
        <div className="workspace-empty">
          <h2>项目工作区</h2>
          <button className="primary" onClick={onNew}>
            <Plus size={16} />
            新建任务
          </button>
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
                  重新创建任务
                </button>
              )}
            </div>
          </header>
          <details className="scope-summary">
            <summary>已授权范围</summary>
            <dl>
              <dt>读取</dt>
              <dd>
                {selected.scope.readPaths.map((path) => (
                  <code key={path}>{path}</code>
                ))}
              </dd>
              <dt>写入</dt>
              <dd>
                {selected.scope.writePaths.length
                  ? selected.scope.writePaths.map((path) => (
                      <code key={path}>{path}</code>
                    ))
                  : "无"}
              </dd>
              <dt>提交</dt>
              <dd>
                {selected.scope.mode === "manual" ? "手动审查" : "自动提交"} ·{" "}
                {selected.scope.allowDelete ? "允许删除" : "禁止删除"}
              </dd>
            </dl>
          </details>
          <section className="agent-section">
            <header className="section-heading">
              <h2>智能体</h2>
              <span className="subtle">{running ? "执行中" : "就绪"}</span>
            </header>
            <div className="chat-messages" aria-live="polite">
              {messages.map((message, index) => (
                <article key={index} className={`chat-${message.role}`}>
                  <strong>{message.role === "user" ? "你" : "智能体"}</strong>
                  <p>{message.content}</p>
                </article>
              ))}
              {!messages.length && selected.summary && (
                <article className="chat-assistant">
                  <strong>智能体</strong>
                  <p>{selected.summary}</p>
                </article>
              )}
              {running && (
                <p className="running-indicator">智能体正在处理任务…</p>
              )}
            </div>
            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                if (!model || !prompt.trim() || terminal) return;
                const content = prompt.trim();
                setPrompt("");
                void onSend(model.id, content);
              }}
            >
              <textarea
                aria-label="任务消息"
                placeholder="输入任务消息"
                rows={3}
                value={prompt}
                disabled={running || terminal}
                onChange={(event) => setPrompt(event.target.value)}
              />
              <footer>
                <div className="model-control">
                  <select
                    aria-label="选择模型"
                    value={model?.id ?? ""}
                    disabled={running || terminal}
                    onChange={(event) => setModelId(event.target.value)}
                  >
                    <option value="" disabled>
                      选择模型
                    </option>
                    {models.map((profile) => (
                      <option value={profile.id} key={profile.id}>
                        {profile.name}
                        {profile.approved ? "" : " · 未授权"}
                      </option>
                    ))}
                  </select>
                  {!models.length && (
                    <button type="button" onClick={onModels}>
                      配置模型
                    </button>
                  )}
                </div>
                {running ? (
                  <button type="button" onClick={onCancel}>
                    <Square size={14} />
                    停止
                  </button>
                ) : (
                  <button
                    className="primary"
                    disabled={
                      busy || terminal || !model?.approved || !prompt.trim()
                    }
                  >
                    <ArrowUp size={16} />
                    发送
                  </button>
                )}
              </footer>
            </form>
            {selected.events.length > 0 && (
              <details className="audit-section" open={running}>
                <summary>工具记录 · {selected.events.length}</summary>
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
