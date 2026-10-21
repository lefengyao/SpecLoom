import type { ModelProfile } from "../../shared/contracts";
import { type OrchestrationRun, type OrchestrationStep } from "../../shared/orchestration";
import type { WorkflowRetryAction, WorkflowRun, WorkflowRunInputs } from "../../shared/workflow-api";
import { useI18n } from "../i18n";
import { RunInputsForm, WorkflowRunDetails } from "./WorkflowRunPanel";
import {
  orchestrationApprovalLabels,
  orchestrationRunStatusLabels,
  orchestrationStepStatusLabels,
  type OrchestrationDraft,
} from "./useOrchestration";

const activeStatuses: ReadonlySet<OrchestrationRun["status"]> = new Set(["queued", "running", "waiting_approval"]);

function truncate(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > limit ? flat.slice(0, limit) + "…" : flat;
}

export interface OrchestrationChainProps {
  steps: OrchestrationStep[];
  run?: OrchestrationRun | undefined;
  workflowTitles: Record<string, string>;
}

/**
 * The ordered chain shown in Run mode. Before a run every step is pending; after
 * one starts the chain mirrors the durable step statuses, including auto
 * approvals and step errors.
 */
export function OrchestrationChain({ steps, run, workflowTitles }: OrchestrationChainProps) {
  const tr = useI18n();
  const current = run === undefined ? 0 : Math.min(run.currentStepIndex + 1, steps.length);
  return (
    <section className="workflow-chain" aria-label={tr("编排时间线")}>
      <header className="workflow-panel-heading">
        <h2>{tr("编排时间线")}</h2>
        <span className="workflow-hint">
          {run === undefined
            ? tr("{steps} 步", { steps: steps.length })
            : tr("第 {current} / {total} 步", { current, total: steps.length })}
        </span>
      </header>
      <ol className="workflow-chain-list">
        {steps.map((step, index) => {
          const state = run?.steps[index];
          const status = state?.status ?? "pending";
          const title = workflowTitles[step.workflowId] ?? step.workflowId;
          return (
            <li key={step.id} className={"workflow-chain-item wf-status-" + status}>
              <span className="workflow-chain-index" aria-hidden="true">
                {index + 1}
              </span>
              <div className="workflow-chain-body">
                <div className="workflow-chain-head">
                  <strong>{title}</strong>
                  <span className={"workflow-run-status wf-status-" + status}>{tr(orchestrationStepStatusLabels[status])}</span>
                </div>
                <span className="workflow-timeline-meta">
                  {tr("审批：{label}", { label: tr(orchestrationApprovalLabels[step.approval]) })}
                  {state?.autoApproved === true ? tr(" · 已自动批准") : ""}
                </span>
                {state?.runId && (
                  <code className="workflow-chain-run" title={state.runId}>
                    {state.runId}
                  </code>
                )}
                {state?.error && <p className="workflow-timeline-error">{truncate(state.error, 160)}</p>}
                {state?.summary && <p className="workflow-hint">{truncate(state.summary, 120)}</p>}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export interface OrchestrationRunPanelProps {
  draft: OrchestrationDraft | undefined;
  models: ModelProfile[];
  run: OrchestrationRun | undefined;
  childRun: WorkflowRun | undefined;
  busy: boolean;
  onStart: (inputs: WorkflowRunInputs) => void;
  onSave: () => void;
  onApprove: (digest: string) => void;
  onReject: () => void;
  onRetry: (action: WorkflowRetryAction) => void;
  onCancel: () => void;
}

/**
 * Run mode's orchestration panel: shared inputs, the orchestration status, the
 * current child run (reusing WorkflowRunDetails for approval/retry/cancel) and
 * the save action that turns a temporary queue into a project orchestration.
 */
export function OrchestrationRunPanel({
  draft,
  models,
  run,
  childRun,
  busy,
  onStart,
  onSave,
  onApprove,
  onReject,
  onRetry,
  onCancel,
}: OrchestrationRunPanelProps) {
  const tr = useI18n();
  const visibleRun = run !== undefined && draft !== undefined && run.orchestrationId === draft.id ? run : undefined;
  const active = visibleRun !== undefined && activeStatuses.has(visibleRun.status);
  const needsSave = draft !== undefined && (draft.fileVersion === undefined || draft.dirty);
  const isTemporary = draft !== undefined && draft.fileVersion === undefined;

  return (
    <section className="workflow-run" aria-label={tr("编排运行")}>
      <header className="workflow-panel-heading">
        <h2>{tr("编排运行")}</h2>
        {isTemporary && <span className="workflow-badge">{tr("临时队列")}</span>}
      </header>

      {!draft ? (
        <p className="workflow-empty">{tr("先选择或新建一个编排，再填写共享输入。")}</p>
      ) : (
        <>
          <div className="workflow-orchestration-summary">
            <strong>{draft.title.trim() || tr("未命名编排")}</strong>
            <span className="workflow-hint">{tr("{steps} 步 · 共用输入", { steps: draft.steps.length })}</span>
          </div>
          <p className="workflow-hint">{tr("目标、读取范围、修改范围、模型只填一次，按步骤顺序执行；上一步摘要会注入下一步。")}</p>

          <RunInputsForm
            models={models}
            busy={busy}
            active={active}
            submitLabel={needsSave ? "保存并运行编排" : "开始编排"}
            onSubmit={onStart}
          />

          {needsSave && (
            <button type="button" disabled={busy} onClick={onSave}>
              {tr("保存为编排")}
            </button>
          )}

          {visibleRun ? (
            <>
              <section className="workflow-run-section">
                <h3>{tr("编排状态")}</h3>
                <dl className="workflow-meta">
                  <div>
                    <dt>{tr("状态")}</dt>
                    <dd>
                      <span className={"workflow-run-status wf-status-" + visibleRun.status}>
                        {tr(orchestrationRunStatusLabels[visibleRun.status])}
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt>{tr("步骤")}</dt>
                    <dd>
                      {tr("第 {current} / {total} 步", { current: Math.min(visibleRun.currentStepIndex + 1, visibleRun.steps.length), total: visibleRun.steps.length })}
                    </dd>
                  </div>
                  <div>
                    <dt>{tr("运行 ID")}</dt>
                    <dd>
                      <code>{visibleRun.orchestrationRunId}</code>
                    </dd>
                  </div>
                </dl>
                {visibleRun.error && (
                  <p className="workflow-error" role="alert">
                    {visibleRun.error}
                  </p>
                )}
              </section>

              {childRun ? (
                <section className="workflow-run-section" aria-label={tr("当前子运行")}>
                  <WorkflowRunDetails
                    run={childRun}
                    busy={busy}
                    heading="当前子运行"
                    onApprove={onApprove}
                    onReject={onReject}
                    onCancel={onCancel}
                    onRetry={onRetry}
                  />
                </section>
              ) : (
                <>
                  {active && (
                    <div className="workflow-button-row">
                      <button disabled={busy} onClick={onCancel}>
                        {tr("取消编排")}
                      </button>
                    </div>
                  )}
                  {visibleRun.status === "failed" && (
                    <section className="workflow-run-section">
                      <h3>{tr("重试")}</h3>
                      <div className="workflow-button-row">
                        <button disabled={busy} onClick={() => onRetry("implement")}>
                          {tr("重试当前步骤")}
                        </button>
                      </div>
                    </section>
                  )}
                </>
              )}
            </>
          ) : (
            <p className="workflow-empty">{tr("填写共享输入后开始编排。")}</p>
          )}
        </>
      )}
    </section>
  );
}