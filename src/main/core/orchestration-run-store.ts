import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  ORCHESTRATION_ID_PATTERN,
  ORCHESTRATION_LIMITS,
  ORCHESTRATION_RUN_STATUSES,
  ORCHESTRATION_RUN_STEP_STATUSES,
  OrchestrationApprovalSchema,
  type OrchestrationRun,
} from "../../shared/orchestration";
import { WORKFLOW_ID_PATTERN } from "../../shared/workflow";
import { WorkflowRunInputsSchema } from "../../shared/workflow-api";
import { ProjectError } from "./errors";

/** Fixed project-relative directory that owns every orchestration run record. */
export const ORCHESTRATION_RUNS_DIRECTORY = ".specloom/workflows/orchestration-runs";

/** Hard cap for an orchestration run id, including its file name. */
export const MAX_ORCHESTRATION_RUN_ID_LENGTH = 128;
/** Hard cap for one persisted orchestration run record. */
export const MAX_ORCHESTRATION_RUN_BYTES = 4 * 1024 * 1024;
/** Hard cap for a persisted error message. */
export const MAX_RUN_ERROR_LENGTH = 2000;
/** Hard cap for the previous-step handoff summary, matching the run context cap. */
export const MAX_STEP_SUMMARY_LENGTH = 32768;
/** Hard cap for a decision document path recorded on a step. */
export const MAX_STEP_DECISION_PATH_LENGTH = 4096;

/**
 * File-name rule for an orchestration run id. The same shape is used by
 * WorkflowRunner for child runs: no separators, no leading dot, no traversal.
 */
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** File-name rule for the child WorkflowRun id recorded on a step. */
const CHILD_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DECISION_PREFIX = "specs/decisions/";
const INTERRUPTED_MESSAGE = "Orchestration run was interrupted when the application restarted";

const OrchestrationRunStepRecordSchema = z
  .object({
    stepId: z.string().min(1, "step id must not be empty").max(80, "step id must be at most 80 characters"),
    workflowId: z.string().regex(WORKFLOW_ID_PATTERN, "workflow id must be lowercase snake_case, at most 120 characters"),
    approval: OrchestrationApprovalSchema,
    runId: z.string().regex(CHILD_RUN_ID_PATTERN, "run id must be a safe file name").optional(),
    status: z.enum(ORCHESTRATION_RUN_STEP_STATUSES),
    autoApproved: z.boolean().optional(),
    error: z.string().max(MAX_RUN_ERROR_LENGTH).optional(),
    summary: z.string().max(MAX_STEP_SUMMARY_LENGTH).optional(),
    decisionPath: z
      .string()
      .min(1)
      .max(MAX_STEP_DECISION_PATH_LENGTH)
      .refine(
        (value) => value.startsWith(DECISION_PREFIX) && !value.split("/").includes(".."),
        "decision path must stay under " + DECISION_PREFIX,
      )
      .optional(),
  })
  .strict();

const OrchestrationRunRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    orchestrationRunId: z
      .string()
      .max(MAX_ORCHESTRATION_RUN_ID_LENGTH)
      .regex(RUN_ID_PATTERN, "orchestration run id must be a safe file name"),
    orchestrationId: z
      .string()
      .regex(ORCHESTRATION_ID_PATTERN, "orchestration id must be lowercase snake_case, at most 120 characters"),
    title: z.string().trim().min(1, "title must not be empty").max(200, "title must be at most 200 characters"),
    inputs: WorkflowRunInputsSchema,
    steps: z
      .array(OrchestrationRunStepRecordSchema)
      .min(1, "an orchestration run requires at least one step")
      .max(ORCHESTRATION_LIMITS.steps, "at most " + ORCHESTRATION_LIMITS.steps + " steps are supported"),
    currentStepIndex: z.number().int().min(0).max(ORCHESTRATION_LIMITS.steps),
    status: z.enum(ORCHESTRATION_RUN_STATUSES),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime().optional(),
    error: z.string().max(MAX_RUN_ERROR_LENGTH).optional(),
  })
  .strict()
  .superRefine((run, ctx) => {
    if (run.currentStepIndex > run.steps.length) {
      ctx.addIssue({
        code: "custom",
        path: ["currentStepIndex"],
        message: "currentStepIndex must point at a step or at the end of the run",
      });
    }
  });

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
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

