import { Trash2 } from "lucide-react";
import type { WorkflowNode } from "../../shared/workflow";
import { useI18n } from "../i18n";
import { workflowNodeTypeLabels } from "./useWorkflow";

export interface WorkflowInspectorProps {
  node: WorkflowNode | undefined;
  onChange: (node: WorkflowNode) => void;
  canDelete?: boolean;
  onDelete?: () => void;
}

function withLabel(node: WorkflowNode, label: string): WorkflowNode {
  return { ...node, label } as WorkflowNode;
}

type AgentNode = Extract<WorkflowNode, { type: "agent" }>;

function withAgentConfig(node: AgentNode, patch: { access?: "read" | "write"; prompt?: string; model?: string | undefined }): WorkflowNode {
  const access = patch.access ?? node.config.access;
  const prompt = patch.prompt ?? node.config.prompt;
  const model = "model" in patch ? patch.model : node.config.model;
  const trimmed = model?.trim();
  return {
    ...node,
    config: {
      access,
      prompt,
      ...(trimmed ? { model: trimmed } : {}),
    },
  };
}

/**
 * Right-hand inspector for the selected node. It only edits the in-memory
 * definition and never talks to the API; the page decides when to save.
 */
export function WorkflowInspector({ node, onChange, canDelete = false, onDelete }: WorkflowInspectorProps) {
  const tr = useI18n();
  return (
    <section className="workflow-inspector" aria-label={tr("节点检查器")}>
      <header className="workflow-panel-heading">
        <h2>{tr("节点检查器")}</h2>
      </header>
      {!node ? (
        <p className="workflow-empty">{tr("在画布中选择一个节点，查看并编辑它的配置。")}</p>
      ) : (
        <div className="workflow-inspector-body">
          <dl className="workflow-meta">
            <div>
              <dt>{tr("节点 ID")}</dt>
              <dd>
                <code>{node.id}</code>
              </dd>
            </div>
            <div>
              <dt>{tr("类型")}</dt>
              <dd>{tr(workflowNodeTypeLabels[node.type])}</dd>
            </div>
          </dl>

          <label className="workflow-field">
            <span>{tr("标签")}</span>
            <input value={node.label} onChange={(event) => onChange(withLabel(node, event.target.value))} />
          </label>

          {node.type === "agent" && (
            <>
              <label className="workflow-field">
                <span>{tr("访问")}</span>
                <select
                  value={node.config.access}
                  onChange={(event) => onChange(withAgentConfig(node, { access: event.target.value === "write" ? "write" : "read" }))}
                >
                  <option value="read">{tr("只读")}</option>
                  <option value="write">{tr("写入")}</option>
                </select>
              </label>
              <label className="workflow-field">
                <span>{tr("提示词")}</span>
                <textarea
                  rows={6}
                  value={node.config.prompt}
                  onChange={(event) => onChange(withAgentConfig(node, { prompt: event.target.value }))}
                />
              </label>
              <label className="workflow-field">
                <span>{tr("模型")}</span>
                <input
                  value={node.config.model ?? ""}
                  placeholder={tr("留空则使用运行模型")}
                  onChange={(event) => onChange(withAgentConfig(node, { model: event.target.value }))}
                />
              </label>
            </>
          )}

          {node.type === "decision" && (
            <label className="workflow-field">
              <span>{tr("决策目录")}</span>
              <input value={node.config.directory} readOnly />
            </label>
          )}

          {node.type === "approval" && (
            <label className="workflow-field">
              <span>{tr("允许驳回")}</span>
              <input value={tr("固定为 true")} readOnly />
            </label>
          )}

          {(node.type === "context" || node.type === "validation") && <p className="workflow-hint">{tr("此节点没有额外配置。")}</p>}

          {onDelete && (
            <button type="button" className="workflow-delete-node" disabled={!canDelete} onClick={onDelete}>
              <Trash2 size={14} /> {tr("删除只读 Agent")}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
