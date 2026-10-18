import { expect, test, vi } from "vitest";
import { AgentRuntime, noToolsCatalog, type AgentEvent } from "../../src/main/core/agent-runtime";

test("split credentials never appear in streaming events", async () => {
  const events: AgentEvent[] = []; const credential = "SECRET-CREDENTIAL";
  const runtime = new AgentRuntime({ catalog: noToolsCatalog, executeTool: async () => ({}), resolveCredential: async () => credential, onEvent: (event) => { events.push(event); }, fetch: async () => new Response(Array.from(`hello ${credential} done`).map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }) });
  await runtime.run({ taskId: "s", prompt: "hi", profile: { id: "m", name: "M", provider: "openai-compatible", protocol: "openai", model: "m", baseUrl: "http://model.test/v1", approved: true, timeoutMs: 1000, maxToolRounds: 2 } });
  const text = events.filter((e) => e.type === "text").map((e) => e.content);
  expect(text.some((s) => s.includes("hello S"))).toBe(false);
  expect(text.at(-1)).toBe("hello [redacted] done");
});

test("a short safe first chunk stays visible before EOF when a long API key is configured", async () => {
  const events: AgentEvent[] = []; let stream!: ReadableStreamDefaultController<Uint8Array>;
  const runtime = new AgentRuntime({ catalog: noToolsCatalog, executeTool: async () => ({}), resolveCredential: async () => "sk-" + "x".repeat(80), onEvent: (event) => { events.push(event); }, fetch: async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"首段"}}]}\n\n')); } }), { headers: { "content-type": "text/event-stream" } }) });
  const running = runtime.run({ taskId: "s", prompt: "hi", profile: { id: "m", name: "M", provider: "openai-compatible", protocol: "openai", model: "m", baseUrl: "http://model.test/v1", approved: true, timeoutMs: 10000, maxToolRounds: 2 } });
  try { await vi.waitFor(() => expect(events.some((e) => e.type === "text" && e.content === "首段")).toBe(true)); }
  finally { stream.close(); await running; }
});

test("credentials remain redacted when text is split around an interleaved tool", async () => {
  const events: AgentEvent[] = []; let calls = 0;
  const frames = [
    { choices: [{ delta: { content: "before SEC" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "t", function: { name: "read_file", arguments: '{"path":"x","expectedVersion":"absent"}' } }] } }] },
    { choices: [{ delta: { content: "RET after" } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ];
  const runtime = new AgentRuntime({ catalog: noToolsCatalog, executeTool: async () => ({}), resolveCredential: async () => "SECRET", onEvent: (event) => { events.push(event); }, fetch: async () => ++calls === 1 ? new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }) : Response.json({ choices: [{ message: { role: "assistant", content: "done" } }] }) });
  await runtime.run({ taskId: "s", prompt: "hi", profile: { id: "m", name: "M", provider: "openai-compatible", protocol: "openai", model: "m", baseUrl: "http://model.test/v1", approved: true, timeoutMs: 1000, maxToolRounds: 2 } });
  const text = events.filter((e) => e.type === "text").map((e) => e.content);
  expect(text.some((t) => t.includes("SEC") || t.includes("RET"))).toBe(false);
  expect(text).toContain("before [redacted]"); expect(text).toContain(" after");
});
