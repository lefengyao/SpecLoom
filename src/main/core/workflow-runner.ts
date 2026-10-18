import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";
import { z } from "zod";
import { ValidationResultSchema, type ValidationResult } from "../../shared/contracts";
import {
  WORKFLOW_LIMITS,
  validateWorkflowDefinition,
  WorkflowNodeTypeSchema,
  WorkflowValidationError,
  type WorkflowDefinition,
  type WorkflowNode,
} from "../../shared/workflow";
import { WorkflowRunInputsSchema } from "../../shared/workflow-api";
import { ProjectError } from "./errors";
import { FileStore } from "./file-store";
import type { WorkflowTaskAdapter } from "./workflow-task-adapter";

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
 * The user-supplied inputs of one run.
 *
 * This is the runner's structural copy of the shared contract; validation and
 * record checks use the shared WorkflowRunInputsSchema so the types cannot
 * drift. `context` is the optional, bounded previous-step summary.
 */
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
}

/**
 * A durable workflow run record.
 *
 * Field names follow the design record contract: title, definitionSnapshot and
 * approval (digest / approvedAt). Records are validated again when read.
 */
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

export interface WorkflowRunnerOptions {
  adapter: WorkflowTaskAdapter;
  /** Project root; run records live under .specloom/workflows/runs. */
  root: string;
  /** Optional FileStore used for the decision document; defaults to one on root. */
  files?: FileStore;
  /** Injectable clock, used for deterministic timestamps in tests. */
  now?: () => Date;
  /** Injectable run id generator; ids must be usable as file names. */
  idFactory?: () => string;
  /**
   * Called with a clone of the durable record after each persist succeeds.
   * createRun() does not persist, so it never reports an update.
   */
  onUpdate?: (run: WorkflowRun) => void;
}

/** Hard cap for a persisted node output. */
export const MAX_NODE_OUTPUT_LENGTH = 16 * 1024;
/** Hard cap for a persisted error message. */
export const MAX_NODE_ERROR_LENGTH = 2000;
/** Hard cap for one persisted run record. */
export const MAX_RECORD_BYTES = 4 * 1024 * 1024;

const RUNS_DIRECTORY = ".specloom/workflows/runs";
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const INTERRUPTED_MESSAGE = "Workflow run was interrupted when the application restarted";
const TERMINAL_STATUSES: readonly WorkflowRunStatus[] = ["completed", "failed", "cancelled", "interrupted"];

const WorkflowNodeStateRecordSchema = z
  .object({
    id: z.string().min(1).max(80),
    type: WorkflowNodeTypeSchema,
    status: z.enum(["pending", "running", "waiting_approval", "completed", "failed", "skipped"]),
    attempts: z.number().int().min(0).max(10_000),
    taskId: z.string().min(1).max(256).optional(),
    output: z.string().max(MAX_NODE_OUTPUT_LENGTH).optional(),
    error: z.string().max(MAX_NODE_ERROR_LENGTH).optional(),
    startedAt: z.string().datetime().optional(),
    finishedAt: z.string().datetime().optional(),
  })
  .strict();

const WorkflowApprovalRecordSchema = z
  .object({
    digest: z.string().min(1).max(4096),
    approvedAt: z.string().datetime().optional(),
  })
  .strict();

const WorkflowRunRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().max(128).regex(RUN_ID_PATTERN),
    workflowId: z.string().min(1).max(120),
    title: z.string().min(1).max(200),
    workflowVersion: z.number().int().positive(),
    definitionSnapshot: z.unknown(),
    inputs: WorkflowRunInputsSchema,
    status: z.enum(["queued", "running", "waiting_approval", "completed", "failed", "cancelled", "interrupted"]),
    nodeStates: z.array(WorkflowNodeStateRecordSchema).max(WORKFLOW_LIMITS.nodes),
    readTaskIds: z.array(z.string().min(1).max(256)).max(WORKFLOW_LIMITS.nodes * 4),
    writeTaskId: z.string().min(1).max(256).optional(),
    attempts: z.number().int().min(0).max(10_000),
    validation: ValidationResultSchema.optional(),
    approval: WorkflowApprovalRecordSchema.optional(),
    decisionPath: z.string().min(1).max(4096).optional(),
    resolvedModel: z.string().min(1).max(120).optional(),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime().optional(),
    error: z.string().max(MAX_NODE_ERROR_LENGTH).optional(),
  })
  .strict();

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Remove credentials from an error before it is persisted or shown. */
function redactErrorMessage(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(
      /(["']?(?:api[-_]?key|(?:access|refresh|auth)[-_]?token|token|password|(?:client[-_]?)?secret|authorization|credential|cookie)["']?\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}&]+)/gi,
      "$1[redacted]",
    )
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, "https://[redacted]@");
}

function boundOutput(value: string): string {
  return value.length > MAX_NODE_OUTPUT_LENGTH ? value.slice(0, MAX_NODE_OUTPUT_LENGTH) : value;
}

function boundError(value: string): string {
  return value.length > MAX_NODE_ERROR_LENGTH ? value.slice(0, MAX_NODE_ERROR_LENGTH) : value;
}

/** Redact and bound one error message before storing it in a record. */
function boundedError(error: unknown): string {
  const redacted = redactErrorMessage(messageOf(error)).trim();
  return boundError(redacted.length > 0 ? redacted : "Unknown workflow error");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function assertRunId(runId: string): void {
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
    throw new ProjectError("VALIDATION_FAILED", "Invalid workflow run id: " + JSON.stringify(String(runId)));
  }
}

function assertProjectRelativePath(value: string): void {
  const normalized = value.replaceAll("\\", "/");
  if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized) || normalized.includes("\0")) {
    throw new ProjectError("VALIDATION_FAILED", "Workflow paths must be project-relative: " + JSON.stringify(value));
  }
  if (normalized.split("/").includes("..")) {
    throw new ProjectError("VALIDATION_FAILED", "Workflow paths cannot escape the project root: " + JSON.stringify(value));
  }
}

