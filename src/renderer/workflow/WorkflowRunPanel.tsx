import { useMemo, useState } from "react";
import type { ModelProfile, ValidationDiagnostic, ValidationResult } from "../../shared/contracts";
import type { WorkflowRetryAction, WorkflowRun, WorkflowRunInputs } from "../../shared/workflow-api";
import { useI18n } from "../i18n";
import { workflowNodeStatusLabels, workflowRunStatusLabels } from "./useWorkflow";

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

export interface RunInputsFormProps {
  models: ModelProfile[];
  busy: boolean;
  active?: boolean;
  /** Button text; orchestration runs save a temporary queue first. */
  submitLabel?: string;
  onSubmit: (inputs: WorkflowRunInputs) => void;
}

/**
 * The shared goal/read/write/model form. Workflow runs and orchestration runs
 * collect exactly the same inputs; only the submit label differs.
 */
export function RunInputsForm({ models, busy, active = false, submitLabel = "开始运行", onSubmit }: RunInputsFormProps) {
  const tr = useI18n();
  const [goal, setGoal] = useState("");
  const [readPaths, setReadPaths] = useState("");
  const [writePaths, setWritePaths] = useState("");
  const [model, setModel] = useState("");
  const [formError, setFormError] = useState<string | undefined>(undefined);

  function submit(): void {
    const goalText = goal.trim();
    const readList = parsePaths(readPaths);
    const writeList = parsePaths(writePaths);
    if (!goalText) {
      setFormError(tr("请填写运行目标。"));
      return;
    }
    if (!readList.length) {
      setFormError(tr("请至少填写一个读取路径（每行一个）。"));
      return;
    }
    if (!writeList.length) {
      setFormError(tr("请至少填写一个修改路径（每行一个）。"));
      return;
    }
    setFormError(undefined);
    onSubmit({
      goal: goalText,
      readPaths: readList,
      writePaths: writeList,
      ...(model.trim() ? { model: model.trim() } : {}),
    });
  }

  return (
    <form
      className="workflow-run-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label className="workflow-field">
        <span>{tr("目标")}</span>
        <textarea rows={3} value={goal} placeholder={tr("这次运行要完成什么")} onChange={(event) => setGoal(event.target.value)} />
      </label>
      <label className="workflow-field">
        <span>{tr("读取范围")}</span>
        <textarea rows={3} value={readPaths} placeholder={tr("例如 specs，每行一个")} onChange={(event) => setReadPaths(event.target.value)} />
      </label>
      <label className="workflow-field">
        <span>{tr("修改范围")}</span>
        <textarea rows={3} value={writePaths} placeholder={tr("例如 specs/entities，每行一个")} onChange={(event) => setWritePaths(event.target.value)} />
      </label>
      {models.length > 0 ? (
        <label className="workflow-field">
          <span>{tr("模型")}</span>
          <select value={model} onChange={(event) => setModel(event.target.value)}>
            <option value="">{tr("使用默认模型")}</option>
            {models.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name} · {profile.model}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <label className="workflow-field">
          <span>{tr("模型")}</span>
          <input value={model} placeholder={tr("输入模型 ID，留空使用默认模型")} onChange={(event) => setModel(event.target.value)} />
        </label>
      )}
      <p className="workflow-hint">{tr("路径每行一个，只能是项目内的相对路径。")}</p>
      {formError && (
        <p className="workflow-error" role="alert">
          {formError}
        </p>
      )}
      <button className="primary" type="submit" disabled={busy || active}>
        {tr(submitLabel)}
      </button>
    </form>
  );
}

export interface WorkflowRunDetailsProps {
  run: WorkflowRun;
  busy: boolean;
  /** Panel heading; orchestration runs show it as the current child run. */
  heading?: string;
  onApprove: (digest: string) => void;
  onReject: () => void;
  onCancel: () => void;
  onRetry: (action: WorkflowRetryAction) => void;
}

