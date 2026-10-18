import { z } from "zod";

export const McpServerConfigSchema = z.object({
  command: z.string().trim().min(1).max(4096).optional(),
  args: z.array(z.string().max(4096)).max(128).optional(),
  env: z.record(z.string().max(256), z.string().max(8192)).optional(),
  url: z.url().optional(),
  headers: z.record(z.string().max(256), z.string().max(8192)).optional(),
  enabled: z.boolean().optional(),
  type: z.enum(["stdio", "http", "streamable-http"]).optional(),
}).strict().superRefine((value, context) => {
  if ((value.command === undefined) === (value.url === undefined)) {
    context.addIssue({ code: "custom", message: "MCP 服务必须配置 command 或 url（二选一）" });
  }
  if (value.url) {
    const protocol = new URL(value.url).protocol;
    if (!["http:", "https:"].includes(protocol)) context.addIssue({ code: "custom", message: "MCP URL 只支持 HTTP(S)" });
  }
});
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const McpConfigSchema = z.object({
  mcpServers: z.record(z.string().trim().min(1).max(256), McpServerConfigSchema),
}).strict();
export type McpConfig = z.infer<typeof McpConfigSchema>;

export const McpConfigScopeSchema = z.enum(["global", "project"]);
export type McpConfigScope = z.infer<typeof McpConfigScopeSchema>;

export const ManagedMcpServerSchema = z.object({
  name: z.string().min(1).max(256),
  scope: McpConfigScopeSchema,
  config: McpServerConfigSchema,
}).strict();
export type ManagedMcpServer = z.infer<typeof ManagedMcpServerSchema>;
