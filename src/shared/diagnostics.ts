import { z } from "zod";

export const DiagnosticEventTypeSchema = z.enum([
  "request_started", "connection_error", "response_headers", "first_stream_data",
  "stream_read_error", "protocol_parse_error", "retry_scheduled", "request_completed", "request_failed",
]);
export const DiagnosticProtocolSchema = z.enum(["openai", "anthropic", "gemini"]);
export const DiagnosticSeveritySchema = z.enum(["info", "warning", "error"]);
export const DiagnosticErrorCategorySchema = z.enum([
  "connection_error", "http_error", "idle_timeout", "response_stream_error",
  "response_parse_error", "response_consumer_error", "cancelled", "unknown",
]);

const shortId = z.string().min(1).max(128).regex(/^[a-zA-Z0-9._:/@+-]+$/);
const boundedCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Explicit metadata allowlist. Never add model content, arbitrary messages, or request objects here. */
export const DiagnosticEventInputSchema = z.object({
  type: DiagnosticEventTypeSchema,
  diagnosticId: z.string().uuid(),
  severity: DiagnosticSeveritySchema.optional(),
  sessionId: shortId.optional(),
  runId: shortId.optional(),
  providerId: shortId.optional(),
  modelId: shortId.optional(),
  protocol: DiagnosticProtocolSchema.optional(),
  attempt: z.number().int().positive().max(1000).optional(),
  round: z.number().int().nonnegative().max(1000).optional(),
  status: z.number().int().min(100).max(599).optional(),
  mediaType: z.enum(["application/json", "text/event-stream", "other", "unknown"]).optional(),
  elapsedMs: boundedCount.optional(),
  receivedBytes: boundedCount.optional(),
  receivedFrames: boundedCount.optional(),
  completionReceived: z.boolean().optional(),
  errorCategory: DiagnosticErrorCategorySchema.optional(),
  causeCode: z.string().min(1).max(64).regex(/^[A-Z0-9_:-]+$/).optional(),
  retryLimitReached: z.boolean().optional(),
}).strict();
export type DiagnosticEventInput = z.infer<typeof DiagnosticEventInputSchema>;
export type DiagnosticEventWithoutId = Omit<DiagnosticEventInput, "diagnosticId">;

/** In-memory bridge used by one AgentRuntime model call across transport retries. */
export interface DiagnosticTrace {
  readonly diagnosticId: string;
  nextAttempt(): number;
  currentAttempt(): number;
  record(event: DiagnosticEventWithoutId): Promise<void> | void;
}

export const DiagnosticEventSchema = DiagnosticEventInputSchema.extend({
  severity: DiagnosticSeveritySchema,
  schemaVersion: z.literal(1),
  eventId: z.string().uuid(),
  at: z.string().datetime({ offset: true }),
}).strict();
export type DiagnosticEvent = z.infer<typeof DiagnosticEventSchema>;

export const DiagnosticQuerySchema = z.object({
  diagnosticId: z.string().uuid().optional(),
  text: z.string().max(200).optional(),
  limit: z.number().int().positive().max(500).default(200),
}).strict();
export type DiagnosticQuery = z.input<typeof DiagnosticQuerySchema>;

export const DiagnosticListResultSchema = z.object({
  events: z.array(DiagnosticEventSchema).max(500),
  readIssues: z.number().int().nonnegative(),
}).strict();
export type DiagnosticListResult = z.infer<typeof DiagnosticListResultSchema>;

export const DiagnosticSummarySchema = z.object({
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  events: z.number().int().nonnegative(),
  retentionDays: z.number().int().positive(),
  maxBytes: z.number().int().positive(),
  maxFileBytes: z.number().int().positive(),
  readIssues: z.number().int().nonnegative(),
  cleanupError: z.string().max(200).optional(),
}).strict();
export type DiagnosticSummary = z.infer<typeof DiagnosticSummarySchema>;
