import { z } from "zod";
import { SessionModelPreferenceSchema } from "./contracts";
import { ApprovalModeSchema, ApprovalRequestSchema } from "./approvals";
import { WebSearchModeSchema } from "./web-search";

export const chatId = z.string().min(1).max(256);
export const sessionFileLimit = 16_777_216;
export const ChatImageAttachmentSchema = z.object({
  name: z.string().min(1).max(256),
  mimeType: z.string().min(1).max(128),
  base64: z.string().min(1).max(8_388_608),
}).strict();
export type ChatImageAttachment = z.infer<typeof ChatImageAttachmentSchema>;
export const ChatGuidanceInputSchema = z.object({
  runId: chatId, guidanceId: z.string().min(1).max(128), prompt: z.string().min(1).max(131072),
  images: z.array(ChatImageAttachmentSchema).max(16).optional(),
}).strict();
const option = z.object({ id: chatId, label: z.string().min(1).max(200), description: z.string().max(1000).optional() }).strict();
export const QuestionFieldSchema = z.object({
  id: chatId, label: z.string().min(1).max(200), type: z.enum(["text", "single", "multi"]), required: z.boolean().default(false),
  options: z.array(option).max(20).optional(), defaultValue: z.union([z.string().max(8192), z.array(chatId).max(20)]).optional(),
}).strict();
export const QuestionInputSchema = z.object({ title: z.string().min(1).max(200), description: z.string().max(4000).optional(), fields: z.array(QuestionFieldSchema).min(1).max(12) }).strict().superRefine((q, ctx) => {
  if (new Set(q.fields.map((f) => f.id)).size !== q.fields.length) ctx.addIssue({ code: "custom", message: "Duplicate question field IDs" });
  for (const f of q.fields) if (f.type !== "text" && (!f.options?.length || new Set(f.options.map((o) => o.id)).size !== f.options.length)) ctx.addIssue({ code: "custom", message: "Selection fields require unique options" });
});
export type QuestionInput = z.infer<typeof QuestionInputSchema>;
export const AnswerSchema = z.record(z.string().min(1).max(256), z.union([z.string().max(8192), z.array(chatId).max(20)]));
export type QuestionAnswer = z.infer<typeof AnswerSchema>;
export const QuestionSchema = QuestionInputSchema.extend({ id: chatId, runId: chatId, sessionId: chatId });
export type ChatQuestion = z.infer<typeof QuestionSchema>;

/** Durable timing and output statistics for one completed assistant reply. */
export const ResponseMetricsSchema = z.object({
  /** Milliseconds from run start until the first streamed model content. */
  firstTokenMs: z.number().finite().nonnegative(),
  /** Milliseconds spent receiving provider thinking content. */
  thinkingMs: z.number().finite().nonnegative(),
  /** Completion token count, using provider usage when available and a local estimate otherwise. */
  outputTokens: z.number().finite().nonnegative(),
  /** Output tokens per second over the streamed output interval. */
  outputRate: z.number().finite().nonnegative(),
  /** Milliseconds from run start until completion. */
  durationMs: z.number().finite().nonnegative(),
}).strict();
export type ResponseMetrics = z.infer<typeof ResponseMetricsSchema>;

/** Actual content changes observed during one run; workspace observations do not imply authorship. */
export const RunFileChangeSchema = z.object({
  path: z.string().min(1).max(4096),
  operation: z.enum(["create", "modify", "delete"]),
  source: z.enum(["tool", "workspace"]),
}).strict();
export type RunFileChange = z.infer<typeof RunFileChangeSchema>;
export const RunFileChangesSchema = z.object({
  runId: chatId,
  files: z.array(RunFileChangeSchema).max(256),
  complete: z.boolean(),
  notes: z.array(z.string().max(1000)).max(32),
}).strict();
export type RunFileChanges = z.infer<typeof RunFileChangesSchema>;

export function validateAnswer(question: QuestionInput, answer: QuestionAnswer): void {
  AnswerSchema.parse(answer);
  if (Object.keys(answer).some((id) => !question.fields.some((f) => f.id === id))) throw new Error("回答包含未知字段");
  for (const field of question.fields) {
    const value = answer[field.id];
    if (field.required && (value === undefined || value === "" || (typeof value === "string" && !value.trim()) || (Array.isArray(value) && !value.length))) throw new Error(`请填写${field.label}`);
    if (value === undefined) continue;
    if (field.type === "multi") {
      if (!Array.isArray(value) || new Set(value).size !== value.length || value.some((id) => !field.options?.some((o) => o.id === id))) throw new Error(`${field.label}的选项无效`);
    } else if (typeof value !== "string" || (field.type === "single" && value !== "" && !field.options?.some((o) => o.id === value))) throw new Error(`${field.label}的回答无效`);
  }
}

