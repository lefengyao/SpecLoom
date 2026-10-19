import { z } from "zod";

export const SCHEMA_VERSION = 1 as const;

export const VersionTokenSchema = z.union([
  z.literal("absent"),
  z.string().regex(/^sha256:[a-f0-9]{64}$/),
]);
export type VersionToken = z.infer<typeof VersionTokenSchema>;

export const FileVersionSchema = z.object({
  path: z.string().min(1),
  version: VersionTokenSchema,
  exists: z.boolean(),
  size: z.number().int().nonnegative(),
}).strict();
export type FileVersion = z.infer<typeof FileVersionSchema>;

export const FileReadResultSchema = z.object({
  path: z.string().min(1),
  version: VersionTokenSchema,
  content: z.string(),
}).strict();
export type FileReadResult = z.infer<typeof FileReadResultSchema>;

export const TextPatchSchema = z.object({
  search: z.string().min(1),
  replace: z.string(),
}).strict();
export type TextPatch = z.infer<typeof TextPatchSchema>;

export const ChangeEntrySchema = z.object({
  path: z.string().min(1),
  operation: z.enum(["create", "update", "delete"]),
  expectedVersion: VersionTokenSchema,
  nextContent: z.string().optional(),
  sourceTaskId: z.string().min(1),
  sourceTool: z.string().min(1),
}).strict().superRefine((entry, context) => {
  if (entry.operation !== "delete" && entry.nextContent === undefined) {
    context.addIssue({ code: "custom", message: "Create and update entries require nextContent", path: ["nextContent"] });
  }
  if (entry.operation === "delete" && entry.nextContent !== undefined) {
    context.addIssue({ code: "custom", message: "Delete entries cannot include nextContent", path: ["nextContent"] });
  }
  if (entry.operation === "create" && entry.expectedVersion !== "absent") {
    context.addIssue({ code: "custom", message: "Create entries require an absent expected version", path: ["expectedVersion"] });
  }
});
export type ChangeEntry = z.infer<typeof ChangeEntrySchema>;

export const ChangeSetStatusSchema = z.enum([
  "staged", "validated", "committing", "applied", "rejected", "conflicted", "failed", "recovery-conflict",
]);
export type ChangeSetStatus = z.infer<typeof ChangeSetStatusSchema>;

export const ChangeSetDataSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  entries: z.array(ChangeEntrySchema),
  dependencies: z.record(z.string(), VersionTokenSchema),
  digest: z.string().min(1),
  status: ChangeSetStatusSchema,
}).strict();
export type ChangeSetData = z.infer<typeof ChangeSetDataSchema>;

/** Hard cap for the optional task goal; it is a prompt, never a permission. */
export const MAX_TASK_GOAL_LENGTH = 8192;

export const TaskScopeSpecSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  /**
   * Optional implementation goal used only to start the default workflow.
   * It never participates in task path matching; old tasks simply omit it and
   * fall back to their title.
   */
  goal: z
    .string()
    .trim()
    .max(MAX_TASK_GOAL_LENGTH, "goal must be at most " + MAX_TASK_GOAL_LENGTH + " characters")
    .optional(),
  readPaths: z.array(z.string().min(1)),
  writePaths: z.array(z.string().min(1)),
  allowDelete: z.boolean().default(false),
  mode: z.enum(["manual", "auto"]).default("manual"),
}).strict();
export type TaskScopeSpec = z.infer<typeof TaskScopeSpecSchema>;

export const SkillSourceSchema = z.object({
  path: z.string().min(1),
  version: VersionTokenSchema,
}).strict();
export type SkillSource = z.infer<typeof SkillSourceSchema>;

export const ValidationDiagnosticSchema = z.object({
  severity: z.enum(["error", "warning", "info"]),
  message: z.string(),
  code: z.string().optional(),
  path: z.string().optional(),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
}).strict();
export type ValidationDiagnostic = z.infer<typeof ValidationDiagnosticSchema>;

export const ValidationStatusSchema = z.enum(["pass", "fail", "skipped"]);
export type ValidationStatus = z.infer<typeof ValidationStatusSchema>;

export const ValidationCheckSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: ValidationStatusSchema,
  command: z.array(z.string()).optional(),
  exitCode: z.number().int().optional(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().nonnegative().optional(),
}).strict();
export type ValidationCheck = z.infer<typeof ValidationCheckSchema>;

export const ValidationResultSchema = z.object({
  taskId: z.string().optional(),
  status: ValidationStatusSchema,
  checks: z.array(ValidationCheckSchema),
  diagnostics: z.array(ValidationDiagnosticSchema),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
}).strict();
export type ValidationResult = z.infer<typeof ValidationResultSchema>;

