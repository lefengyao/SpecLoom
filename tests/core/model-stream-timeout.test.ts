import { afterEach, expect, test, vi } from "vitest";
import { requestCompletion, type CompletionRequest } from "../../src/main/core/agent-client";

afterEach(() => { vi.useRealTimers(); });

const profile = { id: "m", name: "M", provider: "openai-compatible" as const, protocol: "openai" as const,
  model: "deepseek-flash", baseUrl: "https://model.test/v1", approved: true, timeoutMs: 100, maxToolRounds: 2 };
const sse = (delta: Record<string, unknown>, finish_reason?: string) =>
  new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta, ...(finish_reason ? { finish_reason } : {}) }] })}\n\n`);

async function streamRequest(overrides: Partial<CompletionRequest> = {}, headerDelay = 0) {
  vi.useFakeTimers();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let signal!: AbortSignal;
  const pending = requestCompletion({ profile, messages: [{ role: "user", content: "go" }], tools: [], canRetry: false,
    onDelta: () => {}, ...overrides }, async (_url, init) => {
    signal = init!.signal!;
    if (headerDelay) await new Promise(resolve => setTimeout(resolve, headerDelay));
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }),
      { headers: { "content-type": "text/event-stream" } });
  });
  // Observe failures immediately so the fake clock cannot produce an unhandled rejection.
  const result = pending.then(message => ({ message, error: undefined }), error => ({ message: undefined, error }));
  await vi.advanceTimersByTimeAsync(headerDelay);
  return { stream, signal, result };
}

test("continuous thinking can run past the timeout while data keeps arriving", async () => {
  const { stream, signal, result } = await streamRequest();
  for (let index = 0; index < 6; index++) {
    await vi.advanceTimersByTimeAsync(60);
    expect(signal.aborted).toBe(false);
    stream.enqueue(sse({ reasoning_content: "思考" }));
    await vi.advanceTimersByTimeAsync(0);
  }
  stream.enqueue(sse({ content: "done" }, "stop")); stream.close();
  expect((await result).message?.content).toBe("done");
});

test("SSE keep-alive comments reset the wait for data even without a text delta", async () => {
  const { stream, signal, result } = await streamRequest({}, 80);
  for (let index = 0; index < 3; index++) {
    await vi.advanceTimersByTimeAsync(80);
    expect(signal.aborted).toBe(false);
    stream.enqueue(new TextEncoder().encode(": keep-alive\n\n"));
    await vi.advanceTimersByTimeAsync(0);
  }
  stream.enqueue(sse({ content: "done" }, "stop")); stream.close();
  expect((await result).message?.content).toBe("done");
});

test("a stalled stream times out with the configured idle duration", async () => {
  const { stream, result } = await streamRequest();
  stream.enqueue(sse({ reasoning_content: "started" }));
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(101);
  expect((await result).error).toMatchObject({ code: "MODEL_ERROR", details: { reason: "idle_timeout", timeoutMs: 100 } });
});

test("local delta persistence does not consume the provider wait timeout", async () => {
  const { stream, signal, result } = await streamRequest({
    onDelta: async () => { await new Promise(resolve => setTimeout(resolve, 250)); },
  });
  stream.enqueue(sse({ content: "done" }, "stop")); stream.close();
  await vi.advanceTimersByTimeAsync(251);
  expect(signal.aborted).toBe(false);
  expect((await result).message?.content).toBe("done");
});

test("user cancellation remains immediate while a stream is waiting", async () => {
  const controller = new AbortController();
  const { result } = await streamRequest({ signal: controller.signal });
  controller.abort();
  expect((await result).error).toMatchObject({ code: "MODEL_ERROR", message: "The agent run was cancelled." });
});

test("a server that never returns headers still times out", async () => {
  vi.useFakeTimers();
  const pending = requestCompletion({ profile, messages: [], tools: [], canRetry: false }, async (_url, init) =>
    new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true })));
  const checked = pending.then(() => undefined, error => error);
  await vi.advanceTimersByTimeAsync(101);
  expect(await checked).toMatchObject({ details: { reason: "idle_timeout", timeoutMs: 100 } });
});
