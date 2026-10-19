import { z } from "zod";
import type { VersionToken } from "../../../shared/contracts";
import type { OrchestrationRun, WorkflowDefaultSource } from "../../../shared/orchestration";
import type { OrchestrationSource, OrchestrationSummary } from "../../../shared/orchestration-api";
import { WORKFLOW_ID_PATTERN } from "../../../shared/workflow";
import { MAX_RUN_CONTEXT_LENGTH, WorkflowRunInputsSchema } from "../../../shared/workflow-api";
import type {
  WorkflowApproval,
  WorkflowNodeState,
  WorkflowRun,
  WorkflowRunInputs,
  WorkflowRunStatus,
  WorkflowSource,
  WorkflowSummary,
} from "../../../shared/workflow-api";
import { ProjectError } from "../errors";
import type { WorkTool } from "./catalog";

/**
 * Agent-facing workflow and orchestration tools.
 *
 * Two rules shape this module:
 *
 * 1. No tool approves anything. An approval only ever happens because the
 *    definition says `approvalPolicy: auto` or an orchestration step says
 *    `approval: auto` (and even then the orchestrator performs it), never
 *    because an agent asked for one. There is deliberately no WorkflowApprove.
 * 2. Run inputs are explicit. `goal`, `readPaths`, and `writePaths` are resolved
 *    from the call itself; the tool never silently borrows a session's or an
 *    unrelated task's scope. Omitted inputs produce a readable error instead.
 *
 * The runtime interface below keeps this module free of Electron, ProjectCore,
 * and the stores: the main wiring injects one runtime per project, and tests
 * inject a fake.
 */

/** The default id any run tool uses when the caller does not name a workflow. */
export const DEFAULT_WORKFLOW_TARGET = "default";

/** Summaries plus the project default a WorkflowList call reports. */
export interface WorkflowListResult {
  workflows: WorkflowSummary[];
  /** The workflow a run starts when the caller passes "default" or no id. */
  defaultWorkflowId: string;
  /** Whether that default came from the project settings, the official template, or a fallback. */
  defaultSource: WorkflowDefaultSource;
  /** Present when a configured project default was unusable and the official workflow was used. */
  warning?: string;
}

export interface WorkflowCreateResult {
  id: string;
  /** Content version token of the YAML file the store just wrote. */
  fileVersion: VersionToken;
}

/** Orchestration summaries; orchestrations never have a default marker. */
export interface OrchestrationListResult {
  orchestrations: OrchestrationSummary[];
}

export interface OrchestrationCreateResult {
  id: string;
  /** Content version token of the YAML file the store just wrote. */
  fileVersion: VersionToken;
}

/**
 * Compact run snapshot returned to the model. The definition snapshot and the
 * full validation diagnostics stay out: a status answer only needs identity,
 * lifecycle, per-node state, and the approval/decision pointers.
 */