export const ModelProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  provider: z.literal("openai-compatible"),
  model: z.string().min(1),
  baseUrl: z.url().refine((value) => {
    const url = new URL(value);
    const secretParameter = /(?:api[-_]?key|token|password|secret|authorization|credential|cookie|signature)|^(?:key|auth|sig)$/i;
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      && ![...url.searchParams.keys()].some((key) => secretParameter.test(key));
  }, "Model endpoints must use HTTP(S) without embedded credentials"),
  approved: z.boolean(),
  timeoutMs: z.number().int().positive(),
  /** Legacy profile setting retained for stored profiles; the runtime ignores it. */
  maxToolRounds: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
}).strict();
export type ModelProfile = z.infer<typeof ModelProfileSchema>;
/** Legacy field validation ceiling retained for stored settings. */
export const MAX_MODEL_TOOL_ROUNDS = 256;
/** Legacy default retained for consumers of older model configuration APIs. */
export const DEFAULT_MODEL_TOOL_ROUNDS = 64;
/** Maximum request duration accepted by the model client, in milliseconds. */
export const MAX_MODEL_TIMEOUT_MS = 900_000;

/** Protocols supported by the provider/model registry. */
export const ProtocolSchema = z.enum(["openai", "anthropic", "gemini"]);
export type Protocol = z.infer<typeof ProtocolSchema>;
/** Alias used by integrations that call this field a provider protocol. */
export const ProviderProtocolSchema = ProtocolSchema;
export type ProviderProtocol = Protocol;

export const ReasoningLevelSchema = z.enum(["off", "low", "medium", "high"]);
export type ReasoningLevel = z.infer<typeof ReasoningLevelSchema>;
/** Compatibility alias used by StoryFabric-aligned model helpers. */
export type ThinkingLevel = ReasoningLevel;
export const ReasoningPreferenceSchema = z.enum(["inherit", "off", "low", "medium", "high"]);
export type ReasoningPreference = z.infer<typeof ReasoningPreferenceSchema>;

export const ModelReferenceSchema = z.object({
  providerId: z.string().trim().min(1).max(256),
  model: z.string().trim().min(1).max(512),
}).strict();
export type ModelReference = z.infer<typeof ModelReferenceSchema>;
/** StoryFabric-compatible short name. */
export const ModelRefSchema = ModelReferenceSchema;
export type ModelRef = ModelReference;

const PositiveSafeIntegerSchema = z.number().int().safe().positive();

const DANGEROUS_MAPPING_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const RESERVED_MAPPING_ROOTS = new Set([
  "model", "messages", "tools", "tool_choice", "toolConfig", "contents", "system",
  "systemInstruction", "stream", "stream_options", "max_tokens", "max_completion_tokens",
  "maxOutputTokens", "safetySettings", "metadata", "service_tier", "store", "user", "seed",
  "response_format", "responseMimeType", "responseSchema", "responseModalities",
  "temperature",
]);

/** Canonical request-writing path; legacy stored mappings are checked when used. */
export function normalizeReasoningMapPath(path: string): string | undefined {
  const segments = path.split(".").map((segment) => segment.trim());
  if (segments.some((segment) => !segment || DANGEROUS_MAPPING_SEGMENTS.has(segment) || RESERVED_MAPPING_ROOTS.has(segment))) return undefined;
  return segments.join(".");
}

const ReasoningMapPathSchema = z.string().trim().min(1).superRefine((path, context) => {
  const segments = path.split(".");
  if (segments.some((segment) => !segment.trim())) {
    context.addIssue({ code: "custom", message: "Reasoning mapping paths cannot contain empty segments" });
    return;
  }
  if (segments.some((segment) => DANGEROUS_MAPPING_SEGMENTS.has(segment))) {
    context.addIssue({ code: "custom", message: "Reasoning mapping paths cannot use prototype fields" });
  }
  if (segments.some((segment) => RESERVED_MAPPING_ROOTS.has(segment.trim()))) {
    context.addIssue({ code: "custom", message: "Reasoning mapping paths cannot replace reserved request fields" });
  }
});

/** Custom per-level thinking parameter mapping, preserving user-entered strings. */
/** StoryFabric-aligned protocol constraints for custom reasoning mapping paths. */
export function isProtocolMappingPath(protocol: Protocol, path: string): boolean {
  const trimmed = normalizeReasoningMapPath(path);
  if (!trimmed) return false;
  if (protocol === "anthropic") return trimmed === "thinking";
  if (protocol === "gemini") return trimmed.startsWith("generationConfig.");
  return true;
}

