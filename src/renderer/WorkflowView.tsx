import { Copy, Plus, RefreshCw, Save, Star, Trash2 } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { ModelProfile } from "../shared/contracts";
import type { DesktopApi } from "../shared/desktop-api";
import { OFFICIAL_WORKFLOW_ID } from "../shared/orchestration";
import type { WorkflowNodeStatus } from "../shared/workflow-api";
import { useI18n } from "./i18n";
import { OrchestrationBuilder, OrchestrationInspector } from "./workflow/OrchestrationBuilder";
import { OrchestrationChain, OrchestrationRunPanel } from "./workflow/OrchestrationRunPanel";
import { WorkflowCanvas } from "./workflow/WorkflowCanvas";
import { WorkflowInspector } from "./workflow/WorkflowInspector";
import { WorkflowRunPanel } from "./workflow/WorkflowRunPanel";
import { useOrchestration } from "./workflow/useOrchestration";
import { useWorkflow, workflowRunStatusLabels } from "./workflow/useWorkflow";
import "./workflow/workflow.css";

export interface WorkflowViewProps {
  api: DesktopApi | undefined;
  models: ModelProfile[];
  projectPath: string;
  onError?: (error: unknown) => void;
  /** A run card asked the page to open one durable run in Run mode. */
  runRequest?: { runId: string; sequence: number } | undefined;
  /** Called once the request was consumed, so the owner can clear it. */
  onRunRequestHandled?: (sequence: number) => void;
}

type RunTarget = "workflow" | "orchestration";

const OFFICIAL_TITLE = "官方开发审查";

/**
 * The workflow page with three modes: the graph editor, the sequential
 * orchestration editor, and the run view for either a single workflow or a
 * chain. The official workflow is the global default; a project workflow can
 * override it, and an orchestration can never be a default.
 */
