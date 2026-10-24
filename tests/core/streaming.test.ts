import { expect, test, vi } from "vitest";
import { requestProtocolCompletion, type ProtocolRequest } from "../../src/main/core/protocols";
import { readProtocolBody } from "../../src/main/core/protocol-stream";

const base = { baseUrl: "https://model.test/v1", model: "test", messages: [{ role: "user" as const, content: "hello" }], tools: [] };
const sse = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;

test.each(["openai", "anthropic", "gemini"] as const)("%s forwards provider thinking separately from answer", async (protocol) => {
  const deltas: unknown[] = [];
  const frames = protocol === "openai" ? [{ choices: [{ delta: { reasoning_content: "先检查依赖", content: "回答" } }] }]
    : protocol === "anthropic" ? [{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }, { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "先检查依赖" } }, { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "回答" } }]
    : [{ candidates: [{ content: { parts: [{ thought: true, text: "先检查依赖" }, { text: "回答" }] } }] }];
  const result = await requestProtocolCompletion({ ...base, protocol, onDelta: d => { deltas.push(d); }, fetcher: async () => new Response(frames.map(sse).join(""), { headers: { "content-type": "text/event-stream" } }) });
  expect(deltas).toContainEqual({ type: "thinking-delta", text: "先检查依赖" });
  expect(result.message.content).toBe("回答");
});

test("accepts MiMo text parts and null optional tool_calls", async () => {
  const frames = [
    { choices: [{ index: 0, delta: { content: "", role: "assistant", tool_calls: null, reasoning_content: null }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: null, role: null, tool_calls: null, reasoning_content: "Hmm" }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: [{ type: "text", text: "Hello" }], tool_calls: null, reasoning_content: null }, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } },
  ];
  const deltas: unknown[] = [];
  const result = await requestProtocolCompletion({ ...base, protocol: "openai", onDelta: (delta) => { deltas.push(delta); }, fetcher: async () => new Response(frames.map(sse).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }) });
  expect(deltas).toContainEqual({ type: "thinking-delta", text: "Hmm" });
  expect(deltas).toContainEqual({ type: "text-delta", text: "Hello" });
  expect(result.message.content).toBe("Hello");
  expect(result.usage).toMatchObject({ promptTokens: 1, completionTokens: 2 });
});

test("retains arbitrary Anthropic JSON fragments for each tool block", async () => {
  const frames = [
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "c1", name: "files_read", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"spe' } },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "c2", name: "lookup", input: {} } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"q":1}' } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'cs/project.md"}' } },
    { type: "content_block_stop", index: 1 }, { type: "content_block_stop", index: 2 }, { type: "message_stop" },
  ];
  const result = await requestProtocolCompletion({ ...base, protocol: "anthropic", fetcher: async () => new Response(frames.map(sse).join(""), { headers: { "content-type": "text/event-stream" } }) });
  expect(result.message.tool_calls?.map((c) => JSON.parse(c.function.arguments))).toEqual([{ path: "specs/project.md" }, { q: 1 }]);
});

test.each(["openai", "anthropic", "gemini"] as const)("%s shows UTF-8 text before stream closure", async (protocol) => {
  const received: unknown[] = [];
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let url = "";
  let body: Record<string, unknown> = {};
  const frame = protocol === "openai" ? { choices: [{ delta: { content: "你好" } }] } : protocol === "anthropic" ? { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你好" } } : { candidates: [{ content: { parts: [{ text: "你好" }] } }] };
  const request = requestProtocolCompletion({ ...base, protocol, onDelta: (delta: unknown) => { received.push(delta); }, fetcher: async (input, init) => {
    url = String(input); body = JSON.parse(String(init?.body));
    return new Response(new ReadableStream({ start(controller) { stream = controller; } }), { headers: { "content-type": "text/event-stream" } });
  } } as ProtocolRequest);
  await vi.waitFor(() => expect(stream).toBeDefined());
  const bytes = new TextEncoder().encode(sse(frame));
  for (const byte of bytes) stream.enqueue(new Uint8Array([byte]));
  try { await vi.waitFor(() => expect(received).toContainEqual({ type: "text-delta", text: "你好" }), { timeout: 500 }); }
  finally { stream.close(); }
  expect((await request).message.content).toBe("你好");
  if (protocol === "gemini") expect(url).toContain(":streamGenerateContent?alt=sse");
  else expect(body.stream).toBe(true);
});

test("aborts a stalled reader and preserves emitted partial text", async () => {
  const controller = new AbortController();
  const deltas: unknown[] = [];
  const cancel = vi.fn();
  const request = requestProtocolCompletion({ ...base, protocol: "openai", signal: controller.signal, onDelta: (d: unknown) => { deltas.push(d); }, fetcher: async () => new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode(sse({ choices: [{ delta: { content: "partial" } }] }))); }, cancel }), { headers: { "content-type": "text/event-stream" } }) } as ProtocolRequest);
  await vi.waitFor(() => expect(deltas).toHaveLength(1));
  controller.abort();
  await expect(request).rejects.toBeDefined();
  expect(cancel).toHaveBeenCalled();
});

