import { randomUUID } from "node:crypto";
import {
  MAX_RUN_ERROR_LENGTH,
  MAX_STEP_DECISION_PATH_LENGTH,
  MAX_STEP_SUMMARY_LENGTH,
  type OrchestrationRunStore,
} from "./orchestration-run-store";
import {
  OFFICIAL_WORKFLOW_ID,
  type OrchestrationDefinition,
  type OrchestrationRun,
  type OrchestrationRunStatus,
  type OrchestrationRunStep,
} from "../../shared/orchestration";
import { WorkflowValidationError, validateWorkflowDefinition, type WorkflowDefinition } from "../../shared/workflow";
import { MAX_RUN_CONTEXT_LENGTH, WorkflowRunInputsSchema, type WorkflowRunInputs } from "../../shared/workflow-api";
import { ProjectError } from "./errors";
import type { WorkflowRetryAction, WorkflowRun, WorkflowRunStatus } from "./workflow-runner";

/**
 * Main-process sequential orchestration runtime.
 *
 * One WorkflowOrchestrator owns one project: it reads an orchestration
 * definition, creates a durable OrchestrationRun, and runs its steps in order by
 * starting one child WorkflowRun at a time. Every transition is persisted
 * before the next observation, so a waiting run survives a restart and a
 * running run is honestly reported as interrupted (the run store normalizes it).
 *
 * This module stays Electron-free and never imports ProjectCore. It drives a
 * child through the same interface a WorkflowRunner exposes, so tests can script
 * a fake runner without an agent.
 */

/** Read the orchestration definition the run starts from. */
export interface OrchestrationDefinitionSource {
  read(id: string): Promise<{ definition: OrchestrationDefinition }>;
}

/**
 * The subset of WorkflowRunner the orchestrator drives.
 *
 * WorkflowRunner satisfies this interface structurally; a test double only has
 * to implement these methods. A child is always observed through getRun(), so
 * the orchestrator never needs the runner's own update callback.
 */
export interface OrchestrationChildRunner {
  createRun(definition: WorkflowDefinition, inputs: WorkflowRunInputs): WorkflowRun;
  start(runId: string): Promise<void>;
  getRun(runId: string): Promise<WorkflowRun>;
  listRuns(): Promise<WorkflowRun[]>;
  approve(runId: string, digest: string): Promise<void>;
  reject(runId: string): Promise<void>;
  cancel(runId: string): Promise<void>;
  retry(runId: string, action: WorkflowRetryAction): Promise<void>;
}

export interface OrchestrationRunnerOptions {
  /** Durable store under .specloom/workflows/orchestration-runs. */
  runStore: OrchestrationRunStore;
  /** Reads an orchestration definition from specs/orchestrations. */
  orchestrationStore: OrchestrationDefinitionSource;
  /** Loads one project workflow definition by id. */
  loadWorkflow: (id: string) => Promise<WorkflowDefinition>;
  /** Loads the bundled official development-review workflow. */
  loadOfficial: () => Promise<WorkflowDefinition>;
  /** The WorkflowRunner (or a double) that executes each step. */
  runner: OrchestrationChildRunner;
  /** Injectable clock, used for deterministic timestamps in tests. */
  now?: () => Date;
  /** Injectable run id generator; ids must be usable as file names. */
  idFactory?: () => string;
  /** Called with a clone of the durable record after each persist succeeds. */
  onUpdate?: (run: OrchestrationRun) => void;
}

/** The previous-step handoff cap, shared with WorkflowRunInputs.context. */
export const MAX_ORCHESTRATION_CONTEXT_LENGTH = MAX_RUN_CONTEXT_LENGTH;

/** Poll interval while waiting for a child run to settle. */
export const CHILD_POLL_INTERVAL_MS = 50;

/** How often waitForRun() re-reads the record. */
const WAIT_POLL_INTERVAL_MS = 25;

/** Same file-name rule the run store applies to an orchestration run id. */
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DECISION_PREFIX = "specs/decisions/";

