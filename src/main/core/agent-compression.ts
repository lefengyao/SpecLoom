import { estimateConversationTokens, type AgentMessage } from "./agent-client";
import type { ProviderTool } from "./tool-catalog";

export const DEFAULT_COMPRESSION_TRIGGER = 0.9;
export const DEFAULT_COMPRESSION_TARGET = 0.68;
const MAX_SUMMARY_DEPTH = 8;

export class CompressionError extends Error {
  readonly code = "CONTEXT_COMPRESSION_FAILED";
  constructor(message: string, options?: { cause?: unknown }) { super(message, options); this.name = "CompressionError"; }
}

export interface SummaryRequest { transcript: string; signal?: AbortSignal }
export type SummarizeContext = (request: SummaryRequest) => Promise<string>;
export interface CompressionInput {
  messages: AgentMessage[];
  contextTokens: number;
  outputTokens?: number;
  tools?: ProviderTool[];
  currentUserMessage?: AgentMessage;
  existingSummary?: string;
  summarize: SummarizeContext;
  triggerRatio?: number;
  targetRatio?: number;
  maxChunkTokens?: number;
  signal?: AbortSignal;
  estimate?: (messages: AgentMessage[], tools?: ProviderTool[]) => number;
  storageLimits?: { messageLimit: number; jsonLimit: number };
}
export interface CompressionResult { summary: string; retained: AgentMessage[]; compressedGroups: number; chunkCount: number }

interface Group { messages: AgentMessage[]; text: string }

function messageText(message: AgentMessage): string {
  const content = message.content ?? "";
  if (message.tool_calls?.length) return `[assistant tool calls]\n${content}\n${message.tool_calls.map(call => `${call.id} ${call.function.name}: ${call.function.arguments}`).join("\n")}`;
  if (message.role === "tool") return `[tool ${message.tool_call_id ?? ""} ${message.tool_name ?? "result"}]\n${content}`;
  return `[${message.role}]\n${content}`;
}

function groups(messages: AgentMessage[]): Group[] {
  const result: Group[] = [];
  for (const message of messages.filter(item => item.role !== "system")) {
    if (message.role === "user" || result.length === 0) result.push({ messages: [message], text: "" });
    else result.at(-1)!.messages.push(message);
  }
  for (const group of result) group.text = group.messages.map(messageText).join("\n");
  return result;
}

function batches(messages: AgentMessage[]): Group[] {
  const result: Group[] = [];
  for (let index = 0; index < messages.length; index++) {
    const batch = [messages[index]!];
    const calls = batch[0]!.tool_calls;
    const receipts = calls ? messages.slice(index + 1, index + 1 + calls.length) : [];
    const ids = new Set(calls?.map(call => call.id));
    if (calls?.length && receipts.length === calls.length && receipts.every(receipt =>
      receipt.role === "tool" && receipt.tool_call_id && ids.delete(receipt.tool_call_id))) {
      batch.push(...receipts);
      index += calls.length;
    }
    result.push({ messages: batch, text: batch.map(messageText).join("\n") });
  }
  return result;
}

/** Image bytes are live-only; durable history retains the text receipt instead. */
export function conversationStorageSize(messages: AgentMessage[]): { messages: number; jsonChars: number } {
  const durable = messages.filter(message => message.role !== "system").map(({ images, ...message }) => ({
    ...message, ...(images?.length ? { content: `${message.content ?? ""}\n[该轮工具图像已展示给模型，历史仅保存调用记录]` } : {}),
  }));
  return { messages: durable.length, jsonChars: JSON.stringify(durable).length };
}

export function shouldCompress(input: Pick<CompressionInput, "messages" | "contextTokens" | "outputTokens" | "tools" | "triggerRatio" | "estimate" | "storageLimits">): boolean {
  const trigger = input.triggerRatio ?? DEFAULT_COMPRESSION_TRIGGER;
  if (input.storageLimits) {
    const storage = conversationStorageSize(input.messages);
    if (storage.messages >= input.storageLimits.messageLimit * trigger || storage.jsonChars >= input.storageLimits.jsonLimit * trigger) return true;
  }
  const effective = input.contextTokens - Math.max(1, input.outputTokens ?? 1);
  if (!input.contextTokens) return false;
  if (effective <= 0) return true;
  return (input.estimate ?? estimateConversationTokens)(input.messages, input.tools) / effective >= trigger;
}

