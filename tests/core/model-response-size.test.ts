import { expect, test, vi } from "vitest";
import { requestCompletion } from "../../src/main/core/agent-client";
import { readProtocolBody } from "../../src/main/core/protocol-stream";

const encoder = new TextEncoder();
const profile = { id: "fixture", name: "Fixture", provider: "openai-compatible" as const, protocol: "openai" as const,
  model: "fixture", baseUrl: "https://model.test/v1", approved: true, timeoutMs: 1000, maxToolRounds: 1, maxOutputTokens: 32768 };

test.each(["text/event-stream", "application/json"])("allows normal long reasoning with SSE overhead above 1 MiB (%s)", async contentType => {
  const frame = `data: ${JSON.stringify({ id: "chatcmpl-" + "x".repeat(256), object: "chat.completion.chunk", created: 1,
    choices: [{ delta: { reasoning_content: "考" } }] })}\n\n`;
  const stream = frame.repeat(4000) + 'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n';
  expect(encoder.encode(stream).byteLength).toBeGreaterThan(1_048_576);
  let thinking = "";
  const message = await requestCompletion({ profile, messages: [], tools: [], canRetry: false,
    onDelta: delta => { if (delta.type === "thinking-delta") thinking += delta.text; } },
  async () => new Response(stream, { headers: { "content-type": contentType } }));
  expect(message.content).toBe("done");
  expect(message.reasoning_content).toBe("考".repeat(4000));
  expect(thinking).toBe(message.reasoning_content);
});

test("retains the 1 MiB non-streaming JSON limit", async () => {
  const body = JSON.stringify({ padding: "x".repeat(1_048_576), choices: [{ message: { content: "done" } }] });
  await expect(readProtocolBody(new Response(body, { headers: { "content-type": "application/json" } }), "openai"))
    .rejects.toMatchObject({ code: "MODEL_ERROR", details: { reason: "response_size_limit", mode: "json" } });
});

test.each(["\n\n", ""])("bounds an oversized single SSE frame, including an unfinished one (%j)", async ending => {
  const cancelled = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ padding: "x".repeat(1_048_576), choices: [{ delta: { content: "done" } }] })}${ending}`));
  }, cancel: cancelled });
  await expect(readProtocolBody(new Response(body, { headers: { "content-type": "text/event-stream" } }), "openai"))
    .rejects.toMatchObject({ code: "MODEL_ERROR", details: { reason: "response_frame_limit" } });
  expect(cancelled).toHaveBeenCalled();
});

test("bounds total SSE transport even when each frame is small and cancels the remaining body", async () => {
  const chunk = encoder.encode(": " + "x".repeat(512 * 1024) + "\n\n");
  const cancelled = vi.fn();
  const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(chunk); }, cancel: cancelled });
  await expect(readProtocolBody(new Response(body, { headers: { "content-type": "text/event-stream" } }), "openai"))
    .rejects.toMatchObject({ code: "MODEL_ERROR", details: { reason: "response_size_limit", mode: "stream", limitBytes: 32 * 1024 * 1024 } });
  expect(cancelled).toHaveBeenCalled();
});

test.each(["content", "reasoning_content"])("retains the decoded %s limit independently of transport overhead", async field => {
  const body = `data: ${JSON.stringify({ choices: [{ delta: { [field]: "x".repeat(131_073) } }] })}\n\n`;
  await expect(readProtocolBody(new Response(body, { headers: { "content-type": "text/event-stream" } }), "openai"))
    .rejects.toMatchObject({ code: "MODEL_ERROR", message: `The model ${field === "content" ? "text" : "thinking"} exceeded the size limit.` });
});
