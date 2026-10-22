import { z } from "zod";

export const PLUGIN_API_VERSION = 1;

const relativePath = (value: string): boolean => {
  if (!value || value.length > 512 || value.includes("\\") || value.startsWith("/") || /^[a-zA-Z]:/.test(value)) return false;
  return value.split("/").every((segment) => segment && segment !== "." && segment !== ".." && !/[\u0000-\u001f]/u.test(segment));
};
const RelativePathSchema = z.string().min(1).max(512).refine(relativePath, "Expected a safe relative path");
const PluginIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u, "Expected a lowercase plugin id");

export const PluginPageSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,31}$/u),
  title: z.string().min(1).max(80),
  entry: RelativePathSchema,
  icon: z.string().max(40).optional(),
}).strict();
export type PluginPage = z.infer<typeof PluginPageSchema>;

export const PluginManifestSchema = z.object({
  id: PluginIdSchema,
  name: z.string().min(1).max(80),
  version: z.string().min(1).max(40),
  apiVersion: z.number().int().positive(),
  description: z.string().max(500).optional(),
  author: z.string().max(120).optional(),
  official: z.boolean().optional(),
  enabledByDefault: z.boolean().optional(),
  main: RelativePathSchema.optional(),
  contributes: z.object({ pages: z.array(PluginPageSchema).max(32).optional() }).strict().optional(),
  permissions: z.array(z.string().max(80)).max(64).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.apiVersion !== PLUGIN_API_VERSION) ctx.addIssue({ code: "custom", path: ["apiVersion"], message: "Unsupported plugin API version" });
  if (!value.main && !value.contributes?.pages?.length) ctx.addIssue({ code: "custom", path: ["main"], message: "A plugin must provide a main module or a page" });
  const pageIds = new Set<string>();
  for (const page of value.contributes?.pages ?? []) {
    if (pageIds.has(page.id)) ctx.addIssue({ code: "custom", path: ["contributes", "pages"], message: "Duplicate page id" });
    pageIds.add(page.id);
  }
});
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export const PluginPageSummarySchema = PluginPageSchema.extend({ pageId: z.string() }).strict();
export type PluginPageSummary = z.infer<typeof PluginPageSummarySchema>;

export const PluginSummarySchema = z.object({
  id: PluginIdSchema,
  name: z.string(),
  version: z.string(),
  description: z.string().optional(),
  author: z.string().optional(),
  official: z.boolean(),
  source: z.enum(["builtin", "user"]),
  enabled: z.boolean(),
  status: z.enum(["ready", "disabled", "error"]),
  error: z.string().optional(),
  pages: z.array(PluginPageSummarySchema),
}).strict();
export type PluginSummary = z.infer<typeof PluginSummarySchema>;

export const PluginInventorySchema = z.object({ plugins: z.array(PluginSummarySchema), trusted: z.literal(true) }).strict();
export type PluginInventory = z.infer<typeof PluginInventorySchema>;

export const PluginCommandRequestSchema = z.object({
  pluginId: PluginIdSchema,
  command: z.string().min(1).max(80),
  input: z.unknown().optional(),
}).strict();
export type PluginCommandRequest = z.infer<typeof PluginCommandRequestSchema>;

export function pluginPageId(pluginId: string, pageId: string): string {
  return `plugin:${pluginId}:${pageId}`;
}
export function parsePluginPageId(value: string): { pluginId: string; pageId: string } | undefined {
  const match = /^plugin:([a-z0-9][a-z0-9._-]{0,63}):([a-z0-9][a-z0-9._-]{0,31})$/u.exec(value);
  return match ? { pluginId: match[1]!, pageId: match[2]! } : undefined;
}
