import { z } from "zod";

export const ProjectErrorCodeSchema = z.enum([
  "INVALID_PROJECT", "PATH_ESCAPE", "VERSION_CONFLICT", "TASK_SCOPE_DENIED",
  "READ_REQUIRED", "APPROVAL_REQUIRED", "COMMAND_FAILED", "BACKEND_UNAVAILABLE",
  "VALIDATION_FAILED", "MODEL_ERROR", "FILE_NOT_FOUND", "INVALID_PATCH", "INTERNAL_ERROR",
]);
export type ProjectErrorCode = z.infer<typeof ProjectErrorCodeSchema>;

export interface SerializedProjectError {
  name: "ProjectError";
  code: ProjectErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export class ProjectError extends Error {
  readonly code: ProjectErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ProjectErrorCode, message: string, details?: Record<string, unknown>, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProjectError";
    this.code = code;
    this.details = details;
  }
}

type ProjectErrorLike = {
  code: ProjectErrorCode;
  message: string;
  details?: unknown;
};

/**
 * IPC, bundled modules, and test doubles can produce an error-like object
 * whose prototype is not this module's ProjectError constructor. Preserve
 * its validated public code and message instead of hiding it as INTERNAL_ERROR.
 */
function projectErrorLike(value: unknown): ProjectErrorLike | undefined {
  if (value instanceof ProjectError) return value;
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { code?: unknown; message?: unknown; details?: unknown };
  try {
    const code = ProjectErrorCodeSchema.safeParse(candidate.code);
    if (!code.success || typeof candidate.message !== "string") return undefined;
    return { code: code.data, message: candidate.message, details: candidate.details };
  } catch {
    return undefined;
  }
}

const secretField = /(?:api[-_]?key|token|password|secret|authorization|credential|cookie)/i;

function redactMessage(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/(["']?(?:api[-_]?key|(?:access|refresh|auth)[-_]?token|token|password|(?:client[-_]?)?secret|authorization|credential|cookie)["']?\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}&]+)/gi, "$1[redacted]")
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, "https://[redacted]@");
}

function safeDetails(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") return redactMessage(value);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "object") return undefined;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => safeDetails(item, seen, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (secretField.test(key)) continue;
    const safe = safeDetails(item, seen, depth + 1);
    if (safe !== undefined) result[key] = safe;
  }
  return result;
}

export function serializeError(error: unknown): SerializedProjectError {
  const projectError = projectErrorLike(error);
  if (!projectError) {
    return { name: "ProjectError", code: "INTERNAL_ERROR", message: "An unexpected project error occurred." };
  }
  const result: SerializedProjectError = { name: "ProjectError", code: projectError.code, message: redactMessage(projectError.message) };
  if (projectError.details !== undefined) result.details = safeDetails(projectError.details) as Record<string, unknown>;
  return result;
}

export const serializeProjectError = serializeError;