/** Keep run ids usable in the decision file name without changing the record. */
function safeFileSegment(value: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+/, "")
    .slice(0, 80);
  return cleaned.length > 0 ? cleaned : "workflow";
}

function recordError(runId: string, detail: string): ProjectError {
  return new ProjectError("INTERNAL_ERROR", boundedError("Workflow run record " + runId + " " + detail));
}

function parseRunRecord(source: string, expectedRunId: string): WorkflowRun {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    // Never echo the record body or the raw parser message: both can contain credentials.
    throw recordError(expectedRunId, "is not valid JSON");
  }

  const result = WorkflowRunRecordSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const location = issue && issue.path.length > 0 ? issue.path.map(String).join(".") : "record";
    throw recordError(expectedRunId, "is invalid at " + location + ": " + (issue?.message ?? "unknown schema error"));
  }

  const run = result.data as WorkflowRun;
  if (run.runId !== expectedRunId) {
    throw recordError(expectedRunId, "declares a different runId");
  }

  let snapshot: WorkflowDefinition;
  try {
    snapshot = validateWorkflowDefinition(run.definitionSnapshot);
  } catch (error) {
    const message = error instanceof WorkflowValidationError ? error.message : messageOf(error);
    throw recordError(expectedRunId, "has an invalid definition snapshot: " + message);
  }
  if (snapshot.id !== run.workflowId || snapshot.title !== run.title || snapshot.version !== run.workflowVersion) {
    throw recordError(expectedRunId, "does not match its definition snapshot identity");
  }

  const expectedNodes = new Map(snapshot.nodes.map((node) => [node.id, node.type]));
  if (run.nodeStates.length !== expectedNodes.size) {
    throw recordError(expectedRunId, "does not carry exactly one state per definition node");
  }
  const seen = new Set<string>();
  for (const state of run.nodeStates) {
    if (seen.has(state.id) || expectedNodes.get(state.id) !== state.type) {
      throw recordError(expectedRunId, "has a node state that does not match the definition snapshot");
    }
    seen.add(state.id);
  }

  if (run.status === "waiting_approval" && !run.approval?.digest) {
    throw recordError(expectedRunId, "is waiting for approval without an approval digest");
  }
  if (run.decisionPath !== undefined && !run.decisionPath.startsWith("specs/decisions/")) {
    throw recordError(expectedRunId, "has a decision path outside specs/decisions");
  }

  return { ...run, definitionSnapshot: snapshot };
}

function validationFailureMessage(result: ValidationResult): string {
  const errors = result.diagnostics
    .filter((diagnostic) => diagnostic.severity === "error")
    .map((diagnostic) => diagnostic.message.trim())
    .filter((message) => message.length > 0);
  const detail = errors.length > 0 ? errors.slice(0, 3).join("; ") : "validation status " + result.status;
  return "Validation did not pass: " + detail;
}