test("does not classify a consumer callback failure as malformed JSON", async () => {
  const request = requestProtocolCompletion({ ...base, protocol: "openai", onDelta: () => { throw new Error("renderer persistence failed"); }, fetcher: async () => new Response(sse({ choices: [{ delta: { content: "partial" } }] }), { headers: { "content-type": "text/event-stream" } }) });
  await expect(request).rejects.toMatchObject({ code: "INTERNAL_ERROR", message: "Unable to process model response updates.", details: { reason: "response_consumer_error" } });
});

test("classifies a failed response body read as a transport failure", async () => {
  const request = requestProtocolCompletion({ ...base, protocol: "openai", fetcher: async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(new TypeError("socket terminated")); } }), { headers: { "content-type": "text/event-stream" } }) });
  await expect(request).rejects.toMatchObject({ code: "MODEL_ERROR", message: "The model stream failed while receiving data.", details: { reason: "response_stream_error" } });
});

test("keeps safe transport diagnostics without copying socket data or credentials", async () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const failure = new TypeError("terminated Bearer private-token", { cause: Object.assign(new Error("private socket details"), { code: "UND_ERR_SOCKET", socket: { remoteAddress: "private-address" } }) });
  const request = requestProtocolCompletion({ ...base, protocol: "openai", fetcher: async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(failure); } }), { headers: { "content-type": "text/event-stream" } }) });
  let error: unknown;
  try { await request; } catch (next) { error = next; }
  expect(error).toMatchObject({ code: "MODEL_ERROR", details: { reason: "response_stream_error", causeName: "TypeError", causeCode: "UND_ERR_SOCKET", completionReceived: false, receivedBytes: 0, receivedFrames: 0, elapsedMs: expect.any(Number) } });
  const details = JSON.stringify((error as { details: unknown }).details);
  expect(details).not.toMatch(/private-token|private-address|private socket|Bearer/);
  expect(log).toHaveBeenCalledWith("[SpecLoom] model_stream_error", expect.stringContaining('"causeCode":"UND_ERR_SOCKET"'));
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-token|private-address|private socket|Bearer/);
});

test("omits unknown transport error names and codes", async () => {
  const failure = Object.assign(new Error("private-token"), { name: "private-token", code: "private-token" });
  const request = requestProtocolCompletion({ ...base, protocol: "openai", fetcher: async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(failure); } })) });
  let error: unknown;
  try { await request; } catch (next) { error = next; }
  expect(error).toMatchObject({ details: { reason: "response_stream_error", causeName: "Error" } });
  expect(JSON.stringify((error as { details: unknown }).details)).not.toContain("private-token");
});

test("accepts MiMo usage frames with null choices and null tool arguments", async () => {
  const frames = [
    { choices: null, usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c", function: { name: "write", arguments: null } }] }, finish_reason: "tool_calls" }] },
  ];
  const result = await requestProtocolCompletion({ ...base, protocol: "openai", fetcher: async () => new Response(frames.map(sse).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }) });
  expect(result.message.tool_calls?.[0]?.function.arguments).toBe("{}");
  expect(result.usage).toMatchObject({ promptTokens: 1, completionTokens: 2 });
});

