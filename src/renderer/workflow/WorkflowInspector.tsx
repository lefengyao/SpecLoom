import { Trash2 } from "lucide-react";
import type { WorkflowNode } from "../../shared/workflow";
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
  return (
    <section className="workflow-inspector" aria-label="节点检查器">
      <header className="workflow-panel-heading">
        <h2>节点检查器</h2>
      </header>
      {!node ? (
        <p className="workflow-empty">在画布中选择一个节点，查看并编辑它的配置。</p>
      ) : (
        <div className="workflow-inspector-body">
          <dl className="workflow-meta">
            <div>
              <dt>节点 ID</dt>
              <dd>
                <code>{node.id}</code>
              </dd>
            </div>
            <div>
              <dt>类型</dt>
              <dd>{workflowNodeTypeLabels[node.type]}</dd>
            </div>
          </dl>

          <label className="workflow-field">
            <span>标签</span>
            <input value={node.label} onChange={(event) => onChange(withLabel(node, event.target.value))} />
          </label>

          {node.type === "agent" && (
            <>
              <label className="workflow-field">
                <span>访问</span>
                <select
                  value={node.config.access}
                  onChange={(event) => onChange(withAgentConfig(node, { access: event.target.value === "write" ? "write" : "read" }))}
                >
                  <option value="read">只读</option>
                  <option value="write">写入</option>
                </select>
              </label>
              <label className="workflow-field">
                <span>提示词</span>
                <textarea
                  rows={6}
                  value={node.config.prompt}
                  onChange={(event) => onChange(withAgentConfig(node, { prompt: event.target.value }))}
                />
              </label>
              <label className="workflow-field">
                <span>模型</span>
                <input
                  value={node.config.model ?? ""}
                  placeholder="留空则使用运行模型"
                  onChange={(event) => onChange(withAgentConfig(node, { model: event.target.value }))}
                />
              </label>
            </>
          )}

          {node.type === "decision" && (
            <label className="workflow-field">
              <span>决策目录</span>
              <input value={node.config.directory} readOnly />
            </label>
          )}

          {node.type === "approval" && (
            <label className="workflow-field">
              <span>允许驳回</span>
              <input value="固定为 true" readOnly />
            </label>
          )}

          {(node.type === "context" || node.type === "validation") && <p className="workflow-hint">此节点没有额外配置。</p>}

          {onDelete && (
            <button type="button" className="workflow-delete-node" disabled={!canDelete} onClick={onDelete}>
              <Trash2 size={14} /> 删除只读 Agent
            </button>
          )}
        </div>
      )}
    </section>
  );
}