function isTerminal(status: WorkflowRunStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Executes one workflow definition at a time against a WorkflowTaskAdapter.
 *
 * start() is deliberately background: it resolves after the queued record is
 * persisted and the first node has been launched, not after the graph finishes.
 * Callers that need an outcome use waitForRun(). The runner owns the run state
 * machine, the atomic run record, and the one decision document a completed run
 * may write. It never touches ProjectCore directly and never starts a shell
 * command, so it stays Electron-free.
 */
export class WorkflowRunner {
  private readonly adapter: WorkflowTaskAdapter;
  private readonly root: string;
  private readonly files: FileStore;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly onUpdate: ((run: WorkflowRun) => void) | undefined;
  /** Runs created by this instance or hydrated from disk. */
  private readonly runs = new Map<string, WorkflowRun>();
  /** The single run allowed to own a task/agent in this runner instance. */
  private activeRunId: string | undefined;
  private readonly controllers = new Map<string, AbortController>();
  /** Serializes writes per run so a late transition cannot overwrite a newer record. */
  private readonly persistChains = new Map<string, Promise<void>>();
  /**
   * The last record per run that is known to be durable. Background transitions
   * mutate the live run and enqueue the write in the same tick, so the live
   * object can legitimately be ahead of the record that carries its state.
   * External observers (getRun/listRuns/waitForRun) must only see this map, so a
   * fresh runner can never hydrate an older record than the one that was
   * observed here.
   */
  private readonly durableRuns = new Map<string, WorkflowRun>();

  constructor(options: WorkflowRunnerOptions) {
    this.adapter = options.adapter;
    this.root = path.resolve(options.root);
    this.files = options.files ?? new FileStore(this.root);
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => "run-" + randomUUID());
    this.onUpdate = options.onUpdate;
  }

  /**
   * Validate inputs and definition, snapshot both, and initialize every node as
   * pending. Nothing is persisted until start(), so an abandoned draft run leaves
   * no record behind.
   */
  createRun(definition: WorkflowDefinition, inputs: WorkflowRunInputs): WorkflowRun {
    let snapshot: WorkflowDefinition;
    try {
      snapshot = validateWorkflowDefinition(definition);
    } catch (error) {
      const message = error instanceof WorkflowValidationError ? error.message : messageOf(error);
      throw new ProjectError("VALIDATION_FAILED", "Invalid workflow definition: " + message);
    }

    const parsed = WorkflowRunInputsSchema.safeParse(inputs);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ProjectError("VALIDATION_FAILED", "Invalid workflow run inputs: " + (issue?.message ?? "unknown input error"));
    }
    const value: WorkflowRunInputs = {
      goal: parsed.data.goal,
      readPaths: [...parsed.data.readPaths],
      writePaths: [...parsed.data.writePaths],
      ...(parsed.data.model === undefined ? {} : { model: parsed.data.model }),
      ...(parsed.data.context === undefined ? {} : { context: parsed.data.context }),
    };

    const runId = this.idFactory();
    assertRunId(runId);
    if (this.runs.has(runId)) {
      throw new ProjectError("VALIDATION_FAILED", "Workflow run id is already in use: " + runId);
    }

    const run: WorkflowRun = {
      schemaVersion: 1,
      runId,
      workflowId: snapshot.id,
      title: snapshot.title,
      workflowVersion: snapshot.version,
      definitionSnapshot: snapshot,
      inputs: value,
      status: "queued",
      nodeStates: snapshot.nodes.map((node) => ({ id: node.id, type: node.type, status: "pending", attempts: 0 })),
      readTaskIds: [],
      attempts: 0,
      startedAt: this.timestamp(),
    };
    this.runs.set(runId, run);
    return this.view(run);
  }

  /**
   * Start a queued run in the background and return before any node finishes.
   * Use waitForRun() to observe a status; errors after this point are persisted
   * on the run record.
   */
  async start(runId: string): Promise<void> {
    const run = await this.loadRun(runId);
    await this.assertNoOtherActiveRun(runId);
    if (run.status !== "queued") {
      throw new ProjectError("VALIDATION_FAILED", "Workflow run " + runId + " cannot start from status " + run.status);
    }

    const previousStartedAt = run.startedAt;
    this.activeRunId = runId;
    run.status = "running";
    run.startedAt = this.timestamp();
    delete run.finishedAt;
    delete run.error;
    const controller = new AbortController();
    this.controllers.set(runId, controller);

    try {
      await this.persist(run);
    } catch (error) {
      run.status = "queued";
      run.startedAt = previousStartedAt;
      this.release(runId);
      throw error;
    }
    this.launch(run, this.contextNode(run.definitionSnapshot).id, controller);
  }

  /**
   * Read a run from memory, or hydrate its persisted record on a fresh instance.
   * The returned snapshot only carries state whose record has been written, so
   * an approval or rejection can never be observed before it is durable.
   */
  async getRun(runId: string): Promise<WorkflowRun> {
    return await this.loadRun(runId, { snapshot: true });
  }

  /** Persisted runs, newest first by start time. Stale running records hydrate as interrupted. */
  async listRuns(): Promise<WorkflowRun[]> {
    let names: string[];
    try {
      names = await readdir(this.runsDirectory());
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const runs: WorkflowRun[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        runs.push(await this.loadRun(name.slice(0, -".json".length), { snapshot: true }));
      } catch {
        // A record that cannot be read is skipped rather than hiding every other record.
      }
    }
    runs.sort((left, right) => right.startedAt.localeCompare(left.startedAt) || right.runId.localeCompare(left.runId));
    return runs;
  }

  /** Poll for a state the callers care about; predicates run against a snapshot. */
  async waitForRun(runId: string, predicate: (run: WorkflowRun) => boolean, timeoutMs = 5000): Promise<WorkflowRun> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      const run = await this.getRun(runId);
      if (predicate(run)) return run;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new ProjectError(
          "INTERNAL_ERROR",
          "Timed out waiting for workflow run " + runId + " (status: " + run.status + ")",
        );
      }
      await delay(Math.min(25, remaining));
    }
  }

  /** Stop a run. The write task is deliberately kept for inspection. */
  async cancel(runId: string): Promise<void> {
    const run = await this.loadRun(runId);
    if (isTerminal(run.status)) return;
    const controller = this.controllers.get(runId);
    controller?.abort();
    const active = run.nodeStates.find((state) => state.status === "running" || state.status === "waiting_approval");
    run.status = "cancelled";
    run.finishedAt = this.timestamp();
    if (active) {
      active.status = "failed";
      active.error = "Cancelled by the user";
      active.finishedAt = run.finishedAt;
    }
    this.release(runId);
    await this.persist(run);
  }

  /** Resume one failed run at the requested node, reusing the write task. */
  async retry(runId: string, action: WorkflowRetryAction): Promise<void> {
    const run = await this.loadRun(runId);
    if (run.status !== "failed") {
      throw new ProjectError("VALIDATION_FAILED", "Workflow run " + runId + " can only retry from status failed, not " + run.status);
    }
    await this.assertNoOtherActiveRun(runId);
    if (action !== "plan" && action !== "implement" && action !== "validate") {
      throw new ProjectError("VALIDATION_FAILED", "Unsupported workflow retry action: " + JSON.stringify(String(action)));
    }
    const target = this.nodeForAction(run.definitionSnapshot, action);
    if (action === "validate" && !run.writeTaskId) {
      throw new ProjectError("VALIDATION_FAILED", "Workflow run " + runId + " has no write task to validate");
    }

    this.resetFrom(run, target.id);
    run.status = "running";
    delete run.error;
    delete run.finishedAt;
    delete run.approval;
    delete run.validation;
    delete run.decisionPath;
    const controller = new AbortController();
    this.activeRunId = runId;
    this.controllers.set(runId, controller);
    try {
      await this.persist(run);
    } catch (error) {
      run.status = "failed";
      run.error = boundedError(error);
      run.finishedAt = this.timestamp();
      this.release(runId);
      throw error;
    }
    this.launch(run, target.id, controller);
  }

  /** Approve the current change set and record the decision. */
  async approve(runId: string, digest: string): Promise<void> {
    const run = await this.loadRun(runId);
    if (run.status !== "waiting_approval") {
      throw new ProjectError("VALIDATION_FAILED", "Workflow run " + runId + " is not waiting for approval");
    }
    const approval = run.approval;
    if (!approval) {
      throw new ProjectError("VALIDATION_FAILED", "Workflow run " + runId + " has no approval digest");
    }
    if (typeof digest !== "string" || digest.length === 0 || digest !== approval.digest) {
      throw new ProjectError("VALIDATION_FAILED", "Approval digest does not match the current change set");
    }
    const taskId = run.writeTaskId;
    if (!taskId) {
      throw new ProjectError("VALIDATION_FAILED", "Workflow run " + runId + " has no write task to approve");
    }
    const decision = run.definitionSnapshot.nodes.find((node) => node.type === "decision");
    if (!decision) {
      throw new ProjectError("VALIDATION_FAILED", "Workflow " + run.definitionSnapshot.id + " has no decision node");
    }
    await this.assertNoOtherActiveRun(runId, { allowSelfActive: true });

    await this.adapter.approve(taskId, digest);
    run.approval = { digest, approvedAt: this.timestamp() };
    const review = run.definitionSnapshot.nodes.find((node) => node.type === "approval");
    if (review) {
      const state = this.nodeState(run, review.id);
      if (state.status === "waiting_approval") {
        state.status = "completed";
        state.finishedAt = this.timestamp();
      }
    }
    run.status = "running";
    delete run.finishedAt;
    delete run.error;
    const controller = new AbortController();
    this.activeRunId = runId;
    this.controllers.set(runId, controller);
    try {
      await this.persist(run);
    } catch (error) {
      await this.failRun(run, undefined, error);
      throw error;
    }

    try {
      await this.executeFrom(run, decision.id, controller);
    } catch (error) {
      await this.failRun(run, decision.id, error);
      return;
    }
    if (run.status === "running") {
      await this.failRun(run, decision.id, new Error("Workflow run stopped before reaching a terminal state"));
    }
  }

  /**
   * Reject the current change set and rerun implement -> validate -> review.
   * The implementation attempt count increments on rejection; the run fails
   * only once that count exceeds the definition's maxImplementAttempts.
   */
  async reject(runId: string): Promise<void> {
    const run = await this.loadRun(runId);
    if (run.status !== "waiting_approval") {
      throw new ProjectError("VALIDATION_FAILED", "Workflow run " + runId + " is not waiting for approval");
    }
    const taskId = run.writeTaskId;
    if (!taskId) {
      throw new ProjectError("VALIDATION_FAILED", "Workflow run " + runId + " has no write task to reject");
    }
    const maxAttempts = run.definitionSnapshot.settings.maxImplementAttempts;
    const implement = this.nodeForAction(run.definitionSnapshot, "implement");
    const review = run.definitionSnapshot.nodes.find((node) => node.type === "approval");

    await this.adapter.reject(taskId);
    run.attempts += 1;

    if (run.attempts > maxAttempts) {
      const message = boundedError(
        "Implementation attempts exhausted after rejection (" + run.attempts + " of " + maxAttempts + ")",
      );
      run.status = "failed";
      run.error = message;
      run.finishedAt = this.timestamp();
      delete run.approval;
      if (review) {
        const state = this.nodeState(run, review.id);
        state.status = "failed";
        state.error = message;
        state.finishedAt = run.finishedAt;
      }
      this.release(runId);
      await this.persist(run);
      return;
    }

    this.resetFrom(run, implement.id);
    run.status = "running";
    delete run.error;
    delete run.finishedAt;
    delete run.approval;
    delete run.validation;
    delete run.decisionPath;
    const controller = new AbortController();
    this.activeRunId = runId;
    this.controllers.set(runId, controller);
    try {
      await this.persist(run);
    } catch (error) {
      run.status = "failed";
      run.error = boundedError(error);
      run.finishedAt = this.timestamp();
      this.release(runId);
      throw error;
    }
    this.launch(run, implement.id, controller);
  }

  private launch(run: WorkflowRun, startNodeId: string, controller: AbortController): void {
    void this.executeFrom(run, startNodeId, controller).catch(async (error: unknown) => {
      if (controller.signal.aborted || run.status === "cancelled") return;
      await this.failRun(run, undefined, error);
    });
  }

  /** Walk success edges from startNodeId to the end of the graph. */
  private async executeFrom(run: WorkflowRun, startNodeId: string, controller: AbortController): Promise<void> {
    const order = this.successOrder(run.definitionSnapshot);
    const start = order.indexOf(startNodeId);
    if (start < 0) {
      throw new ProjectError("VALIDATION_FAILED", "Workflow node " + startNodeId + " is not on the success path");
    }

    for (let index = start; index < order.length; index += 1) {
      if (controller.signal.aborted || run.status !== "running") return;
      const nodeId = order[index];
      if (nodeId === undefined) continue;
      const node = this.definitionNode(run, nodeId);
      const state = this.nodeState(run, nodeId);

      state.status = "running";
      state.attempts += 1;
      state.startedAt = this.timestamp();
      delete state.error;
      delete state.finishedAt;
      await this.persist(run);

      const outcome = await this.runNode(run, node, state, controller.signal);
      if (outcome === "stop") return;
    }

    if (run.status === "running") await this.completeRun(run);
  }

  private async runNode(
    run: WorkflowRun,
    node: WorkflowNode,
    state: WorkflowNodeState,
    signal: AbortSignal,
  ): Promise<"continue" | "stop"> {
    try {
      switch (node.type) {
        case "context": {
          this.verifyScope(run);
          const inventory = await this.readInventory(run);
          state.output = boundOutput(this.scopeSummary(run, inventory));
          break;
        }
        case "agent":
          if (node.config.access === "read") await this.runPlanNode(run, node, state, signal);
          else await this.runImplementNode(run, node, state, signal);
          break;
        case "validation":
          await this.runValidationNode(run, state, signal);
          break;
        case "approval":
          await this.runReviewNode(run, state, signal);
          return "stop";
        case "decision":
          await this.runDecisionNode(run, node, state);
          break;
      }
    } catch (error) {
      if (signal.aborted || run.status === "cancelled") return "stop";
      await this.failRun(run, node.id, error);
      return "stop";
    }

    if (signal.aborted || run.status === "cancelled") return "stop";
    state.status = "completed";
    state.finishedAt = this.timestamp();
    await this.persist(run);
    return "continue";
  }

  private async runPlanNode(
    run: WorkflowRun,
    node: Extract<WorkflowNode, { type: "agent" }>,
    state: WorkflowNodeState,
    signal: AbortSignal,
  ): Promise<void> {
    const profile = await this.adapter.resolveModelProfile(run.inputs.model ?? "");
    this.recordResolvedModel(run, profile);
    const task = await this.adapter.createTask({
      title: this.taskTitle(run),
      readPaths: [...run.inputs.readPaths],
      writePaths: [],
    });
    run.readTaskIds.push(task.id);
    state.taskId = task.id;
    await this.persist(run);
    try {
      const result = await this.adapter.runAgent(task.id, profile, node.config.prompt, signal);
      if (!signal.aborted) state.output = boundOutput(result.summary);
    } finally {
      try {
        await this.adapter.removeTask(task.id);
      } catch {
        // A cleanup failure must not hide the run outcome; the read task id stays recorded.
      }
    }
  }

  private async runImplementNode(
    run: WorkflowRun,
    node: Extract<WorkflowNode, { type: "agent" }>,
    state: WorkflowNodeState,
    signal: AbortSignal,
  ): Promise<void> {
    // The first implementation counts as attempt 1; later attempts are added by reject().
    if (run.attempts === 0) run.attempts = 1;
    const profile = await this.adapter.resolveModelProfile(run.inputs.model ?? "");
    this.recordResolvedModel(run, profile);

    let taskId = run.writeTaskId;
    if (taskId === undefined) {
      const task = await this.adapter.createTask({
        title: this.taskTitle(run),
        readPaths: [...run.inputs.readPaths],
        writePaths: [...run.inputs.writePaths],
      });
      taskId = task.id;
      run.writeTaskId = task.id;
      await this.persist(run);
    }
    state.taskId = taskId;

    const planOutput = this.agentOutput(run, "read") ?? "";
    const prompt = [
      node.config.prompt,
      "",
      "Goal:",
      run.inputs.goal,
      "",
      "Plan:",
      planOutput.length > 0 ? planOutput : "(no plan output)",
    ].join("\n");

    const result = await this.adapter.runAgent(taskId, profile, prompt, signal);
    if (!signal.aborted) state.output = boundOutput(result.summary);
  }

  private async runValidationNode(
    run: WorkflowRun,
    state: WorkflowNodeState,
    signal: AbortSignal,
  ): Promise<void> {
    const taskId = run.writeTaskId;
    if (taskId === undefined) {
      throw new ProjectError("VALIDATION_FAILED", "Workflow run " + run.runId + " has no write task to validate");
    }
    const result = await this.adapter.validate(taskId, signal);
    if (signal.aborted) return;
    run.validation = result;
    state.output = boundOutput("validation: " + result.status);
    // A skipped check means the environment cannot run it (for example Docker
    // is unavailable). It is not a code failure; the review still shows the
    // skipped diagnostics and a human decides whether to approve.
    if (result.status === "fail") {
      throw new ProjectError("VALIDATION_FAILED", validationFailureMessage(result));
    }
  }

  private async runReviewNode(run: WorkflowRun, state: WorkflowNodeState, signal: AbortSignal): Promise<void> {
    const taskId = run.writeTaskId;
    if (taskId === undefined) {
      throw new ProjectError("VALIDATION_FAILED", "Workflow run " + run.runId + " has no write task to review");
    }
    const review = await this.adapter.preview(taskId);
    if (signal.aborted || run.status === "cancelled") return;
    if (review.validation !== undefined) run.validation = review.validation;
    const digest = review.changeSet.digest;
    if (typeof digest !== "string" || digest.length === 0) {
      throw new ProjectError("VALIDATION_FAILED", "Change review has no digest");
    }
    run.approval = { digest };
    state.status = "waiting_approval";
    state.output = boundOutput("approval pending: " + digest);
    run.status = "waiting_approval";
    delete run.finishedAt;
    await this.persist(run);
  }

  private async runDecisionNode(
    run: WorkflowRun,
    node: Extract<WorkflowNode, { type: "decision" }>,
    state: WorkflowNodeState,
  ): Promise<void> {
    const approval = run.approval;
    if (!approval) {
      throw new ProjectError("VALIDATION_FAILED", "Workflow run " + run.runId + " has no approval to record");
    }
    const approvedAt = approval.approvedAt ?? this.timestamp();
    run.approval = { digest: approval.digest, approvedAt };
    const model = await this.ensureResolvedModel(run);
    const planSummary = this.agentOutput(run, "read") ?? "(no plan output)";
    const implementationSummary = this.agentOutput(run, "write") ?? "(no implementation output)";
    const validationStatus = run.validation?.status ?? "unknown";
    const diagnosticCount = run.validation?.diagnostics.length ?? 0;

    const fileName = [
      approvedAt.slice(0, 10),
      safeFileSegment(run.workflowId),
      run.runId,
    ].join("-") + ".md";
    const relative = path.posix.join(node.config.directory, fileName);

    const frontmatter = {
      schemaVersion: 1,
      runId: run.runId,
      workflowId: run.workflowId,
      workflowVersion: run.workflowVersion,
      title: run.title,
      goal: run.inputs.goal,
      model,
      validationStatus,
      approvalDigest: approval.digest,
      startedAt: run.startedAt,
      approvedAt,
    };
    const body = [
      "# 决策记录",
      "",
      "## 运行",
      "",
      "- 工作流：" + run.title + "（" + run.workflowId + " v" + run.workflowVersion + "）",
      "- 运行 id：" + run.runId,
      "- 开始时间：" + run.startedAt,
      "- 批准时间：" + approvedAt,
      "- 模型：" + model,
      "",
      "## 目标",
      "",
      run.inputs.goal,
      "",
      "## 计划摘要",
      "",
      planSummary,
      "",
      "## 实现摘要",
      "",
      implementationSummary,
      "",
      "## 校验",
      "",
      "- 状态：" + validationStatus,
      "- 诊断数：" + diagnosticCount,
      "",
      "## 审批",
      "",
      "- 批准摘要：" + approval.digest,
      "- 写入范围：" + (run.inputs.writePaths.join(", ") || "（无）"),
    ].join("\n");

    // The decision document goes through FileStore so path policy, the byte
    // limit, and atomic writes are the same as every other project document.
    await this.files.write(relative, "---\n" + stringify(frontmatter) + "---\n\n" + body + "\n", "absent");
    run.decisionPath = relative;
    state.output = boundOutput("decision: " + relative);
  }

  private async completeRun(run: WorkflowRun): Promise<void> {
    run.status = "completed";
    run.finishedAt = this.timestamp();
    delete run.error;
    this.release(run.runId);
    await this.persist(run);
  }

  private async failRun(run: WorkflowRun, nodeId: string | undefined, error: unknown): Promise<void> {
    if (run.status === "cancelled") return;
    const message = boundedError(error);
    const finishedAt = this.timestamp();
    run.status = "failed";
    run.error = message;
    run.finishedAt = finishedAt;
    const state = nodeId === undefined
      ? run.nodeStates.find((candidate) => candidate.status === "running" || candidate.status === "waiting_approval")
      : this.nodeState(run, nodeId);
    if (state && (state.status === "running" || state.status === "waiting_approval")) {
      state.status = "failed";
      state.error = message;
      state.finishedAt = finishedAt;
    }
    this.release(run.runId);
    try {
      await this.persist(run);
    } catch {
      // The in-memory run still reflects the failure even when the record cannot be rewritten.
    }
  }

  private verifyScope(run: WorkflowRun): void {
    for (const value of run.inputs.readPaths) assertProjectRelativePath(value);
    for (const value of run.inputs.writePaths) assertProjectRelativePath(value);
  }

  /**
   * Count regular files under every read path without following symlinks.
   * A symlink anywhere on a read path is skipped and reported, never traversed.
   */
  private async readInventory(run: WorkflowRun): Promise<{ files: number; symlinks: number }> {
    let files = 0;
    let symlinks = 0;
    for (const readPath of run.inputs.readPaths) {
      const target = await this.readTarget(readPath);
      if (target === undefined) {
        symlinks += 1;
        continue;
      }
      const counted = await this.countFiles(target);
      files += counted.files;
      symlinks += counted.symlinks;
    }
    return { files, symlinks };
  }

  /** Resolve a project-relative read path one segment at a time, refusing symlinks. */
  private async readTarget(value: string): Promise<string | undefined> {
    const segments = value
      .replaceAll("\\", "/")
      .split("/")
      .filter((segment) => segment.length > 0 && segment !== ".");
    let current = this.root;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (segment === undefined) continue;
      current = path.join(current, segment);
      let stats;
      try {
        stats = await lstat(current);
      } catch (error) {
        if (isMissing(error)) {
          throw new ProjectError("VALIDATION_FAILED", "Workflow read path does not exist: " + JSON.stringify(value));
        }
        throw error;
      }
      if (stats.isSymbolicLink()) return undefined;
      if (index < segments.length - 1 && !stats.isDirectory()) {
        throw new ProjectError("VALIDATION_FAILED", "Workflow read path is not a directory: " + JSON.stringify(value));
      }
      if (index === segments.length - 1 && !stats.isDirectory() && !stats.isFile()) {
        throw new ProjectError("VALIDATION_FAILED", "Workflow read path is not a regular file or directory: " + JSON.stringify(value));
      }
    }
    return current;
  }

  private async countFiles(directory: string): Promise<{ files: number; symlinks: number }> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return { files: 0, symlinks: 0 };
      throw error;
    }
    let files = 0;
    let symlinks = 0;
    for (const entry of entries) {
      // Dirent types come from directory entries and are not followed.
      if (entry.isSymbolicLink()) {
        symlinks += 1;
      } else if (entry.isDirectory()) {
        const counted = await this.countFiles(path.join(directory, entry.name));
        files += counted.files;
        symlinks += counted.symlinks;
      } else if (entry.isFile()) {
        files += 1;
      }
    }
    return { files, symlinks };
  }

  private scopeSummary(run: WorkflowRun, inventory: { files: number; symlinks: number }): string {
    const read = run.inputs.readPaths.join(", ");
    const write = run.inputs.writePaths.join(", ");
    const skipped = inventory.symlinks > 0 ? " (" + inventory.symlinks + " symbolic link(s) skipped)" : "";
    return "read " + inventory.files + " file(s) under " + read + skipped + "; write: " + (write.length > 0 ? write : "(none)");
  }

  private taskTitle(run: WorkflowRun): string {
    return "[工作流] " + run.title + " / " + run.runId;
  }

  private recordResolvedModel(run: WorkflowRun, profile: { id: string }): void {
    if (typeof profile.id === "string" && profile.id.trim().length > 0) {
      run.resolvedModel = profile.id.trim().slice(0, 120);
    }
  }

  /** Never let a decision name an empty model; resolve the default profile once if needed. */
  private async ensureResolvedModel(run: WorkflowRun): Promise<string> {
    if (run.resolvedModel !== undefined && run.resolvedModel.length > 0) return run.resolvedModel;
    const profile = await this.adapter.resolveModelProfile(run.inputs.model ?? "");
    this.recordResolvedModel(run, profile);
    if (run.resolvedModel === undefined) {
      throw new ProjectError("MODEL_ERROR", "Workflow model profile has no id");
    }
    return run.resolvedModel;
  }

  private agentOutput(run: WorkflowRun, access: "read" | "write"): string | undefined {
    const order = this.successOrder(run.definitionSnapshot);
    for (const nodeId of order) {
      const node = this.definitionNode(run, nodeId);
      if (node.type === "agent" && node.config.access === access) {
        return this.nodeState(run, nodeId).output;
      }
    }
    return undefined;
  }

  private successOrder(definition: WorkflowDefinition): string[] {
    const next = new Map<string, string>();
    for (const edge of definition.edges) {
      if (edge.on === "success") next.set(edge.from, edge.to);
    }
    const start = this.contextNode(definition);
    const order: string[] = [];
    const seen = new Set<string>();
    let current: string | undefined = start.id;
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      order.push(current);
      current = next.get(current);
    }
    return order;
  }

  private contextNode(definition: WorkflowDefinition): WorkflowNode {
    const node = definition.nodes.find((candidate) => candidate.type === "context");
    if (!node) throw new ProjectError("VALIDATION_FAILED", "Workflow " + definition.id + " has no context node");
    return node;
  }

  private nodeForAction(definition: WorkflowDefinition, action: WorkflowRetryAction): WorkflowNode {
    const node = definition.nodes.find((candidate) => {
      if (action === "plan") return candidate.type === "agent" && candidate.config.access === "read";
      if (action === "implement") return candidate.type === "agent" && candidate.config.access === "write";
      return candidate.type === "validation";
    });
    if (!node) {
      throw new ProjectError("VALIDATION_FAILED", "Workflow " + definition.id + " has no node for action " + action);
    }
    return node;
  }

  private resetFrom(run: WorkflowRun, startNodeId: string): void {
    const order = this.successOrder(run.definitionSnapshot);
    const start = order.indexOf(startNodeId);
    if (start < 0) {
      throw new ProjectError("VALIDATION_FAILED", "Workflow node " + startNodeId + " is not on the success path");
    }
    for (let index = start; index < order.length; index += 1) {
      const nodeId = order[index];
      if (nodeId === undefined) continue;
      const state = this.nodeState(run, nodeId);
      state.status = "pending";
      delete state.error;
      delete state.output;
      delete state.startedAt;
      delete state.finishedAt;
    }
  }

  private definitionNode(run: WorkflowRun, nodeId: string): WorkflowNode {
    const node = run.definitionSnapshot.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) throw new ProjectError("VALIDATION_FAILED", "Workflow node " + nodeId + " is missing from the snapshot");
    return node;
  }

  private nodeState(run: WorkflowRun, nodeId: string): WorkflowNodeState {
    const state = run.nodeStates.find((candidate) => candidate.id === nodeId);
    if (!state) throw new ProjectError("VALIDATION_FAILED", "Workflow node state " + nodeId + " is missing");
    return state;
  }

  /**
   * Load a run from memory or from disk, hydrating a stale active record.
   *
   * Callers that mutate the run need the live object; external readers pass
   * { snapshot: true } and receive the last durable state instead. The clone for
   * a snapshot is taken inside this method, before another microtask can apply a
   * newer transition, so the value returned always matches a written record.
   */
  private async loadRun(runId: string, options: { snapshot?: boolean } = {}): Promise<WorkflowRun> {
    assertRunId(runId);
    const live = this.runs.get(runId);
    if (live) {
      // A transition can enqueue another write while we await, so wait until the
      // chain is stable.
      for (;;) {
        const pending = this.persistChains.get(runId);
        if (!pending) break;
        await pending;
        if (this.persistChains.get(runId) === pending) break;
      }
      if (options.snapshot !== true) return live;
      // The live object can be ahead of its record; only durable state is observable.
      const durable = this.durableRuns.get(runId);
      return this.view(durable ?? live);
    }
    const record = await this.readRecord(runId);
    const interrupted = this.hydrate(record);
    this.runs.set(runId, record);
    if (interrupted) {
      await this.persist(record);
    } else {
      this.durableRuns.set(runId, this.view(record));
    }
    if (options.snapshot !== true) return record;
    const durable = this.durableRuns.get(runId);
    return this.view(durable ?? record);
  }

  /**
   * A queued/running record can only be stale after a process restart: no agent
   * survives it. Preserve waiting_approval and terminal runs exactly as written.
   */
  private hydrate(run: WorkflowRun): boolean {
    if (run.status !== "queued" && run.status !== "running") return false;
    const finishedAt = this.timestamp();
    run.status = "interrupted";
    run.finishedAt = finishedAt;
    run.error = boundError(INTERRUPTED_MESSAGE);
    for (const state of run.nodeStates) {
      if (state.status === "running" || state.status === "waiting_approval") {
        state.status = "failed";
        state.error = run.error;
        state.finishedAt = finishedAt;
      }
    }
    return true;
  }

  /**
   * One project may own one active run. In-memory execution wins, and a
   * persisted waiting_approval run still blocks starts after a restart.
   */
  private async assertNoOtherActiveRun(
    runId: string,
    options: { allowSelfActive?: boolean } = {},
  ): Promise<void> {
    if (this.activeRunId !== undefined && this.activeRunId !== runId) {
      throw new ProjectError("VALIDATION_FAILED", "Another workflow run is already active: " + this.activeRunId);
    }
    if (this.activeRunId === runId && options.allowSelfActive !== true) {
      throw new ProjectError("VALIDATION_FAILED", "Workflow run " + runId + " is already active");
    }
    const records = await this.listRuns();
    const blocking = records.find((record) => record.runId !== runId && record.status === "waiting_approval");
    if (blocking) {
      throw new ProjectError(
        "VALIDATION_FAILED",
        "Another workflow run is already waiting for approval: " + blocking.runId,
      );
    }
  }

  private release(runId: string): void {
    if (this.activeRunId === runId) this.activeRunId = undefined;
    this.controllers.delete(runId);
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private view(run: WorkflowRun): WorkflowRun {
    return structuredClone(run);
  }

  private runsDirectory(): string {
    return path.join(this.root, ...RUNS_DIRECTORY.split("/"));
  }

  private recordPath(runId: string): string {
    return path.join(this.runsDirectory(), runId + ".json");
  }

  private async readRecord(runId: string): Promise<WorkflowRun> {
    assertRunId(runId);
    let source: string;
    try {
      source = await readFile(this.recordPath(runId), "utf8");
    } catch (error) {
      if (isMissing(error)) {
        throw new ProjectError("FILE_NOT_FOUND", "Unknown workflow run: " + runId);
      }
      throw error;
    }
    if (Buffer.byteLength(source, "utf8") > MAX_RECORD_BYTES) {
      throw recordError(runId, "exceeds the maximum record size");
    }
    return parseRunRecord(source, runId);
  }

  private persist(run: WorkflowRun): Promise<void> {
    // Snapshot now; only the write itself is queued behind earlier writes for this run.
    const content = JSON.stringify(run, null, 2) + "\n";
    const target = this.recordPath(run.runId);
    const durable = this.view(run);
    const previous = this.persistChains.get(run.runId) ?? Promise.resolve();
    const commit = async (): Promise<void> => {
      await this.writeAtomic(target, content);
      // Publish only once the record is on disk: the live run may already be newer.
      this.durableRuns.set(run.runId, durable);
      // Observers only ever see durable state, and an observer must never change
      // the outcome of a transition that already reached the disk.
      try {
        this.onUpdate?.(this.view(durable));
      } catch {
        // A throwing listener cannot fail the durable write it observes.
      }
    };
    const write = previous.then(commit, commit);
    this.persistChains.set(run.runId, write.catch(() => undefined));
    return write;
  }

  private async writeAtomic(absolute: string, content: string): Promise<void> {
    const directory = path.dirname(absolute);
    await mkdir(directory, { recursive: true });
    const temporary = path.join(directory, "." + path.basename(absolute) + "." + randomUUID() + ".tmp");
    try {
      await writeFile(temporary, content, "utf8");
      await rename(temporary, absolute);
    } catch (error) {
      try {
        await unlink(temporary);
      } catch {
        // The temporary file may not exist; the original failure is the one to report.
      }
      throw error;
    }
  }
}
