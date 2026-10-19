import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { TaskScopeSpec } from "../../shared/contracts";
import {
  OFFICIAL_WORKFLOW_ID,
  type WorkflowDefaultSource,
  type WorkflowSettings,
} from "../../shared/orchestration";
import { WORKFLOW_ID_PATTERN, type WorkflowDefinition } from "../../shared/workflow";
import {
  WorkflowRunInputsSchema,
  type WorkflowRun,
  type WorkflowRunInputs,
  type WorkflowTriggerChatInput,
  type WorkflowTriggerResult,
  type WorkflowTriggerSource,
} from "../../shared/workflow-api";
import { ProjectError } from "./errors";
import { resolveDefaultWorkflow } from "./workflow-defaults";
import { loadOfficialWorkflow } from "./workflow-official";

/** Fixed project-relative sidecar that binds a task to the one run it started. */
export const TASK_BINDINGS_RELATIVE_PATH = ".specloom/workflows/task-bindings.json";

/** Hard cap for one task id used as a binding key. */
export const MAX_BINDING_TASK_ID_LENGTH = 1024;
/** Hard cap for the whole binding sidecar, read or written. */
export const MAX_TASK_BINDINGS_BYTES = 1024 * 1024;

/** Same run-id rule the runner uses for a run record file name. */
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TASK_ID_SCHEMA = z.string().min(1).max(MAX_BINDING_TASK_ID_LENGTH);

const TaskBindingSchema = z
  .object({
    runId: z.string().regex(RUN_ID_PATTERN, "run id must be a safe file name"),
    workflowId: z.string().regex(WORKFLOW_ID_PATTERN, "workflow id must be lowercase snake_case"),
    source: z.enum(["project", "official", "fallback"]),
  })
  .strict();

const TaskBindingsFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    bindings: z.record(TASK_ID_SCHEMA, TaskBindingSchema),
  })
  .strict();

/** One durable task-to-run binding, including why that workflow was chosen. */
export interface TaskBinding {
  runId: string;
  workflowId: string;
  source: WorkflowDefaultSource;
}

interface TaskBindingsFile {
  schemaVersion: 1;
  bindings: Record<string, TaskBinding>;
}

