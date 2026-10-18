import type { ChatToolItem } from "./tool-chain";

function record(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const object = value as Record<string, unknown>;
    const result = object.ok === true ? object.result : object.ok === false ? object.error : undefined;
    return result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : object;
  }
  catch { return {}; }
}
function clip(value: unknown, length = 180): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

/** Only summarize known fields; full parameters/results stay in the detail sidebar. */
export function toolPreview(item: ChatToolItem): { title: string; detail: string; result: string; snippet: string } {
  if (item.status === "receiving") return { title: item.name, detail: "", result: "", snippet: "" };
  const envelope = record(item.arguments);
  const argumentsText = typeof envelope.preview === "string" ? envelope.preview : item.arguments;
  const input = record(argumentsText);
  const output = record(item.output);
  // Validated Write payloads can exceed the retained history budget. Decode only
  // a complete JSON path token, never execute or parse the truncated content.
  const pathToken = !input.path && /"path"\s*:\s*("(?:\\.|[^"\\])*")/.exec(argumentsText)?.[1];
  let file = clip(input.path || output.path, 240);
  if (!file && pathToken) { try { file = clip(JSON.parse(pathToken), 240); } catch { /* No complete path is available. */ } }
  const titles: Record<string, string> = { Read: "读取文件", Write: "写入文件", Edit: "编辑文件", Glob: "查找文件", Grep: "搜索内容", Bash: "执行命令", Monitor: "管理后台作业", code_execution: "运行代码", Agent: "委派任务", Task: "委派任务", Skill: "执行工作流" };
  const title = titles[item.name] ?? item.name;
  const detail = file || clip(input.command || input.pattern || input.title || input.id || input.language);
  let result = "";
  if (item.status === "ok") {
    if (item.name === "Edit" && typeof output.replacements === "number") result = `已替换 ${output.replacements} 处`;
    else if (item.name === "Write") result = "写入完成";
    else if (item.name === "Bash" || item.name === "code_execution" || item.name === "Monitor") {
      result = typeof output.output === "string" ? clip(output.output.trim().split(/\r?\n/).at(-1), 140) : "";
      if (!result && typeof output.partialOutput === "string" && output.partialOutput.trim()) result = `未换行：${clip(output.partialOutput, 130)}`;
    }
  }
  if (item.status === "error") result = clip(typeof output.message === "string" ? output.message : item.output, 140);
  const content = item.name === "Edit" ? input.new_string : item.name === "Write" ? input.content : undefined;
  const snippet = typeof content === "string" && item.status !== "error" && item.status !== "cancelled" ? content.slice(0, 240).split(/\r?\n/).slice(0, 3).join("\n") : "";
  return { title, detail, result, snippet };
}
