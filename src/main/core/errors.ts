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
  if (!(error instanceof ProjectError)) {
    return { name: "ProjectError", code: "INTERNAL_ERROR", message: "An unexpected project error occurred." };
  }
  const result: SerializedProjectError = { name: "ProjectError", code: error.code, message: redactMessage(error.message) };
  if (error.details !== undefined) result.details = safeDetails(error.details) as Record<string, unknown>;
  return result;
}

export const serializeProjectError = serializeError;