/** Redact and bound an error string. */
function boundError(value: string): string {
  const redacted = redactErrorMessage(value);
  return redacted.length > MAX_RUN_ERROR_LENGTH ? redacted.slice(0, MAX_RUN_ERROR_LENGTH) : redacted;
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const at = issue.path.length > 0 ? issue.path.map((part) => String(part)).join(".") : "(root)";
    return at + ": " + issue.message;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Bound the strings that can legitimately grow without bound (error messages
 * and step summaries) before validating. Structural malformed values are left
 * untouched so the schema rejects them with a precise path.
 */
function boundedCandidate(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const candidate: Record<string, unknown> = { ...value };
  if (typeof candidate.error === "string") candidate.error = boundError(candidate.error);
  if (Array.isArray(candidate.steps)) {
    candidate.steps = candidate.steps.map((step) => {
      if (!isRecord(step)) return step;
      const bounded: Record<string, unknown> = { ...step };
      if (typeof bounded.error === "string") bounded.error = boundError(bounded.error);
      if (typeof bounded.summary === "string" && bounded.summary.length > MAX_STEP_SUMMARY_LENGTH) {
        bounded.summary = bounded.summary.slice(0, MAX_STEP_SUMMARY_LENGTH);
      }
      return bounded;
    });
  }
  return candidate;
}

function validationError(relative: string, issues: string[]): ProjectError {
  return new ProjectError(
    "VALIDATION_FAILED",
    boundError("Invalid orchestration run at " + relative + ": " + issues.join("; ")),
    { path: relative, issues },
  );
}

function recordError(relative: string, id: string, detail: string): ProjectError {
  return new ProjectError("INTERNAL_ERROR", boundError("Orchestration run record " + id + " " + detail), {
    path: relative,
  });
}

/**
 * Durable store for sequential orchestration runs.
 *
 * Records live at the fixed project relative path
 * .specloom/workflows/orchestration-runs/<orchestrationRunId>.json. The store
 * owns the id/path rule, schema validation, bounded errors, and atomic writes
 * (temp + rename); it never touches Electron or a child WorkflowRun. Loading a
 * queued/running record normalizes it to interrupted with an error because no
 * orchestration survives a process restart; waiting_approval and terminal
 * records are preserved exactly.
 */
export class OrchestrationRunStore {
  private readonly root: string;
  private readonly directory: string;
  /**
   * Serializes writes per record path. Atomic rename is not a filesystem CAS:
   * two concurrent rename() calls on Windows can fail with EPERM when they
   * target the same file, so only one write per id may be in flight.
   */
  private readonly writeChains = new Map<string, Promise<void>>();

  constructor(root: string) {
    this.root = path.resolve(root);
    this.directory = path.join(this.root, ...ORCHESTRATION_RUNS_DIRECTORY.split("/"));
  }

  /** Validate and atomically replace one run record. Returns the bounded record. */
  async save(run: OrchestrationRun): Promise<OrchestrationRun> {
    const id = isRecord(run) && typeof run.orchestrationRunId === "string" ? run.orchestrationRunId : "";
    const { relative, absolute } = this.paths(id);

    const result = OrchestrationRunRecordSchema.safeParse(boundedCandidate(run));
    if (!result.success) throw validationError(relative, formatIssues(result.error));

    const record = result.data as OrchestrationRun;
    if (record.orchestrationRunId !== id) {
      throw validationError(relative, ["orchestrationRunId must match the record file name"]);
    }
    await this.writeRecord(record, relative, absolute);
    return record;
  }

  /**
   * Read one record by id. A queued/running record is normalized to interrupted
   * and the normalized state is persisted, so a later load cannot report a run
   * that no process is executing. A missing record is FILE_NOT_FOUND.
   */
  async get(id: string): Promise<OrchestrationRun> {
    const { relative, absolute } = this.paths(id);
    const record = await this.readRecord(id, relative, absolute);
    if (this.hydrate(record)) await this.writeRecord(record, relative, absolute);
    return record;
  }

  /**
   * Every readable record, newest first by start time (id descending as a
   * tie-break). A corrupt or misnamed file is skipped so one bad record cannot
   * hide the rest of the run history; use get(id) to surface its error.
   */
  async list(): Promise<OrchestrationRun[]> {
    let entries;
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw new ProjectError(
        "INTERNAL_ERROR",
        boundError("Unable to list orchestration run records"),
        { path: ORCHESTRATION_RUNS_DIRECTORY },
        { cause: error },
      );
    }

    const records: OrchestrationRun[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const id = entry.name.slice(0, -".json".length);
      if (id.length > MAX_ORCHESTRATION_RUN_ID_LENGTH || !RUN_ID_PATTERN.test(id)) continue;
      try {
        const { relative, absolute } = this.paths(id);
        const record = await this.readRecord(id, relative, absolute);
        this.hydrate(record);
        records.push(record);
      } catch {
        // A record that cannot be read is skipped rather than hiding every other record.
      }
    }
    records.sort(
      (left, right) =>
        right.startedAt.localeCompare(left.startedAt) ||
        right.orchestrationRunId.localeCompare(left.orchestrationRunId),
    );
    return records;
  }

  /** Resolve the only writable path for an id, rejecting traversal and extensions. */
  private paths(id: string): { relative: string; absolute: string } {
    const relative = ORCHESTRATION_RUNS_DIRECTORY + "/" + id + ".json";
    if (typeof id !== "string" || id.length > MAX_ORCHESTRATION_RUN_ID_LENGTH || !RUN_ID_PATTERN.test(id)) {
      throw new ProjectError(
        "VALIDATION_FAILED",
        "Invalid orchestration run id: " + JSON.stringify(String(id)),
        { path: relative },
      );
    }
    const absolute = path.join(this.directory, id + ".json");
    if (path.dirname(absolute) !== this.directory) {
      throw new ProjectError("PATH_ESCAPE", "Orchestration run path escaped its directory", { path: relative });
    }
    return { relative, absolute };
  }

  private async readRecord(id: string, relative: string, absolute: string): Promise<OrchestrationRun> {
    let source: string;
    try {
      source = await readFile(absolute, "utf8");
    } catch (error) {
      if (isMissing(error)) {
        throw new ProjectError("FILE_NOT_FOUND", "Unknown orchestration run: " + id, { path: relative });
      }
      throw new ProjectError(
        "INTERNAL_ERROR",
        boundError("Unable to read orchestration run record " + id),
        { path: relative },
        { cause: error },
      );
    }

    if (Buffer.byteLength(source, "utf8") > MAX_ORCHESTRATION_RUN_BYTES) {
      throw recordError(relative, id, "exceeds the maximum record size");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(source) as unknown;
    } catch {
      // Never echo the record body or the raw parser message: both can contain credentials.
      throw recordError(relative, id, "is not valid JSON");
    }

    const result = OrchestrationRunRecordSchema.safeParse(parsed);
    if (!result.success) {
      const issue = result.error.issues[0];
      const location = issue && issue.path.length > 0 ? issue.path.map(String).join(".") : "record";
      throw recordError(relative, id, "is invalid at " + location + ": " + (issue?.message ?? "unknown schema error"));
    }

    const record = result.data as OrchestrationRun;
    if (record.orchestrationRunId !== id) {
      throw recordError(relative, id, "declares a different orchestrationRunId");
    }
    return record;
  }

  /**
   * A queued/running record can only be stale after a process restart: no
   * orchestration survives it. Preserve waiting_approval and terminal runs.
   */
  private hydrate(record: OrchestrationRun): boolean {
    if (record.status !== "queued" && record.status !== "running") return false;
    record.status = "interrupted";
    record.finishedAt = new Date().toISOString();
    record.error = INTERRUPTED_MESSAGE;
    for (const step of record.steps) {
      if (step.status === "running" || step.status === "waiting_approval") {
        step.status = "failed";
        step.error = INTERRUPTED_MESSAGE;
      }
    }
    return true;
  }

  /** Serialize, then append the write to this record's chain and return its completion. */
  private writeRecord(record: OrchestrationRun, relative: string, absolute: string): Promise<void> {
    const content = JSON.stringify(record, null, 2) + "\n";
    if (Buffer.byteLength(content, "utf8") > MAX_ORCHESTRATION_RUN_BYTES) {
      return Promise.reject(
        new ProjectError("VALIDATION_FAILED", "Orchestration run record exceeds the maximum record size", {
          path: relative,
        }),
      );
    }

    const id = record.orchestrationRunId;
    const previous = this.writeChains.get(relative) ?? Promise.resolve();
    const write = previous.then(
      () => this.writeAtomic(absolute, relative, content, id),
      () => this.writeAtomic(absolute, relative, content, id),
    );
    // Store a settled value: the chain must never reject, and a failed write is
    // still reported to its own caller through the returned promise.
    const settled = write.then(
      () => undefined,
      () => undefined,
    );
    this.writeChains.set(relative, settled);
    void settled.then(() => {
      if (this.writeChains.get(relative) === settled) this.writeChains.delete(relative);
    });
    return write;
  }

  private async writeAtomic(
    absolute: string,
    relative: string,
    content: string,
    id: string,
  ): Promise<void> {
    const directory = path.dirname(absolute);
    const temporary = path.join(directory, "." + path.basename(absolute) + "." + randomUUID() + ".tmp");
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(temporary, content, "utf8");
      await rename(temporary, absolute);
    } catch (error) {
      try {
        await unlink(temporary);
      } catch {
        // The temporary file may not exist; the original failure is the one to report.
      }
      throw new ProjectError(
        "INTERNAL_ERROR",
        boundError("Unable to save orchestration run record " + id),
        { path: relative },
        { cause: error },
      );
    }
  }
}
