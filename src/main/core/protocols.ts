/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Protocol, ReasoningLevel } from "../../shared/contracts";
import { isProtocolMappingPath, normalizeReasoningMapPath } from "../../shared/contracts";
import { ProjectError } from "./errors";
import type { AgentMessage } from "./agent-client";
import type { ProviderTool } from "./tool-catalog";
import { matchModelFamily, stripVendorPrefix } from "./model-settings";
import { assertCompletionStatus, readProtocolBody, stringifyResponseValue, transportCause, type CompletionDelta } from "./protocol-stream";
import type { DiagnosticEventWithoutId } from "../../shared/diagnostics";

export interface ProtocolSettings {
  reasoningSupport?: boolean;
  reasoning?: ReasoningLevel;
  reasoningMap?: { path: string; values: Partial<Record<ReasoningLevel, string>> } | null;
  temperature?: number;
  maxOutputTokens?: number;
  vision?: boolean;
}

export interface ProtocolRequest {
  protocol: Protocol;
  baseUrl: string;
  model: string;
  messages: AgentMessage[];
  tools: ProviderTool[];
  secret?: string;
  settings?: ProtocolSettings;
  signal?: AbortSignal;
  onDelta?: (delta: CompletionDelta) => void | Promise<void>;
  onWait?: (waiting: boolean) => void;
  onDiagnostic?: (event: Omit<DiagnosticEventWithoutId, "attempt">) => Promise<void> | void;
  fetcher?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

async function recordDiagnostic(input: ProtocolRequest, event: Omit<DiagnosticEventWithoutId, "attempt">): Promise<void> {
  try { await input.onDiagnostic?.(event); }
  catch { console.warn("[SpecLoom] diagnostic_log_write_failed"); }
}

function safeMediaType(response: Response): "application/json" | "text/event-stream" | "other" | "unknown" {
  const value = response.headers.get("content-type");
  if (!value) return "unknown";
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || mediaType === "text/event-stream" ? mediaType : "other";
}

export interface NormalizedUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
}

export interface ProtocolCompletion {
  message: AgentMessage;
  usage?: NormalizedUsage;
  thinkingBlocks?: unknown[];
}

const ReasoningBudget: Record<Exclude<ReasoningLevel, "off">, number> = { low: 2048, medium: 8192, high: 16384 };

type GeminiThinkingLevel = "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";

function geminiThinkingLevel(model: string, requested: ReasoningLevel): GeminiThinkingLevel {
  const bareModel = stripVendorPrefix(model).trim().toLowerCase();
  const supported: GeminiThinkingLevel[] = bareModel.startsWith("gemini-3-pro")
    ? ["LOW", "HIGH"]
    : bareModel.startsWith("gemini-3.1-pro")
      ? ["LOW", "MEDIUM", "HIGH"]
      : bareModel.startsWith("gemini-3.1-flash-lite-image")
        ? ["MINIMAL", "HIGH"]
        : ["MINIMAL", "LOW", "MEDIUM", "HIGH"];
  const requestedLevel: GeminiThinkingLevel = requested === "off" ? "MINIMAL" : requested.toUpperCase() as GeminiThinkingLevel;
  let selected = supported[0]!;
  for (const level of supported) {
    if (["MINIMAL", "LOW", "MEDIUM", "HIGH"].indexOf(level) <= ["MINIMAL", "LOW", "MEDIUM", "HIGH"].indexOf(requestedLevel)) selected = level;
  }
  return selected;
}

function endpoint(baseUrl: string, protocol: Protocol, model: string): string {
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new ProjectError("MODEL_ERROR", "Invalid model endpoint."); }
  url.hash = "";
  const path = url.pathname.replace(/\/+$/, "");
  if (protocol === "openai") url.pathname = path.endsWith("/chat/completions") ? path : `${path}/chat/completions`;
  else if (protocol === "anthropic") url.pathname = path.endsWith("/messages") ? path : path.endsWith("/v1") ? `${path}/messages` : `${path}/v1/messages`;
  else {
    const root = path.replace(/\/models\/[^/]+:(?:generateContent|streamGenerateContent)$/, "").replace(/\/v1beta\/openai$/, "");
    url.pathname = `${root.endsWith("/v1beta") ? root : `${root}/v1beta`}/models/${encodeURIComponent(model)}:generateContent`;
  }
  return url.toString();
}