export const ChatItemSchema = z.discriminatedUnion("kind", [
  z.object({ id: chatId, kind: z.literal("thinking"), content: z.string().max(131072), partial: z.boolean().optional() }).strict(),
  z.object({ id: chatId, kind: z.literal("activity"), content: z.string().max(16384) }).strict(),
  z.object({ id: chatId, kind: z.literal("message"), role: z.enum(["user", "assistant"]), content: z.string().max(131072), partial: z.boolean().optional(), metrics: ResponseMetricsSchema.optional(), fileChanges: RunFileChangesSchema.optional(), guidance: z.object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional() }).strict(),
  z.object({ id: chatId, kind: z.literal("tool"), callId: chatId, name: z.string().max(128), arguments: z.string().max(16384), output: z.string().max(16384), status: z.enum(["receiving", "running", "waiting", "ok", "error", "cancelled"]) }).strict(),
  z.object({ id: chatId, kind: z.literal("question"), question: QuestionSchema, answer: AnswerSchema.optional(), status: z.enum(["waiting", "answered", "interrupted", "cancelled"]) }).strict(),
  z.object({ id: chatId, kind: z.literal("approval"), request: ApprovalRequestSchema, status: z.enum(["waiting", "approved", "denied", "interrupted", "cancelled"]) }).strict(),
]);
export type ChatItem = z.infer<typeof ChatItemSchema>;
export const CapabilitiesSchema = z.object({
  tools: z.array(z.object({ name: z.string().max(128), description: z.string().max(2000) }).strict()).max(512),
  skills: z.array(z.object({ id: z.string().max(256), name: z.string().max(256), purpose: z.string().max(2000) }).strict()).max(256),
  mcp: z.array(z.object({ name: z.string().max(256), status: z.enum(["connected", "error", "disabled"]), tools: z.array(z.string().max(128)).max(512), error: z.string().max(2000).optional() }).strict()).max(64),
  plugins: z.array(z.object({ name: z.string().max(256), description: z.string().max(2000) }).strict()).max(64),
}).strict();
export type SessionCapabilities = z.infer<typeof CapabilitiesSchema>;
/** Accumulated token usage for the latest run, including live updates when available. */
export const SessionUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  source: z.enum(["actual", "estimated", "missing"]),
}).strict();
export type SessionUsage = z.infer<typeof SessionUsageSchema>;
/** One provider measurement paired with the local estimate for that same request. */
export const ContextCalibrationSchema = z.object({
  profileId: z.string().min(1).max(769),
  model: z.string().min(1).max(512),
  estimatedInputTokens: z.number().int().positive(),
  actualInputTokens: z.number().int().nonnegative(),
}).strict();
export type ContextCalibration = z.infer<typeof ContextCalibrationSchema>;
export const ChatSessionSchema = z.object({
  id: chatId, title: z.string().min(1).max(200), taskId: chatId.optional(), createdAt: z.string(), updatedAt: z.string(),
  archived: z.boolean(), draft: z.string().max(131072), draftRevision: z.number().int().nonnegative(), revision: z.number().int().nonnegative(),
  model: SessionModelPreferenceSchema.optional(), items: z.array(ChatItemSchema).max(4096),
  approvalMode: ApprovalModeSchema.optional(),
  webSearchMode: WebSearchModeSchema.optional(),
  capabilities: CapabilitiesSchema.optional(), capabilityError: z.string().max(2000).optional(), activity: z.string().max(2000).optional(),
  status: z.enum(["idle", "running", "waiting", "completed", "error", "cancelled", "interrupted"]),
  runId: chatId.optional(), seq: z.number().int().nonnegative(), error: z.string().max(4000).optional(), diagnosticId: z.string().uuid().optional(),
  usage: SessionUsageSchema.optional(),
  /** Usage from one model request, independent of the accumulated run usage. */
  lastRequestUsage: SessionUsageSchema.optional(),
  contextCalibration: ContextCalibrationSchema.optional(),
  /** Durable derived context used for future model requests; visible items remain authoritative. */
  contextSummary: z.string().max(131072).optional(),
  /** Current request-context estimate including system/tools, calibrated by provider usage when available. */
  contextTokensEstimate: z.number().int().nonnegative().optional(),
}).strict();
export type ChatSession = z.infer<typeof ChatSessionSchema>;
export const SessionPatchSchema = z.object({ title: z.string().min(1).max(200).optional(), archived: z.boolean().optional(), draft: z.string().max(131072).optional(), model: SessionModelPreferenceSchema.optional(), approvalMode: ApprovalModeSchema.optional(), webSearchMode: WebSearchModeSchema.optional() }).strict();
export type SessionPatch = z.infer<typeof SessionPatchSchema>;
export interface SessionEvent { projectPath: string; sessionId: string; runId?: string; seq: number; session: ChatSession }
export interface ChatSessionsApi {
  list(projectPath: string): Promise<ChatSession[]>;
  create(projectPath: string, title?: string, taskId?: string): Promise<ChatSession>;
  patch(projectPath: string, sessionId: string, patch: SessionPatch): Promise<ChatSession>;
  remove(projectPath: string, sessionId: string): Promise<void>;
  export(projectPath: string, sessionId: string): Promise<string>;
  import(projectPath: string, json: string): Promise<ChatSession>;
  send(projectPath: string, sessionId: string, prompt: string, draftRevision?: number, images?: ChatImageAttachment[]): Promise<ChatSession>;
  guide(projectPath: string, sessionId: string, runId: string, guidanceId: string, prompt: string, images?: ChatImageAttachment[]): Promise<ChatSession>;
  cancel(projectPath: string, sessionId: string): Promise<void>;
  answer(projectPath: string, sessionId: string, runId: string, questionId: string, answers: QuestionAnswer): Promise<ChatSession>;
  approve(projectPath: string, sessionId: string, runId: string, approvalId: string, approved: boolean): Promise<ChatSession>;
  subscribe(listener: (event: SessionEvent) => void): () => void;
  /** Metadata invalidation; streamed replies continue to arrive through subscribe. */
  subscribeChanges?: (listener: (projectPath: string) => void) => () => void;
}