function splitChunks(source: Group[], maxChunkTokens: number): string[] {
  const prefix = "[history chunk]\n";
  const result: string[] = [];
  let pending: string[] = [];
  for (const [groupIndex, group] of source.entries()) {
    if (textTokens(prefix + group.text) <= maxChunkTokens) { pending.push(group.text); continue; }
    // Oversized turns can still contain small complete assistant/tool exchanges.
    for (const [batchIndex, batch] of batches(group.messages).entries()) {
      const text = batch.text;
      if (textTokens(prefix + text) <= maxChunkTokens) { pending.push(text); continue; }
      result.push(...packTexts(pending, maxChunkTokens, prefix));
      pending = [];
      // A single batch larger than the model budget must be represented as data
      // fragments. Repeat its identity so each summary can associate the pieces.
      const label = `[partial history batch ${groupIndex + 1}.${batchIndex + 1}; ordered fragment]\n`;
      result.push(...textChunks(text, maxChunkTokens, prefix + label));
    }
  }
  return [...result, ...packTexts(pending, maxChunkTokens, prefix)];
}

const textTokens = (value: string) => estimateConversationTokens([{ role: "user", content: value }]);

function textChunks(value: string, maxTokens: number, prefix: string): string[] {
  const result: string[] = [];
  for (let offset = 0; offset < value.length;) {
    let low = 0;
    let high = value.length - offset;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (textTokens(prefix + value.slice(offset, offset + middle)) <= maxTokens) low = middle;
      else high = middle - 1;
    }
    let end = offset + low;
    // Keep surrogate pairs intact when a single message exceeds the chunk budget.
    if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1] ?? "")) end--;
    if (end <= offset) throw new CompressionError("摘要分块预算不足");
    result.push(prefix + value.slice(offset, end));
    offset = end;
  }
  return result;
}

function packTexts(values: string[], maxTokens: number, prefix: string): string[] {
  const result: string[] = [];
  let current = "";
  for (const value of values) {
    const candidate = current ? `${current}\n\n${value}` : value;
    if (textTokens(prefix + candidate) <= maxTokens) { current = candidate; continue; }
    if (current) { result.push(prefix + current); current = ""; }
    if (textTokens(prefix + value) <= maxTokens) current = value;
    else result.push(...textChunks(value, maxTokens, prefix));
  }
  if (current) result.push(prefix + current);
  return result;
}

async function summarizeChunks(chunks: string[], summarize: SummarizeContext, signal: AbortSignal | undefined, existingSummary: string | undefined, maxSummaryTokens: number, maxChunkTokens: number): Promise<string> {
  if (!chunks.length && !existingSummary) throw new CompressionError("没有可压缩的会话历史");
  const summarizeOne = async (transcript: string): Promise<string> => {
    signal?.throwIfAborted();
    try {
      const result = await summarize({ transcript, ...(signal ? { signal } : {}) });
      signal?.throwIfAborted();
      if (!result.trim()) throw new CompressionError("摘要模型返回空结果");
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      throw new CompressionError("会话压缩摘要失败", { cause: error });
    }
  };
  let outputs: string[] = [];
  for (const chunk of chunks) outputs.push(await summarizeOne(chunk));
  // Old summaries are subject to the same budget as newly generated summaries.
  if (existingSummary) outputs.unshift(`[previous summary]\n${existingSummary}`);
  let mustMerge = Boolean(existingSummary);
  for (let depth = 0; depth < MAX_SUMMARY_DEPTH; depth++) {
    const combined = outputs.join("\n\n");
    if (!mustMerge && textTokens(combined) <= maxSummaryTokens) return combined;
    const next: string[] = [];
    for (const part of packTexts(outputs, maxChunkTokens, "[summary merge]\n")) {
      next.push(await summarizeOne(part));
    }
    outputs = next;
    mustMerge = false;
  }
  const reduced = outputs.join("\n\n");
  if (textTokens(reduced) > maxSummaryTokens) throw new CompressionError("摘要仍超过目标上下文预算");
  return reduced;
}