test("still classifies invalid UTF-8 as a recoverable parsing failure", async () => {
  const request = requestProtocolCompletion({ ...base, protocol: "openai", fetcher: async () => new Response(new Uint8Array([0xc3, 0x28]), { headers: { "content-type": "application/json" } }) });
  await expect(request).rejects.toMatchObject({ code: "MODEL_ERROR", details: { reason: "response_parse_error" } });
});

test("does not accept a truncated SSE tool call just because its JSON looks complete", async () => {
  const input = { ...base, protocol: "openai" as const, fetcher: async () => new Response(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "write", arguments: "{}" } }] } }] }), { headers: { "content-type": "text/event-stream" } }) };
  await expect(requestProtocolCompletion(input)).rejects.toThrow();
});

test.each([
  ["openai", { choices: [{ delta: { tool_calls: [{ index: "bad", id: "c", function: { name: "write", arguments: "{}" } }] } }] }],
  ["openai", { choices: [{ delta: { tool_calls: [{ index: -1, id: "c", function: { name: "write", arguments: "{}" } }] } }] }],
  ["openai", { choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "write", arguments: 123 } }] } }] }],
  ["openai", { choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "write", arguments: {} } }] } }] }],
  ["openai", { choices: [{ delta: { content: 123 } }] }],
  ["openai", { choices: [{ delta: { reasoning_content: {} } }] }],
  ["anthropic", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: 123 } }],
  ["anthropic", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: 123 } }],
  ["anthropic", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "c", name: 123, input: {} } }],
  ["anthropic", { type: "content_block_delta", index: 0, delta: { type: { toString: null, valueOf: null } } }],
  ["gemini", { candidates: [{ content: { parts: [{ text: 123 }] } }] }],
  ["gemini", { candidates: [{ content: { parts: [{ functionCall: { name: 123, args: {} } }] } }] }],
] as const)("rejects malformed %s stream fields before sending updates (%j)", async (protocol, frame) => {
  const deltas: unknown[] = [];
  await expect(requestProtocolCompletion({ ...base, protocol, onDelta: (delta) => { deltas.push(delta); }, fetcher: async () => new Response(sse(frame) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }) }))
    .rejects.toMatchObject({ code: "MODEL_ERROR", details: { reason: "response_parse_error" } });
  expect(deltas).toEqual([]);
});

test.each(["input_json_delta", "thinking_delta", "signature_delta"])("rejects malformed Anthropic %s fragments", async (type) => {
  const block = type === "input_json_delta" ? { type: "tool_use", id: "c", name: "write", input: {} } : { type: "thinking", thinking: "" };
  const field = type === "input_json_delta" ? "partial_json" : type === "thinking_delta" ? "thinking" : "signature";
  const frames = [{ type: "content_block_start", index: 0, content_block: block }, { type: "content_block_delta", index: 0, delta: { type, [field]: 123 } }, { type: "message_stop" }];
  await expect(requestProtocolCompletion({ ...base, protocol: "anthropic", fetcher: async () => new Response(frames.map(sse).join(""), { headers: { "content-type": "text/event-stream" } }) }))
    .rejects.toMatchObject({ code: "MODEL_ERROR", details: { reason: "response_parse_error" } });
});

test("reports a body wait callback failure as a local processing error", async () => {
  await expect(readProtocolBody(Response.json({ choices: [{ message: { content: "answer" } }] }), "openai", undefined, undefined, (waiting) => { if (waiting) throw new Error("local clock failed"); }))
    .rejects.toMatchObject({ code: "INTERNAL_ERROR", details: { reason: "response_consumer_error" } });
});

test("stops waiting after a failed body read without masking the transport error", async () => {
  const states: boolean[] = [];
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(new TypeError("socket terminated")); } }));
  await expect(readProtocolBody(response, "openai", undefined, undefined, (waiting) => { states.push(waiting); if (!waiting) throw new Error("cleanup failed"); }))
    .rejects.toMatchObject({ code: "MODEL_ERROR", details: { reason: "response_stream_error" } });
  expect(states).toEqual([true, false]);
});
