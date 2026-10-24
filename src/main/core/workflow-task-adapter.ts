import { randomUUID } from "node:crypto";
import type { ModelProfile, TaskScopeSpec, ValidationResult } from "../../shared/contracts";
import type { ChangeReview, TaskView } from "../../shared/desktop-api";
import { ProjectError } from "./errors";

/** Task scope requested by one workflow node. */
export interface WorkflowTaskScope {
  title: string;
  readPaths: string[];
  writePaths: string[];
}

/** Identity and effective scope of a created workflow task. */
export interface WorkflowTaskHandle {
  id: string;
  scope: WorkflowTaskScope;
}

/**
 * The subset of ProjectCore that workflow runs depend on. ProjectCore satisfies
 * this structurally, so tests can supply a plain double without Electron.
 */
export interface WorkflowTaskCore {
  createTask(spec: TaskScopeSpec): Promise<Pick<TaskView, "id" | "scope">>;
  removeTask(taskId: string): Promise<void>;
  agentMessage(taskId: string, profile: ModelProfile, prompt: string, signal?: AbortSignal): Promise<{ summary: string }>;
  validate(taskId: string, signal?: AbortSignal): Promise<ValidationResult>;
  previewChanges(taskId: string): Promise<ChangeReview>;
  approveChanges(taskId: string, digest: string): Promise<unknown>;
  rejectChanges(taskId: string): Promise<unknown>;
}

/** Boundary between WorkflowRunner and ProjectCore tasks. */
export interface WorkflowTaskAdapter {
  /**
   * Resolves a run input's model id to the profile its agent nodes run with.
   * Production resolves asynchronously; tests may return the profile directly.
   */
  resolveModelProfile(modelId: string): ModelProfile | Promise<ModelProfile>;
  createTask(scope: WorkflowTaskScope): Promise<WorkflowTaskHandle>;
  removeTask(taskId: string): Promise<void>;
  runAgent(taskId: string, profile: ModelProfile, prompt: string, signal: AbortSignal): Promise<{ summary: string }>;
  validate(taskId: string, signal: AbortSignal): Promise<ValidationResult>;
  preview(taskId: string): Promise<ChangeReview>;
  approve(taskId: string, digest: string): Promise<void>;
  reject(taskId: string): Promise<void>;
}

/**
 * Workflow inputs are usually directories (specs, specs/entities). Project task
 * scopes match exact paths, so a directory input is widened to a recursive
 * pattern. File-looking inputs with an extension stay exact.
 */
function taskScopePattern(value: string): string {
  const normalized = value.replace(/\/+$/, "");
  if (normalized === "*" || normalized.endsWith("/**") || /\.[a-z0-9]{1,12}$/i.test(normalized)) return normalized;
  return normalized + "/**";
}

/** Resolves a run input model id to the profile configured for this project. */
export type WorkflowProfileResolver = (modelId: string) => ModelProfile | undefined | Promise<ModelProfile | undefined>;

/**
 * Production adapter. Workflow tasks are always manual and cannot delete:
 * workflow nodes never gain broader permissions than the run inputs grant.
 */
export class ProjectCoreWorkflowTaskAdapter implements WorkflowTaskAdapter {
  constructor(
    private readonly core: WorkflowTaskCore,
    private readonly resolveProfile?: WorkflowProfileResolver,
  ) {}

  /** Resolves the configured profile for a workflow run's model input. */
  async resolveModelProfile(modelId: string): Promise<ModelProfile> {
    const profile = await this.resolveProfile?.(modelId);
    if (!profile) throw new ProjectError("MODEL_ERROR", "Unknown workflow model profile: " + JSON.stringify(modelId));
    return profile;
  }

  async createTask(scope: WorkflowTaskScope): Promise<WorkflowTaskHandle> {
    const id = "workflow-" + randomUUID();
    const view = await this.core.createTask({
      id,
      title: scope.title,
      readPaths: scope.readPaths.map(taskScopePattern),
      writePaths: scope.writePaths.map(taskScopePattern),
      allowDelete: false,
      mode: "manual",
    });
    return {
      id: view.id,
      scope: {
        title: view.scope.title,
        readPaths: [...view.scope.readPaths],
        writePaths: [...view.scope.writePaths],
      },
    };
  }

  removeTask(taskId: string): Promise<void> {
    return this.core.removeTask(taskId);
  }

  async runAgent(taskId: string, profile: ModelProfile, prompt: string, signal: AbortSignal): Promise<{ summary: string }> {
    const result = await this.core.agentMessage(taskId, profile, prompt, signal);
    return { summary: result.summary };
  }

  validate(taskId: string, signal: AbortSignal): Promise<ValidationResult> {
    return this.core.validate(taskId, signal);
  }

  preview(taskId: string): Promise<ChangeReview> {
    return this.core.previewChanges(taskId);
  }

  async approve(taskId: string, digest: string): Promise<void> {
    await this.core.approveChanges(taskId, digest);
  }

  async reject(taskId: string): Promise<void> {
    await this.core.rejectChanges(taskId);
  }
}