export const WorkflowView = memo(function WorkflowView({ api, models, projectPath, onError, runRequest, onRunRequestHandled }: WorkflowViewProps) {
  const tr = useI18n();
  const workflow = useWorkflow(api, projectPath, onError);
  const orchestration = useOrchestration(api, projectPath, workflow.summaries, onError);
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>(undefined);
  const [runTarget, setRunTarget] = useState<RunTarget>("workflow");
  const definition = workflow.definition;
  const definitionId = definition?.id;
  const mode = workflow.mode;

  // A different definition starts with no node selected.
  useEffect(() => {
    setSelectedNodeId(undefined);
  }, [definitionId]);
  // A chat or task run card can deep-link into Run mode. The request carries a
  // sequence so the same run can be reopened after the page already handled it.
  const handledRunRequest = useRef<number | undefined>(undefined);
  const handledRunRequestCallback = useRef(onRunRequestHandled);
  handledRunRequestCallback.current = onRunRequestHandled;
  const openRun = workflow.openRun;
  useEffect(() => {
    if (!runRequest || !api?.workflow || handledRunRequest.current === runRequest.sequence) return;
    handledRunRequest.current = runRequest.sequence;
    let cancelled = false;
    void (async () => {
      try {
        const run = await api.workflow!.getRun(runRequest.runId);
        if (cancelled) return;
        setRunTarget("workflow");
        await openRun(run);
      } catch (error) {
        if (!cancelled) onError?.(error);
      } finally {
        if (!cancelled) handledRunRequestCallback.current?.(runRequest.sequence);
      }
    })();
    return () => { cancelled = true; };
  }, [api, runRequest, openRun, onError]);

  const selectedNode = definition?.nodes.find((node) => node.id === selectedNodeId);

  // A run belongs to one definition; switching workflows hides an unrelated run.
  const activeRun = workflow.run && workflow.run.workflowId === definition?.id ? workflow.run : undefined;

  const nodeStatuses = useMemo(() => {
    const statuses: Record<string, WorkflowNodeStatus> = {};
    if (!activeRun) return statuses;
    for (const state of activeRun.nodeStates) statuses[state.id] = state.status;
    return statuses;
  }, [activeRun]);

  const workflowTitles = useMemo(() => {
    const titles: Record<string, string> = { [OFFICIAL_WORKFLOW_ID]: OFFICIAL_TITLE };
    for (const summary of workflow.summaries) titles[summary.id] = summary.title;
    for (const step of orchestration.draft?.steps ?? []) {
      if (titles[step.workflowId] === undefined) titles[step.workflowId] = step.workflowId;
    }
    return titles;
  }, [workflow.summaries, orchestration.draft?.steps]);

  const projectDefaultTitle =
    workflow.projectDefaultId === undefined
      ? undefined
      : (workflow.summaries.find((summary) => summary.id === workflow.projectDefaultId)?.title ?? workflow.projectDefaultId);

  // A run only belongs to the orchestration draft it was started from.
  const orchestrationRun =
    orchestration.draft !== undefined && orchestration.run?.orchestrationId === orchestration.draft.id
      ? orchestration.run
      : undefined;

  const loading = workflow.loading || orchestration.loading;
  const dirty = workflow.dirty;
  const inspectorEmpty = mode === "workflow" && !selectedNode;

  function openOrchestration(id: string): void {
    setRunTarget("orchestration");
    void orchestration.select(id);
  }

  function startNewOrchestration(): void {
    orchestration.newDraft();
    setRunTarget("orchestration");
  }

  return (
    <section className="workflow-view" aria-label="工作流">
      <header className="workflow-header">
        <div className="workflow-heading">
          <h1>{tr("工作流")}</h1>
          <p className="subtle">{tr("官方开发审查流程可复制、可编辑、可运行")}</p>
        </div>
        <div className="workflow-toolbar">
          <div className="workflow-mode" role="group" aria-label="工作流模式">
            <button type="button" aria-pressed={mode === "workflow"} onClick={() => workflow.setMode("workflow")}>
              {tr("工作流")}
            </button>
            <button type="button" aria-pressed={mode === "orchestration"} onClick={() => workflow.setMode("orchestration")}>
              {tr("编排")}
            </button>
            <button type="button" aria-pressed={mode === "run"} onClick={() => workflow.setMode("run")}>
              {tr("运行")}
            </button>
          </div>
          {mode === "workflow" && (
            <button type="button" className="primary" disabled={!dirty || !definition || loading} onClick={() => void workflow.save()}>
              <Save size={15} />
              {tr("保存")}
            </button>
          )}
          {mode === "orchestration" && (
            <button
              type="button"
              className="primary"
              disabled={!orchestration.draft || !orchestration.dirty || loading}
              onClick={() => void orchestration.save()}
            >
              <Save size={15} />
              {tr("保存")}
            </button>
          )}
          <button
            type="button"
            disabled={loading}
            title="刷新工作流与编排列表"
            onClick={() => {
              void workflow.refresh();
              void orchestration.refresh();
            }}
          >
            <RefreshCw size={15} />
            {tr("刷新")}
          </button>
          {mode === "workflow" && (
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
              {tr("删除")}
            </button>
          )}
          {mode === "orchestration" && (
            <button
              type="button"
              disabled={orchestration.draft?.fileVersion === undefined || loading}
              title="删除当前编排"
              onClick={() => {
                const draft = orchestration.draft;
                if (!draft) return;
                if (typeof window.confirm === "function" && !window.confirm("删除编排 " + draft.title + "？此操作不会删除运行记录。")) return;
                void orchestration.removeSelected();
              }}
            >
              <Trash2 size={15} />
              {tr("删除")}
            </button>
          )}
        </div>
      </header>

      {!workflow.available ? (
        <p className="workflow-empty" role="status">
          当前桌面版本没有提供工作流接口，无法加载或运行工作流。
        </p>
      ) : (
        <div className={"workflow-layout" + (inspectorEmpty ? " is-inspector-empty" : "")}>
          <aside className="workflow-sidebar" aria-label="我的工作流">
            <header className="workflow-sidebar-head">
              <h2>{tr("我的工作流")} <span className="workflow-count">{workflow.summaries.length + 1}</span></h2>
              <div className="workflow-sidebar-tools">
                <button type="button" aria-label={tr("新建空白")} title={tr("新建空白")} disabled={loading} onClick={() => void workflow.newBlank()}>
                  <Plus size={14} />
                </button>
                <button type="button" aria-label={tr("从官方复制")} title={tr("从官方模板复制")} disabled={loading} onClick={() => void workflow.copyOfficial()}>
                  <Copy size={14} />
                </button>
              </div>
            </header>

            <section className="workflow-official-row" aria-label="默认工作流">
              <button type="button" className="workflow-official-button" aria-label="复制官方模板" title="复制官方模板为项目工作流" disabled={loading} onClick={() => void workflow.copyOfficial()}>
                <Star size={13} fill="currentColor" aria-hidden="true" className="workflow-default-star" />
                <div className="workflow-official-main">
                  <span className="workflow-list-title">{tr("官方模板")}</span>
                  <span className="workflow-list-meta">官方开发审查 · 6 节点</span>
                </div>
                <span className="workflow-badge">{tr("全局默认")}</span>
                <Copy size={12} aria-hidden="true" className="workflow-official-copy" />
              </button>
            </section>

            {workflow.projectDefaultId !== undefined && (
              <div className="workflow-default-note">
                <span>项目默认：{projectDefaultTitle}</span>
                {workflow.defaultsAvailable && (
                  <button type="button" onClick={() => void workflow.restoreDefault()}>{tr("恢复全局默认")}</button>
                )}
              </div>
            )}
            {workflow.defaultMissing && (
              <p className="workflow-warning" role="alert">
                项目默认 {workflow.projectDefaultId} 不可用，已回退官方。
              </p>
            )}

            {workflow.summaries.length === 0 ? (
              <p className="workflow-empty">还没有项目工作流。用右上角按钮新建或复制官方模板。</p>
            ) : (
              <ul className="workflow-list">
                {workflow.summaries.map((summary) => {
                  const isDefault = summary.id === workflow.projectDefaultId;
                  return (
                    <li key={summary.id}>
                      <div className="workflow-list-row">
                        <button
                          type="button"
                          className="workflow-list-item"
                          aria-pressed={summary.id === workflow.selectedId}
                          title={summary.id}
                          onClick={() => void workflow.select(summary.id)}
                        >
                          <span className="workflow-list-title-line">
                            <span className="workflow-list-title">{summary.title}</span>
                            {isDefault && <span className="workflow-badge">项目默认</span>}
                          </span>
                          <span className="workflow-list-meta">
                            {summary.nodeCount} 节点 · {summary.writeCount} 写入
                          </span>
                        </button>
                        {workflow.defaultsAvailable && (
                          <button
                            type="button"
                            className="workflow-star"
                            aria-pressed={isDefault}
                            aria-label={(isDefault ? "取消项目默认：" : "设为默认：") + summary.title}
                            title={isDefault ? "取消项目默认，恢复全局默认" : "设为项目默认"}
                            onClick={() => void (isDefault ? workflow.restoreDefault() : workflow.setDefault(summary.id))}
                          >
                            <Star size={13} fill={isDefault ? "currentColor" : "none"} aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {(mode === "orchestration" || mode === "run") && (
              <section className="workflow-runs" aria-label={tr("我的编排")}>
                <header className="workflow-sidebar-head">
                  <h2>{tr("我的编排")} <span className="workflow-count">{orchestration.summaries.length}</span></h2>
                  <button type="button" className="workflow-new-orchestration" disabled={loading} onClick={startNewOrchestration} aria-label={tr("新建编排")}>
                    <Plus size={13} />
                  </button>
                </header>
                {orchestration.summaries.length === 0 ? (
                  <p className="workflow-hint">还没有编排。</p>
                ) : (
                  <ul>
                    {orchestration.summaries.map((summary) => (
                      <li key={summary.id}>
                        <button
                          type="button"
                          aria-pressed={summary.id === orchestration.selectedId}
                          onClick={() => openOrchestration(summary.id)}
                          title={summary.id}
                        >
                          <span className="workflow-run-item-title">{summary.title}</span>
                          <span className="workflow-run-item-meta">{summary.stepCount} 步 · 不能设为默认</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}

            {workflow.mode !== "workflow" && orchestration.runs.length > 0 && (
              <section className="workflow-runs" aria-label={tr("最近编排运行")}>
                <h2>{tr("最近编排运行")}</h2>
                <ul>
                  {orchestration.runs.slice(0, 6).map((item) => (
                    <li key={item.orchestrationRunId}>
                      <button
                        type="button"
                        aria-pressed={orchestration.run?.orchestrationRunId === item.orchestrationRunId}
                        onClick={() => {
                          void orchestration.openRun(item);
                          setRunTarget("orchestration");
                          workflow.setMode("run");
                        }}
                        title={item.orchestrationRunId}
                      >
                        <span className="workflow-run-item-title">{item.title}</span>
                        <span className="workflow-run-item-meta">
                          {item.steps.length} 步 · {new Date(item.startedAt).toLocaleString("zh-CN")}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {mode === "run" && workflow.runs.length > 0 && (
              <section className="workflow-runs" aria-label={tr("最近运行")}>
                <h2>{tr("最近运行")}</h2>
                <ul>
                  {workflow.runs.slice(0, 6).map((item) => (
                    <li key={item.runId}>
                      <button
                        type="button"
                        aria-pressed={workflow.run?.runId === item.runId}
                        onClick={() => {
                          setRunTarget("workflow");
                          void workflow.openRun(item);
                        }}
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
          </aside>

          <section className="workflow-main" aria-label="工作流画布">
            {mode === "workflow" && (
              definition ? (
                <>
                  <div className="workflow-canvas-caption">
                    <strong>{definition.title}</strong>
                    <code>{definition.id}</code>
                    {dirty && <span className="workflow-dirty">未保存</span>}
                    <button
                      type="button"
                      className="workflow-add-agent"
                      aria-label={tr("添加只读 Agent")}
                      disabled={loading}
                      onClick={() => {
                        const id = workflow.addReadAgent();
                        if (id) setSelectedNodeId(id);
                      }}
                    >
                      {tr("添加只读 Agent")}
                    </button>
                  </div>
                  <WorkflowCanvas
                    definition={definition}
                    selectedNodeId={selectedNodeId}
                    nodeStatuses={nodeStatuses}
                    readOnly={false}
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
              )
            )}

            {mode === "orchestration" && (
              orchestration.available ? (
                orchestration.draft ? (
                  <>
                    <div className="workflow-canvas-caption">
                      <strong>{orchestration.draft.title}</strong>
                      <code>{orchestration.draft.id}</code>
                      {orchestration.draft.fileVersion === undefined && <span className="workflow-dirty">临时队列</span>}
                      {orchestration.dirty && orchestration.draft.fileVersion !== undefined && <span className="workflow-dirty">未保存</span>}
                    </div>
                    <OrchestrationBuilder
                      draft={orchestration.draft}
                      workflows={workflow.summaries}
                      loading={loading}
                      onChangeTitle={orchestration.setTitle}
                      onChangeDescription={orchestration.setDescription}
                      onAddStep={orchestration.addStep}
                      onUpdateStep={orchestration.updateStep}
                      onRemoveStep={orchestration.removeStep}
                      onMoveStep={orchestration.moveStep}
                    />
                  </>
                ) : (
                  <p className="workflow-empty">
                    还没有编排。使用左侧“新建编排”，按顺序选择要运行的工作流。
                  </p>
                )
              ) : (
                <p className="workflow-empty">当前桌面版本没有提供编排接口，无法加载或运行编排。</p>
              )
            )}

            {mode === "run" && (
              <div className="workflow-run-main">
                <div className="workflow-run-target">
                  <label className="workflow-field">
                    <span>运行目标</span>
                    <select
                      aria-label="运行目标"
                      value={runTarget}
                      onChange={(event) => setRunTarget(event.target.value === "orchestration" ? "orchestration" : "workflow")}
                    >
                      <option value="workflow">单个工作流</option>
                      <option value="orchestration" disabled={!orchestration.available}>
                        编排
                      </option>
                    </select>
                  </label>
                  {runTarget === "orchestration" && orchestration.draft && (
                    <span className="workflow-hint">{orchestration.draft.title}</span>
                  )}
                </div>

                {runTarget === "workflow" ? (
                  definition ? (
                    <>
                      <div className="workflow-canvas-caption">
                        <strong>{definition.title}</strong>
                        <code>{definition.id}</code>
                      </div>
                      <WorkflowCanvas
                        definition={definition}
                        selectedNodeId={selectedNodeId}
                        nodeStatuses={nodeStatuses}
                        readOnly
                        onSelectNode={setSelectedNodeId}
                      />
                    </>
                  ) : (
                    <p className="workflow-empty">{loading ? "正在加载工作流…" : "选择左侧工作流后再运行。"}</p>
                  )
                ) : orchestration.draft ? (
                  orchestration.draft.fileVersion === undefined && orchestrationRun === undefined ? (
                    <>
                      <p className="workflow-hint">临时队列：添加步骤后可以直接保存为项目编排，或保存并运行。</p>
                      <OrchestrationBuilder
                        draft={orchestration.draft}
                        workflows={workflow.summaries}
                        loading={loading}
                        onChangeTitle={orchestration.setTitle}
                        onChangeDescription={orchestration.setDescription}
                        onAddStep={orchestration.addStep}
                        onUpdateStep={orchestration.updateStep}
                        onRemoveStep={orchestration.removeStep}
                        onMoveStep={orchestration.moveStep}
                      />
                    </>
                  ) : (
                    <OrchestrationChain
                      steps={orchestration.draft.steps}
                      run={orchestrationRun}
                      workflowTitles={workflowTitles}
                    />
                  )
                ) : (
                  <p className="workflow-empty">选择或新建一个编排，再填写共享输入。</p>
                )}
              </div>
            )}
          </section>

          <aside className="workflow-side" aria-label="工作流详情">
            {mode === "workflow" && (
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
            )}

            {mode === "orchestration" && (
              <OrchestrationInspector
                draft={orchestration.draft}
                workflows={workflow.summaries}
                error={orchestration.error}
              />
            )}

            {mode === "run" && runTarget === "workflow" && (
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

            {mode === "run" && runTarget === "orchestration" && (
              <OrchestrationRunPanel
                draft={orchestration.draft}
                models={models}
                run={orchestrationRun}
                childRun={orchestrationRun === undefined ? undefined : orchestration.childRun}
                busy={orchestration.runLoading || loading}
                onStart={(inputs) => void orchestration.start(inputs)}
                onSave={() => void orchestration.save()}
                onApprove={(digest) => void orchestration.approveStep(digest)}
                onReject={() => void orchestration.rejectStep()}
                onRetry={(action) => void orchestration.retryStep(action)}
                onCancel={() => void orchestration.cancel()}
              />
            )}
          </aside>
        </div>
      )}

      {(workflow.error || orchestration.error) && (
        <div className="workflow-error-bar" role="alert">
          <span>{workflow.error ?? orchestration.error}</span>
          <button
            type="button"
            onClick={() => {
              workflow.clearError();
              orchestration.clearError();
            }}
          >
            关闭
          </button>
        </div>
      )}
    </section>
  );
});