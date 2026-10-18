import { z } from "zod";

export const HookEventSchema = z.enum(["session.before", "session.after", "tool.before", "tool.after"]);
export type HookEvent = z.infer<typeof HookEventSchema>;
export const HookDefinitionSchema = z.object({
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(200),
  event: HookEventSchema,
  command: z.string().min(1).max(8192),
  shell: z.string().max(256).optional(),
  timeoutMs: z.number().int().min(100).max(120_000),
  enabled: z.boolean(),
  updatedAt: z.string(),
  lastRun: z.object({ ok: z.boolean(), at: z.string(), message: z.string().max(2000) }).optional(),
}).strict();
export type HookDefinition = z.infer<typeof HookDefinitionSchema>;
export const HookDefinitionInputSchema = HookDefinitionSchema.omit({ id: true, updatedAt: true, lastRun: true }).extend({ id: z.string().max(256).optional() });
export type HookDefinitionInput = z.infer<typeof HookDefinitionInputSchema>;
export interface HookRunResult { ok: boolean; message: string; at: string; exitCode?: number; }