export const ReasoningMapSchema = z.object({
  path: ReasoningMapPathSchema,
  values: z.partialRecord(ReasoningLevelSchema, z.string()),
}).strict().superRefine((mapping, context) => {
  if (!Object.values(mapping.values).some((value) => value.trim().length > 0)) {
    context.addIssue({ code: "custom", message: "Reasoning mappings require at least one non-empty value", path: ["values"] });
  }
});
export type ReasoningMap = z.infer<typeof ReasoningMapSchema>;

/** Optional user overrides for a single model. */
export const ModelSettingsSchema = z.object({
  reasoningSupport: z.boolean().optional(),
  vision: z.boolean().optional(),
  reasoning: ReasoningLevelSchema.optional(),
  reasoningMap: ReasoningMapSchema.nullable().optional(),
  contextTokens: PositiveSafeIntegerSchema.optional(),
  maxOutputTokens: PositiveSafeIntegerSchema.optional(),
  /** Legacy setting accepted for compatibility; the runtime ignores it. */
  maxToolRounds: z.number().int().positive().max(MAX_MODEL_TOOL_ROUNDS).optional(),
}).strict().superRefine((settings, context) => {
  if (settings.contextTokens !== undefined && settings.maxOutputTokens !== undefined && settings.maxOutputTokens > settings.contextTokens) {
    context.addIssue({ code: "custom", message: "maxOutputTokens cannot exceed contextTokens", path: ["maxOutputTokens"] });
  }
});
export type ModelSettings = z.infer<typeof ModelSettingsSchema>;

/** Complete cross-product JSON v1 model settings document. */
export const ModelSettingsJsonV1Schema = z.object({
  schemaVersion: z.literal(1),
  reasoningSupport: z.boolean(),
  vision: z.boolean(),
  reasoning: ReasoningLevelSchema,
  reasoningMap: ReasoningMapSchema.nullable(),
  contextTokens: PositiveSafeIntegerSchema,
  maxOutputTokens: PositiveSafeIntegerSchema,
  /** Legacy setting accepted for compatibility; newly encoded documents omit it. */
  maxToolRounds: z.number().int().positive().max(MAX_MODEL_TOOL_ROUNDS).optional(),
}).strict().superRefine((settings, context) => {
  if (settings.maxOutputTokens > settings.contextTokens) {
    context.addIssue({ code: "custom", message: "maxOutputTokens cannot exceed contextTokens", path: ["maxOutputTokens"] });
  }
});
export type ModelSettingsJsonV1 = z.infer<typeof ModelSettingsJsonV1Schema>;
export const ModelSettingsJsonSchema = ModelSettingsJsonV1Schema;
/** JSON editor boundary shared by renderer and main-process validators. */
export const MODEL_SETTINGS_JSON_MAX_CHARS = 64_000;

const EndpointSchema = z.string().url().refine((value) => {
  const url = new URL(value);
  const secretParameter = /(?:api[-_]?key|token|password|secret|authorization|credential|cookie|signature)|^(?:key|auth|sig)$/i;
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
    && ![...url.searchParams.keys()].some((key) => secretParameter.test(key));
}, "Provider endpoints must use HTTP(S) without embedded credentials");

const ModelIdListSchema = z.array(z.string().trim().min(1).max(512)).max(2048);
const ModelSettingsRecordSchema = z.record(z.string().trim().min(1).max(512), ModelSettingsSchema);

/** Public credential state; it never contains plaintext or ciphertext. */
export const KeyStorageSchema = z.enum(["encrypted", "plain", "none", "safeStorage", "plaintext"]);
export type KeyStorage = z.infer<typeof KeyStorageSchema>;
export const CredentialStatusSchema = z.object({
  hasKey: z.boolean(),
  keyPreview: z.string().max(64).optional(),
  keyStorage: KeyStorageSchema,
}).strict();
export type CredentialStatus = z.infer<typeof CredentialStatusSchema>;
export const PublicCredentialStatusSchema = CredentialStatusSchema;
export type PublicCredentialStatus = CredentialStatus;