export interface WorkflowRunView {
  runId: string;
  workflowId: string;
  title: string;
  workflowVersion: number;
  status: WorkflowRunStatus;
  nodeStates: WorkflowNodeState[];
  attempts: number;
  approval?: WorkflowApproval;
  validationStatus?: string;
  decisionPath?: string;
  resolvedModel?: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

/**
 * Bridge between the agent tools and the project workflow stores/runner.
 *
 * Every method is asynchronous and returns the durable shape the tool reports.
 * `create` and `orchestrationCreate` take an unknown definition on purpose:
 * validation belongs to the store/validator so the agent gets the same readable
 * B-rule or schema message the editor gets.
 */
export interface WorkflowToolRuntime {
  list(): Promise<WorkflowListResult>;
  read(id: string): Promise<WorkflowSource>;
  create(definition: unknown): Promise<WorkflowCreateResult>;
  run(inputs: WorkflowRunInputs, workflowId?: string | undefined): Promise<WorkflowRun>;
  status(runId: string): Promise<WorkflowRun>;
  cancel(runId: string): Promise<WorkflowRun>;
  orchestrationList(): Promise<OrchestrationListResult>;
  orchestrationRead(id: string): Promise<OrchestrationSource>;
  orchestrationCreate(definition: unknown): Promise<OrchestrationCreateResult>;
  orchestrationRun(orchestrationId: string, inputs: WorkflowRunInputs): Promise<OrchestrationRun>;
  orchestrationStatus(runId: string): Promise<OrchestrationRun>;
  orchestrationCancel(runId: string): Promise<OrchestrationRun>;
}

/** Project a durable run record down to the fields a tool result needs. */
export function workflowRunView(run: WorkflowRun): WorkflowRunView {
  return {
    runId: run.runId,
    workflowId: run.workflowId,
    title: run.title,
    workflowVersion: run.workflowVersion,
    status: run.status,
    nodeStates: run.nodeStates,
    attempts: run.attempts,
    ...(run.approval === undefined ? {} : { approval: run.approval }),
    ...(run.validation === undefined ? {} : { validationStatus: run.validation.status }),
    ...(run.decisionPath === undefined ? {} : { decisionPath: run.decisionPath }),
    ...(run.resolvedModel === undefined ? {} : { resolvedModel: run.resolvedModel }),
    startedAt: run.startedAt,
    ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
    ...(run.error === undefined ? {} : { error: run.error }),
  };
}

/** Raw run-tool arguments, before the explicit-input rules are applied. */
export interface WorkflowRunToolInput {
  goal?: string | undefined;
  readPaths?: string[] | undefined;
  writePaths?: string[] | undefined;
  model?: string | undefined;
  context?: string | undefined;
}

function firstIssue(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .map((issue) => (issue.path.length > 0 ? issue.path.map((part) => String(part)).join(".") + ": " : "") + issue.message)
    .join("; ");
}

/**
 * Resolve run inputs from an explicit tool call.
 *
 * The agent must name the goal and both scopes. Falling back to "whatever task
 * the session is attached to" would let one run quietly write into an unrelated
 * task's scope, so an omitted value is a readable VALIDATION_FAILED instead.
 * Task-scope reuse arrives with the trigger work in Task 9, not here.
 */
export function explicitRunInputs(tool: string, input: WorkflowRunToolInput): WorkflowRunInputs {
  const goal = typeof input.goal === "string" ? input.goal.trim() : "";
  if (goal.length === 0) {
    throw new ProjectError(
      "VALIDATION_FAILED",
      tool + " 需要显式 goal：请提供本次实现目标，不会自动使用会话或任务范围",
    );
  }
  const readPaths = [...(input.readPaths ?? [])];
  const writePaths = [...(input.writePaths ?? [])];
  if (readPaths.length === 0) {
    throw new ProjectError(
      "VALIDATION_FAILED",
      tool + " 需要显式 readPaths：请提供读取范围，不会自动使用会话或任务范围",
    );
  }
  if (writePaths.length === 0) {
    throw new ProjectError(
      "VALIDATION_FAILED",
      tool + " 需要显式 writePaths：请提供写入范围，不会自动使用会话或任务范围",
    );
  }

  const parsed = WorkflowRunInputsSchema.safeParse({
    goal,
    readPaths,
    writePaths,
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.context === undefined ? {} : { context: input.context }),
  });
  if (!parsed.success) {
    throw new ProjectError("VALIDATION_FAILED", tool + " 参数无效：" + firstIssue(parsed.error));
  }
  return parsed.data;
}

/**
 * Map an explicit id to the runtime's target: "default" and an omitted id both
 * mean "resolve the project default", any other value names a definition.
 */
export function requestedWorkflowId(id: string | undefined): string | undefined {
  return id === undefined || id === DEFAULT_WORKFLOW_TARGET ? undefined : id;
}

const empty = z.object({}).strict();
const workflowId = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(WORKFLOW_ID_PATTERN, "工作流 id 必须是小写 snake_case，最多 120 个字符");
const orchestrationId = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(WORKFLOW_ID_PATTERN, "编排 id 必须是小写 snake_case，最多 120 个字符");
const runId = z.string().trim().min(1).max(128);
const relativePath = z.string().trim().min(1).max(1024);
const model = z.string().trim().min(1).max(120);

