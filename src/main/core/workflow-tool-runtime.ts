import { stringify } from "yaml";
import { ZodError } from "zod";
import {
  OFFICIAL_WORKFLOW_ID,
  OrchestrationDefinitionSchema,
  type OrchestrationDefinition,
} from "../../shared/orchestration";
import {
  WorkflowValidationError,
  validateWorkflowDefinition,
  type WorkflowDefinition,
} from "../../shared/workflow";
import type { WorkflowRunInputs } from "../../shared/workflow-api";
import { ProjectError } from "./errors";
import { stringifyOrchestration } from "./orchestration-store";
import type {
  OrchestrationCreateResult,
  OrchestrationListResult,
  WorkflowCreateResult,
  WorkflowListResult,
  WorkflowToolRuntime,
} from "./tools/workflow-tools";
import { loadOfficialWorkflow } from "./workflow-official";
import { resolveDefaultWorkflow } from "./workflow-defaults";
import type { WorkflowService } from "./workflow-service";

export interface ServiceWorkflowToolRuntimeOptions {
  /** The project-scoped service that owns the definition stores and the run runner. */
  service: WorkflowService;
  /** Loads the bundled official workflow for default resolution; injectable for tests. */
  loadOfficial?: () => Promise<WorkflowDefinition>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Turn every B-rule or schema failure into one readable VALIDATION_FAILED error. */
function invalidDefinition(error: unknown): ProjectError {
  const message = error instanceof WorkflowValidationError ? error.message : messageOf(error);
  return new ProjectError("VALIDATION_FAILED", "Invalid workflow definition: " + message, undefined, { cause: error });
}

function validateDefinition(input: unknown): WorkflowDefinition {
  try {
    return validateWorkflowDefinition(input);
  } catch (error) {
    throw invalidDefinition(error);
  }
}

function validateOrchestration(input: unknown): OrchestrationDefinition {
  try {
    return OrchestrationDefinitionSchema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      const issues = error.issues
        .map((issue) => (issue.path.length > 0 ? issue.path.map((part) => String(part)).join(".") + ": " : "") + issue.message)
        .join("; ");
      throw new ProjectError(
        "VALIDATION_FAILED",
        "Invalid orchestration definition: " + (issues.length > 0 ? issues : "unknown schema error"),
        undefined,
        { cause: error },
      );
    }
    if (error instanceof ProjectError) throw error;
    throw new ProjectError(
      "VALIDATION_FAILED",
      "Invalid orchestration definition: " + messageOf(error),
      undefined,
      { cause: error },
    );
  }
}

function invalidOrchestrationDefinition(error: unknown): ProjectError {
  return error instanceof ProjectError
    ? error
    : new ProjectError("VALIDATION_FAILED", "Invalid orchestration definition: " + messageOf(error), undefined, { cause: error });
}

/**
 * Bind the agent workflow tools to one project's WorkflowService.
 *
 * The service already owns `specs/workflows`, `specs/orchestrations`, the run
 * records, and the runner, so this adapter never touches the filesystem itself:
 * definitions are validated here (for a readable message) and then written
 * through the store, which validates and version-checks them again. Definitions
 * are created exclusively with an "absent" expected version, so a tool can never
 * overwrite a workflow a person edited.
 *
 * Default resolution reuses resolveDefaultWorkflow(), which reads the project
 * settings and falls back to the official development-review workflow with a
 * warning instead of failing.
 */
export function createWorkflowToolRuntime(options: ServiceWorkflowToolRuntimeOptions): WorkflowToolRuntime {
  const service = options.service;
  const loadOfficial = options.loadOfficial ?? (() => loadOfficialWorkflow());

  const resolveDefault = async () => {
    const settings = await service.defaultsRead();
    return await resolveDefaultWorkflow({
      settings,
      loadProject: async (id) => (await service.read(id)).definition,
      loadOfficial,
    });
  };

  /**
   * Load the definition a run should execute. An explicit id names a project
   * workflow (the official virtual id still means the bundled template); an
   * omitted or "default" target resolves the project default first.
   */
  const loadRunDefinition = async (workflowId: string | undefined): Promise<WorkflowDefinition> => {
    if (workflowId !== undefined) {
      if (workflowId === OFFICIAL_WORKFLOW_ID) return await loadOfficial();
      return (await service.read(workflowId)).definition;
    }
    const resolved = await resolveDefault();
    return resolved.source === "project" ? (await service.read(resolved.workflowId)).definition : await loadOfficial();
  };

  return {
    async list(): Promise<WorkflowListResult> {
      const workflows = await service.list();
      const resolved = await resolveDefault();
      return {
        workflows,
        defaultWorkflowId: resolved.workflowId,
        defaultSource: resolved.source,
        ...(resolved.warning === undefined ? {} : { warning: resolved.warning }),
      };
    },

    read(id: string) {
      return service.read(id);
    },

    async create(definition: unknown): Promise<WorkflowCreateResult> {
      const parsed = validateDefinition(definition);
      const saved = await service.save(parsed.id, stringify(parsed, { lineWidth: 0 }), "absent");
      return { id: parsed.id, fileVersion: saved.fileVersion };
    },

    async run(inputs: WorkflowRunInputs, workflowId?: string | undefined) {
      const definition = await loadRunDefinition(workflowId);
      return await service.start(definition, inputs);
    },

    status(runId: string) {
      return service.getRun(runId);
    },

    async cancel(runId: string) {
      await service.cancel(runId);
      return await service.getRun(runId);
    },

    async orchestrationList(): Promise<OrchestrationListResult> {
      return { orchestrations: await service.orchestrationList() };
    },

    orchestrationRead(id: string) {
      return service.orchestrationRead(id);
    },

    async orchestrationCreate(definition: unknown): Promise<OrchestrationCreateResult> {
      let parsed: OrchestrationDefinition;
      try {
        parsed = validateOrchestration(definition);
      } catch (error) {
        throw invalidOrchestrationDefinition(error);
      }
      const saved = await service.orchestrationSave(parsed.id, stringifyOrchestration(parsed), "absent");
      return { id: parsed.id, fileVersion: saved.fileVersion };
    },

    orchestrationRun(orchestrationId: string, inputs: WorkflowRunInputs) {
      return service.orchestrationStart(orchestrationId, inputs);
    },

    orchestrationStatus(runId: string) {
      return service.orchestrationGetRun(runId);
    },

    async orchestrationCancel(runId: string) {
      await service.orchestrationCancel(runId);
      return await service.orchestrationGetRun(runId);
    },
  };
}