/** The durable run summary, node timeline, validation, approval gate and actions. */
export function WorkflowRunDetails({
  run,
  busy,
  heading = "当前运行",
  onApprove,
  onReject,
  onCancel,
  onRetry,
}: WorkflowRunDetailsProps) {
  const tr = useI18n();
  const active = activeStatuses.has(run.status);
  const approval = run.approval;
  const nodeLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const node of run.definitionSnapshot.nodes) labels.set(node.id, node.label);
    return labels;
  }, [run]);

  return (
    <div className="workflow-run-body">
      <section className="workflow-run-section">
        <h3>{tr(heading)}</h3>
        <dl className="workflow-meta">
          <div>
            <dt>{tr("状态")}</dt>
            <dd>
              <span className={"workflow-run-status wf-status-" + run.status}>{tr(workflowRunStatusLabels[run.status])}</span>
            </dd>
          </div>
          <div>
            <dt>{tr("尝试")}</dt>
            <dd>{run.attempts}</dd>
          </div>
          <div>
            <dt>{tr("运行 ID")}</dt>
            <dd>
              <code>{run.runId}</code>
            </dd>
          </div>
          <div>
            <dt>{tr("模型")}</dt>
            <dd>{run.resolvedModel ?? run.inputs.model ?? tr("默认模型")}</dd>
          </div>
        </dl>
        {run.error && (
          <p className="workflow-error" role="alert">
            {run.error}
          </p>
        )}
        {run.decisionPath && (
          <p className="workflow-hint">
            {tr("决策文件：")}<code>{run.decisionPath}</code>
          </p>
        )}
      </section>

      <section className="workflow-run-section">
        <h3>{tr("节点时间线")}</h3>
        <ol className="workflow-timeline">
          {run.nodeStates.map((state) => (
            <li key={state.id} className={"workflow-timeline-item wf-status-" + state.status}>
              <div className="workflow-timeline-head">
                <strong>{nodeLabels.get(state.id) ?? state.id}</strong>
                <span className="workflow-timeline-state">{tr(workflowNodeStatusLabels[state.status])}</span>
              </div>
              <span className="workflow-timeline-meta">{tr("第 {count} 次", { count: state.attempts })}</span>
              {state.error && <p className="workflow-timeline-error">{truncate(state.error, 160)}</p>}
            </li>
          ))}
        </ol>
      </section>

      {run.validation && (
        <section className="workflow-run-section">
          <h3>{tr("校验结果")}</h3>
          <p className="workflow-hint">{tr("状态：{status}", { status: tr(validationStatusLabels[run.validation.status]) })}</p>
          {run.validation.checks.length > 0 && (
            <ul className="workflow-check-list">
              {run.validation.checks.map((check) => (
                <li key={check.id}>
                  <span>{check.name}</span>
                  <span className={"wf-status-" + check.status}>{tr(validationStatusLabels[check.status])}</span>
                </li>
              ))}
            </ul>
          )}
          {run.validation.diagnostics.length > 0 && (
            <ul className="workflow-diagnostics">
              {run.validation.diagnostics.map((diagnostic, index) => (
                <li key={index} className={"wf-severity-" + diagnostic.severity}>
                  <span className="workflow-diagnostic-severity">{tr(severityLabels[diagnostic.severity])}</span>
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
          <h3>{tr("审批")}</h3>
          <p className="workflow-hint">
            {tr("摘要：")}<code>{approval.digest}</code>
          </p>
          {approval.approvedAt && <p className="workflow-hint">{tr("已于 {time} 批准", { time: formatTime(approval.approvedAt) ?? "" })}</p>}
          {approval.autoApproved && <p className="workflow-hint">{tr("已由编排器自动批准。")}</p>}
          {run.status === "waiting_approval" && (
            <div className="workflow-button-row">
              <button className="primary" disabled={busy} onClick={() => onApprove(approval.digest)}>
                {tr("批准并记录决策")}
              </button>
              <button disabled={busy} onClick={onReject}>
                {tr("驳回并重新实现")}
              </button>
            </div>
          )}
        </section>
      )}

      {active && (
        <div className="workflow-button-row">
          <button disabled={busy} onClick={onCancel}>
            {tr("取消运行")}
          </button>
        </div>
      )}

      {run.status === "failed" && (
        <section className="workflow-run-section">
          <h3>{tr("重试")}</h3>
          <div className="workflow-button-row">
            <button disabled={busy} onClick={() => onRetry("plan")}>
              {tr("重试规划")}
            </button>
            <button disabled={busy} onClick={() => onRetry("implement")}>
              {tr("重试实现")}
            </button>
            <button disabled={busy} onClick={() => onRetry("validate")}>
              {tr("重试校验")}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

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

/**
 * Run mode's right panel: the input form and the live run details. The details
 * component is shared with the orchestration panel's current child run.
 */
export function WorkflowRunPanel({ models, run, busy, onStart, onApprove, onReject, onCancel, onRetry }: WorkflowRunPanelProps) {
  const tr = useI18n();
  const active = run !== undefined && activeStatuses.has(run.status);
  return (
    <section className="workflow-run" aria-label={tr("运行面板")}>
      <header className="workflow-panel-heading">
        <h2>{tr("运行")}</h2>
      </header>

      <RunInputsForm models={models} busy={busy} active={active} onSubmit={onStart} />

      {run && (
        <WorkflowRunDetails
          run={run}
          busy={busy}
          onApprove={onApprove}
          onReject={onReject}
          onCancel={onCancel}
          onRetry={onRetry}
        />
      )}
    </section>
  );
}
