import { z } from "zod";

export const GodotPluginIdSchema = z.string().min(1).max(512).refine((value) => {
  const match = /^addons\/([^/\\]{1,240})\/plugin\.cfg$/u.exec(value);
  return !!match && match[1] !== "." && match[1] !== ".." && !/[. ]$/u.test(match[1]!)
    && !/^(?:\.git|\.godot|\.specloom)$/iu.test(match[1]!)
    && !/^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/iu.test(match[1]!);
}, "Expected a direct addons/<directory>/plugin.cfg identifier");
export type GodotPluginId = z.infer<typeof GodotPluginIdSchema>;

export const PluginIssueSchema = z.enum(["missing_config", "invalid_config"]);
export const GodotPluginEntrySchema = z.object({
  id: GodotPluginIdSchema,
  name: z.string().min(1).max(160),
  description: z.string().max(1_024).optional(),
  author: z.string().max(160).optional(),
  version: z.string().max(80).optional(),
  enabled: z.boolean(),
  metadataValid: z.boolean(),
  issue: PluginIssueSchema.optional(),
}).strict();
export type GodotPluginEntry = z.infer<typeof GodotPluginEntrySchema>;

export const GodotMcpPluginEntrySchema = z.object({
  status: z.enum(["missing", "ready", "conflict"]),
  installedVersion: z.string().max(80).optional(),
  enabled: z.boolean(),
  connected: z.boolean(),
  issue: z.enum(["project_setting_conflict", "files_modified", "metadata_invalid", "bundle_unavailable"]).optional(),
}).strict();
export type GodotMcpPluginEntry = z.infer<typeof GodotMcpPluginEntrySchema>;

export const PluginInventorySchema = z.object({
  godotMcp: GodotMcpPluginEntrySchema,
  plugins: z.array(GodotPluginEntrySchema).max(512),
  scanLimitReached: z.boolean(),
}).strict();
export type PluginInventory = z.infer<typeof PluginInventorySchema>;

export const SetGodotPluginEnabledInputSchema = z.object({ id: GodotPluginIdSchema, enabled: z.boolean() }).strict();
export const RevealPluginDirectoryInputSchema = z.object({
  target: z.union([z.literal("project"), z.literal("godot-mcp"), GodotPluginIdSchema]),
}).strict();
export type RevealPluginDirectoryTarget = z.infer<typeof RevealPluginDirectoryInputSchema>["target"];
export const PluginMutationResultSchema = z.object({ restartRequired: z.boolean(), installedVersion: z.string().optional(), changedPaths: z.array(z.string()).optional() }).strict();
export type PluginMutationResult = z.infer<typeof PluginMutationResultSchema>;
