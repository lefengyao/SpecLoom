import { z } from "zod";
import type { AgentToolCatalog } from "../agent-runtime";
import { ProjectError } from "../errors";
import type { ProviderTool, ParsedToolCall } from "../tool-catalog";
import { materialToolDefinitions } from "./material-tool-catalog";
import { OfflineDocumentReadOptionsSchema } from "../../../shared/offline-documents";
import { godotMcpToolDefinitions } from "../godot-mcp/tool-definitions";
import { workflowToolDefinitions } from "./workflow-tools";

export interface WorkTool { name: string; description: string; schema: z.ZodType; parameters?: Record<string, unknown>; initial?: boolean }
const p = z.string().min(1).max(2048);
const command = z.string().min(1).max(32768);
const empty = z.object({}).strict();
const coordinate = z.tuple([z.number().int(), z.number().int()]);
export const workspaceDefinitions: WorkTool[] = [
  ...materialToolDefinitions,
  // Workflow/orchestration tools load on demand: ToolSearch must discover them first.
  ...workflowToolDefinitions,
  { name: "Read", description: "读取项目文件（文本、图片、PDF、Notebook）并记录版本。修改已有文件前必须 Read。", initial: true, schema: z.object({ path: p, offset: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(10000).optional() }).strict() },
  { name: "Write", description: "新建或整文件覆盖；已有文件必须先 Read，外部修改时拒绝覆盖。", initial: true, schema: z.object({ path: p, content: z.string().max(1048576) }).strict() },
  { name: "Edit", description: "按 old_string → new_string 精确替换；先 Read；多次匹配需明确 replace_all。", initial: true, schema: z.object({ path: p, old_string: z.string().min(1).max(262144), new_string: z.string().max(262144), replace_all: z.boolean().optional() }).strict() },
  { name: "Glob", description: "使用文件路径模式寻找文件，例如 src/**/*.tsx。", initial: true, schema: z.object({ pattern: p }).strict() },
  { name: "Grep", description: "按正则搜索文件内容，返回文件路径、行号和匹配行；可指定 glob。", initial: true, schema: z.object({ pattern: z.string().min(1).max(2000), glob: p.optional(), ignore_case: z.boolean().optional(), limit: z.number().int().min(1).max(500).optional() }).strict() },
  { name: "Bash", description: "在项目目录运行宿主 shell 命令（git/npm/pytest/docker）。Windows 默认 PowerShell，可选 Bash。支持取消、输出流和超时。", initial: true, schema: z.object({ command, shell: z.enum(["bash", "powershell", "cmd"]).optional(), timeoutMs: z.number().int().min(1).max(600000).optional() }).strict() },
  { name: "Monitor", description: "管理本会话拥有的后台作业：start 启动（相同命令仍运行时复用）；poll 默认读取增量，cursor 可回读，waitMs 最长 30 秒；连续 3 次无变化时用 waitMs=30000 等待，正常静默运行不代表失败，同一运行作业持续至少 120 秒无进展后应处理或说明阻塞。list 返回所有权和可用操作。cancel 仅停止指定作业的进程树；restart 必须提供本会话 id 和完全相同的原 command/shell，经正常命令审批后等待旧作业结束再启动。外部已有实例不能按名称或端口批量结束，应告知用户。", schema: z.object({ operation: z.enum(["start", "poll", "cancel", "restart", "list"]), command: command.optional(), shell: z.enum(["bash", "powershell", "cmd"]).optional(), id: z.string().min(1).max(256).optional(), cursor: z.number().int().min(0).optional(), waitMs: z.number().int().min(0).max(30000).optional() }).strict().superRefine((input, context) => {
    if (["start", "restart"].includes(input.operation) && !input.command) context.addIssue({ code: "custom", path: ["command"], message: "start/restart requires the command" });
    if (["poll", "cancel", "restart"].includes(input.operation) && !input.id) context.addIssue({ code: "custom", path: ["id"], message: "The operation requires a session-owned job id" });
  }) },
  { name: "Agent", description: "在独立模型上下文中派生子智能体探索或执行任务；返回结果，子工具调用可见；继承项目提示词。", schema: z.object({ prompt: z.string().min(1).max(65536), title: z.string().min(1).max(200).optional() }).strict() },
  { name: "Task", description: "Agent 的别名：使用独立上下文执行委派任务。", schema: z.object({ prompt: z.string().min(1).max(65536), title: z.string().min(1).max(200).optional() }).strict() },
  { name: "TaskCreate", description: "创建当前会话的持久待办事项。", schema: z.object({ title: z.string().min(1).max(200), description: z.string().max(4000).optional() }).strict() },
  { name: "TaskUpdate", description: "更新待办状态或描述。", schema: z.object({ id: z.string().min(1).max(256), status: z.enum(["pending", "in_progress", "completed", "cancelled"]).optional(), title: z.string().min(1).max(200).optional(), description: z.string().max(4000).optional() }).strict() },
  { name: "TaskList", description: "列出当前会话的持久待办任务。", schema: empty },
  { name: "ToolSearch", description: "按名称或用途搜索更多工具（资料创建／修改／组件绑定／配图、Monitor、Agent、Task、memory、code_execution、computer use、Godot、MCP）并按需加载参数定义。空查询列出工具。", initial: true, schema: z.object({ query: z.string().max(2000) }).strict() },
  { name: "Skill", description: "执行可复用工作流：未指定 id 时列出项目 Skills，指定 id 时加载其真实指令与引用内容，随后遵照流程执行。", initial: true, schema: z.object({ id: z.string().max(256).optional(), sourcePaths: z.array(p).max(64).optional() }).strict() },
  { name: "OfflineDocsList", description: "列出已启用离线文档包、当前版本和文件索引。", schema: empty },
  { name: "OfflineDocsRead", description: "分页读取已启用离线文档中的一个文本文件，默认每页最多 6000 字符（limit 最大 8000，实际页长受输出预算限制）。page.hasMore=true 时，使用返回的 versionId 和 page.nextOffset 作为 offset 续读；偏移从 0 开始。二进制文件只返回元数据。", schema: z.object({ bundleId: z.string().uuid(), versionId: z.string().uuid().optional(), path: p, ...OfflineDocumentReadOptionsSchema.shape }).strict() },
  { name: "code_execution", description: "在本机运行 JavaScript 或 Python 代码并返回 stdout/stderr 与退出状态。远端项目可通过 MCP 服务器执行。", schema: z.object({ language: z.enum(["javascript", "python"]), code: z.string().min(1).max(262144), timeoutMs: z.number().int().min(1).max(600000).optional() }).strict() },
  { name: "memory", description: "读写当前会话记忆；operation=read/write/delete/list，跨重启保留。", schema: z.object({ operation: z.enum(["read", "write", "delete", "list"]), key: z.string().min(1).max(200).optional(), value: z.string().max(32768).optional() }).strict() },
  ...["screenshot", "mouse_move", "left_click", "right_click", "middle_click", "double_click", "triple_click", "left_click_drag", "scroll", "type", "key", "hold_key", "wait"].map(name => ({ name, description: `桌面操作 ${name}：坐标为屏幕像素，text 为真实文字或按键组合，等待/按住时长使用 durationMs。`, schema: z.object({ coordinate: coordinate.optional(), startCoordinate: coordinate.optional(), text: z.string().max(32768).optional(), direction: z.enum(["up", "down", "left", "right"]).optional(), amount: z.number().int().min(1).max(100).optional(), durationMs: z.number().int().min(1).max(30000).optional() }).strict() })),
];

