import path from "node:path";
import type { ApprovalMode, ToolApprovalInput } from "../../../shared/approvals";
import { ProjectError, serializeError } from "../errors";
import { godotMcpToolDefinitions } from "../godot-mcp/tool-definitions";

const godotMcpToolNames = godotMcpToolDefinitions.map(tool => tool.name);

const localTools = new Set([
  "Glob", "Grep", "ToolSearch", "Skill", "OfflineDocsList", "OfflineDocsRead", "Agent", "Task",
  "TaskCreate", "TaskUpdate", "TaskList", "memory", "MaterialsList", "MaterialRead", "MaterialCreate",
  "MaterialUpdate", "MaterialBindComponent", "MaterialUnbindComponent", "MaterialSetImage",
  "files_list_versions", "files_read", "files_write", "files_patch", "skills_list", "skills_load", "changes_preview",
]);
const readOnlyDesktop = new Set(["screenshot", "mouse_move", "wait", ...godotMcpToolNames]);
const desktopEffects = new Set(["left_click", "right_click", "middle_click", "double_click", "triple_click", "left_click_drag", "scroll", "type", "key", "hold_key"]);
const sensitivePath = /(?:^|[\\/])(?:\.env(?:\.[^\\/]*)?|\.ssh|\.aws|\.azure|\.gnupg|credentials(?:\.[^\\/]*)?|id_(?:rsa|ed25519)|[^\\/]*\.(?:pem|p12|pfx)|Login Data|Cookies)(?:[\\/]|$)/i;

export function approvalArguments(input: unknown, redactText?: (text: string) => string): string {
  const safe = serializeError(new ProjectError("APPROVAL_REQUIRED", "approval", { input })).details?.input;
  const scrub = (value: unknown): unknown => {
    if (typeof value === "string") return value.replace(/((?:--?|\/)[a-z_-]*(?:key|token|password|secret|authorization|credential|cookie)[a-z_-]*(?:\s+|=))(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, "$1[redacted]");
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item)]));
    return value;
  };
  let value = JSON.stringify(scrub(safe ?? input));
  if (redactText) value = redactText(value);
  return value.length <= 16384 ? value : `${value.slice(0, 16340)}\n[参数过长，显示已截断]`;
}

export function isOutsideProject(root: string, input: string): boolean {
  if (!path.isAbsolute(input)) return false;
  const relative = path.relative(root, input);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

export function toolApproval(mode: ApprovalMode, root: string, toolName: string, input: Record<string, unknown>, redactText?: (text: string) => string): ToolApprovalInput | undefined {
  if (mode === "full") return undefined;
  let reason: string | undefined;
  let risk: ToolApprovalInput["risk"] = "standard";
  if (["Read", "Write", "Edit", "files_read", "files_write", "files_patch"].includes(toolName)) {
    const target = String(input.path);
    if (sensitivePath.test(target)) { reason = "访问可能包含凭据或私密数据的文件"; risk = "high"; }
    else if (isOutsideProject(root, target)) {
      if (!["Read", "files_read"].includes(toolName)) { reason = "修改项目目录之外的文件"; risk = "high"; }
      else if (mode === "ask") reason = "读取项目目录之外的文件";
    }
  } else if (toolName === "skills_load" && Array.isArray(input.sourcePaths) && input.sourcePaths.some(item => sensitivePath.test(String(item)))) {
    reason = "Skill 源文件可能包含凭据或私密数据"; risk = "high";
  } else if (toolName === "web_search" || toolName === "web_extract") {
    if (mode === "ask") reason = "向联网服务发送搜索词或公开网页地址";
  } else if (toolName === "Monitor" && !["start", "restart"].includes(String(input.operation))) return undefined;
  else if (["Bash", "bash_exec", "Monitor"].includes(toolName)) {
    reason = "宿主命令可以访问网络、外部文件或执行其他程序，效果需要确认"; risk = "high";
  } else if (toolName === "code_execution") { reason = "宿主代码可以访问网络、外部文件或执行其他程序"; risk = "high"; }
  else if (desktopEffects.has(toolName)) { reason = "桌面输入可能修改外部软件或提交操作"; risk = "high"; }
  else if (readOnlyDesktop.has(toolName)) { if (mode === "ask") reason = "访问桌面或外部应用状态"; }
  else if (!localTools.has(toolName)) { reason = "工具的外部效果无法可靠判断"; risk = "high"; }
  return reason ? { toolName, arguments: approvalArguments(input, redactText), reason, risk } : undefined;
}

export function mcpConnectionApproval(name: string, server: { command?: string | undefined; args?: string[] | undefined; url?: string | undefined }): ToolApprovalInput {
  let url: string | undefined;
  if (server.url) {
    try { const parsed = new URL(server.url); parsed.username = ""; parsed.password = ""; parsed.search = ""; parsed.hash = ""; url = parsed.toString(); }
    catch { url = "[无效服务器地址]"; }
  }
  let secretArgument = false;
  const args = (server.args ?? []).map(argument => {
    if (secretArgument) { secretArgument = false; return "[redacted]"; }
    secretArgument = /^--?(?:.*(?:key|token|password|secret|authorization|credential|cookie))$/i.test(argument);
    return argument;
  });
  return {
    toolName: "MCPConnect", arguments: approvalArguments({ name, ...(server.command ? { command: server.command, args } : {}), ...(url ? { url } : {}) }),
    reason: server.command ? "连接 MCP 需要启动外部程序，其效果无法可靠判断" : "连接 MCP 会访问网络并可能创建服务器会话",
    risk: "high",
  };
}
