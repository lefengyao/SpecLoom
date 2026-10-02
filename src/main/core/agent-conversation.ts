import { z } from "zod";
import { MessageSchema, type AgentMessage } from "./agent-client";
import { redactSecret } from "./agent-output";

const MESSAGE_LIMIT = 96;
const JSON_LIMIT = 262_144;
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

export const AgentConversationSchema = z.array(MessageSchema).max(MESSAGE_LIMIT).superRefine((messages, context) => {
  if (JSON.stringify(messages).length > JSON_LIMIT) context.addIssue({ code: "custom", message: "Agent conversation exceeds the size limit." });
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
    } };
  });
  return group.map((message, index) => ({ role: message.role,
    content: message.content === null ? null : boundedText(redactSecret(message.content, secret), 131_072),
    ...(index === 0 && calls ? { tool_calls: calls } : {}),
    ...(message.tool_call_id ? { tool_call_id: callIds.get(message.tool_call_id) ?? redactSecret(message.tool_call_id, secret).slice(0, 256) } : {}),
  }));
}

function fitUser(message: AgentMessage): void {
  if (message.content === null || JSON.stringify([message]).length <= JSON_LIMIT) return;
  const content = message.content;
  let low = 0;
  let high = Math.min(content.length, 131_072 - TRUNCATED.length);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (JSON.stringify([{ ...message, content: `${content.slice(0, middle)}${TRUNCATED}` }]).length <= JSON_LIMIT) low = middle;
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

export function boundConversation(messages: readonly AgentMessage[], secret?: string): AgentMessage[] {
  const groups = batches(messages.filter((message) => message.role !== "system")).groups.map((group) => redactBatch(group, secret));
  const latestUser = [...groups].reverse().find((group) => group[0]!.role === "user");
  if (latestUser) fitUser(latestUser[0]!);
  const sizes = new Map(groups.map((group) => [group, JSON.stringify(group).length - 1]));
  let count = groups.reduce((sum, group) => sum + group.length, 0);
  let size = 1 + [...sizes.values()].reduce((sum, value) => sum + value, 0);
  // Keep the latest user goal while removing old exchanges only at complete batch boundaries.
  while (count > MESSAGE_LIMIT || size > JSON_LIMIT) {
    const index = groups.findIndex((group) => group !== latestUser);
    if (index < 0) break;
    const [removed] = groups.splice(index, 1);
    count -= removed!.length;
    size -= sizes.get(removed!)!;
  }
  return groups.flat();
}
