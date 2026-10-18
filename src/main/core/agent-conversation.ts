import { z } from "zod";
import { MessageSchema, type AgentMessage } from "./agent-client";
import { redactSecret } from "./agent-output";

// This is a durable safety ceiling, not the model context window. Runtime
// compression runs before reaching it so long-window models retain their history.
export const PERSISTED_CONVERSATION_MESSAGE_LIMIT = 4096;
export const PERSISTED_CONVERSATION_JSON_LIMIT = 4_194_304;
export interface ConversationLimits { maxMessages: number; maxJsonChars: number }
const ARGUMENT_LIMIT = 524_288;
const TRUNCATED = "[truncated]";

function batches(messages: readonly AgentMessage[]): { groups: AgentMessage[][]; complete: boolean } {
  const groups: AgentMessage[][] = [];
  let complete = true;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role === "system" || message.role === "tool" || message.tool_call_id ||
      (message.role !== "assistant" && message.tool_calls)) { complete = false; continue; }
    if (!message.tool_calls?.length) { groups.push([message]); continue; }
    const calls = message.tool_calls;
    const results = messages.slice(index + 1, index + 1 + calls.length);
    const ids = new Set(calls.map((call) => call.id));
    if (ids.size !== calls.length || results.length !== calls.length || results.some((result) =>
      result.role !== "tool" || result.tool_calls || !result.tool_call_id || !ids.delete(result.tool_call_id))) {
      complete = false;
      continue;
    }
    groups.push([message, ...results]);
    index += calls.length;
  }
  return { groups, complete };
}

export const AgentConversationSchema = z.array(MessageSchema).max(PERSISTED_CONVERSATION_MESSAGE_LIMIT).superRefine((messages, context) => {
  if (JSON.stringify(messages).length > PERSISTED_CONVERSATION_JSON_LIMIT) context.addIssue({ code: "custom", message: "Agent conversation exceeds the size limit." });
  if (!batches(messages).complete) context.addIssue({ code: "custom", message: "Agent conversation contains an incomplete tool batch." });
});