const ACTIVE_STATUSES: readonly OrchestrationRunStatus[] = ["queued", "running", "waiting_approval"];
const TERMINAL_STATUSES: readonly OrchestrationRunStatus[] = ["completed", "failed", "cancelled", "interrupted"];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isActive(status: OrchestrationRunStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

function isTerminal(status: OrchestrationRunStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** A child status the orchestrator can act on instead of polling again. */
function isSettledChild(status: WorkflowRunStatus): boolean {
  return (
    status === "waiting_approval" ||
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function boundError(value: string): string {
  return value.length > MAX_RUN_ERROR_LENGTH ? value.slice(0, MAX_RUN_ERROR_LENGTH) : value;
}

function boundSummary(value: string): string {
  return value.length > MAX_STEP_SUMMARY_LENGTH ? value.slice(0, MAX_STEP_SUMMARY_LENGTH) : value;
}

/** Only a path the orchestration run store can persist is recorded on a step. */
function boundedDecisionPath(value: string | undefined): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_STEP_DECISION_PATH_LENGTH) {
    return undefined;
  }
  if (!value.startsWith(DECISION_PREFIX) || value.split("/").includes("..")) return undefined;
  return value;
}

/**
 * Effective approval for one step: an explicit step override wins, and inherit
 * follows the workflow definition's approvalPolicy (manual when absent).
 */
export function effectiveApproval(step: OrchestrationRunStep, definition: WorkflowDefinition): "manual" | "auto" {
  if (step.approval === "auto") return "auto";
  if (step.approval === "always") return "manual";
  return definition.settings.approvalPolicy === "auto" ? "auto" : "manual";
}

/**
 * Join the user's own context with the previous-step handout.
 *
 * The result is one prompt string capped at MAX_RUN_CONTEXT_LENGTH characters
 * (UTF-16 code units), exactly like WorkflowRunInputs.context.
 */
export function combineRunContext(userContext: string | undefined, previous: string | undefined): string | undefined {
  const parts: string[] = [];
  if (typeof userContext === "string" && userContext.length > 0) parts.push(userContext);
  if (typeof previous === "string" && previous.length > 0) parts.push(previous);
  if (parts.length === 0) return undefined;
  const combined = parts.join("\n\n");
  return combined.length > MAX_RUN_CONTEXT_LENGTH ? combined.slice(0, MAX_RUN_CONTEXT_LENGTH) : combined;
}

/**
 * Executes a sequential orchestration as a durable state machine.
 *
 * start() validates inputs, resolves every step's workflow up front, persists a
 * queued run, and advances it in the background; use getRun/waitForRun to
 * observe it. advance() starts one child run per step, waits for it to reach
 * waiting_approval/completed/failed/cancelled, auto-approves when the effective
 * approval is auto, and otherwise persists waiting_approval and returns.
 *
 * A failed child pauses the orchestration at the current step: retry() resumes
 * that step instead of skipping it. cancel() cancels the current child and the
 * orchestration. Only one orchestration may be active per project.
 */
export class WorkflowOrchestrator {
  private readonly runStore: OrchestrationRunStore;
  private readonly orchestrationStore: OrchestrationDefinitionSource;
  private readonly loadWorkflow: (id: string) => Promise<WorkflowDefinition>;
  private readonly loadOfficial: () => Promise<WorkflowDefinition>;
  private readonly runner: OrchestrationChildRunner;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly onUpdate: ((run: OrchestrationRun) => void) | undefined;

  /** Live records created or hydrated by this instance. */
  private readonly runs = new Map<string, OrchestrationRun>();
  /** Workflow definitions resolved per orchestration run, so a step is not re-read mid-run. */
  private readonly definitions = new Map<string, Map<string, WorkflowDefinition>>();
  /** Serializes the background advance loop per orchestration run. */
  private readonly advancing = new Map<string, Promise<void>>();
  /** The one orchestration allowed to own a child run in this project. */
  private activeRunId: string | undefined;

  constructor(options: OrchestrationRunnerOptions) {
    this.runStore = options.runStore;
    this.orchestrationStore = options.orchestrationStore;
    this.loadWorkflow = options.loadWorkflow;
    this.loadOfficial = options.loadOfficial;
    this.runner = options.runner;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => "orch-" + randomUUID());
    this.onUpdate = options.onUpdate;
  }

  /**
   * Validate inputs, resolve every step's workflow, persist a queued run, then
   * advance it in the background.
   *
   * Definitions are resolved before a record exists, so a missing workflow is a
   * readable start error naming the step instead of a half-created run.
   */
  async start(orchestrationId: string, inputs: WorkflowRunInputs): Promise<OrchestrationRun> {
    const source = await this.orchestrationStore.read(orchestrationId);
    const definition = source.definition;

    const parsed = WorkflowRunInputsSchema.safeParse(inputs);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ProjectError(
        "VALIDATION_FAILED",
        "Invalid orchestration run inputs: " + (issue?.message ?? "unknown input error"),
      );
    }
    const value: WorkflowRunInputs = {
      goal: parsed.data.goal,
      readPaths: [...parsed.data.readPaths],
      writePaths: [...parsed.data.writePaths],
      ...(parsed.data.model === undefined ? {} : { model: parsed.data.model }),
      ...(parsed.data.context === undefined ? {} : { context: parsed.data.context }),
    };

    const resolved = new Map<string, WorkflowDefinition>();
    for (const step of definition.steps) {
      try {
        resolved.set(step.workflowId, await this.resolveWorkflow(step.workflowId));
      } catch (error) {
        throw new ProjectError(
          "VALIDATION_FAILED",
          "Orchestration step " + JSON.stringify(step.id) + " references an unusable workflow " +
            JSON.stringify(step.workflowId) + ": " + messageOf(error),
        );
      }
    }

    await this.assertNoOtherActiveRun();

    const orchestrationRunId = this.newRunId();
    const run: OrchestrationRun = {
      schemaVersion: 1,
      orchestrationRunId,
      orchestrationId: definition.id,
      title: definition.title,
      inputs: value,
      steps: definition.steps.map((step) => ({
        stepId: step.id,
        workflowId: step.workflowId,
        approval: step.approval,
        status: "pending",
      })),
      currentStepIndex: 0,
      status: "queued",
      startedAt: this.timestamp(),
    };

    this.runs.set(orchestrationRunId, run);
    this.definitions.set(orchestrationRunId, resolved);
    this.activeRunId = orchestrationRunId;
    try {
      await this.persist(run);
    } catch (error) {
      this.runs.delete(orchestrationRunId);
      this.definitions.delete(orchestrationRunId);
      this.release(orchestrationRunId);
      throw error;
    }

    const created = this.view(run);
    this.scheduleAdvance(orchestrationRunId);
    return created;
  }

  /** One durable orchestration run, hydrated from disk when this instance has not seen it. */
  async getRun(orchestrationRunId: string): Promise<OrchestrationRun> {
    return this.view(await this.loadRun(orchestrationRunId));
  }

  /** Persisted runs, newest first by start time; live records win over their file. */
  async listRuns(): Promise<OrchestrationRun[]> {
    const records = await this.runStore.list();
    const merged = records.map((record) => this.runs.get(record.orchestrationRunId) ?? record);
    const known = new Set(merged.map((record) => record.orchestrationRunId));
    for (const live of this.runs.values()) {
      if (!known.has(live.orchestrationRunId)) merged.push(live);
    }
    merged.sort(
      (left, right) =>
        right.startedAt.localeCompare(left.startedAt) ||
        right.orchestrationRunId.localeCompare(left.orchestrationRunId),
    );
    return merged.map((record) => this.view(record));
  }

  /** Poll for an orchestration state the caller cares about. */
  async waitForRun(
    orchestrationRunId: string,
    predicate: (run: OrchestrationRun) => boolean,
    timeoutMs = 5000,
  ): Promise<OrchestrationRun> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      const run = await this.getRun(orchestrationRunId);
      if (predicate(run)) return run;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new ProjectError(
          "INTERNAL_ERROR",
          "Timed out waiting for orchestration run " + orchestrationRunId + " (status: " + run.status + ")",
        );
      }
      await delay(Math.min(WAIT_POLL_INTERVAL_MS, remaining));
    }
  }

  /**
   * Approve the current child run with the digest a person reviewed and resume.
   *
   * The digest is validated by the child runner, so a stale approval cannot
   * advance a change set that is no longer staged.
   */
  async approveStep(orchestrationRunId: string, digest: string): Promise<void> {
    const { run, step } = await this.waitingStep(orchestrationRunId);
    await this.assertNoOtherActiveRun(orchestrationRunId);
    const child = await this.runner.getRun(step.runId);
    if (child.status !== "waiting_approval") {
      throw new ProjectError("VALIDATION_FAILED", "Workflow run " + child.runId + " is not waiting for approval");
    }
    await this.runner.approve(child.runId, digest);

    step.status = "running";
    delete step.autoApproved;
    run.status = "running";
    delete run.error;
    delete run.finishedAt;
    this.activeRunId = orchestrationRunId;
    await this.persist(run);
    this.scheduleAdvance(orchestrationRunId);
  }

  /**
   * Reject the current change set. The child runs implement -> validate -> review
   * again and the orchestration stays waiting for the next decision.
   */
  async rejectStep(orchestrationRunId: string): Promise<void> {
    const { run, step } = await this.waitingStep(orchestrationRunId);
    await this.assertNoOtherActiveRun(orchestrationRunId);
    const child = await this.runner.getRun(step.runId);
    if (child.status !== "waiting_approval") {
      throw new ProjectError("VALIDATION_FAILED", "Workflow run " + child.runId + " is not waiting for approval");
    }
    await this.runner.reject(child.runId);

    const after = await this.runner.getRun(child.runId);
    if (after.status === "failed") {
      await this.failStep(run, step, after.error ?? "Workflow run ended with status failed after rejection");
      return;
    }
    step.status = "waiting_approval";
    delete step.autoApproved;
    run.status = "waiting_approval";
    await this.persist(run);
  }

  /**
   * Retry the current step from the child's implementation node (or restart the
   * step when it never got a child run) and resume the orchestration.
   */
  async retryStep(orchestrationRunId: string, action: WorkflowRetryAction = "implement"): Promise<void> {
    const run = await this.loadRun(orchestrationRunId);
    if (run.status !== "failed") {
      throw new ProjectError(
        "VALIDATION_FAILED",
        "Orchestration run " + orchestrationRunId + " can only retry from status failed, not " + run.status,
      );
    }
    await this.assertNoOtherActiveRun(orchestrationRunId);
    const step = run.steps[run.currentStepIndex];

    if (step !== undefined && step.runId !== undefined) {
      await this.runner.retry(step.runId, action);
      step.status = "running";
    } else if (step !== undefined) {
      step.status = "pending";
    }
    if (step !== undefined) delete step.error;
    run.status = "running";
    delete run.error;
    delete run.finishedAt;
    this.activeRunId = orchestrationRunId;
    await this.persist(run);
    this.scheduleAdvance(orchestrationRunId);
  }

  /** Cancel the current child run and the orchestration. Terminal runs are left alone. */
  async cancel(orchestrationRunId: string): Promise<void> {
    const run = await this.loadRun(orchestrationRunId);
    if (isTerminal(run.status)) return;

    const step = run.steps[run.currentStepIndex];
    if (step !== undefined && (step.status === "pending" || step.status === "running" || step.status === "waiting_approval")) {
      step.status = "cancelled";
    }
    run.status = "cancelled";
    run.finishedAt = this.timestamp();
    this.release(orchestrationRunId);
    await this.persist(run);

    // The orchestration is already terminal, so a background advance cannot
    // overwrite the cancellation. A missing child record is not a cancel failure.
    if (step?.runId !== undefined) {
      try {
        await this.runner.cancel(step.runId);
      } catch {
        // The child may already be gone; the orchestration state is what matters.
      }
    }
  }

  /** WorkflowRunner-compatible alias for approveStep(). */
  approve(orchestrationRunId: string, digest: string): Promise<void> {
    return this.approveStep(orchestrationRunId, digest);
  }

  /** WorkflowRunner-compatible alias for rejectStep(). */
  reject(orchestrationRunId: string): Promise<void> {
    return this.rejectStep(orchestrationRunId);
  }

  /** WorkflowRunner-compatible alias for retryStep(). */
  retry(orchestrationRunId: string, action: WorkflowRetryAction = "implement"): Promise<void> {
    return this.retryStep(orchestrationRunId, action);
  }

  /**
   * Resolve and validate one workflow definition for a step.
   *
   * The official virtual id always loads the bundled workflow; every other id is
   * a project workflow that must exist and declare the id it was referenced by.
   */
  async resolveWorkflow(workflowId: string): Promise<WorkflowDefinition> {
    let loaded: WorkflowDefinition;
    try {
      loaded = workflowId === OFFICIAL_WORKFLOW_ID ? await this.loadOfficial() : await this.loadWorkflow(workflowId);
    } catch (error) {
      throw new ProjectError(
        "VALIDATION_FAILED",
        "Workflow " + JSON.stringify(workflowId) + " is unavailable: " + messageOf(error),
      );
    }

    let definition: WorkflowDefinition;
    try {
      definition = validateWorkflowDefinition(loaded);
    } catch (error) {
      const message = error instanceof WorkflowValidationError ? error.message : messageOf(error);
      throw new ProjectError(
        "VALIDATION_FAILED",
        "Workflow " + JSON.stringify(workflowId) + " is invalid: " + message,
      );
    }
    if (definition.id !== workflowId) {
      throw new ProjectError(
        "VALIDATION_FAILED",
        "Workflow " + JSON.stringify(workflowId) + " declares id " + JSON.stringify(definition.id),
      );
    }
    return definition;
  }

  /** The shared "one active orchestration per project" guard. */
  private async assertNoOtherActiveRun(orchestrationRunId?: string): Promise<void> {
    if (this.activeRunId !== undefined && this.activeRunId !== orchestrationRunId) {
      throw new ProjectError(
        "VALIDATION_FAILED",
        "Another orchestration run is already active: " + this.activeRunId,
      );
    }
    const records = await this.runStore.list();
    const blocking = records.find(
      (record) => record.orchestrationRunId !== orchestrationRunId && isActive(record.status),
    );
    if (blocking !== undefined) {
      throw new ProjectError(
        "VALIDATION_FAILED",
        "Another orchestration run is already active: " + blocking.orchestrationRunId,
      );
    }
  }

  /** Load the live record, or hydrate it from the store when this instance is new. */
  private async loadRun(orchestrationRunId: string): Promise<OrchestrationRun> {
    const live = this.runs.get(orchestrationRunId);
    if (live !== undefined) return live;
    const record = await this.runStore.get(orchestrationRunId);
    this.runs.set(orchestrationRunId, record);
    if (this.activeRunId === undefined && isActive(record.status)) this.activeRunId = orchestrationRunId;
    return record;
  }

  /** Load a run that must be waiting for approval and return its current step. */
  private async waitingStep(
    orchestrationRunId: string,
  ): Promise<{ run: OrchestrationRun; step: OrchestrationRunStep & { runId: string } }> {
    const run = await this.loadRun(orchestrationRunId);
    if (run.status !== "waiting_approval") {
      throw new ProjectError(
        "VALIDATION_FAILED",
        "Orchestration run " + orchestrationRunId + " is not waiting for approval",
      );
    }
    const step = run.steps[run.currentStepIndex];
    if (step === undefined || step.status !== "waiting_approval" || step.runId === undefined) {
      throw new ProjectError(
        "VALIDATION_FAILED",
        "Orchestration run " + orchestrationRunId + " has no step waiting for approval",
      );
    }
    return { run, step: step as OrchestrationRunStep & { runId: string } };
  }

  /** Persist, then publish the durable record to the optional listener. */
  private async persist(run: OrchestrationRun): Promise<void> {
    await this.runStore.save(run);
    this.runs.set(run.orchestrationRunId, run);
    if (this.onUpdate !== undefined) {
      try {
        this.onUpdate(this.view(run));
      } catch {
        // A throwing listener cannot fail the durable write it observes.
      }
    }
  }

  /** Start the background advance loop unless one is already running for this run. */
  private scheduleAdvance(orchestrationRunId: string): void {
    if (this.advancing.has(orchestrationRunId)) return;
    const task = this.runAdvance(orchestrationRunId);
    this.advancing.set(orchestrationRunId, task);
    const done = (): void => {
      if (this.advancing.get(orchestrationRunId) === task) this.advancing.delete(orchestrationRunId);
    };
    void task.then(done, done);
  }

  private async runAdvance(orchestrationRunId: string): Promise<void> {
    try {
      await this.advance(orchestrationRunId);
    } catch (error) {
      await this.failRun(orchestrationRunId, error);
    }
  }

  /**
   * Follow the steps in order until the orchestration pauses, fails, or ends.
   *
   * The loop is resumable: a step with a persisted child run continues from that
   * child, so a manual approval or a retry only has to re-enter the loop.
   */
  private async advance(orchestrationRunId: string): Promise<void> {
    for (;;) {
      const run = this.runs.get(orchestrationRunId);
      if (run === undefined || !isActive(run.status)) return;
      if (run.status === "queued") {
        run.status = "running";
        await this.persist(run);
      }

      if (run.currentStepIndex >= run.steps.length) {
        await this.completeRun(run);
        return;
      }
      const step = run.steps[run.currentStepIndex];
      if (step === undefined) {
        await this.completeRun(run);
        return;
      }
      if (step.status === "completed") {
        run.currentStepIndex += 1;
        await this.persist(run);
        continue;
      }
      if (step.status === "failed" || step.status === "cancelled") return;

      let child: WorkflowRun;
      if (step.runId === undefined) {
        child = await this.startStep(run, step);
      } else {
        child = await this.runner.getRun(step.runId);
      }

      if (!isSettledChild(child.status)) {
        const settled = await this.awaitChild(run, child.runId);
        if (settled === undefined) return;
        child = settled;
      }
      // A cancel or a pause can land while the child is being observed.
      if (run.status !== "running") return;

      if (child.status === "waiting_approval") {
        const definition = await this.workflowFor(run, step);
        if (effectiveApproval(step, definition) === "manual") {
          step.status = "waiting_approval";
          run.status = "waiting_approval";
          delete run.error;
          await this.persist(run);
          return;
        }

        const digest = child.approval?.digest;
        if (typeof digest !== "string" || digest.length === 0) {
          await this.failStep(
            run,
            step,
            "Workflow run " + child.runId + " is waiting for approval without a digest",
          );
          return;
        }
        await this.runner.approve(child.runId, digest);
        step.autoApproved = true;
        step.status = "running";
        run.status = "running";
        delete run.error;
        await this.persist(run);

        const approved = await this.awaitChild(run, child.runId);
        if (approved === undefined || run.status !== "running") return;
        if (approved.status === "completed") {
          await this.completeStep(run, step, approved);
          continue;
        }
        await this.failStepFromChild(run, step, approved);
        return;
      }

      if (child.status === "completed") {
        await this.completeStep(run, step, child);
        continue;
      }

      await this.failStepFromChild(run, step, child);
      return;
    }
  }

  /** Create, persist, and start the child run of one step. */
  private async startStep(run: OrchestrationRun, step: OrchestrationRunStep): Promise<WorkflowRun> {
    const definition = await this.workflowFor(run, step);
    const previous = await this.previousContext(run, run.currentStepIndex);
    const child = this.runner.createRun(definition, this.childInputs(run, previous));

    step.runId = child.runId;
    step.status = "running";
    run.status = "running";
    delete step.error;
    await this.persist(run);

    await this.runner.start(child.runId);
    return await this.runner.getRun(child.runId);
  }

  /**
   * Poll one child until it settles. Returns undefined when the orchestration is
   * no longer running (cancelled or paused by another caller).
   */
  private async awaitChild(run: OrchestrationRun, childRunId: string): Promise<WorkflowRun | undefined> {
    for (;;) {
      if (run.status !== "running") return undefined;
      const child = await this.runner.getRun(childRunId);
      if (isSettledChild(child.status)) return child;
      await delay(CHILD_POLL_INTERVAL_MS);
    }
  }

  /** Record a completed child and move the orchestration to the next step. */
  private async completeStep(run: OrchestrationRun, step: OrchestrationRunStep, child: WorkflowRun): Promise<void> {
    step.status = "completed";
    step.summary = this.summaryOf(child);
    const decisionPath = boundedDecisionPath(child.decisionPath);
    if (decisionPath === undefined) delete step.decisionPath;
    else step.decisionPath = decisionPath;
    delete step.error;
    run.currentStepIndex += 1;
    run.status = "running";
    delete run.error;
    await this.persist(run);
  }

  private async failStepFromChild(
    run: OrchestrationRun,
    step: OrchestrationRunStep,
    child: WorkflowRun,
  ): Promise<void> {
    const detail = child.error ?? "Workflow run " + child.runId + " ended with status " + child.status;
    await this.failStep(run, step, detail);
  }

  private async failStep(
    run: OrchestrationRun,
    step: OrchestrationRunStep | undefined,
    detail: string,
  ): Promise<void> {
    const message = boundError(detail);
    if (
      step !== undefined &&
      (step.status === "pending" || step.status === "running" || step.status === "waiting_approval")
    ) {
      step.status = "failed";
      step.error = message;
    }
    run.status = "failed";
    run.error = message;
    run.finishedAt = this.timestamp();
    this.release(run.orchestrationRunId);
    try {
      await this.persist(run);
    } catch {
      // The in-memory run still reflects the failure even when the record cannot be rewritten.
    }
  }

  private async completeRun(run: OrchestrationRun): Promise<void> {
    run.status = "completed";
    run.finishedAt = this.timestamp();
    delete run.error;
    this.release(run.orchestrationRunId);
    await this.persist(run);
  }

  /** Persist an orchestration-level failure raised outside a child transition. */
  private async failRun(orchestrationRunId: string, error: unknown): Promise<void> {
    const run = this.runs.get(orchestrationRunId);
    if (run === undefined || isTerminal(run.status)) return;
    await this.failStep(run, run.steps[run.currentStepIndex], messageOf(error));
  }

  /** A bounded summary of the completed child, preferring its write agent output. */
  private summaryOf(child: WorkflowRun): string {
    const nodes = child.definitionSnapshot.nodes;
    const write = nodes.find((node) => node.type === "agent" && node.config.access === "write");
    const candidates: (string | undefined)[] = [
      write?.id,
      ...nodes.filter((node) => node.type === "agent").map((node) => node.id),
    ];
    for (const id of candidates) {
      if (id === undefined) continue;
      const output = child.nodeStates.find((state) => state.id === id)?.output;
      if (typeof output === "string" && output.trim().length > 0) return boundSummary(output);
    }
    return boundSummary("工作流 " + child.workflowId + " 已完成");
  }

  /**
   * The bounded handout for the step after the immediately preceding one.
   *
   * It carries the durable step summary and decision path plus the child's
   * validation status and approval, never the full run history, and is capped at
   * MAX_RUN_CONTEXT_LENGTH characters.
   */
  private async previousContext(run: OrchestrationRun, index: number): Promise<string | undefined> {
    const step = run.steps[index - 1];
    if (step === undefined || step.status !== "completed") return undefined;

    const parts: string[] = [
      "上一步「" + step.stepId + "」（工作流 " + step.workflowId + "）已完成。",
    ];
    const summary = step.summary?.trim();
    if (summary !== undefined && summary.length > 0) parts.push("摘要：\n" + summary);
    if (step.decisionPath !== undefined) parts.push("决策记录：" + step.decisionPath);

    let child: WorkflowRun | undefined;
    if (step.runId !== undefined) {
      try {
        child = await this.runner.getRun(step.runId);
      } catch {
        // The child record may be gone; the persisted step fields still describe it.
        child = undefined;
      }
    }
    if (child?.validation !== undefined) parts.push("校验状态：" + child.validation.status);
    if (step.autoApproved === true) {
      parts.push("审批：自动批准（orchestrator）");
    } else if (child?.approval?.approvedAt !== undefined) {
      parts.push("审批：人工批准（" + child.approval.approvedAt + "）");
    }

    const text = parts.join("\n\n");
    return text.length > MAX_RUN_CONTEXT_LENGTH ? text.slice(0, MAX_RUN_CONTEXT_LENGTH) : text;
  }

  /** Shared step inputs plus the bounded previous-step handout. */
  private childInputs(run: OrchestrationRun, previous: string | undefined): WorkflowRunInputs {
    const context = combineRunContext(run.inputs.context, previous);
    return {
      goal: run.inputs.goal,
      readPaths: [...run.inputs.readPaths],
      writePaths: [...run.inputs.writePaths],
      ...(run.inputs.model === undefined ? {} : { model: run.inputs.model }),
      ...(context === undefined ? {} : { context }),
    };
  }

  /** Resolve a step's workflow, caching the definition for this orchestration run. */
  private async workflowFor(run: OrchestrationRun, step: OrchestrationRunStep): Promise<WorkflowDefinition> {
    const cached = this.definitions.get(run.orchestrationRunId)?.get(step.workflowId);
    if (cached !== undefined) return cached;
    const definition = await this.resolveWorkflow(step.workflowId);
    const cache = this.definitions.get(run.orchestrationRunId) ?? new Map<string, WorkflowDefinition>();
    cache.set(step.workflowId, definition);
    this.definitions.set(run.orchestrationRunId, cache);
    return definition;
  }

  /** A generated id must be usable as the record file name. */
  private newRunId(): string {
    const id = this.idFactory();
    if (typeof id !== "string" || !RUN_ID_PATTERN.test(id)) {
      throw new ProjectError(
        "VALIDATION_FAILED",
        "Orchestration run id is not usable as a file name: " + JSON.stringify(String(id)),
      );
    }
    return id;
  }

  private release(orchestrationRunId: string): void {
    if (this.activeRunId === orchestrationRunId) this.activeRunId = undefined;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private view(run: OrchestrationRun): OrchestrationRun {
    return structuredClone(run);
  }
}

/** The orchestration runtime's public interface, named after its role. */
export type OrchestrationRunner = WorkflowOrchestrator;