/**
 * Goal, scope, and context stay optional here so a call that omits them reaches
 * explicitRunInputs() and fails with a readable message instead of a generic
 * schema rejection.
 */
const runInputFields = {
  goal: z.string().max(8192).optional(),
  readPaths: z.array(relativePath).max(256).optional(),
  writePaths: z.array(relativePath).max(256).optional(),
  model: model.optional(),
  context: z.string().max(MAX_RUN_CONTEXT_LENGTH).optional(),
};

/**
 * The Workflow* and Orchestration* definitions.
 *
 * They are not in the initial set: the catalog only exposes initial tools to the
 * model, so ToolSearch has to discover these first and their schemas stay out of
 * every request that does not work with workflows.
 */
export const workflowToolDefinitions: WorkTool[] = [
  {
    name: "WorkflowList",
    initial: false,
    description: "列出项目工作流定义、节点数量和写入范围，并返回默认工作流 id 与来源（project/official/fallback）。运行工作流前先确认默认项。",
    schema: empty,
  },
  {
    name: "WorkflowRead",
    initial: false,
    description: "读取一个工作流定义的完整 YAML 源码、解析结果和文件版本；修改前必须先读取。",
    schema: z.object({ id: workflowId }).strict(),
  },
  {
    name: "WorkflowCreate",
    initial: false,
    description: "提交完整的工作流 B 定义对象；通过 B 校验后写入 specs/workflows/<id>.yaml，返回 id 与文件版本。不会启动运行，也不会批准任何变更。",
    schema: z.object({ definition: z.unknown() }).strict(),
  },
  {
    name: "WorkflowRun",
    initial: false,
    description: "启动一次工作流运行。id 可为项目工作流 id 或 \"default\"（省略同样使用默认）；goal/readPaths/writePaths 必须显式提供，不会自动套用会话或任务范围；返回 runId 与当前状态。审批只由定义中的 approvalPolicy 决定，没有批准工具。",
    schema: z.object({ id: z.union([z.literal(DEFAULT_WORKFLOW_TARGET), workflowId]).optional(), ...runInputFields }).strict(),
  },
  {
    name: "WorkflowStatus",
    initial: false,
    description: "按 runId 读取工作流运行状态、节点状态、待审批摘要、决策记录和错误。",
    schema: z.object({ runId }).strict(),
  },
  {
    name: "WorkflowCancel",
    initial: false,
    description: "取消一个工作流运行并返回取消后的状态；已结束的运行保持原状态。",
    schema: z.object({ runId }).strict(),
  },
  {
    name: "OrchestrationList",
    initial: false,
    description: "列出项目编排定义及其步骤数量；编排没有默认项。",
    schema: empty,
  },
  {
    name: "OrchestrationRead",
    initial: false,
    description: "读取一个编排定义的完整 YAML 源码、解析结果和文件版本。",
    schema: z.object({ id: orchestrationId }).strict(),
  },
  {
    name: "OrchestrationCreate",
    initial: false,
    description: "提交完整的编排定义对象（步骤按顺序引用已有工作流 id）；通过 schema 校验后写入 specs/orchestrations/<id>.yaml，返回 id 与文件版本。",
    schema: z.object({ definition: z.unknown() }).strict(),
  },
  {
    name: "OrchestrationRun",
    initial: false,
    description: "按现有编排 id 启动顺序运行；goal/readPaths/writePaths 必须显式提供，不会自动套用会话或任务范围；返回编排运行记录。审批只由步骤的 approval 配置决定。",
    schema: z.object({ id: orchestrationId, ...runInputFields }).strict(),
  },
  {
    name: "OrchestrationStatus",
    initial: false,
    description: "按编排运行 id 读取阶段、当前步骤、每步状态与摘要。",
    schema: z.object({ runId }).strict(),
  },
  {
    name: "OrchestrationCancel",
    initial: false,
    description: "取消一个编排运行（连同当前子运行）并返回取消后的记录。",
    schema: z.object({ runId }).strict(),
  },
];
