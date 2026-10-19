import { z } from "zod";
import type { ValidationResult, VersionToken } from "./contracts";
import type { WorkflowDefinition, WorkflowNode } from "./workflow";

/**
 * Serializable workflow contracts shared by the main process, the preload
 * bridge, and the renderer.
 *
 * These are structural copies of the types owned by the workflow store and the
 * workflow runner. The store and the runner keep their own definitions on
 * purpose: they are the source of truth for the on-disk record, while this
 * module is the only shape that may cross a process boundary. Nothing here may
 * import from the main process.
 */

/** One definition in the project workflow list. */
export interface WorkflowSummary {
  id: string;
  title: string;
  nodeCount: number;
  writeCount: number;
  /** Numeric version stored inside the definition document. */
  definitionVersion: number;
  /** Content version token of the YAML file that stores the definition. */
  fileVersion: VersionToken;
}

/** A loaded workflow definition plus the token needed to write it back. */
export interface WorkflowSource {
  definition: WorkflowDefinition;
  /** Content version token of the YAML file, for later save/remove checks. */
  fileVersion: VersionToken;
  source: string;
}

export interface WorkflowSaveResult {
  fileVersion: VersionToken;
}

export interface WorkflowCopyResult {
  id: string;
  fileVersion: VersionToken;
}

/** Lifecycle of one workflow run. */
export type WorkflowRunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

/** Lifecycle of one node inside a workflow run. */
export type WorkflowNodeStatus = "pending" | "running" | "waiting_approval" | "completed" | "failed" | "skipped";

/**
 * Hard cap for the optional previous-step context carried into one run.
 *
 * The unit is characters (UTF-16 code units), not bytes: this is a prompt
 * contract, not a file-size limit, so a value of MAX_RUN_CONTEXT_LENGTH
 * characters is valid and MAX_RUN_CONTEXT_LENGTH + 1 is not.
 */
export const MAX_RUN_CONTEXT_LENGTH = 32768;

/**
 * The user-supplied inputs of one run.
 *
 * `context` is optional and bounded so an orchestration can hand the next step
 * a summary without copying an unbounded history into the prompt. It is
 * trimmed, and an empty or whitespace-only value is treated as absent.
 */
export const WorkflowRunInputsSchema = z
  .object({
    goal: z.string().trim().min(1, "goal must not be empty").max(8192, "goal must be at most 8192 characters"),
    readPaths: z
      .array(z.string().trim().min(1, "read paths must not be empty").max(1024))
      .min(1, "readPaths must contain at least one path")
      .max(256),
    writePaths: z
      .array(z.string().trim().min(1, "write paths must not be empty").max(1024))
      .min(1, "writePaths must contain at least one path")
      .max(256),
    model: z.string().trim().min(1, "model must not be empty").max(120).optional(),
    context: z
      .string()
      .trim()
      .max(MAX_RUN_CONTEXT_LENGTH, "context must be at most " + MAX_RUN_CONTEXT_LENGTH + " characters")
      .optional()
      .transform((value) => (value === undefined || value.length === 0 ? undefined : value)),
  })
  .strict();

export interface WorkflowRunInputs {
  goal: string;
  readPaths: string[];
  writePaths: string[];
  model?: string | undefined;
  context?: string | undefined;
}

/** Snapshot of one node's execution state. */
export interface WorkflowNodeState {
  id: string;
  type: WorkflowNode["type"];
  status: WorkflowNodeStatus;
  attempts: number;
  taskId?: string;
  output?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

/** The approval currently requested (or granted) for one run. */
export interface WorkflowApproval {
  /** Digest of the staged change set that was previewed. */
  digest: string;
  /** Set only after approve() succeeded. */
  approvedAt?: string;
  /** True when the approval policy approved the change set without a human. */
  autoApproved?: boolean;
  /** Who granted the approval; "orchestrator" for an auto approval. */
  approvedBy?: string;
}

/** A durable workflow run record. */
export interface WorkflowRun {
  schemaVersion: 1;
  runId: string;
  workflowId: string;
  title: string;
  workflowVersion: number;
  definitionSnapshot: WorkflowDefinition;
  inputs: WorkflowRunInputs;
  status: WorkflowRunStatus;
  nodeStates: WorkflowNodeState[];
  readTaskIds: string[];
  writeTaskId?: string;
  /** Number of implementation attempts: 1 for the first, +1 for each rejection. */
  attempts: number;
  validation?: ValidationResult;
  approval?: WorkflowApproval;
  decisionPath?: string;
  /** Resolved profile id, persisted so a hydrated run can still name its model. */
  resolvedModel?: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

/** Actions a failed run can resume from. */
export type WorkflowRetryAction = "plan" | "implement" | "validate";

/** One runner transition pushed to the renderer. */
export interface WorkflowUpdate {
  /** Project root the run belongs to; the renderer compares it to its own. */
  projectPath: string;
  run: WorkflowRun;
}
