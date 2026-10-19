import { ProjectError } from "../../src/main/core/errors";
import type {
  WorkflowRetryAction,
  WorkflowRun,
  WorkflowRunInputs,
  WorkflowRunStatus,
} from "../../src/main/core/workflow-runner";
import type { OrchestrationChildRunner } from "../../src/main/core/workflow-orchestrator";
import type { ValidationResult } from "../../src/shared/contracts";
import type { WorkflowDefinition } from "../../src/shared/workflow";

/**
 * One scripted child workflow run.
 *
 * The orchestration runner only observes a child through getRun(), so a script
 * states exactly which durable status the child reports after each transition.
 * A script is selected by child creation order; the last script is reused.
 */
export interface FakeOrchestrationChildScript {
  /** Status reported once the child is started. Defaults to completed. */
  startStatus?: WorkflowRunStatus;
  /** Status reached after approve(). Defaults to completed. */
  approveStatus?: WorkflowRunStatus;
  /** Status reached after retry(). Defaults to completed. */
  retryStatus?: WorkflowRunStatus;
  /** Status reached after reject(). Defaults to waiting_approval. */
  rejectStatus?: WorkflowRunStatus;
  /** Durable status the child settles on for any transition, when set. */
  status?: WorkflowRunStatus;
  /** Implementation summary written to the write agent node output. */
  summary?: string;
  /** Decision document recorded on the completed child. */
  decisionPath?: string;
  /** Validation result recorded on the completed child. */
  validation?: ValidationResult;
  /** Approval digest requested by a waiting_approval child. */
  digest?: string;
  /** Error recorded on a failed child. */
  error?: string;
}

/** One child run the orchestrator created, in creation order. */
export interface FakeOrchestrationChild {
  runId: string;
  definition: WorkflowDefinition;
  inputs: WorkflowRunInputs;
}

/** Statuses a cancelled child cannot leave. */
const TERMINAL: readonly WorkflowRunStatus[] = ["completed", "failed", "cancelled", "interrupted"];

/**
 * In-memory WorkflowRunner double for orchestrator tests.
 *
 * It implements the same surface the orchestrator drives a real WorkflowRunner
 * with: createRun/start/getRun/approve/reject/cancel/retry. Every call is
 * recorded, and each child's status transitions are scripted by
 * FakeOrchestrationChildScript so a test can make a child wait, approve, fail,
 * or retry without an agent.
 */
export class FakeOrchestrationRunner implements OrchestrationChildRunner {
  /** Every child run created by the orchestrator, in creation order. */
  readonly created: FakeOrchestrationChild[] = [];
  /** Child ids passed to start(), in call order. */
  readonly started: string[] = [];
  /** Every approve() call the orchestrator made. */
  readonly approvals: { runId: string; digest: string }[] = [];
  /** Child ids passed to reject(). */
  readonly rejections: string[] = [];
  /** Child ids passed to cancel(). */
  readonly cancellations: string[] = [];
  /** Every retry() call, including the requested retry action. */
  readonly retries: { runId: string; action: WorkflowRetryAction }[] = [];
  /** Per-child script, consumed in creation order; the last script is reused. */
  scripts: FakeOrchestrationChildScript[] = [];

  private readonly runs = new Map<string, WorkflowRun>();
  private readonly scriptsById = new Map<string, FakeOrchestrationChildScript>();
  private sequence = 0;
  private clock = 0;

  /** The durable record of one child run, cloned. */
  child(runId: string): WorkflowRun {
    return structuredClone(this.require(runId));
  }

  /** Inputs recorded for the child at one creation index. */
  inputs(index: number): WorkflowRunInputs {
    const child = this.created[index];
    if (child === undefined) throw new Error("no child run was created at index " + index);
    return child.inputs;
  }

  createRun(definition: WorkflowDefinition, inputs: WorkflowRunInputs): WorkflowRun {
    const runId = "child-" + (++this.sequence);
    const index = this.created.length;
    const script = this.scripts[index] ?? this.scripts[this.scripts.length - 1] ?? {};
    const run: WorkflowRun = {
      schemaVersion: 1,
      runId,
      workflowId: definition.id,
      title: definition.title,
      workflowVersion: definition.version,
      definitionSnapshot: definition,
      inputs: {
        goal: inputs.goal,
        readPaths: [...inputs.readPaths],
        writePaths: [...inputs.writePaths],
        ...(inputs.model === undefined ? {} : { model: inputs.model }),
        ...(inputs.context === undefined ? {} : { context: inputs.context }),
      },
      status: "queued",
      nodeStates: definition.nodes.map((node) => ({ id: node.id, type: node.type, status: "pending", attempts: 0 })),
      readTaskIds: [],
      attempts: 0,
      startedAt: this.timestamp(),
    };
    this.runs.set(runId, run);
    this.scriptsById.set(runId, script);
    this.created.push({ runId, definition, inputs: run.inputs });
    return structuredClone(run);
  }

