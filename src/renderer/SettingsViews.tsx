import type { McpConnection, TaskView } from "../shared/desktop-api";
import { AuditEvents } from "./WorkspaceView";
import { CopyButton, Status } from "./ui";

export function McpView({
  connection,
  task,
  onError,
}: {
  connection: McpConnection | undefined;
  task: TaskView | undefined;
  onError: (value: unknown) => void;
}) {
  const config = connection
    ? {
        mcpServers: {
          specloom: {
            url: connection.url,
            headers: { Authorization: `Bearer ${connection.token}` },
          },
        },
      }
    : undefined;
  const visibleConfig = config
    ? {
        mcpServers: {
          specloom: {
            ...config.mcpServers.specloom,
            headers: {
              ...config.mcpServers.specloom.headers,
              Authorization: "Bearer <访问令牌>",
            },
          },
        },
      }
    : undefined;
  return (
    <section className="standard-view mcp-view">
      <header className="section-heading">
        <h1>MCP</h1>
        <span
          className={`status ${connection ? "status-applied" : "status-staged"}`}
        >
          {connection ? "已启动" : "未连接"}
        </span>
      </header>
      {connection ? (
        <>
          <dl className="connection-fields">
            <dt>地址</dt>
            <dd>
              <code>{connection.url}</code>
              <CopyButton
                value={connection.url}
                label="复制 MCP 地址"
                onError={onError}
              />
            </dd>
            <dt>访问令牌</dt>
            <dd>
              <input
                type="password"
                readOnly
                value={connection.token}
                aria-label="MCP 访问令牌"
              />
              <CopyButton
                value={connection.token}
                label="复制 MCP 访问令牌"
                onError={onError}
              />
            </dd>
            <dt>当前任务 ID</dt>
            <dd>
              <code>{task?.id ?? "未选择任务"}</code>
              {task && (
                <CopyButton
                  value={task.id}
                  label="复制任务 ID"
                  onError={onError}
                />
              )}
            </dd>
          </dl>
          <header className="section-heading">
            <h2>连接配置</h2>
            <CopyButton
              value={JSON.stringify(config, null, 2)}
              label="复制连接配置"
              onError={onError}
            />
          </header>
          <pre className="config-code">
            {JSON.stringify(visibleConfig, null, 2)}
          </pre>
          {task && (
            <>
              <header className="section-heading mcp-tool-heading">
                <h2>files.list_versions · 参数</h2>
                <CopyButton
                  value={JSON.stringify(
                    { taskId: task.id, paths: ["specs/project.md"] },
                    null,
                    2,
                  )}
                  label="复制工具参数"
                  onError={onError}
                />
              </header>
              <pre className="config-code">
                {JSON.stringify(
                  { taskId: task.id, paths: ["specs/project.md"] },
                  null,
                  2,
                )}
              </pre>
            </>
          )}
        </>
      ) : (
        <p className="empty-state">MCP 服务未就绪</p>
      )}
    </section>
  );
}
export function HistoryView({
  tasks,
  onSelect,
}: {
  tasks: TaskView[];
  onSelect: (id: string) => void;
}) {
  return (
    <section className="standard-view">
      <header className="section-heading">
        <h1>历史</h1>
        <span className="subtle">{tasks.length} 个任务</span>
      </header>
      {[...tasks].reverse().map((task) => (
        <article className="history-task" key={task.id}>
          <header className="section-heading">
            <button className="text-button" onClick={() => onSelect(task.id)}>
              {task.scope.title}
            </button>
            <Status status={task.status} running={task.running} />
          </header>
          <code>{task.id}</code>
          {task.summary && <p>{task.summary}</p>}
          <AuditEvents task={task} />
        </article>
      ))}
      {!tasks.length && <p className="empty-state">暂无任务记录</p>}
    </section>
  );
}