function outputLimit(settings: ProtocolSettings | undefined): number {
  return settings?.maxOutputTokens ?? 8192;
}

function parseMappedValue(settings: ProtocolSettings | undefined, protocol?: Protocol): { path: string; value: unknown } | undefined {
  if (settings?.reasoningSupport === false) return undefined;
  const map = settings?.reasoningMap;
  const level = settings?.reasoning ?? "off";
  const path = map?.path ? normalizeReasoningMapPath(map.path) : undefined;
  const raw = path ? map?.values?.[level] : undefined;
  if (!path || raw === undefined || !raw.trim()) return undefined;
  if (protocol && !isProtocolMappingPath(protocol, path)) return undefined;
  try { const value = JSON.parse(raw); return value === null ? undefined : { path, value }; } catch { return { path, value: raw }; }
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let current = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i]!;
    if (!current[key] || typeof current[key] !== "object" || Array.isArray(current[key])) current[key] = {};
    current = current[key] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}

function modelParams(protocol: Protocol, settings: ProtocolSettings | undefined, model = ""): Record<string, unknown> {
  const max = outputLimit(settings);
  const level = settings?.reasoning ?? "off";
  const mapped = parseMappedValue(settings, protocol);
  const bareModel = stripVendorPrefix(model).trim();
  const family = matchModelFamily(model);
  const gemini3 = protocol === "gemini" && family?.id === "gemini-3";
  const gpt5NoneSupported = /^gpt-5\.[12](?:-\d{4}-\d{2}-\d{2})?$/i.test(bareModel);
  const gpt5MinimalSupported = /^gpt-5(?:-(?:mini|nano))?(?:-\d{4}-\d{2}-\d{2})?$/i.test(bareModel);
  const openAiOutputParam = family?.outputTokenParam ?? (/^o[1-4](?:[.-]|$)/i.test(bareModel) ? "max_completion_tokens" : "max_tokens");
  const result: Record<string, unknown> = protocol === "anthropic" ? { max_tokens: max } : protocol === "gemini" ? { generationConfig: { maxOutputTokens: max } } : { [openAiOutputParam]: max };
  if (mapped) setPath(result, mapped.path, mapped.value);
  else if (protocol === "openai" && settings?.reasoningSupport && level === "off") {
    if (gpt5NoneSupported) result.reasoning_effort = "none";
    else if (gpt5MinimalSupported) result.reasoning_effort = "minimal";
  }
  else if (protocol === "gemini" && family?.id === "gemini-2.5" && settings?.reasoningSupport && level === "off") {
    // Flash permits disabling thinking; Pro must retain its minimum 128 tokens.
    const budget = /^gemini-2\.5-pro(?:-|$)/i.test(bareModel) ? 128 : /^gemini-2\.5-flash(?:-|$)/i.test(bareModel) ? 0 : undefined;
    if (budget !== undefined) {
      if (budget > max) throw new ProjectError("MODEL_ERROR", "The configured output limit is below the model's minimum thinking budget.");
      (result.generationConfig as Record<string, unknown>).thinkingConfig = { thinkingBudget: budget };
    }
  }
  else if (settings?.reasoningSupport && (level !== "off" || gemini3)) {
    if (protocol === "openai") result.reasoning_effort = level;
    else if (protocol === "anthropic") {
      const budget = Math.max(0, Math.min(level === "off" ? 0 : ReasoningBudget[level], max - 1024));
      if (budget >= 1024) result.thinking = { type: "enabled", budget_tokens: budget };
    } else {
      const thinkingConfig = gemini3
        ? { thinkingLevel: geminiThinkingLevel(model, level) }
        : (() => {
          const budget = Math.max(0, Math.min(level === "off" ? 0 : ReasoningBudget[level], max - 1024));
          return budget >= 1024 ? { thinkingBudget: budget } : undefined;
        })();
      if (thinkingConfig) (result.generationConfig as Record<string, unknown>).thinkingConfig = thinkingConfig;
    }
  }
  if (settings?.temperature !== undefined) {
    if (protocol === "gemini") (result.generationConfig as Record<string, unknown>).temperature = settings.temperature;
    else if (protocol === "openai") {
      // GPT-5.1/5.2 accept sampling controls only with none effort; legacy GPT-5
      // and o-series reject them even when no reasoning preference is sent.
      if (openAiOutputParam !== "max_completion_tokens" || (gpt5NoneSupported && result.reasoning_effort === "none")) result.temperature = settings.temperature;
    } else {
      const thinkingType = (result.thinking as { type?: string } | undefined)?.type;
      if (!thinkingType || thinkingType === "disabled") result.temperature = Math.max(0, Math.min(1, settings.temperature));
    }
  }
  if (mapped) {
    if (protocol === "gemini") (result.generationConfig = { ...((result.generationConfig as Record<string, unknown>) ?? {}), maxOutputTokens: max });
    else if (protocol === "anthropic") result.max_tokens = max;
    else if (result.max_completion_tokens === undefined && result.max_tokens === undefined) result.max_tokens = max;
    const budget = protocol === "anthropic"
      ? (result.thinking as { type?: string; budget_tokens?: unknown } | undefined)?.type === "enabled"
        ? (result.thinking as { budget_tokens?: unknown }).budget_tokens : undefined
      : protocol === "gemini" ? ((result.generationConfig as { thinkingConfig?: { thinkingBudget?: unknown } } | undefined)?.thinkingConfig?.thinkingBudget) : undefined;
    if (typeof budget === "number" && (budget > max || (protocol === "anthropic" && budget === max))) {
      throw new ProjectError("MODEL_ERROR", "The mapped thinking budget exceeds the configured output limit.");
    }
  }
  return result;
}