  async start(runId: string): Promise<void> {
    const run = this.require(runId);
    this.started.push(runId);
    this.apply(run, this.scriptsById.get(runId) ?? {}, "startStatus", "completed");
  }

  async getRun(runId: string): Promise<WorkflowRun> {
    return structuredClone(this.require(runId));
  }

  async listRuns(): Promise<WorkflowRun[]> {
    return [...this.runs.values()].map((run) => structuredClone(run));
  }

  async waitForRun(
    runId: string,
    predicate: (run: WorkflowRun) => boolean,
    timeoutMs = 5000,
  ): Promise<WorkflowRun> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      const run = await this.getRun(runId);
      if (predicate(run)) return run;
      if (Date.now() >= deadline) {
        throw new ProjectError("INTERNAL_ERROR", "Timed out waiting for child run " + runId);
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
    }
  }

  async approve(runId: string, digest: string): Promise<void> {
    const run = this.require(runId);
    if (run.status !== "waiting_approval") {
      throw new ProjectError("VALIDATION_FAILED", "Child run " + runId + " is not waiting for approval");
    }
    const expected = run.approval?.digest;
    if (expected === undefined || digest !== expected) {
      throw new ProjectError("VALIDATION_FAILED", "Approval digest does not match the current change set");
    }
    this.approvals.push({ runId, digest });
    run.approval = { ...run.approval, digest, approvedAt: this.timestamp() };
    this.apply(run, this.scriptsById.get(runId) ?? {}, "approveStatus", "completed");
  }

  async reject(runId: string): Promise<void> {
    const run = this.require(runId);
    if (run.status !== "waiting_approval") {
      throw new ProjectError("VALIDATION_FAILED", "Child run " + runId + " is not waiting for approval");
    }
    this.rejections.push(runId);
    run.attempts += 1;
    delete run.approval;
    this.apply(run, this.scriptsById.get(runId) ?? {}, "rejectStatus", "waiting_approval");
  }

  async retry(runId: string, action: WorkflowRetryAction): Promise<void> {
    const run = this.require(runId);
    if (run.status !== "failed") {
      throw new ProjectError("VALIDATION_FAILED", "Child run " + runId + " can only retry from status failed");
    }
    this.retries.push({ runId, action });
    run.attempts += 1;
    delete run.approval;
    delete run.validation;
    delete run.decisionPath;
    this.apply(run, this.scriptsById.get(runId) ?? {}, "retryStatus", "completed");
  }

  async cancel(runId: string): Promise<void> {
    const run = this.require(runId);
    if (TERMINAL.includes(run.status)) return;
    this.cancellations.push(runId);
    run.status = "cancelled";
    run.finishedAt = this.timestamp();
  }

  private apply(
    run: WorkflowRun,
    script: FakeOrchestrationChildScript,
    key: "startStatus" | "approveStatus" | "retryStatus" | "rejectStatus",
    fallback: WorkflowRunStatus,
  ): void {
    const status = script.status ?? script[key] ?? fallback;
    run.status = status;
    if (status === "completed") {
      run.finishedAt = this.timestamp();
      delete run.error;
      for (const state of run.nodeStates) {
        state.status = "completed";
        state.finishedAt = run.finishedAt;
      }
      const write = run.definitionSnapshot.nodes.find(
        (node) => node.type === "agent" && node.config.access === "write",
      );
      const target = write === undefined ? undefined : run.nodeStates.find((state) => state.id === write.id);
      if (target !== undefined) target.output = script.summary ?? "completed";
      if (script.validation !== undefined) run.validation = script.validation;
      if (script.decisionPath !== undefined) run.decisionPath = script.decisionPath;
      return;
    }
    if (status === "waiting_approval") {
      delete run.finishedAt;
      run.approval = { digest: script.digest ?? "child-digest-" + run.runId };
      return;
    }
    if (status === "failed") {
      run.finishedAt = this.timestamp();
      run.error = script.error ?? "child run failed";
      return;
    }
    if (status === "cancelled" || status === "interrupted") {
      run.finishedAt = this.timestamp();
    }
  }

  private require(runId: string): WorkflowRun {
    const run = this.runs.get(runId);
    if (run === undefined) {
      throw new ProjectError("FILE_NOT_FOUND", "Unknown workflow run: " + runId);
    }
    return run;
  }

  private timestamp(): string {
    this.clock += 1;
    return new Date(Date.UTC(2026, 9, 18, 0, 0, this.clock)).toISOString();
  }
}
