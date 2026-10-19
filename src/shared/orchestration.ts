import { z } from "zod";
import { WORKFLOW_ID_PATTERN } from "./workflow";
import type { WorkflowRunInputs } from "./workflow-api";

/**
 * Shared contracts for project workflow defaults and sequential orchestrations.
 *
 * Orchestrations only reference workflows by id and never embed definitions:
 * a missing workflow is reported at run time, just like a missing project file.
 * This module must stay importable from the main process and the renderer.
 */

/** Same rule as the workflow store's file-name rule: lowercase snake_case. */
export const ORCHESTRATION_ID_PATTERN = /^[a-z][a-z0-9_]{0,119}$/;

/** Hard caps for one orchestration definition. */
export const ORCHESTRATION_LIMITS = {
  steps: 20,
} as const;

/** Virtual id of the official development-review workflow. */
export const OFFICIAL_WORKFLOW_ID = "wf_official_development_review";

/**
 * How one orchestration step treats the workflow's approval node.
 *
 * This is a plain enum, without the step default: stored orchestration run
 * records reuse it, and parsing a record must never invent an approval value
 * that was not persisted. Only OrchestrationStepSchema adds "inherit".
 */
export const OrchestrationApprovalSchema = z.enum(["inherit", "always", "auto"]);
export type OrchestrationApproval = z.infer<typeof OrchestrationApprovalSchema>;

/** One ordered step: an existing workflow plus its approval override. */
export const OrchestrationStepSchema = z
  .object({
    id: z.string().trim().min(1, "step id must not be empty").max(80, "step id must be at most 80 characters"),
    workflowId: z
      .string()
      .trim()
      .regex(WORKFLOW_ID_PATTERN, "workflow id must be lowercase snake_case, at most 120 characters"),
    approval: OrchestrationApprovalSchema.default("inherit"),
  })
  .strict();

export const OrchestrationDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z
      .string()
      .trim()
      .regex(ORCHESTRATION_ID_PATTERN, "orchestration id must be lowercase snake_case, at most 120 characters"),
    title: z
      .string()
      .trim()
      .min(1, "orchestration title must not be empty")
      .max(200, "orchestration title must be at most 200 characters"),
    description: z
      .string()
      .trim()
      .max(2000, "orchestration description must be at most 2000 characters")
      .default(""),
    steps: z
      .array(OrchestrationStepSchema)
      .min(1, "an orchestration requires at least one step")
      .max(ORCHESTRATION_LIMITS.steps, "at most " + ORCHESTRATION_LIMITS.steps + " steps are supported")
      .superRefine((steps, ctx) => {
        const seen = new Set<string>();
        steps.forEach((step, index) => {
          if (seen.has(step.id)) {
            ctx.addIssue({
              code: "custom",
              path: [index, "id"],
              message: "duplicate step id: " + step.id,
            });
          } else {
            seen.add(step.id);
          }
        });
      }),
  })
  .strict();

export type OrchestrationStep = z.infer<typeof OrchestrationStepSchema>;
export type OrchestrationDefinition = z.infer<typeof OrchestrationDefinitionSchema>;

/** Lifecycle of one persisted orchestration run. */
export const ORCHESTRATION_RUN_STATUSES = [
  "queued",
  "running",
  "waiting_approval",
  "failed",
  "completed",
  "cancelled",
  "interrupted",
] as const;
export type OrchestrationRunStatus = (typeof ORCHESTRATION_RUN_STATUSES)[number];

/** Lifecycle of one step inside an orchestration run. */
export const ORCHESTRATION_RUN_STEP_STATUSES = [
  "pending",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled",
  "skipped",
] as const;
export type OrchestrationRunStepStatus = (typeof ORCHESTRATION_RUN_STEP_STATUSES)[number];

/**
 * One step of a persisted sequential orchestration run.
 *
 * A step references an existing workflow and, once started, the durable
 * WorkflowRun under .specloom/workflows/runs that executed it. The orchestration
 * record never embeds the workflow definition or the child run.
 */
export interface OrchestrationRunStep {
  stepId: string;
  workflowId: string;
  approval: OrchestrationApproval;
  /** The child WorkflowRun this step started. */
  runId?: string;
  status: OrchestrationRunStepStatus;
  /** Set when the orchestrator approved this step without a person. */
  autoApproved?: boolean;
  error?: string;
  /** Bounded handoff context captured from the completed child run. */
  summary?: string;
  decisionPath?: string;
}

/**
 * A durable orchestration run record.
 *
 * Field names follow the design record contract. The record is stored under
 * .specloom/workflows/orchestration-runs/<orchestrationRunId>.json and is
 * validated again when read.
 */
export interface OrchestrationRun {
  schemaVersion: 1;
  orchestrationRunId: string;
  orchestrationId: string;
  title: string;
  inputs: WorkflowRunInputs;
  steps: OrchestrationRunStep[];
  currentStepIndex: number;
  status: OrchestrationRunStatus;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

/** Project-level default workflow settings stored under .specloom/editor. */
export const WorkflowSettingsSchema = z
  .object({
    schemaVersion: z.literal(1),
    defaultWorkflowId: z
      .string()
      .trim()
      .regex(WORKFLOW_ID_PATTERN, "default workflow id must be lowercase snake_case, at most 120 characters")
      .optional(),
  })
  .strict();

export type WorkflowSettings = z.infer<typeof WorkflowSettingsSchema>;

/** Where a resolved default workflow came from. */
export type WorkflowDefaultSource = "project" | "official" | "fallback";

/** Result of resolving the project default, including a readable warning. */
export interface WorkflowDefaultResolution {
  workflowId: string;
  source: WorkflowDefaultSource;
  warning?: string;
}