export async function compressConversation(input: CompressionInput): Promise<CompressionResult> {
  const allGroups = groups(input.messages);
  const currentIndex = input.currentUserMessage ? allGroups.findIndex(group => group.messages.includes(input.currentUserMessage!)) : allGroups.length - 1;
  if (currentIndex < 0 || !allGroups.length) throw new CompressionError("当前用户目标不在会话历史中");
  const current = currentIndex;
  const systems = input.messages.filter(message => message.role === "system");
  const effective = Math.max(1, input.contextTokens - Math.max(1, input.outputTokens ?? 1));
  const target = effective * (input.targetRatio ?? DEFAULT_COMPRESSION_TARGET);
  const estimate = input.estimate ?? estimateConversationTokens;
  const storageFits = (candidate: AgentMessage[]) => {
    if (!input.storageLimits) return true;
    const storage = conversationStorageSize(candidate);
    const ratio = input.targetRatio ?? DEFAULT_COMPRESSION_TARGET;
    return storage.messages <= input.storageLimits.messageLimit * ratio && storage.jsonChars <= input.storageLimits.jsonLimit * ratio;
  };
  const fits = (candidate: AgentMessage[]) => estimate(candidate, input.tools) <= target && storageFits(candidate);
  const summaryReserve = input.existingSummary
    ? estimateConversationTokens([{ role: "system", content: input.existingSummary }])
    : Math.max(256, Math.floor(effective * 0.12));
  const activeBatches = batches(allGroups.slice(current).flatMap(group => group.messages));
  const completeTools = activeBatches.filter(batch => batch.messages[0]!.tool_calls?.length
    && batch.messages.length === batch.messages[0]!.tool_calls!.length + 1);
  const activeSource: Group[] = [];
  const withSummary = (body: AgentMessage[]) => [
    ...systems,
    { role: "system" as const, content: "x".repeat(Math.ceil(summaryReserve / 0.55)) },
    ...body,
  ];
  // Long runs can outgrow a window before the next user message. Keep the user
  // goal, generated continuations, and newest tool batch; summarize older batches.
  for (const batch of completeTools.slice(0, -1)) {
    const active = activeBatches.flatMap(item => item.messages);
    if (fits(withSummary(active))) break;
    activeBatches.splice(activeBatches.indexOf(batch), 1);
    activeSource.push(batch);
  }
  const retainedActive = activeBatches.flatMap(batch => batch.messages);
  const retainedGroups: Group[] = [];
  // Keep as much recent complete history as can fit with a bounded summary reserve.
  for (let index = current - 1; index >= 0; index--) {
    if (index === 0) break; // Always retain a non-empty prefix for semantic compression.
    const candidate = withSummary([...allGroups.slice(index, current).flatMap(group => group.messages), ...retainedActive]);
    if (!fits(candidate)) break;
    retainedGroups.unshift(allGroups[index]!);
  }
  const cut = retainedGroups.length ? allGroups.indexOf(retainedGroups[0]!) : current;
  const source = [...allGroups.slice(0, cut), ...activeSource];
  if (!source.length) throw new CompressionError("没有足够的完整历史可压缩");
  const retained = [...retainedGroups.flatMap(group => group.messages), ...retainedActive];
  if (!storageFits(retained)) throw new CompressionError("当前用户目标与最新工具结果超过保存压缩目标");
  // The summary request supports at most 524288 transcript characters. Keep a
  // conservative raw text budget below that bound instead of slicing history.
  const maxChunkTokens = Math.min(input.maxChunkTokens ?? Math.max(512, Math.floor(input.contextTokens * 0.24)), 280_000);
  const chunks = splitChunks(source, maxChunkTokens);
  const summary = await summarizeChunks(chunks, input.summarize, input.signal, input.existingSummary, Math.max(256, Math.floor(effective * 0.12)), maxChunkTokens);
  return { summary: summary.slice(0, 131_072), retained, compressedGroups: source.length, chunkCount: chunks.length };
}