function openAiContent(message: AgentMessage): unknown {
  if (!message.images?.length) return message.content ?? null;
  return [{ ...(message.content ? { type: "text", text: message.content } : {}) }, ...message.images.map((image) => ({ type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.base64}` } }))].filter((part) => Object.keys(part).length);
}
function openAiMessages(messages: AgentMessage[], deepseek = false): unknown[] {
  return messages.map((message) => {
    const rest = { ...message };
    delete rest.images;
    delete rest.thinking_blocks;
    delete rest.tool_name;
    if (deepseek && rest.role === "assistant") {
      rest.content ??= "";
      // Older histories do not retain thinking. Preserve the required field without
      // inventing reasoning for those completed tool calls.
      if (rest.tool_calls?.length) rest.reasoning_content ??= "";
    } else if (!deepseek) delete rest.reasoning_content;
    return message.role === "user" && message.images?.length ? { ...rest, content: openAiContent(message) } : rest;
  });
}
function toAnthropicContent(message: AgentMessage): unknown {
  const blocks: unknown[] = [];
  if (message.content) blocks.push({ type: "text", text: message.content });
  for (const image of message.images ?? []) blocks.push({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.base64 } });
  return blocks.length ? blocks : "";
}
function toGeminiParts(message: AgentMessage): unknown[] {
  return [{ ...(message.content ? { text: message.content } : {}) }, ...(message.images ?? []).map((image) => ({ inlineData: { mimeType: image.mimeType, data: image.base64 } }))].filter((part) => Object.keys(part).length);
}
function anthropicMessages(messages: AgentMessage[], replayThinking = true): Array<{ role: "user" | "assistant"; content: unknown }> {
  const out: Array<{ role: "user" | "assistant"; content: unknown }> = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") out.push({ role: "user", content: toAnthropicContent(message) });
    else if (message.role === "assistant") {
      const blocks: unknown[] = [];
      if (replayThinking && message.thinking_blocks?.length) blocks.push(...message.thinking_blocks);
      if (message.content) blocks.push({ type: "text", text: message.content });
      for (const call of message.tool_calls ?? []) {
        let input: unknown = {};
        try { input = JSON.parse(call.function.arguments || "{}"); } catch { /* preserve an empty tool input */ }
        blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input });
      }
      if (blocks.length) out.push({ role: "assistant", content: blocks });
    } else if (message.role === "tool") {
      const block = { type: "tool_result", tool_use_id: message.tool_call_id ?? "", content: message.content ?? "" };
      const last = out.at(-1);
      if (last?.role === "user" && Array.isArray(last.content) && (last.content as Array<{ type?: string }>).every((item) => item.type === "tool_result")) (last.content as unknown[]).push(block);
      else out.push({ role: "user", content: [block] });
    }
  }
  return out;
}
function geminiMessages(messages: AgentMessage[]): Array<{ role: "user" | "model"; parts: unknown[] }> {
  const out: Array<{ role: "user" | "model"; parts: unknown[] }> = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") out.push({ role: "user", parts: toGeminiParts(message) });
    else if (message.role === "assistant") {
      const parts: unknown[] = message.content ? [{ text: message.content }] : [];
      for (const call of message.tool_calls ?? []) { let args: unknown = {}; try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* empty */ } parts.push({ functionCall: { name: call.function.name, args }, ...(call.thought_signature ? { thoughtSignature: call.thought_signature } : {}) }); }
      if (parts.length) out.push({ role: "model", parts });
    } else if (message.role === "tool") {
      let result: unknown = message.content ?? ""; try { result = JSON.parse(String(result)); } catch { /* text result */ }
      out.push({ role: "user", parts: [{ functionResponse: { name: message.tool_name ?? "tool", response: { result } } }] });
    }
  }
  return out;
}

function usage(value: any, protocol: Protocol): NormalizedUsage | undefined {
  if (!value) return undefined;
  const counts = protocol === "openai"
    ? [value.prompt_tokens, value.completion_tokens, value.prompt_tokens_details?.cached_tokens ?? value.prompt_cache_hit_tokens, 0]
    : protocol === "anthropic"
      ? [value.input_tokens, value.output_tokens, value.cache_read_input_tokens, value.cache_creation_input_tokens]
      : [value.promptTokenCount, value.candidatesTokenCount, value.cachedContentTokenCount, 0];
  const [inputTokens, completionTokens, cachedTokens, cacheWriteTokens] = counts.map(count => Number(count ?? 0)) as [number, number, number, number];
  if (![inputTokens, completionTokens, cachedTokens, cacheWriteTokens].every(count => Number.isSafeInteger(count) && count >= 0)) return undefined;
  const promptTokens = protocol === "anthropic" ? inputTokens + cachedTokens + cacheWriteTokens : inputTokens;
  if (!Number.isSafeInteger(promptTokens)) return undefined;
  return { promptTokens, completionTokens, cachedTokens, cacheWriteTokens };
}

function responseObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function responseName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function malformedResponse(): never {
  throw new ProjectError("MODEL_ERROR", "The model returned a malformed completion.", { reason: "response_parse_error" });
}

export async function requestProtocolCompletion(input: ProtocolRequest): Promise<ProtocolCompletion> {
  if (input.messages.some((message) => message.images?.length) && input.settings?.vision === false) {
    throw new ProjectError("MODEL_ERROR", "当前模型不支持图片输入，请切换模型或移除图片。");
  }
  const fetcher = input.fetcher ?? fetch;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (input.protocol === "openai" && input.secret) headers.Authorization = `Bearer ${input.secret}`;
  if (input.protocol === "anthropic") { if (input.secret) headers["x-api-key"] = input.secret; headers["anthropic-version"] = "2023-06-01"; }
  if (input.protocol === "gemini" && input.secret) headers["x-goog-api-key"] = input.secret;
  const system = input.messages.find((message) => message.role === "system")?.content ?? "";
  const url = endpoint(input.baseUrl, input.protocol, input.model);
  const params = modelParams(input.protocol, input.settings, input.model);
  const deepseek = input.protocol === "openai" && new URL(url).hostname === "api.deepseek.com";
  const body: Record<string, unknown> = input.protocol === "openai"
    ? { model: input.model, messages: openAiMessages(input.messages, deepseek), tools: input.tools, tool_choice: "auto", ...params }
    : input.protocol === "anthropic"
      ? { model: input.model, messages: anthropicMessages(input.messages, Boolean(params.thinking && (params.thinking as { type?: string }).type !== "disabled")), tools: input.tools.map((tool) => ({ name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters })), ...(system ? { system } : {}), ...params }
      : { contents: geminiMessages(input.messages), tools: input.tools.length ? [{ functionDeclarations: input.tools.map((tool) => ({ name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters })) }] : undefined, ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}), ...params };
  if (deepseek) {
    delete body.tool_choice;
    if (/^deepseek-(?:flash|v4)(?:-|$)/i.test(stripVendorPrefix(input.model).trim())) {
      const enabled = input.settings?.reasoningSupport !== false && input.settings?.reasoning !== "off";
      const mapped = parseMappedValue(input.settings, input.protocol);
      if (mapped?.path !== "thinking") body.thinking = { type: enabled ? "enabled" : "disabled" };
      if (!enabled) {
        if (mapped?.path !== "reasoning_effort") delete body.reasoning_effort;
      } else if (mapped?.path !== "reasoning_effort" && (body.reasoning_effort === undefined || body.reasoning_effort === "medium")) {
        body.reasoning_effort = input.settings?.reasoning === "low" ? "low" : "high";
      }
    }
  }
  if (!input.tools.length && input.protocol !== "gemini") delete body.tools;
  if (input.protocol === "gemini" && !input.tools.length) delete body.tools;
  if (input.onDelta && input.protocol !== "gemini") body.stream = true;
  if (input.onDelta && input.protocol === "openai") body.stream_options = { include_usage: true };
  const requestUrl = input.onDelta && input.protocol === "gemini" ? url.replace(":generateContent", ":streamGenerateContent") + (url.includes("?") ? "&" : "?") + "alt=sse" : url;
  let response: Response;
  try {
    response = await fetcher(requestUrl, {
      method: "POST", redirect: "error", headers, body: JSON.stringify(body),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }
  catch (error) {
    const transport = transportCause(error);
    if (!input.signal?.aborted) await recordDiagnostic(input, { type: "connection_error", errorCategory: "connection_error", ...(transport.causeCode ? { causeCode: transport.causeCode } : {}) });
    throw new ProjectError("MODEL_ERROR", "The model connection failed.");
  }
  await recordDiagnostic(input, { type: "response_headers", status: response.status, mediaType: safeMediaType(response), ...(!response.ok ? { errorCategory: "http_error" } : {}) });
  try { input.onWait?.(false); }
  catch (error) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProjectError("INTERNAL_ERROR", "Unable to process model response updates.", { reason: "response_consumer_error" }, { cause: error });
  }
  input.signal?.throwIfAborted();
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProjectError("MODEL_ERROR", `The model request failed with HTTP ${response.status}.`, { status: response.status });
  }
  const parsed = await readProtocolBody(response, input.protocol, input.onDelta, input.signal, input.onWait, input.onDiagnostic);
  if (!responseObject(parsed)) malformedResponse();
  if (parsed.error) throw new ProjectError("MODEL_ERROR", "The model returned an error.");
  if (input.protocol === "openai") {
    assertCompletionStatus(input.protocol, parsed.choices?.[0]?.finish_reason);
    if (!Array.isArray(parsed.choices) || !responseObject(parsed.choices[0])) malformedResponse();
    const message = parsed.choices?.[0]?.message;
    if (!responseObject(message) || (message.role !== undefined && message.role !== "assistant")) malformedResponse();
    if (message.content != null && typeof message.content !== "string") malformedResponse();
    for (const value of [message.reasoning_content, message.reasoning]) if (value != null && typeof value !== "string") malformedResponse();
    if (message.tool_calls != null) {
      if (!Array.isArray(message.tool_calls)) malformedResponse();
      for (const call of message.tool_calls) {
        if (!responseObject(call) || !responseName(call.id) || call.type !== "function" || !responseObject(call.function)
          || !responseName(call.function.name) || typeof call.function.arguments !== "string") malformedResponse();
      }
    }
    const reasoning = message.reasoning_content ?? message.reasoning;
    const normalized = { role: "assistant" as const, content: message.content ?? null, ...(typeof reasoning === "string" ? { reasoning_content: reasoning } : {}), ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}) };
    if (!normalized.content && !normalized.tool_calls?.length) throw new ProjectError("MODEL_ERROR", "The model returned an empty completion.", { reason: "response_parse_error" });
    const normalizedUsage = usage(parsed.usage, input.protocol);
    return { message: normalized, ...(normalizedUsage ? { usage: normalizedUsage } : {}) };
  }
  if (input.protocol === "anthropic") {
    assertCompletionStatus(input.protocol, parsed.stop_reason);
    if (!Array.isArray(parsed.content)) malformedResponse();
    const blocks = parsed.content;
    for (const block of blocks) {
      if (!responseObject(block) || typeof block.type !== "string") malformedResponse();
      if (block.type === "text" && typeof block.text !== "string") malformedResponse();
      if (block.type === "tool_use" && (!responseName(block.id) || !responseName(block.name) || !responseObject(block.input))) malformedResponse();
      if (block.type === "thinking" && (typeof block.thinking !== "string" || (block.signature !== undefined && typeof block.signature !== "string"))) malformedResponse();
      if (block.type === "redacted_thinking" && typeof block.data !== "string") malformedResponse();
    }
    const text = blocks.filter((block: any) => block.type === "text").map((block: any) => block.text).join("");
    const calls = blocks.filter((block: any) => block.type === "tool_use").map((block: any) => ({ id: block.id, type: "function" as const, function: { name: block.name, arguments: stringifyResponseValue(block.input) } }));
    if (!text && !calls.length) throw new ProjectError("MODEL_ERROR", "The model returned an empty completion.", { reason: "response_parse_error" });
    const normalizedUsage = usage(parsed.usage, input.protocol);
    const thinkingBlocks = blocks.filter((block: any) => block?.type === "thinking" || block?.type === "redacted_thinking");
    return { message: { role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}), ...(thinkingBlocks.length ? { thinking_blocks: thinkingBlocks } : {}) }, ...(normalizedUsage ? { usage: normalizedUsage } : {}), ...(thinkingBlocks.length ? { thinkingBlocks } : {}) };
  }
  assertCompletionStatus(input.protocol, parsed.candidates?.[0]?.finishReason, parsed.promptFeedback?.blockReason);
  if (!Array.isArray(parsed.candidates) || !responseObject(parsed.candidates[0]) || !responseObject(parsed.candidates[0].content)
    || !Array.isArray(parsed.candidates[0].content.parts)) malformedResponse();
  const parts = parsed.candidates[0].content.parts;
  for (const part of parts) {
    if (!responseObject(part)) malformedResponse();
    if (part.text !== undefined && typeof part.text !== "string") malformedResponse();
    if (part.thought !== undefined && typeof part.thought !== "boolean") malformedResponse();
    if (part.thoughtSignature !== undefined && typeof part.thoughtSignature !== "string") malformedResponse();
    if (part.functionCall !== undefined && (!responseObject(part.functionCall) || !responseName(part.functionCall.name)
      || (part.functionCall.args !== undefined && !responseObject(part.functionCall.args)))) malformedResponse();
  }
  const text = parts.filter((part: any) => typeof part?.text === "string" && !part.thought).map((part: any) => part.text).join("");
  const calls = parts.filter((part: any) => part.functionCall).map((part: any, index: number) => ({ id: `call_${index}`, type: "function" as const, function: { name: part.functionCall.name, arguments: stringifyResponseValue(part.functionCall.args ?? {}) }, ...(typeof part.thoughtSignature === "string" ? { thought_signature: part.thoughtSignature } : {}) }));
  if (!text && !calls.length) throw new ProjectError("MODEL_ERROR", "The model returned an empty completion.", { reason: "response_parse_error" });
  const normalizedUsage = usage(parsed.usageMetadata, input.protocol);
  return { message: { role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) }, ...(normalizedUsage ? { usage: normalizedUsage } : {}) };
}

export const protocolRequestUrl = endpoint;
export const buildProtocolParams = modelParams;
