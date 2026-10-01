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

export const TaskScopeSpecSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
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
  maxToolRounds: z.number().int().positive(),
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
}).strict();
export type ModelProfile = z.infer<typeof ModelProfileSchema>;

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
}).strict();
export type ProjectMetadata = z.infer<typeof ProjectMetadataSchema>;