function emptyTaskBindings(): TaskBindingsFile {
  return { schemaVersion: 1, bindings: {} };
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function issueLocation(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "(root): unknown schema error";
  const at = issue.path.length > 0 ? issue.path.map((part) => String(part)).join(".") : "(root)";
  return at + ": " + issue.message;
}

function assertTaskId(taskId: string): void {
  if (!TASK_ID_SCHEMA.safeParse(taskId).success) {
    throw new ProjectError("VALIDATION_FAILED", "Invalid task id for a workflow binding");
  }
}

/**
 * Project-scoped binding store at the fixed path
 * .specloom/workflows/task-bindings.json.
 *
 * No path ever comes from a renderer or a task: the sidecar lives at one fixed
 * project-relative location. Writes are atomic (temp + rename) and serialized so
 * a read-modify-write cannot drop a binding. A missing file reads as empty; a
 * corrupt file fails closed instead of silently starting a second run.
 */
export class TaskBindingStore {
  private readonly file: string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(root: string) {
    this.file = path.join(path.resolve(root), ...TASK_BINDINGS_RELATIVE_PATH.split("/"));
  }

  /** Every binding; a missing sidecar reads as empty. */
  async read(): Promise<TaskBindingsFile> {
    let content: string;
    try {
      content = await readFile(this.file, "utf8");
    } catch (error) {
      if (isMissing(error)) return emptyTaskBindings();
      throw new ProjectError(
        "INTERNAL_ERROR",
        "Unable to read task workflow bindings",
        { path: TASK_BINDINGS_RELATIVE_PATH },
        { cause: error },
      );
    }

    if (Buffer.byteLength(content, "utf8") > MAX_TASK_BINDINGS_BYTES) {
      throw new ProjectError("INTERNAL_ERROR", "Task workflow bindings exceed the maximum size", {
        path: TASK_BINDINGS_RELATIVE_PATH,
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content) as unknown;
    } catch {
      // Never echo the sidecar body: it is runtime state, not user-facing text.
      throw new ProjectError("INTERNAL_ERROR", "Task workflow bindings are not valid JSON", {
        path: TASK_BINDINGS_RELATIVE_PATH,
      });
    }

    const result = TaskBindingsFileSchema.safeParse(parsed);
    if (!result.success) {
      throw new ProjectError(
        "INTERNAL_ERROR",
        "Invalid task workflow bindings at " + issueLocation(result.error),
        { path: TASK_BINDINGS_RELATIVE_PATH },
      );
    }
    return result.data;
  }

  async get(taskId: string): Promise<TaskBinding | undefined> {
    return (await this.read()).bindings[taskId];
  }

  /**
   * Record the first run a task starts and return the effective binding.
   * An existing binding always wins, so a retried start never rebinds a task.
   */
  async bind(taskId: string, binding: TaskBinding): Promise<TaskBinding> {
    assertTaskId(taskId);
    return await this.exclusive(async () => {
      const current = await this.read();
      const existing = current.bindings[taskId];
      if (existing !== undefined) return existing;
      const next: TaskBindingsFile = {
        schemaVersion: 1,
        bindings: { ...current.bindings, [taskId]: binding },
      };
      await this.write(next);
      return binding;
    });
  }

  private async write(value: TaskBindingsFile): Promise<void> {
    const content = JSON.stringify(value, null, 2) + "\n";
    if (Buffer.byteLength(content, "utf8") > MAX_TASK_BINDINGS_BYTES) {
      throw new ProjectError("VALIDATION_FAILED", "Task workflow bindings exceed the maximum size", {
        path: TASK_BINDINGS_RELATIVE_PATH,
      });
    }

    const directory = path.dirname(this.file);
    const temporary = this.file + ".tmp-" + randomUUID();
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(temporary, content, "utf8");
      await rename(temporary, this.file);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw new ProjectError(
        "INTERNAL_ERROR",
        "Unable to save task workflow bindings",
        { path: TASK_BINDINGS_RELATIVE_PATH },
        { cause: error },
      );
    }
  }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.chain.then(action, action);
    // The chain itself never rejects; a failed write is reported to its caller.
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/**
 * The slice of WorkflowService the trigger needs.
 *
 * Keeping this structural lets the trigger stay a pure service: tests inject a
 * double, and the desktop layer passes the one real service so the trigger uses
 * the same runner and durable run records as every other workflow entry point.
 */
export interface WorkflowTriggerService {
  defaultsRead(): Promise<WorkflowSettings>;
  read(id: string): Promise<{ definition: WorkflowDefinition }>;
  start(definition: WorkflowDefinition, inputs: WorkflowRunInputs): Promise<WorkflowRun>;
  getRun(runId: string): Promise<WorkflowRun>;
}

export interface WorkflowTriggerOptions {
  /** Project root; the binding sidecar always stays below it. */
  root: string;
  service: WorkflowTriggerService;
  /** Resolves a task's persisted scope; ProjectCore.taskScope supplies this. */
  resolveTaskScope: (taskId: string) => Promise<TaskScopeSpec> | TaskScopeSpec;
  /** Loads the bundled official workflow; injectable for tests. */
  loadOfficial?: () => Promise<WorkflowDefinition>;
}

/**
 * A chat implementation turn: an explicit scope plus an optional workflow.
 * The shape is owned by the shared workflow API so the IPC boundary and the
 * trigger cannot drift.
 */
export type { WorkflowTriggerChatInput, WorkflowTriggerResult, WorkflowTriggerSource };

/**
 * The goal a task starts its default workflow with.
 *
 * The optional stored goal wins; tasks saved before the goal existed fall back
 * to their title, matching the design contract.
 */
export function taskGoal(scope: Pick<TaskScopeSpec, "goal" | "title">): string {
  const goal = scope.goal?.trim();
  return goal !== undefined && goal.length > 0 ? goal : scope.title;
}

function parseRunInputs(candidate: unknown): WorkflowRunInputs {
  const result = WorkflowRunInputsSchema.safeParse(candidate);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new ProjectError(
      "VALIDATION_FAILED",
      "Invalid workflow run inputs: " + (issue?.message ?? "unknown input error"),
    );
  }
  return {
    goal: result.data.goal,
    readPaths: [...result.data.readPaths],
    writePaths: [...result.data.writePaths],
    ...(result.data.model === undefined ? {} : { model: result.data.model }),
    ...(result.data.context === undefined ? {} : { context: result.data.context }),
  };
}

interface ResolvedDefaultDefinition {
  definition: WorkflowDefinition;
  source: WorkflowDefaultSource;
  warning?: string;
}

/**
 * Starts workflows from the task page and from chat implementation mode.
 *
 * The trigger owns default resolution, the durable task binding, and input
 * assembly. It deliberately has no approve path: a run still follows its own
 * approval policy, so nothing here can approve beyond the workflow definition.
 */
export class WorkflowTrigger {
  private readonly service: WorkflowTriggerService;
  private readonly resolveTaskScope: (taskId: string) => Promise<TaskScopeSpec> | TaskScopeSpec;
  private readonly loadOfficial: () => Promise<WorkflowDefinition>;
  private readonly bindings: TaskBindingStore;
  /** One task start at a time, so an idempotent retry cannot race itself. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: WorkflowTriggerOptions) {
    this.service = options.service;
    this.resolveTaskScope = options.resolveTaskScope;
    this.loadOfficial = options.loadOfficial ?? (() => loadOfficialWorkflow());
    this.bindings = new TaskBindingStore(options.root);
  }

  /**
   * Start the default workflow for a task's first implementation message.
   *
   * The run goal is the task's stored goal (or its title for older tasks); the
   * message only proves this is a non-empty implementation turn. A task starts
   * at most once: an existing durable binding returns its run unchanged.
   */
  async startForTask(taskId: string, message?: string): Promise<WorkflowTriggerResult> {
    assertTaskId(taskId);
    if (message !== undefined && message.trim().length === 0) {
      throw new ProjectError("VALIDATION_FAILED", "A workflow starts from a non-empty implementation message");
    }

    return await this.exclusive(async () => {
      const existing = await this.bindings.get(taskId);
      if (existing !== undefined) return await this.existingResult(existing);

      const scope = await this.resolveTaskScope(taskId);
      const inputs = parseRunInputs({
        goal: taskGoal(scope),
        readPaths: scope.readPaths,
        writePaths: scope.writePaths,
      });
      const resolved = await this.resolveDefaultDefinition();
      const run = await this.service.start(resolved.definition, inputs);
      const binding = await this.bindings.bind(taskId, {
        runId: run.runId,
        workflowId: run.workflowId,
        source: resolved.source,
      });
      return this.resultOf(binding, resolved.warning);
    });
  }

  /**
   * Start a chat implementation run with a validated scope.
   *
   * An explicit workflowId overrides the project default; otherwise the project
   * default is resolved (falling back to the official workflow with a warning).
   */
  async startForChat(input: WorkflowTriggerChatInput): Promise<WorkflowTriggerResult> {
    const inputs = parseRunInputs({
      goal: input.goal,
      readPaths: input.readPaths,
      writePaths: input.writePaths,
      ...(input.model === undefined ? {} : { model: input.model }),
    });

    if (input.workflowId !== undefined) {
      const definition = await this.loadExplicit(input.workflowId);
      const run = await this.service.start(definition, inputs);
      return { workflowId: run.workflowId, runId: run.runId, source: "explicit" };
    }

    const resolved = await this.resolveDefaultDefinition();
    const run = await this.service.start(resolved.definition, inputs);
    return {
      workflowId: run.workflowId,
      runId: run.runId,
      source: resolved.source,
      ...(resolved.warning === undefined ? {} : { warning: resolved.warning }),
    };
  }

  private async existingResult(binding: TaskBinding): Promise<WorkflowTriggerResult> {
    const run = await this.service.getRun(binding.runId);
    return { workflowId: run.workflowId, runId: run.runId, source: binding.source };
  }

  private resultOf(binding: TaskBinding, warning: string | undefined): WorkflowTriggerResult {
    return {
      workflowId: binding.workflowId,
      runId: binding.runId,
      source: binding.source,
      ...(warning === undefined ? {} : { warning }),
    };
  }

  private async resolveDefaultDefinition(): Promise<ResolvedDefaultDefinition> {
    const settings = await this.service.defaultsRead();
    const resolved = await resolveDefaultWorkflow({
      settings,
      loadProject: async (id) => (await this.service.read(id)).definition,
      loadOfficial: this.loadOfficial,
    });
    const definition = resolved.source === "project"
      ? (await this.service.read(resolved.workflowId)).definition
      : await this.loadOfficial();
    return {
      definition,
      source: resolved.source,
      ...(resolved.warning === undefined ? {} : { warning: resolved.warning }),
    };
  }

  private async loadExplicit(workflowId: string): Promise<WorkflowDefinition> {
    if (workflowId === OFFICIAL_WORKFLOW_ID) return await this.loadOfficial();
    return (await this.service.read(workflowId)).definition;
  }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.chain.then(action, action);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
