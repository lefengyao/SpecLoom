import { useMemo, useState } from "react";
import { OFFICIAL_WORKFLOW_ID, type OrchestrationApproval } from "../../shared/orchestration";
import type { WorkflowSummary } from "../../shared/workflow-api";
import {
  orchestrationApprovalLabels,
  orchestrationDraftError,
  type OrchestrationDraft,
} from "./useOrchestration";

export interface OrchestrationBuilderProps {
  draft: OrchestrationDraft;
  workflows: WorkflowSummary[];
  loading: boolean;
  onChangeTitle: (title: string) => void;
  onChangeDescription: (description: string) => void;
  onAddStep: (workflowId: string) => void;
  onUpdateStep: (id: string, patch: { workflowId?: string; approval?: OrchestrationApproval }) => void;
  onRemoveStep: (id: string) => void;
  onMoveStep: (id: string, direction: "up" | "down") => void;
}

const OFFICIAL_TITLE = "官方开发审查";
const approvalOptions: OrchestrationApproval[] = ["inherit", "always", "auto"];

function workflowOptions(workflows: WorkflowSummary[], currentId?: string): { id: string; title: string }[] {
  const options = [
    { id: OFFICIAL_WORKFLOW_ID, title: OFFICIAL_TITLE + "（全局默认）" },
    ...workflows
      .filter((workflow) => workflow.id !== OFFICIAL_WORKFLOW_ID)
      .map((workflow) => ({ id: workflow.id, title: workflow.title })),
  ];
  if (currentId !== undefined && !options.some((option) => option.id === currentId)) {
    options.push({ id: currentId, title: currentId + "（不存在）" });
  }
  return options;
}

function missingWorkflow(draft: OrchestrationDraft, workflows: WorkflowSummary[]): Set<string> {
  const known = new Set([OFFICIAL_WORKFLOW_ID, ...workflows.map((workflow) => workflow.id)]);
  return new Set(draft.steps.filter((step) => !known.has(step.workflowId)).map((step) => step.id));
}

/**
 * Orchestration editor: metadata, ordered step cards, approval policy and the
 * shared-input note. It only edits the in-memory draft; the page decides when to
 * save, and Run mode can also use an unsaved draft as a temporary queue.
 */
