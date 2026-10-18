import { z } from "zod";

export const SkillInstallSourceSchema = z.enum(["directory", "archive"]);
export type SkillInstallSource = z.infer<typeof SkillInstallSourceSchema>;

export const ManagedSkillSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).max(80),
  name: z.string().min(1).max(160),
  purpose: z.string().min(1).max(2000),
  allowedSources: z.array(z.string().min(1)).max(128).optional(),
  version: z.string().min(1).max(128).optional(),
  enabled: z.boolean(),
  installedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  source: SkillInstallSourceSchema,
}).strict();
export type ManagedSkill = z.infer<typeof ManagedSkillSchema>;

export const SkillImportOptionsSchema = z.object({ enabled: z.boolean().optional(), overwrite: z.boolean().optional() }).strict();
export type SkillImportOptions = z.infer<typeof SkillImportOptionsSchema>;
