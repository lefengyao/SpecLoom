/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Protocol } from "../../shared/contracts";
import { ProjectError } from "./errors";
import type { DiagnosticEventWithoutId } from "../../shared/diagnostics";

const JSON_RESPONSE_BYTES = 1_048_576;
const STREAM_RESPONSE_BYTES = 32 * 1024 * 1024;
const STREAM_FRAME_BYTES = 1_048_576;

export function transportCause(error: unknown): { causeName: string; causeCode?: string } {
  const names = new Set(["Error", "TypeError", "AbortError", "TimeoutError", "SocketError"]);
  const codes = new Set(["UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_RES_CONTENT_LENGTH_MISMATCH", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "ERR_HTTP2_STREAM_ERROR", "ERR_HTTP2_GOAWAY_SESSION"]);
  let current = error;
  let causeName = "Error";
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    const value = current as { name?: unknown; code?: unknown; cause?: unknown };
    if (depth === 0 && typeof value.name === "string" && names.has(value.name)) causeName = value.name;
    if (typeof value.code === "string" && codes.has(value.code)) return { causeName, causeCode: value.code };
    current = value.cause;
  }
  return { causeName };
}

function responseObject(value: unknown): value is Record<string, any> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function malformedStream(): never { throw new ProjectError("MODEL_ERROR", "The model returned a malformed response frame.", { reason: "response_parse_error" }); }
function optionalString(value: unknown, nullable = false): void { if (value !== undefined && !(nullable && value === null) && typeof value !== "string") malformedStream(); }
/** OpenAI-compatible providers may return assistant text as a string or text parts. */
export function openAIText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) malformedStream();
  let text = "";
  for (const part of value) {
    if (typeof part === "string") { text += part; continue; }
    if (!responseObject(part) || typeof part.text !== "string") malformedStream();
    if (part.type !== undefined && typeof part.type !== "string") malformedStream();
    text += part.text;
  }
  return text;
}
function streamIndex(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) malformedStream();
  return value;
}

/** Only provider response values use this guard; request serialization stays local. */
export function stringifyResponseValue(value: unknown): string {
  try { const json = JSON.stringify(value); if (json !== undefined) return json; }
  catch (error) { throw new ProjectError("MODEL_ERROR", "The model returned unserializable tool arguments.", { reason: "response_parse_error" }, { cause: error }); }
  return malformedStream();
}

/** Shared by JSON and SSE so a partial response cannot become an executable tool call. */
export function assertCompletionStatus(protocol: Protocol, reason: unknown, blockReason?: unknown): void {
  if (protocol === "openai" && (reason === "length" || reason === "content_filter")) throw new ProjectError("MODEL_ERROR", "The model output was interrupted.");
  if ((protocol === "anthropic" && reason === "max_tokens") || (protocol === "gemini" && reason === "MAX_TOKENS")) throw new ProjectError("MODEL_ERROR", "The model output limit interrupted the response.");
  const blockedReasons = ["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION", "MODEL_ARMOR"];
  if (protocol === "gemini" && ((typeof reason === "string" && blockedReasons.includes(reason)) || (typeof blockReason === "string" && blockReason && blockReason !== "BLOCK_REASON_UNSPECIFIED"))) throw new ProjectError("MODEL_ERROR", "The model response was blocked.");
}

export type CompletionDelta =
  | { type: "text-delta"; text: string }
  | { type: "thinking-delta"; text: string }
  | { type: "tool-delta"; index: number; callId?: string; name?: string; arguments?: string };

