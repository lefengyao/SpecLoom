import { afterEach, expect, test, vi } from "vitest";
import { requestCompletion } from "../../src/main/core/agent-client";

afterEach(() => vi.useRealTimers());
const encoder = new TextEncoder();
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const profile = { id: "fixture", name: "Fixture", provider: "openai-compatible" as const,
  model: "fixture", baseUrl: "https://model.test/v1", approved: true, timeoutMs: 100, maxToolRounds: 2 };

test.each(["openai", "anthropic", "gemini"] as const)("%s completes at its terminal event without waiting for the HTTP body to close", async protocol => {
  vi.useFakeTimers();
  const cancelled = vi.fn();
  const onUsage = vi.fn();
  const frames = protocol === "openai"
    ? frame({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }) + frame({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } }) + "data: [DONE]\n\n"
    : protocol === "anthropic"
      ? frame({ type: "message_start", message: { usage: { input_tokens: 7 } } }) + frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } }) + frame({ type: "message_delta", usage: { output_tokens: 3 } }) + frame({ type: "message_stop" })
      : frame({ candidates: [{ content: { parts: [{ text: "done" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 } });
  const pending = requestCompletion({ profile: { ...profile, protocol }, messages: [], tools: [], canRetry: false,
    onDelta: () => {}, onUsage }, async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(frames)); }, cancel: cancelled,
    }), { headers: { "content-type": "text/event-stream" } }));
  const checked = pending.then(message => ({ message, error: undefined }), error => ({ message: undefined, error }));
  await vi.advanceTimersByTimeAsync(101);
  expect((await checked).error).toBeUndefined();
  expect((await checked).message?.content).toBe("done");
  expect(onUsage).toHaveBeenCalledWith({ promptTokens: 7, completionTokens: 3, cachedTokens: 0, cacheWriteTokens: 0 });
  expect(cancelled).toHaveBeenCalled();
});

test("OpenAI finish_reason retains the later usage frame before DONE", async () => {
  vi.useFakeTimers();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let settled = false;
  const onUsage = vi.fn();
  const pending = requestCompletion({ profile: { ...profile, protocol: "openai" }, messages: [], tools: [], canRetry: false,
    onDelta: () => {}, onUsage }, async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }),
  { headers: { "content-type": "text/event-stream" } }));
  const checked = pending.then(message => { settled = true; return { message, error: undefined }; }, error => { settled = true; return { message: undefined, error }; });
  await vi.advanceTimersByTimeAsync(0);
  stream.enqueue(encoder.encode(frame({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] })));
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false);
  stream.enqueue(encoder.encode(frame({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }) + "data: [DONE]\n\n"));
  await vi.advanceTimersByTimeAsync(101);
  expect((await checked).error).toBeUndefined();
  expect(onUsage).toHaveBeenCalledWith({ promptTokens: 5, completionTokens: 2, cachedTokens: 0, cacheWriteTokens: 0 });
});

test.each(["stop", "tool_calls"])("accepts a validated OpenAI %s completion when the connection resets before DONE", async finishReason => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const delta = finishReason === "stop" ? { content: "complete answer" } : { tool_calls: [{ index: 0, id: "c", function: { name: "inspect", arguments: "{}" } }] };
  let delivered = false;
  const pending = requestCompletion({ profile, messages: [], tools: [], canRetry: false, onDelta: () => { delivered = true; } }, async () =>
    new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }), { headers: { "content-type": "text/event-stream" } }));
  const checked = pending.then(message => ({ message, error: undefined }), error => ({ message: undefined, error }));
  await vi.waitFor(() => expect(stream).toBeDefined());
  stream.enqueue(encoder.encode(frame({ choices: [{ delta, finish_reason: finishReason }] })));
  await vi.waitFor(() => expect(delivered).toBe(true));
  stream.error(new TypeError("socket terminated"));
  const result = await checked;
  expect(result.error).toBeUndefined();
  if (finishReason === "stop") expect(result.message?.content).toBe("complete answer");
  else expect(result.message?.tool_calls).toHaveLength(1);
});

test("does not accept unfinished trailing data after an OpenAI finish reason", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let delivered = false;
  const pending = requestCompletion({ profile, messages: [], tools: [], canRetry: false, onDelta: () => { delivered = true; } }, async () =>
    new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }), { headers: { "content-type": "text/event-stream" } }));
  const checked = pending.then(() => undefined, error => error);
  await vi.waitFor(() => expect(stream).toBeDefined());
  stream.enqueue(encoder.encode(frame({ choices: [{ delta: { content: "answer" }, finish_reason: "stop" }] }) + 'data: {"choices":'));
  await vi.waitFor(() => expect(delivered).toBe(true));
  stream.error(new TypeError("socket terminated"));
  expect(await checked).toMatchObject({ details: { reason: "response_stream_error" } });
});

test.each(["\r", "\r\n", "\n"])("decodes multiline SSE using %j line endings split across byte boundaries", async ending => {
  const deltas: string[] = [];
  const text = ["data: {\"choices\":[", "data: {\"delta\":{\"content\":\"你好\"},\"finish_reason\":\"stop\"}", "data: ]}", "", "data: [DONE]", "", ""].join(ending);
  const pending = requestCompletion({ profile: { ...profile, protocol: "openai" }, messages: [], tools: [], canRetry: false,
    onDelta: delta => { if (delta.type === "text-delta") deltas.push(delta.text); } }, async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { for (const byte of encoder.encode(text)) controller.enqueue(new Uint8Array([byte])); controller.close(); },
    }), { headers: { "content-type": "text/event-stream" } }));
  const checked = pending.then(message => ({ message, error: undefined }), error => ({ message: undefined, error }));
  expect((await checked).error).toBeUndefined();
  expect((await checked).message?.content).toBe("你好");
  expect(deltas).toEqual(["你好"]);
});

test.each(["length", "content_filter"])("legacy JSON requests reject %s before dispatching a tool call", async finishReason => {
  const pending = requestCompletion({ profile, messages: [], tools: [], canRetry: false }, async () => new Response(JSON.stringify({
    choices: [{ finish_reason: finishReason, message: { role: "assistant", content: null,
      tool_calls: [{ id: "call", type: "function", function: { name: "write", arguments: "{}" } }] } }],
  }), { headers: { "content-type": "application/json" } }));
  await expect(pending).rejects.toMatchObject({ code: "MODEL_ERROR", message: "The model output was interrupted." });
});
