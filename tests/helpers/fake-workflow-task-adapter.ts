import type { ModelProfile, ValidationResult } from "../../src/shared/contracts";
import type { ChangeReview } from "../../src/shared/desktop-api";
import type { WorkflowTaskAdapter, WorkflowTaskHandle, WorkflowTaskScope } from "../../src/main/core/workflow-task-adapter";

/** One recorded runAgent call, including the label used in `agents`. */
export interface FakeAgentRun {
  taskId: string;
  profile: ModelProfile;
  prompt: string;
  signal: AbortSignal;
  label: string;
}

/**
 * In-memory WorkflowTaskAdapter for runner tests. Every call is recorded and
 * every failure can be scripted without touching ProjectCore or Electron.
 */
export class FakeWorkflowTaskAdapter implements WorkflowTaskAdapter {
  /** Every scope passed to createTask, in call order. */
  readonly created: WorkflowTaskScope[] = [];
  /** Alias of created, kept for run-level scope assertions. */
  readonly scopes: WorkflowTaskScope[] = [];
  /** One label per runAgent call; defaults to the task title. */
  readonly agents: string[] = [];
  readonly prompts: string[] = [];
  readonly runs: FakeAgentRun[] = [];
  readonly removed: string[] = [];
  readonly validations: string[] = [];
  readonly approvals: { taskId: string; digest: string }[] = [];
  readonly rejections: string[] = [];

  /** Profile returned by resolveModelProfile; tests can script it. */
  profile: ModelProfile = {
    id: "model-1",
    name: "Test model",
    provider: "openai-compatible",
    model: "model-1",
    baseUrl: "https://example.com/v1",
    approved: true,
    timeoutMs: 30_000,
  };
  /** Digest returned by preview and accepted by approve. */
  digest = "digest-1";
  /** Summary returned when the `summaries` queue is empty. */
  summary = "done";
  /** Queued runAgent summaries, consumed before `summary`. */
  summaries: string[] = [];
  /** Queued runAgent labels; falls back to the task title, then the prompt. */
  agentLabels: string[] = [];
  /** Validation returned when the `validationResults` queue is empty. */
  validation: ValidationResult = { status: "pass", checks: [], diagnostics: [] };
  /** Queued validation results, consumed before `validation`. */
  validationResults: ValidationResult[] = [];
  /** Result returned by the most recent validate call; preview reflects it. */
  lastValidation: ValidationResult | undefined;
  /** When set, preview returns this review instead of a generated one. */
  previewResult?: ChangeReview;

  createError?: Error;
  removeError?: Error;
  agentError?: Error;
  validationError?: Error;
  previewError?: Error;
  approveError?: Error;
  rejectError?: Error;
  /** Optional hook for asserting or mutating state during a runAgent call. */
  onRunAgent?: (run: FakeAgentRun) => void | Promise<void>;

  private sequence = 0;
  private readonly scopesById = new Map<string, WorkflowTaskScope>();

  resolveModelProfile(modelId: string): ModelProfile {
    void modelId;
    return this.profile;
  }

  async createTask(scope: WorkflowTaskScope): Promise<WorkflowTaskHandle> {
    if (this.createError) throw this.createError;
    const id = "task-" + (++this.sequence);
    const recorded: WorkflowTaskScope = {
      title: scope.title,
      readPaths: [...scope.readPaths],
      writePaths: [...scope.writePaths],
    };
    this.created.push(recorded);
    this.scopes.push(recorded);
    this.scopesById.set(id, recorded);
    return { id, scope: recorded };
  }

  async removeTask(taskId: string): Promise<void> {
    if (this.removeError) throw this.removeError;
    this.removed.push(taskId);
    this.scopesById.delete(taskId);
  }

  async runAgent(taskId: string, profile: ModelProfile, prompt: string, signal: AbortSignal): Promise<{ summary: string }> {
    if (this.agentError) throw this.agentError;
    const label = this.agentLabels.shift() ?? this.scopesById.get(taskId)?.title ?? prompt;
    const run: FakeAgentRun = { taskId, profile, prompt, signal, label };
    this.agents.push(label);
    this.prompts.push(prompt);
    this.runs.push(run);
    await this.onRunAgent?.(run);
    return { summary: this.summaries.shift() ?? this.summary };
  }

  async validate(taskId: string, signal: AbortSignal): Promise<ValidationResult> {
    if (this.validationError) throw this.validationError;
    void signal;
    this.validations.push(taskId);
    const result = this.validationResults.shift() ?? this.validation;
    this.lastValidation = result;
    return result;
  }

  async preview(taskId: string): Promise<ChangeReview> {
    if (this.previewError) throw this.previewError;
    if (this.previewResult) return this.previewResult;
    return {
      changeSet: {
        id: "changeset-" + taskId,
        taskId,
        entries: [],
        dependencies: {},
        digest: this.digest,
        status: "validated",
      },
      before: {},
      validation: this.lastValidation ?? this.validation,
      approved: false,
    };
  }

  async approve(taskId: string, digest: string): Promise<void> {
    if (this.approveError) throw this.approveError;
    this.approvals.push({ taskId, digest });
  }

  async reject(taskId: string): Promise<void> {
    if (this.rejectError) throw this.rejectError;
    this.rejections.push(taskId);
  }
}
