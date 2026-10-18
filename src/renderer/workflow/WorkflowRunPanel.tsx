import { useMemo, useState } from "react";
import type { ModelProfile, ValidationDiagnostic, ValidationResult } from "../../shared/contracts";
import type { WorkflowRetryAction, WorkflowRun, WorkflowRunInputs } from "../../shared/workflow-api";
import { workflowNodeStatusLabels, workflowRunStatusLabels } from "./useWorkflow";

export interface WorkflowRunPanelProps {
  models: ModelProfile[];
  run: WorkflowRun | undefined;
  busy: boolean;
  onStart: (inputs: WorkflowRunInputs) => void;
  onApprove: (digest: string) => void;
  onReject: () => void;
  onCancel: () => void;
  onRetry: (action: WorkflowRetryAction) => void;
}

const severityLabels: Record<ValidationDiagnostic["severity"], string> = {
  error: "错误",
  warning: "警告",
  info: "提示",
};

const validationStatusLabels: Record<ValidationResult["status"], string> = {
  pass: "通过",
  fail: "失败",
  skipped: "跳过",
};

const activeStatuses: ReadonlySet<WorkflowRun["status"]> = new Set(["queued", "running", "waiting_approval"]);

function parsePaths(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function formatTime(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN");
}

function truncate(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > limit ? flat.slice(0, limit) + "…" : flat;
}

/**
 * Run mode's right panel: the input form, the live run summary, node timeline,
 * validation diagnostics and the approval gate.
 */
export function WorkflowRunPanel({ models, run, busy, onStart, onApprove, onReject, onCancel, onRetry }: WorkflowRunPanelProps) {
  const [goal, setGoal] = useState("");
  const [readPaths, setReadPaths] = useState("");
  const [writePaths, setWritePaths] = useState("");
  const [model, setModel] = useState("");
  const [formError, setFormError] = useState<string | undefined>(undefined);

  const active = run !== undefined && activeStatuses.has(run.status);
  const approval = run?.approval;
  const nodeLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const node of run?.definitionSnapshot.nodes ?? []) labels.set(node.id, node.label);
    return labels;
  }, [run]);

  function submit(): void {
    const goalText = goal.trim();
    const readList = parsePaths(readPaths);
    const writeList = parsePaths(writePaths);
    if (!goalText) {
      setFormError("请填写运行目标。");
      return;
    }
    if (!readList.length) {
      setFormError("请至少填写一个读取路径（每行一个）。");
      return;
    }
    if (!writeList.length) {
      setFormError("请至少填写一个修改路径（每行一个）。");
      return;
    }
    setFormError(undefined);
    onStart({
      goal: goalText,
      readPaths: readList,
      writePaths: writeList,
      ...(model.trim() ? { model: model.trim() } : {}),
    });
  }

  return (
    <section className="workflow-run" aria-label="运行面板">
      <header className="workflow-panel-heading">
        <h2>运行</h2>
      </header>

      <form
        className="workflow-run-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label className="workflow-field">
          <span>目标</span>
          <textarea rows={3} value={goal} placeholder="这次运行要完成什么" onChange={(event) => setGoal(event.target.value)} />
        </label>
        <label className="workflow-field">
          <span>读取范围</span>
          <textarea rows={3} value={readPaths} placeholder="例如 specs，每行一个" onChange={(event) => setReadPaths(event.target.value)} />
        </label>
        <label className="workflow-field">
          <span>修改范围</span>
          <textarea rows={3} value={writePaths} placeholder="例如 specs/entities，每行一个" onChange={(event) => setWritePaths(event.target.value)} />
        </label>
        {models.length > 0 ? (
          <label className="workflow-field">
            <span>模型</span>
            <select value={model} onChange={(event) => setModel(event.target.value)}>
              <option value="">使用默认模型</option>
              {models.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name} · {profile.model}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="workflow-field">
            <span>模型</span>
            <input value={model} placeholder="输入模型 ID，留空使用默认模型" onChange={(event) => setModel(event.target.value)} />
          </label>
        )}
        <p className="workflow-hint">路径每行一个，只能是项目内的相对路径。</p>
        {formError && (
          <p className="workflow-error" role="alert">
            {formError}
          </p>
        )}
        <button className="primary" type="submit" disabled={busy || active}>
          开始运行
        </button>
      </form>

      {run && (
        <div className="workflow-run-body">
          <section className="workflow-run-section">
            <h3>当前运行</h3>
            <dl className="workflow-meta">
              <div>
                <dt>状态</dt>
                <dd>
                  <span className={"workflow-run-status wf-status-" + run.status}>{workflowRunStatusLabels[run.status]}</span>
                </dd>
              </div>
              <div>
                <dt>尝试</dt>
                <dd>{run.attempts}</dd>
              </div>
              <div>
                <dt>运行 ID</dt>
                <dd>
                  <code>{run.runId}</code>
                </dd>
              </div>
              <div>
                <dt>模型</dt>
                <dd>{run.resolvedModel ?? run.inputs.model ?? "默认模型"}</dd>
              </div>
            </dl>
            {run.error && (
              <p className="workflow-error" role="alert">
                {run.error}
              </p>
            )}
            {run.decisionPath && (
              <p className="workflow-hint">
                决策文件：<code>{run.decisionPath}</code>
              </p>
            )}
          </section>

          <section className="workflow-run-section">
            <h3>节点时间线</h3>
            <ol className="workflow-timeline">
              {run.nodeStates.map((state) => (
                <li key={state.id} className={"workflow-timeline-item wf-status-" + state.status}>
                  <div className="workflow-timeline-head">
                    <strong>{nodeLabels.get(state.id) ?? state.id}</strong>
                    <span className="workflow-timeline-state">{workflowNodeStatusLabels[state.status]}</span>
                  </div>
                  <span className="workflow-timeline-meta">第 {state.attempts} 次</span>
                  {state.error && <p className="workflow-timeline-error">{truncate(state.error, 160)}</p>}
                </li>
              ))}
            </ol>
          </section>

          {run.validation && (
            <section className="workflow-run-section">
              <h3>校验结果</h3>
              <p className="workflow-hint">状态：{validationStatusLabels[run.validation.status]}</p>
              {run.validation.checks.length > 0 && (
                <ul className="workflow-check-list">
                  {run.validation.checks.map((check) => (
                    <li key={check.id}>
                      <span>{check.name}</span>
                      <span className={"wf-status-" + check.status}>{validationStatusLabels[check.status]}</span>
                    </li>
                  ))}
                </ul>
              )}
              {run.validation.diagnostics.length > 0 && (
                <ul className="workflow-diagnostics">
                  {run.validation.diagnostics.map((diagnostic, index) => (
                    <li key={index} className={"wf-severity-" + diagnostic.severity}>
                      <span className="workflow-diagnostic-severity">{severityLabels[diagnostic.severity]}</span>
                      <span>{diagnostic.message}</span>
                      {diagnostic.path && <code>{diagnostic.path}</code>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {approval && (
            <section className="workflow-run-section workflow-approval">
              <h3>审批</h3>
              <p className="workflow-hint">
                摘要：<code>{approval.digest}</code>
              </p>
              {approval.approvedAt && <p className="workflow-hint">已于 {formatTime(approval.approvedAt)} 批准</p>}
              {run.status === "waiting_approval" && (
                <div className="workflow-button-row">
                  <button className="primary" disabled={busy} onClick={() => onApprove(approval.digest)}>
                    批准并记录决策
                  </button>
                  <button disabled={busy} onClick={onReject}>
                    驳回并重新实现
                  </button>
                </div>
              )}
            </section>
          )}

          {active && (
            <div className="workflow-button-row">
              <button disabled={busy} onClick={onCancel}>
                取消运行
              </button>
            </div>
          )}

          {run.status === "failed" && (
            <section className="workflow-run-section">
              <h3>重试</h3>
              <div className="workflow-button-row">
                <button disabled={busy} onClick={() => onRetry("plan")}>
                  重试规划
                </button>
                <button disabled={busy} onClick={() => onRetry("implement")}>
                  重试实现
                </button>
                <button disabled={busy} onClick={() => onRetry("validate")}>
                  重试校验
                </button>
              </div>
            </section>
          )}
        </div>
      )}
    </section>
  );
}
