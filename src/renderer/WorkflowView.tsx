import { Copy, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ModelProfile } from "../shared/contracts";
import type { DesktopApi } from "../shared/desktop-api";
import type { WorkflowNodeStatus } from "../shared/workflow-api";
import { WorkflowCanvas } from "./workflow/WorkflowCanvas";
import { WorkflowInspector } from "./workflow/WorkflowInspector";
import { WorkflowRunPanel } from "./workflow/WorkflowRunPanel";
import { useWorkflow, workflowRunStatusLabels } from "./workflow/useWorkflow";
import "./workflow/workflow.css";

export interface WorkflowViewProps {
  api: DesktopApi | undefined;
  models: ModelProfile[];
  projectPath: string;
  onError?: (error: unknown) => void;
}

/**
 * The workflow page: a build mode that edits a project definition on a React
 * Flow canvas, and a run mode that shows the latest run on the same canvas with
 * an approval panel.
 */
export function WorkflowView({ api, models, projectPath, onError }: WorkflowViewProps) {
  const workflow = useWorkflow(api, projectPath, onError);
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>(undefined);
  const definition = workflow.definition;
  const definitionId = definition?.id;

  // A different definition starts with no node selected.
  useEffect(() => {
    setSelectedNodeId(undefined);
  }, [definitionId]);

  const selectedNode = definition?.nodes.find((node) => node.id === selectedNodeId);

  // A run belongs to one definition; switching workflows hides an unrelated run.
  const activeRun = workflow.run && workflow.run.workflowId === definition?.id ? workflow.run : undefined;

  const nodeStatuses = useMemo(() => {
    const statuses: Record<string, WorkflowNodeStatus> = {};
    if (!activeRun) return statuses;
    for (const state of activeRun.nodeStates) statuses[state.id] = state.status;
    return statuses;
  }, [activeRun]);

  const loading = workflow.loading;
  const dirty = workflow.dirty;

  return (
    <section className="workflow-view" aria-label="工作流">
      <header className="workflow-header">
        <div className="workflow-heading">
          <h1>工作流</h1>
          <p className="subtle">官方开发审查流程可复制、可编辑、可运行</p>
        </div>
        <div className="workflow-toolbar">
          <div className="workflow-mode" role="group" aria-label="工作流模式">
            <button type="button" aria-pressed={workflow.mode === "build"} onClick={() => workflow.setMode("build")}>
              编排
            </button>
            <button type="button" aria-pressed={workflow.mode === "run"} onClick={() => workflow.setMode("run")}>
              运行
            </button>
          </div>
          {workflow.mode === "build" && (
            <button type="button" className="primary" disabled={!dirty || !definition || loading} onClick={() => void workflow.save()}>
              <Save size={15} />
              保存
            </button>
          )}
          <button type="button" disabled={loading} title="刷新工作流列表" onClick={() => void workflow.refresh()}>
            <RefreshCw size={15} />
            刷新
          </button>
          <button
            type="button"
            disabled={!definition || !workflow.fileVersion || loading}
            title="删除当前工作流"
            onClick={() => {
              if (!definition) return;
              if (typeof window.confirm === "function" && !window.confirm("删除工作流 " + definition.title + "？此操作不会删除运行记录。")) return;
              void workflow.removeSelected();
            }}
          >
            <Trash2 size={15} />
            删除
          </button>
        </div>
      </header>

      {!workflow.available ? (
        <p className="workflow-empty" role="status">
          当前桌面版本没有提供工作流接口，无法加载或运行工作流。
        </p>
      ) : (
        <div className={"workflow-layout" + (workflow.mode === "build" && !selectedNode ? " is-inspector-empty" : "")}>
          <aside className="workflow-sidebar" aria-label="我的工作流">
            <header className="workflow-sidebar-head">
              <h2>我的工作流</h2>
              <span className="subtle">{workflow.summaries.length} 个</span>
            </header>

            {workflow.summaries.length === 0 ? (
              <p className="workflow-empty">还没有项目工作流。可以新建空白流程，或从官方模板复制一份。</p>
            ) : (
              <ul className="workflow-list">
                {workflow.summaries.map((summary) => (
                  <li key={summary.id}>
                    <button
                      type="button"
                      className="workflow-list-item"
                      aria-pressed={summary.id === workflow.selectedId}
                      onClick={() => void workflow.select(summary.id)}
                    >
                      <span className="workflow-list-title">{summary.title}</span>
                      <code className="workflow-list-id">{summary.id}</code>
                      <span className="workflow-list-meta">
                        节点 {summary.nodeCount} · 写入 {summary.writeCount}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {workflow.runs.length > 0 && (
              <section className="workflow-runs" aria-label="最近运行">
                <h2>最近运行</h2>
                <ul>
                  {workflow.runs.slice(0, 6).map((item) => (
                    <li key={item.runId}>
                      <button
                        type="button"
                        aria-pressed={workflow.run?.runId === item.runId}
                        onClick={() => void workflow.openRun(item)}
                        title={item.runId}
                      >
                        <span className="workflow-run-item-title">{item.title}</span>
                        <span className="workflow-run-item-meta">
                          {workflowRunStatusLabels[item.status]} · {new Date(item.startedAt).toLocaleString("zh-CN")}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <div className="workflow-sidebar-actions">
              <button type="button" disabled={loading} onClick={() => void workflow.newBlank()}>
                <Plus size={14} />
                新建空白
              </button>
              <button type="button" disabled={loading} onClick={() => void workflow.copyOfficial()}>
                <Copy size={14} />
                从官方复制
              </button>
            </div>

            {workflow.mode === "build" && (
              <section className="workflow-runs workflow-palette" aria-label="节点面板">
                <h2>节点</h2>
                <button
                  type="button"
                  disabled={loading || !definition}
                  onClick={() => {
                    const id = workflow.addReadAgent();
                    if (id) setSelectedNodeId(id);
                  }}
                >
                  + 添加只读 Agent
                </button>
                <p className="workflow-hint">B 流程固定：只读 Agent 可增删，连接节点可重排成功连线。</p>
              </section>
            )}

            <section className="workflow-official" aria-label="官方模板">
              <header>
                <h3>官方模板</h3>
                <span className="workflow-badge">只读</span>
              </header>
              <p className="workflow-official-title">官方开发审查</p>
              <p className="workflow-hint">
                读取规范、规划、实现、校验、人工审查、记录决策六个节点。复制后才会写入项目 specs/workflows。
              </p>
              <button type="button" disabled={loading} onClick={() => void workflow.copyOfficial()}>
                复制官方模板
              </button>
            </section>
          </aside>

          <section className="workflow-main" aria-label="工作流画布">
            {definition ? (
              <>
                <div className="workflow-canvas-caption">
                  <strong>{definition.title}</strong>
                  <code>{definition.id}</code>
                  {dirty && <span className="workflow-dirty">未保存</span>}
                </div>
                <WorkflowCanvas
                  definition={definition}
                  selectedNodeId={selectedNodeId}
                  nodeStatuses={nodeStatuses}
                  readOnly={workflow.mode === "run"}
                  onSelectNode={setSelectedNodeId}
                  onMoveNode={(id, position) => workflow.moveNode(id, position)}
                  onConnect={(connection) => {
                    if (connection.source && connection.target) workflow.connectNodes(connection.source, connection.target);
                  }}
                  onEdgesDelete={(edges) => workflow.deleteEdges(edges.map((edge) => edge.id))}
                />
              </>
            ) : (
              <p className="workflow-empty">{loading ? "正在加载工作流…" : "选择左侧工作流，或新建一个空白流程。"}</p>
            )}
          </section>

          <aside className="workflow-side" aria-label="工作流详情">
            {workflow.mode === "build" ? (
              <WorkflowInspector
                node={selectedNode}
                onChange={(node) => workflow.updateNode(node.id, () => node)}
                canDelete={Boolean(selectedNode && workflow.canRemoveNode(selectedNode.id))}
                onDelete={() => {
                  if (!selectedNode) return;
                  workflow.removeNode(selectedNode.id);
                  setSelectedNodeId(undefined);
                }}
              />
            ) : (
              <WorkflowRunPanel
                models={models}
                run={activeRun}
                busy={workflow.runLoading || loading}
                onStart={(inputs) => void workflow.start(inputs)}
                onApprove={(digest) => void workflow.approve(digest)}
                onReject={() => void workflow.reject()}
                onCancel={() => void workflow.cancel()}
                onRetry={(action) => void workflow.retry(action)}
              />
            )}
          </aside>
        </div>
      )}

      {workflow.error && (
        <div className="workflow-error-bar" role="alert">
          <span>{workflow.error}</span>
          <button type="button" onClick={() => workflow.clearError()}>
            关闭
          </button>
        </div>
      )}
    </section>
  );
}
