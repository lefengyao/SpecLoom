import {
  OFFICIAL_WORKFLOW_ID,
  type WorkflowDefaultResolution,
  type WorkflowSettings,
} from "../../shared/orchestration";
import { validateWorkflowDefinition, type WorkflowDefinition } from "../../shared/workflow";

export interface ResolveDefaultWorkflowOptions {
  settings: WorkflowSettings;
  /** Load and return one project workflow; a rejection means "not usable". */
  loadProject: (id: string) => Promise<WorkflowDefinition>;
  /** Load the bundled official development-review workflow. */
  loadOfficial: () => Promise<WorkflowDefinition>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function officialDefault(loadOfficial: () => Promise<WorkflowDefinition>): Promise<WorkflowDefaultResolution> {
  const official = await loadOfficial();
  return { workflowId: official.id, source: "official" };
}

/**
 * Resolve the workflow a task or chat implementation starts when the user did
 * not pick one.
 *
 * A configured id is only trusted after it loads and passes the same B rules
 * the editor enforces; anything else falls back to the official workflow with a
 * readable warning instead of failing the start. The official virtual id means
 * "use the global default", so it never tries a project file.
 */
export async function resolveDefaultWorkflow(
  options: ResolveDefaultWorkflowOptions,
): Promise<WorkflowDefaultResolution> {
  const requested = options.settings.defaultWorkflowId;
  if (requested === undefined || requested === OFFICIAL_WORKFLOW_ID) {
    return officialDefault(options.loadOfficial);
  }

  let reason: string;
  try {
    const definition = validateWorkflowDefinition(await options.loadProject(requested));
    if (definition.id === requested) {
      return { workflowId: definition.id, source: "project" };
    }
    reason = "定义声明的 id 为 " + JSON.stringify(definition.id);
  } catch (error) {
    reason = messageOf(error);
  }

  const official = await options.loadOfficial();
  return {
    workflowId: official.id,
    source: "fallback",
    warning: "项目默认工作流 " + JSON.stringify(requested) + " 不可用，已回退到官方工作流：" + reason,
  };
}