/** Provider save input. An omitted or empty apiKey means reuse the existing key on edit. */
export const ProviderInputSchema = z.object({
  id: z.string().trim().min(1).max(256).optional(),
  name: z.string().trim().min(1).max(256),
  protocol: ProtocolSchema,
  baseUrl: EndpointSchema,
  apiKey: z.string().max(8192).optional(),
  models: ModelIdListSchema,
  modelSettings: ModelSettingsRecordSchema.optional(),
}).strict().superRefine((provider, context) => {
  // StoryFabric baseline: Anthropic maps through `thinking`, Gemini through `generationConfig.*`.
  for (const [model, settings] of Object.entries(provider.modelSettings ?? {})) {
    const map = settings.reasoningMap;
    if (map && !normalizeReasoningMapPath(map.path)) {
      context.addIssue({ code: "custom", message: `思考映射 path 不能覆盖保留或由模型设置控制的字段：${model}`, path: ["modelSettings", model, "reasoningMap", "path"] });
      continue;
    }
    if (map && !isProtocolMappingPath(provider.protocol, map.path)) {
      context.addIssue({
        code: "custom",
        message: provider.protocol === "anthropic"
          ? `Anthropic 映射 path 必须为「thinking」：${model}`
          : "Gemini 映射 path 必须以「generationConfig.」开头：" + model,
        path: ["modelSettings", model, "reasoningMap", "path"],
      });
    }
  }
});
export type ProviderInput = z.infer<typeof ProviderInputSchema>;
/** General provider configuration alias for callers that do not distinguish input/public shapes. */
export const ProviderSchema = ProviderInputSchema;
export type Provider = ProviderInput;
export const ProviderConfigSchema = ProviderInputSchema;
export type ProviderConfig = ProviderInput;

/** Public provider record returned to the renderer. */
export const ProviderPublicSchema = z.object({
  id: z.string().trim().min(1).max(256),
  name: z.string().trim().min(1).max(256),
  protocol: ProtocolSchema,
  baseUrl: EndpointSchema,
  models: ModelIdListSchema,
  modelSettings: ModelSettingsRecordSchema,
  hasKey: z.boolean(),
  authentication: z.enum(["custom-key", "trailblazer-session"]).optional(),
  keyPreview: z.string().max(64).optional(),
  keyStorage: KeyStorageSchema,
  /** Whether the stored credential can currently be used. */
  credentialStatus: z.enum(["configured", "needs-reconfiguration"]).optional(),
}).strict();
export type ProviderPublic = z.infer<typeof ProviderPublicSchema>;

/** Main-process persisted provider shape. The encrypted value is never sent to the renderer. */
export const ProviderStoredSchema = z.object({
  id: z.string().trim().min(1).max(256),
  name: z.string().trim().min(1).max(256),
  protocol: ProtocolSchema,
  baseUrl: EndpointSchema,
  apiKeyEncrypted: z.string().max(32768).optional(),
  models: ModelIdListSchema,
  modelSettings: ModelSettingsRecordSchema,
}).strict();
export type ProviderStored = z.infer<typeof ProviderStoredSchema>;
export const ProviderRecordSchema = ProviderStoredSchema;
export type ProviderRecord = ProviderStored;

export const SessionModelPreferenceSchema = ModelReferenceSchema.extend({ reasoning: ReasoningPreferenceSchema }).strict();
export type SessionModelPreference = z.infer<typeof SessionModelPreferenceSchema>;

const NonnegativeSafeIntegerSchema = z.number().int().safe().nonnegative();
export const UsageRecordSchema = z.object({
  at: NonnegativeSafeIntegerSchema,
  workspaceId: z.string().optional(),
  providerId: z.string().trim().min(1),
  providerName: z.string().trim().min(1),
  model: z.string().trim().min(1),
  promptTokens: NonnegativeSafeIntegerSchema,
  completionTokens: NonnegativeSafeIntegerSchema,
  cachedTokens: NonnegativeSafeIntegerSchema,
  cacheWriteTokens: NonnegativeSafeIntegerSchema,
  callId: z.string().optional(),
  runId: z.string().optional(),
  stageId: z.string().optional(),
  agentId: z.string().optional(),
  parentAgentId: z.string().optional(),
  purpose: z.enum(["basic", "stage", "child", "compression", "retry", "goal-plan", "goal-task", "goal-validation"]).optional(),
  attempt: NonnegativeSafeIntegerSchema.optional(),
  status: z.enum(["completed", "failed", "cancelled", "missing"]).optional(),
  usageSource: z.enum(["actual", "estimated", "missing"]).optional(),
}).strict();
export type UsageRecord = z.infer<typeof UsageRecordSchema>;
export const UsageSchema = UsageRecordSchema;

export const GodotConfigSchema = z.object({
  configVersion: z.number().int().positive().optional(),
  features: z.array(z.string()),
  mainScene: z.string().optional(),
}).strict();
export type GodotConfig = z.infer<typeof GodotConfigSchema>;

export const ProjectMetadataSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  path: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  godot: GodotConfigSchema,
  engine: z.enum(["godot", "generic"]).optional(),
}).strict();
export type ProjectMetadata = z.infer<typeof ProjectMetadataSchema>;