export class WorkspaceCatalog implements AgentToolCatalog {
  private readonly tools = new Map<string, WorkTool>();
  private readonly loaded = new Set<string>();
  private readonly pinned = new Set<string>();
  constructor(definitions: WorkTool[] = workspaceDefinitions) { for (const tool of definitions) this.add(tool); }
  add(tool: WorkTool): void { this.tools.set(tool.name, tool); if (tool.initial) { this.loaded.add(tool.name); this.pinned.add(tool.name); } }
  remove(name: string): void { this.tools.delete(name); this.loaded.delete(name); this.pinned.delete(name); }
  addGodotMcpTools(): void {
    for (const tool of godotMcpToolDefinitions) this.add({ name: tool.name, description: tool.description, schema: tool.schema });
  }
  removePrefix(prefix: string): void { for (const name of this.tools.keys()) if (name.startsWith(prefix)) { this.tools.delete(name); this.loaded.delete(name); } }
  all(): WorkTool[] { return [...this.tools.values()]; }
  search(query: string): { name: string; description: string; parameters: Record<string, unknown> }[] {
    const tokens = query.toLowerCase().split(/[\s,，/|]+/).filter(Boolean);
    const exact = this.all().filter(t => tokens.includes(t.name.toLowerCase()));
    const found = (exact.length ? exact : this.all().filter(t => !tokens.length || tokens.some(q => `${t.name} ${t.description}`.toLowerCase().includes(q)))).slice(0, 32);
    for (const tool of found) { this.loaded.delete(tool.name); this.loaded.add(tool.name); }
    while (this.loaded.size > 96) { const oldest = [...this.loaded].find(name => !this.pinned.has(name)); if (!oldest) break; this.loaded.delete(oldest); }
    return found.map(t => ({ name: t.name, description: t.description, parameters: this.parameters(t) }));
  }
  private parameters(tool: WorkTool): Record<string, unknown> { return tool.parameters ?? z.toJSONSchema(tool.schema, { target: "draft-7" }) as Record<string, unknown>; }
  providerTools(): ProviderTool[] { return this.all().filter(t => this.loaded.has(t.name)).map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: this.parameters(t) } })); }
  parseCall(name: string, json: string): ParsedToolCall {
    const tool = this.tools.get(name);
    if (!tool || json.length > 1048576) throw new ProjectError("MODEL_ERROR", "未知工具或参数过大");
    let input: unknown; try { input = JSON.parse(json); } catch { throw new ProjectError("MODEL_ERROR", "工具参数必须是 JSON 对象"); }
    const result = tool.schema.safeParse(input);
    if (!result.success) throw new ProjectError("VALIDATION_FAILED", `工具 ${name} 参数不符合定义`);
    return { name, input: result.data as Record<string, unknown> };
  }
}
