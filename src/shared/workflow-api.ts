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

/** The user-supplied inputs of one run. */
export interface WorkflowRunInputs {
  goal: string;
  readPaths: string[];
  writePaths: string[];
  model?: string;
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