function boundedText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - TRUNCATED.length)}${TRUNCATED}`;
}

function redactArguments(argumentsJson: string, secret?: string): string {
  const oversized = JSON.stringify("[tool arguments omitted: size limit]");
  if (argumentsJson.length > ARGUMENT_LIMIT) return oversized;
  let parsed: unknown;
  try { parsed = JSON.parse(argumentsJson); }
  catch { return JSON.stringify("[invalid tool arguments omitted]"); }
  let nodes = 0;
  function redact(value: unknown, depth = 0): unknown {
    if (++nodes > 4_096 || depth > 16) return TRUNCATED;
    if (typeof value === "string") return redactSecret(value, secret);
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) {
      const result = value.slice(0, 256).map((entry) => redact(entry, depth + 1));
      if (value.length > 256) result.push(TRUNCATED);
      return result;
    }
    const entries = Object.entries(value);
    const result = Object.fromEntries(entries.slice(0, 256).map(([key, entry]) => [redactSecret(key, secret), redact(entry, depth + 1)]));
    if (entries.length > 256) result[TRUNCATED] = true;
    return result;
  }
  const serialized = JSON.stringify(redact(parsed));
  return serialized.length <= ARGUMENT_LIMIT ? serialized : oversized;
}

function redactBatch(group: AgentMessage[], secret?: string): AgentMessage[] {
  const callIds = new Map<string, string>();
  const usedIds = new Set<string>();
  const calls = group[0]!.tool_calls?.map((call, index) => {
    const redactedId = redactSecret(call.id, secret).slice(0, 256);
    let id = redactedId;
    for (let collision = 0; usedIds.has(id); collision++) id = `${redactedId.slice(0, 220)}:${index}:${collision}`;
    callIds.set(call.id, id);
    usedIds.add(id);
    return { id, type: call.type, function: {
      name: redactSecret(call.function.name, secret).slice(0, 128), arguments: redactArguments(call.function.arguments, secret),
    }, ...(call.thought_signature ? { thought_signature: redactSecret(call.thought_signature, secret).slice(0, 65_536) } : {}) };
  });
  return group.map((message, index) => ({ role: message.role,
    content: message.content === null ? null : boundedText(redactSecret(message.content, secret), 131_072),
    ...(message.images?.length ? { images: message.images.map((image) => ({ mimeType: image.mimeType, base64: image.base64.slice(0, 8_388_608) })) } : {}),
    ...(index === 0 && calls ? { tool_calls: calls } : {}),
    ...(message.thinking_blocks?.length ? { thinking_blocks: message.thinking_blocks } : {}),
    ...(message.reasoning_content !== undefined ? { reasoning_content: boundedText(redactSecret(message.reasoning_content, secret), 131_072) } : {}),
    ...(message.tool_call_id ? { tool_call_id: callIds.get(message.tool_call_id) ?? redactSecret(message.tool_call_id, secret).slice(0, 256) } : {}),
    ...(message.tool_name ? { tool_name: redactSecret(message.tool_name, secret).slice(0, 128) } : {}),
  }));
}

function fitUser(message: AgentMessage, maxJsonChars: number): void {
  if (message.content === null || JSON.stringify([message]).length <= maxJsonChars) return;
  const content = message.content;
  let low = 0;
  let high = Math.min(content.length, 131_072 - TRUNCATED.length);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (JSON.stringify([{ ...message, content: `${content.slice(0, middle)}${TRUNCATED}` }]).length <= maxJsonChars) low = middle;
    else high = middle - 1;
  }
  message.content = `${content.slice(0, low)}${TRUNCATED}`;
}

export function redactConversation(messages: readonly AgentMessage[], secret?: string): AgentMessage[] {
  const systems = messages.filter((message) => message.role === "system").map((message): AgentMessage => ({
    role: "system", content: message.content === null ? null : boundedText(redactSecret(message.content, secret), 131_072),
  }));
  return [...systems, ...batches(messages.filter((message) => message.role !== "system")).groups.flatMap((group) => redactBatch(group, secret))];
}

export function boundConversation(messages: readonly AgentMessage[], secret?: string, currentUserMessage?: AgentMessage,
  limits: ConversationLimits = { maxMessages: PERSISTED_CONVERSATION_MESSAGE_LIMIT, maxJsonChars: PERSISTED_CONVERSATION_JSON_LIMIT }): AgentMessage[] {
  const sourceGroups = batches(messages.filter((message) => message.role !== "system")).groups;
  const groups = sourceGroups.map((group) => redactBatch(group, secret));
  // Vision bytes are sent in the live run only; durable history keeps its text receipt.
  for (const group of groups) for (const message of group) if (message.images?.length) { delete message.images; message.content = `${message.content ?? ""}\n[该轮工具图像已展示给模型，历史仅保存调用记录]`; }
  // Locate the original user before redaction creates copies; tool-generated user
  // continuations must not replace the goal protected by a live run's checkpoint.
  const currentUserIndex = currentUserMessage?.role === "user"
    ? sourceGroups.findIndex((group) => group[0] === currentUserMessage) : -1;
  const latestUser = groups[currentUserIndex] ?? [...groups].reverse().find((group) => group[0]!.role === "user");
  if (latestUser) fitUser(latestUser[0]!, limits.maxJsonChars);
  const sizes = new Map(groups.map((group) => [group, JSON.stringify(group).length - 1]));
  let count = groups.reduce((sum, group) => sum + group.length, 0);
  let size = 1 + [...sizes.values()].reduce((sum, value) => sum + value, 0);
  // Keep the latest user goal while removing old exchanges only at complete batch boundaries.
  while (count > limits.maxMessages || size > limits.maxJsonChars) {
    const index = groups.findIndex((group) => group !== latestUser);
    if (index < 0) break;
    const [removed] = groups.splice(index, 1);
    count -= removed!.length;
    size -= sizes.get(removed!)!;
  }
  return groups.flat();
}