export function OrchestrationBuilder({
  draft,
  workflows,
  loading,
  onChangeTitle,
  onChangeDescription,
  onAddStep,
  onUpdateStep,
  onRemoveStep,
  onMoveStep,
}: OrchestrationBuilderProps) {
  const options = useMemo(() => workflowOptions(workflows), [workflows]);
  const missing = useMemo(() => missingWorkflow(draft, workflows), [draft, workflows]);
  const [newWorkflowId, setNewWorkflowId] = useState(options[0]?.id ?? OFFICIAL_WORKFLOW_ID);
  const addWorkflowId = options.some((option) => option.id === newWorkflowId)
    ? newWorkflowId
    : (options[0]?.id ?? OFFICIAL_WORKFLOW_ID);

  return (
    <section className="workflow-orchestration" aria-label="编排编辑器">
      <header className="workflow-panel-heading">
        <h2>{draft.title.trim() || "未命名编排"}</h2>
        <span className="workflow-hint">
          {draft.steps.length} 步 · 共用输入
        </span>
      </header>

      <p className="workflow-hint">目标、读取范围、修改范围、模型只填一次；每一步按顺序执行，上一步摘要会注入下一步。</p>

      <label className="workflow-field">
        <span>编排名称</span>
        <input value={draft.title} onChange={(event) => onChangeTitle(event.target.value)} />
      </label>
      <label className="workflow-field">
        <span>编排说明</span>
        <textarea rows={2} value={draft.description} onChange={(event) => onChangeDescription(event.target.value)} />
      </label>

      {draft.steps.length === 0 ? (
        <p className="workflow-empty">还没有步骤。选择一个工作流，然后添加为第一步。</p>
      ) : (
        <ol className="workflow-step-list" aria-label="编排步骤">
          {draft.steps.map((step, index) => {
            const number = index + 1;
            const missingReference = missing.has(step.id);
            return (
              <li key={step.id} className={"workflow-step-item" + (missingReference ? " is-missing" : "")} aria-label={"步骤 " + number}>
                <div className="workflow-step-head">
                  <span className="workflow-step-index">第 {number} 步</span>
                  <span className="workflow-step-order">顺序 {number}</span>
                </div>
                <label className="workflow-field">
                  <span>工作流</span>
                  <select
                    aria-label={"步骤 " + number + " 工作流"}
                    value={step.workflowId}
                    disabled={loading}
                    onChange={(event) => onUpdateStep(step.id, { workflowId: event.target.value })}
                  >
                    {workflowOptions(workflows, step.workflowId).map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="workflow-field">
                  <span>审批</span>
                  <select
                    aria-label={"步骤 " + number + " 审批"}
                    value={step.approval}
                    disabled={loading}
                    onChange={(event) =>
                      onUpdateStep(step.id, { approval: event.target.value as OrchestrationApproval })
                    }
                  >
                    {approvalOptions.map((approval) => (
                      <option key={approval} value={approval}>
                        {orchestrationApprovalLabels[approval]}
                      </option>
                    ))}
                  </select>
                </label>
                {step.approval === "auto" && (
                  <p className="workflow-warning" role="note">
                    自动批准：该步骤将跳过人工审查。
                  </p>
                )}
                {step.approval === "always" && <p className="workflow-hint">强制人工：即使工作流允许自动，也会等待人工批准。</p>}
                {missingReference && (
                  <p className="workflow-error" role="alert">
                    工作流 {step.workflowId} 不存在，请重新选择或先创建工作流。
                  </p>
                )}
                <div className="workflow-step-actions">
                  <button
                    type="button"
                    aria-label={"上移步骤 " + number}
                    disabled={loading || index === 0}
                    onClick={() => onMoveStep(step.id, "up")}
                  >
                    上移
                  </button>
                  <button
                    type="button"
                    aria-label={"下移步骤 " + number}
                    disabled={loading || index === draft.steps.length - 1}
                    onClick={() => onMoveStep(step.id, "down")}
                  >
                    下移
                  </button>
                  <button
                    type="button"
                    className="workflow-step-remove"
                    aria-label={"删除步骤 " + number}
                    disabled={loading}
                    onClick={() => onRemoveStep(step.id)}
                  >
                    删除
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <div className="workflow-step-add" aria-label="添加步骤">
        <label className="workflow-field">
          <span>添加步骤</span>
          <select
            aria-label="新步骤工作流"
            value={addWorkflowId}
            disabled={loading}
            onChange={(event) => setNewWorkflowId(event.target.value)}
          >
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.title}
              </option>
            ))}
          </select>
        </label>
        <button type="button" disabled={loading} onClick={() => onAddStep(addWorkflowId)}>
          添加步骤
        </button>
      </div>
    </section>
  );
}

export interface OrchestrationInspectorProps {
  draft: OrchestrationDraft | undefined;
  workflows: WorkflowSummary[];
  error: string | undefined;
}

/**
 * Right-hand orchestration inspector. It surfaces the save/run blockers and the
 * auto-approval warning without duplicating the editable step controls.
 */
export function OrchestrationInspector({ draft, workflows, error }: OrchestrationInspectorProps) {
  const reason = draft ? orchestrationDraftError(draft, workflows) : undefined;
  const autoSteps = draft?.steps.filter((step) => step.approval === "auto").length ?? 0;
  const missing = draft ? missingWorkflow(draft, workflows) : new Set<string>();
  return (
    <section className="workflow-inspector" aria-label="编排检查器">
      <header className="workflow-panel-heading">
        <h2>编排检查器</h2>
      </header>
      {!draft ? (
        <p className="workflow-empty">选择或新建一个编排，查看它的步骤与约束。</p>
      ) : (
        <div className="workflow-inspector-body">
          <dl className="workflow-meta">
            <div>
              <dt>编排 ID</dt>
              <dd>
                <code>{draft.id}</code>
              </dd>
            </div>
            <div>
              <dt>状态</dt>
              <dd>{draft.fileVersion === undefined ? "临时队列" : draft.dirty ? "未保存" : "已保存"}</dd>
            </div>
            <div>
              <dt>步骤</dt>
              <dd>{draft.steps.length} / 20</dd>
            </div>
          </dl>
          {reason && (
            <p className="workflow-error" role="alert">
              {reason}
            </p>
          )}
          {error && <p className="workflow-error">{error}</p>}
          {autoSteps > 0 && (
            <p className="workflow-warning" role="note">
              自动批准已启用：{autoSteps} 个步骤会跳过人工审查。
            </p>
          )}
          {missing.size > 0 && (
            <p className="workflow-warning" role="note">
              {missing.size} 个步骤引用了不存在的工作流，保存和运行前请修复。
            </p>
          )}
          <p className="workflow-hint">编排只引用工作流，不能设为默认；共享输入在运行面板填写。</p>
        </div>
      )}
    </section>
  );
}