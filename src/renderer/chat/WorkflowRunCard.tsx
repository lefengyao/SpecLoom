import type { WorkflowRunStatus, WorkflowTriggerSource } from "../../shared/workflow-api";
import { workflowRunStatusLabels } from "../workflow/useWorkflow";

export interface WorkflowRunCardState {
  runId: string;
  workflowId: string;
  source: WorkflowTriggerSource;
  warning?: string;
  title?: string;
  status?: WorkflowRunStatus;
  error?: string;
}

const sourceLabels: Record<WorkflowTriggerSource, string> = {
  project: "项目默认",
  official: "全局默认",
  fallback: "回退官方",
  explicit: "手动选择",
};

/**
 * The durable result of a task or chat implementation trigger.
 *
 * It links to the workflow page's Run mode; the card never starts another run,
 * so a task keeps its single durable binding.
 */
export function WorkflowRunCard({
  card,
  onOpen,
}: {
  card: WorkflowRunCardState;
  onOpen: (runId: string) => void;
}) {
  return (
    <article className="workflow-run-card" role="region" aria-label="工作流运行">
      <header>
        <strong>{card.title ?? "工作流运行"}</strong>
        <span className={"workflow-run-status wf-status-" + (card.status ?? "queued")}>
          {card.status === undefined ? "已启动" : workflowRunStatusLabels[card.status]}
        </span>
      </header>
      <p className="workflow-hint">
        工作流：{card.workflowId} · {sourceLabels[card.source]}
      </p>
      <code className="workflow-run-card-id">{card.runId}</code>
      {card.warning && <p className="workflow-warning" role="alert">{card.warning}</p>}
      {card.error && <p className="workflow-error" role="alert">{card.error}</p>}
      <button type="button" onClick={() => onOpen(card.runId)}>
        查看运行
      </button>
    </article>
  );
}