/** Decode SSE incrementally, retaining raw JSON fragments until a call is complete. */
export async function readProtocolBody(response: Response, protocol: Protocol, onDelta?: (delta: CompletionDelta) => void | Promise<void>, signal?: AbortSignal, onWait?: (waiting: boolean) => void, onDiagnostic?: (event: Omit<DiagnosticEventWithoutId, "attempt">) => Promise<void> | void): Promise<any> {
  if (!response.body) throw new ProjectError("MODEL_ERROR", "The model returned an empty response.", { reason: "response_parse_error" });
  const startedAt = Date.now();
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  let pending = "";
  let frame: string[] = [];
  let frameBytes = 0;
  let streaming = response.headers.get("content-type")?.includes("text/event-stream") ?? false;
  let content = "";
  let thinkingSize = 0;
  let reasoningContent = "";
  let usage: any;
  let frames = 0;
  let ended = false;
  let terminated = false;
  let waitingForData = false;
  let firstDataRecorded = false;
  let skipLineFeed = false;
  const closedBlocks = new Set<number>();
  const calls = new Map<number, any>();
  const thinking = new Map<number, any>();
  const parts: any[] = [];
  const emitDelta = async (delta: CompletionDelta): Promise<void> => {
    try { await onDelta?.(delta); }
    catch (error) {
      if (error instanceof ProjectError) throw error;
      throw new ProjectError("INTERNAL_ERROR", "Unable to process model response updates.", { reason: "response_consumer_error" }, { cause: error });
    }
  };
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", abort, { once: true });
  const emitText = async (value: string) => { content += value; if (content.length > 131_072) throw new ProjectError("MODEL_ERROR", "The model text exceeded the size limit."); if (value) await emitDelta({ type: "text-delta", text: value }); };
  const emitThinking = async (value: string) => { thinkingSize += value.length; if (thinkingSize > 131072) throw new ProjectError("MODEL_ERROR", "The model thinking exceeded the size limit."); if (value) await emitDelta({ type: "thinking-delta", text: value }); };
  const emitTool = async (index: number, call: any, value?: string) => {
    if (calls.size > 16 || String(call.raw ?? "").length > 524_288) throw new ProjectError("MODEL_ERROR", "The model tool calls exceeded the size limit.");
    await emitDelta({ type: "tool-delta", index, ...(call.id ? { callId: call.id } : {}), ...(call.name ? { name: call.name } : {}), ...(value === undefined ? {} : { arguments: value }) });
  };
  const decode = (bytes?: Uint8Array, incremental = false): string => {
    try { return decoder.decode(bytes, { stream: incremental }); }
    catch (error) { throw new ProjectError("MODEL_ERROR", "The model returned invalid JSON or UTF-8.", { reason: "response_parse_error" }, { cause: error }); }
  };
  const wait = (waiting: boolean): void => {
    waitingForData = waiting;
    try { onWait?.(waiting); }
    catch (error) { throw new ProjectError("INTERNAL_ERROR", "Unable to process model response updates.", { reason: "response_consumer_error" }, { cause: error }); }
  };
  const event = async (raw: string) => {
    if (!raw.trim()) return;
    if (raw.trim() === "[DONE]") { ended = true; terminated = true; return; }
    let value: any;
    try { value = JSON.parse(raw); } catch { throw new ProjectError("MODEL_ERROR", "The model returned an invalid stream frame.", { reason: "response_parse_error" }); }
    if (!responseObject(value)) malformedStream();
    frames++;
    if (value.error || value.type === "error") throw new ProjectError("MODEL_ERROR", "The model returned a stream error.");
    if (protocol === "openai") {
      const reason = value.choices?.[0]?.finish_reason;
      if (reason === "stop" || reason === "tool_calls") ended = true;
      assertCompletionStatus(protocol, reason);
      if (value.usage) usage = value.usage;
      const delta = value.choices?.[0]?.delta;
      if (value.choices !== undefined && !Array.isArray(value.choices)) malformedStream();
      if (delta !== undefined && !responseObject(delta)) malformedStream();
      const reasoning = openAIText(delta?.reasoning_content ?? delta?.reasoning);
      if (reasoning) { reasoningContent += reasoning; await emitThinking(reasoning); }
      const textValue = openAIText(delta?.content);
      if (textValue) await emitText(textValue);
      if (delta?.tool_calls != null && !Array.isArray(delta.tool_calls)) malformedStream();
      for (const item of delta?.tool_calls ?? []) {
        if (!responseObject(item) || (item.function !== undefined && !responseObject(item.function))) malformedStream();
        optionalString(item.id); optionalString(item.function?.name); optionalString(item.function?.arguments);
        const index = streamIndex(item.index, calls.size);
        const call = calls.get(index) ?? { id: "", name: "", raw: "" };
        if (item.id) call.id = item.id;
        if (item.function?.name) call.name += item.function.name;
        const fragment = item.function?.arguments ?? "";
        call.raw += fragment; calls.set(index, call); await emitTool(index, call, fragment);
      }
    } else if (protocol === "anthropic") {
      const index = streamIndex(value.index, 0);
      if (value.type === "message_start") usage = value.message?.usage;
      if (value.type === "message_stop") { ended = true; terminated = true; }
      if (value.type === "content_block_stop") closedBlocks.add(index);
      if (value.type === "message_delta") assertCompletionStatus(protocol, value.delta?.stop_reason);
      if (value.type === "message_delta" && value.usage) usage = { ...usage, ...value.usage };
      if (value.type === "content_block_start") {
        const block = value.content_block;
        if (!responseObject(block)) malformedStream();
        if (block.type === "text" && typeof block.text !== "string") malformedStream();
        if (block.type === "thinking") { optionalString(block.thinking); optionalString(block.signature); }
        if (block.type === "redacted_thinking" && typeof block.data !== "string") malformedStream();
        if (block.type === "tool_use" && (typeof block.id !== "string" || !block.id || typeof block.name !== "string" || !block.name || (block.input !== undefined && !responseObject(block.input)))) malformedStream();
        if (block?.type === "tool_use") { const call = { id: block.id, name: block.name, raw: "", initial: block.input ?? {} }; calls.set(index, call); await emitTool(index, call); }
        else if (block?.type === "text" && block.text) await emitText(block.text);
        else if (block?.type === "thinking" || block?.type === "redacted_thinking") { thinking.set(index, { ...block }); if (block.type === "thinking" && block.thinking) await emitThinking(block.thinking); }
      }
      if (value.type === "content_block_delta") {
        if (!responseObject(value.delta) || typeof value.delta.type !== "string") malformedStream();
        const kind = value.delta.type;
        const field = kind === "text_delta" ? "text" : kind === "input_json_delta" ? "partial_json" : kind === "thinking_delta" ? "thinking" : kind === "signature_delta" ? "signature" : undefined;
        if (field && typeof value.delta[field] !== "string") malformedStream();
        if (value.delta?.type === "text_delta") await emitText(value.delta.text ?? "");
        if (value.delta?.type === "input_json_delta") {
          const call = calls.get(index);
          if (!call) throw new ProjectError("MODEL_ERROR", "Tool arguments arrived before their tool block.", { reason: "response_parse_error" });
          const fragment = value.delta.partial_json; call.raw += fragment; await emitTool(index, call, fragment);
        }
        const block = thinking.get(index);
        if (block && value.delta?.type === "thinking_delta") { block.thinking = (block.thinking ?? "") + value.delta.thinking; await emitThinking(value.delta.thinking ?? ""); }
        if (block && value.delta?.type === "signature_delta") block.signature = (block.signature ?? "") + value.delta.signature;
      }
    } else {
      if (value.candidates?.[0]?.finishReason === "STOP") { ended = true; terminated = true; }
      assertCompletionStatus(protocol, value.candidates?.[0]?.finishReason, value.promptFeedback?.blockReason);
      if (value.usageMetadata) usage = { ...usage, ...value.usageMetadata };
      if (value.candidates !== undefined && !Array.isArray(value.candidates)) malformedStream();
      const streamParts = value.candidates?.[0]?.content?.parts;
      if (streamParts !== undefined && !Array.isArray(streamParts)) malformedStream();
      for (const part of value.candidates?.[0]?.content?.parts ?? []) {
        if (!responseObject(part)) malformedStream();
        optionalString(part.text); optionalString(part.thoughtSignature);
        if (part.thought !== undefined && typeof part.thought !== "boolean") malformedStream();
        if (part.functionCall !== undefined && (!responseObject(part.functionCall) || typeof part.functionCall.name !== "string" || !part.functionCall.name || (part.functionCall.args !== undefined && !responseObject(part.functionCall.args)))) malformedStream();
        optionalString(part.functionCall?.id);
        if (typeof part.text === "string" && part.thought) await emitThinking(part.text);
        if (typeof part.text === "string" && !part.thought) { await emitText(part.text); parts.push({ text: part.text }); }
        if (part.functionCall) { const index = calls.size; const call = { id: part.functionCall.id ?? `call_${index}`, name: part.functionCall.name, raw: stringifyResponseValue(part.functionCall.args ?? {}) }; calls.set(index, call); parts.push(part); await emitTool(index, call, call.raw); }
      }
    }
  };
  const frameLimit = (bytes: number) => {
    if (bytes > STREAM_FRAME_BYTES) throw new ProjectError("MODEL_ERROR", "The model stream frame exceeded the size limit.", { reason: "response_frame_limit", limitBytes: STREAM_FRAME_BYTES });
  };
  const sizeLimit = (limitBytes: number, mode: "stream" | "json") => {
    if (size > limitBytes) throw new ProjectError("MODEL_ERROR", "The model response exceeded the size limit.", { reason: "response_size_limit", mode, limitBytes, receivedBytes: size });
  };
  const appendLine = (line: string) => {
    const bytes = Buffer.byteLength(line, "utf8");
    frameLimit(bytes);
    if (line.startsWith("data:")) {
      frameBytes += bytes + 1; frameLimit(frameBytes);
      frame.push(line.slice(5).replace(/^ /, ""));
    }
  };
  const consume = async (chunk: string, final = false) => {
    if (chunk) {
      // SSE accepts LF, CRLF and CR. A CR at a chunk boundary already ended its line.
      const remainder = skipLineFeed && chunk.startsWith("\n") ? chunk.slice(1) : chunk;
      skipLineFeed = chunk.endsWith("\r");
      pending += remainder.replace(/\r\n?/g, "\n");
    }
    while (!terminated && pending.includes("\n")) {
      const end = pending.indexOf("\n"); const line = pending.slice(0, end); pending = pending.slice(end + 1);
      if (!line) { if (frame.length) { await event(frame.join("\n")); frame = []; frameBytes = 0; } }
      else appendLine(line);
    }
    if (terminated) { pending = ""; return; }
    frameLimit(frameBytes + Buffer.byteLength(pending, "utf8"));
    if (final) { if (pending.startsWith("data:")) appendLine(pending); if (frame.length) await event(frame.join("\n")); }
  };
  try {
    while (true) {
      signal?.throwIfAborted();
      wait(true);
      let next: Awaited<ReturnType<typeof reader.read>>;
      try { next = await reader.read(); }
      catch (error) {
        const transport = transportCause(error);
        const details = { reason: "response_stream_error", protocol, receivedBytes: size, receivedFrames: frames, completionReceived: ended, aborted: signal?.aborted ?? false, elapsedMs: Math.max(0, Date.now() - startedAt), ...transport };
        try { await onDiagnostic?.({ type: "stream_read_error", errorCategory: "response_stream_error", ...(transport.causeCode ? { causeCode: transport.causeCode } : {}), receivedBytes: size, receivedFrames: frames, completionReceived: ended, elapsedMs: details.elapsedMs }); }
        catch { console.warn("[SpecLoom] diagnostic_log_write_failed"); }
        // Record only counters and allowlisted network codes, never raw errors or response data.
        console.warn("[SpecLoom] model_stream_error", JSON.stringify({ at: new Date().toISOString(), ...details }));
        // OpenAI proxies can reset after finish_reason while omitting DONE/usage.
        // Retain a completed response only at a frame boundary; validation still follows.
        if (streaming && ended && !pending.trim() && !frame.length && !signal?.aborted) { wait(false); break; }
        throw new ProjectError("MODEL_ERROR", "The model stream failed while receiving data.", details, { cause: error });
      }
      wait(false); signal?.throwIfAborted(); if (next.done) break;
      size += next.value.byteLength;
      if (!firstDataRecorded && next.value.byteLength > 0) {
        firstDataRecorded = true;
        try { await onDiagnostic?.({ type: "first_stream_data", receivedBytes: size, elapsedMs: Math.max(0, Date.now() - startedAt) }); }
        catch { console.warn("[SpecLoom] diagnostic_log_write_failed"); }
      }
      // SSE repeats metadata for every small delta; bound wire overhead separately from content.
      if (size > STREAM_RESPONSE_BYTES) sizeLimit(streaming ? STREAM_RESPONSE_BYTES : JSON_RESPONSE_BYTES, streaming ? "stream" : "json");
      let decoded = decode(next.value, true);
      if (!streaming) {
        text += decoded;
        if (/^\s*(?:data:|event:|:)/.test(text)) { streaming = true; decoded = text; text = ""; }
        else { sizeLimit(JSON_RESPONSE_BYTES, "json"); continue; }
      }
      await consume(decoded);
      // Completion markers end the protocol, even if a proxy keeps the HTTP body open.
      // OpenAI finish_reason is not terminal: its usage frame can arrive before [DONE].
      if (terminated) { await reader.cancel().catch(() => undefined); break; }
    }
    if (!streaming) {
      let body: any;
      try { body = JSON.parse(text + decode()); }
      catch (error) { throw new ProjectError("MODEL_ERROR", "The model returned invalid JSON or UTF-8.", { reason: "response_parse_error" }, { cause: error }); }
      if (!responseObject(body)) malformedStream();
      assertCompletionStatus(protocol, protocol === "openai" ? body.choices?.[0]?.finish_reason : protocol === "anthropic" ? body.stop_reason : body.candidates?.[0]?.finishReason, body.promptFeedback?.blockReason);
      if (protocol === "anthropic" && body.content !== undefined && (!Array.isArray(body.content) || !body.content.every(responseObject))) malformedStream();
      const jsonParts = body.candidates?.[0]?.content?.parts;
      if (protocol === "gemini" && jsonParts !== undefined && (!Array.isArray(jsonParts) || !jsonParts.every(responseObject))) malformedStream();
      if (protocol === "openai") { const value = body.choices?.[0]?.message; if (typeof (value?.reasoning_content ?? value?.reasoning) === "string") await emitThinking(value.reasoning_content ?? value.reasoning); }
      if (protocol === "anthropic") for (const block of body.content ?? []) if (block.type === "thinking" && typeof block.thinking === "string") await emitThinking(block.thinking);
      if (protocol === "gemini") for (const part of body.candidates?.[0]?.content?.parts ?? []) if (part.thought && typeof part.text === "string") await emitThinking(part.text);
      return body;
    }
    if (!terminated) await consume(decode(), true);
    if (!frames) throw new ProjectError("MODEL_ERROR", "The model returned an empty stream.", { reason: "response_parse_error" });
    if (calls.size && !ended && !(protocol === "anthropic" && [...calls.keys()].every((index) => closedBlocks.has(index)))) throw new ProjectError("MODEL_ERROR", "The model tool stream ended before completion.", { reason: "response_parse_error" });
    for (const call of calls.values()) { if (call.raw) { try { JSON.parse(call.raw); } catch { throw new ProjectError("MODEL_ERROR", "The model returned incomplete tool arguments.", { reason: "response_parse_error" }); } } }
    if (protocol === "openai") return { choices: [{ message: { role: "assistant", content: content || null, ...(reasoningContent ? { reasoning_content: reasoningContent } : {}), ...(calls.size ? { tool_calls: [...calls.values()].map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.raw || "{}" } })) } : {}) } }], usage };
    if (protocol === "anthropic") return { content: [{ type: "text", text: content }, ...thinking.values(), ...[...calls.values()].map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.raw ? JSON.parse(call.raw) : call.initial }))], usage };
    return { candidates: [{ content: { parts } }], usageMetadata: usage };
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort); reader.releaseLock();
    // A pending wait here means the read failed; cleanup must preserve that failure.
    if (waitingForData) { try { wait(false); } catch { /* preserve the original error */ } }
  }
}
