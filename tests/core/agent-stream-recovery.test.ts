import { expect, test, vi } from "vitest";
import * as timers from "node:timers/promises";
import { AgentRuntime, noToolsCatalog, type AgentEvent } from "../../src/main/core/agent-runtime";

vi.mock("node:timers/promises", { spy: true });

const profile = { id: "fixture", name: "Fixture", provider: "openai-compatible" as const, protocol: "openai" as const,
  model: "fixture", baseUrl: "https://model.test/v1", approved: true, timeoutMs: 1000, maxToolRounds: 3 };
const complete = (message: object = { role: "assistant", content: "done" }) => Response.json({ choices: [{ message }] });
function failedStream(delta?: object) {
  let sent = false;
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (!sent && delta) { sent = true; controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`)); }
    else controller.error(new TypeError("socket terminated"));
  } }), { headers: { "content-type": "text/event-stream" } });
}

test("retries an interrupted response with the same conversation and resets only its partial output", async () => {
  const events: AgentEvent[] = [];
  const bodies: unknown[] = [];
  const executeTool = vi.fn(async () => "must not run");
  const runtime = new AgentRuntime({ catalog: noToolsCatalog, executeTool, onEvent: event => { events.push(event); },
    fetch: async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return bodies.length === 1 ? failedStream({ content: "partial" }) : complete(); } });
  const result = await runtime.run({ taskId: "t", profile, prompt: "go" });
  expect(result.summary).toBe("done");
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(events.some(event => event.type === "response-reset" && event.messageIds.length === 1)).toBe(true);
  expect(events.some(event => event.type === "activity" && event.content.includes("重试"))).toBe(true);
  expect(executeTool).not.toHaveBeenCalled();
});

test("records a private correlated trace across stream retry without storing partial content", async () => {
  const recorded: Array<Record<string, unknown>> = [];
  const runtime = new AgentRuntime({ catalog: noToolsCatalog, executeTool: async () => undefined,
    onDiagnostic: event => { recorded.push(event as unknown as Record<string, unknown>); },
    fetch: async () => recorded.some(event => event.type === "stream_read_error") ? complete() : failedStream({ content: "partial assistant text" }) });

  await runtime.run({ taskId: "t", sessionId: "session-1", runId: "run-1", profile, prompt: "go" });

  const readError = recorded.find(event => event.type === "stream_read_error");
  expect(readError).toMatchObject({ diagnosticId: expect.any(String), attempt: 1, errorCategory: "response_stream_error", completionReceived: false });
  expect(recorded.filter(event => event.type === "request_started").map(event => event.diagnosticId)).toEqual([readError?.diagnosticId, readError?.diagnosticId]);
  expect(recorded.map(event => event.type)).toEqual(expect.arrayContaining(["response_headers", "first_stream_data", "retry_scheduled", "request_completed"]));
  expect(recorded.every(event => event.sessionId === "session-1" && event.runId === "run-1")).toBe(true);
  expect(JSON.stringify(recorded)).not.toContain("partial assistant text");
});

test("stops after five transport retries and never adds model correction messages", async () => {
  vi.mocked(timers.setTimeout).mockResolvedValue(undefined);
  const bodies: unknown[] = [];
  const diagnostics: Array<Record<string, unknown>> = [];
  const runtime = new AgentRuntime({ catalog: noToolsCatalog, executeTool: async () => undefined,
    onDiagnostic: event => { diagnostics.push(event as unknown as Record<string, unknown>); },
    fetch: async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return failedStream(); } });
  let failure: unknown;
  try { await runtime.run({ taskId: "t", profile, prompt: "go" }); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ details: { reason: "response_stream_error", diagnosticId: expect.any(String) } });
  const diagnosticId = (failure as { details: { diagnosticId: string } }).details.diagnosticId;
  expect(bodies).toHaveLength(6);
  expect(bodies.every(body => JSON.stringify(body) === JSON.stringify(bodies[0]))).toBe(true);
  expect(diagnostics.filter(event => event.type === "request_started").map(event => event.attempt)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(diagnostics.find(event => event.type === "request_failed")).toMatchObject({ diagnosticId, attempt: 6, retryLimitReached: true });
});

test("succeeds on the fifth transport retry with the same conversation", async () => {
  vi.mocked(timers.setTimeout).mockResolvedValue(undefined);
  const bodies: unknown[] = [];
  const events: AgentEvent[] = [];
  const runtime = new AgentRuntime({ catalog: noToolsCatalog, executeTool: async () => undefined,
    onEvent: event => { events.push(event); },
    fetch: async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return bodies.length < 6 ? failedStream() : complete(); } });
  const result = await runtime.run({ taskId: "t", profile, prompt: "go" });
  expect(result.summary).toBe("done");
  expect(bodies).toHaveLength(6);
  expect(bodies.every(body => JSON.stringify(body) === JSON.stringify(bodies[0]))).toBe(true);
  expect(events.filter(event => event.type === "activity" && event.content.includes("重试"))).toHaveLength(5);
  expect(events.some(event => event.type === "activity" && event.content.includes("第 5 次重试（最多 5 次）"))).toBe(true);
});

test("resets the transport retry budget after a successful tool round", async () => {
  vi.mocked(timers.setTimeout).mockResolvedValue(undefined);
  const bodies: unknown[] = [];
  const runtime = new AgentRuntime({
    catalog: { providerTools: () => [], parseCall: name => ({ name, input: {} }) },
    executeTool: async () => "tool result",
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length <= 4 || (bodies.length >= 6 && bodies.length <= 7)) return failedStream();
      if (bodies.length === 5) return complete({ role: "assistant", content: null, tool_calls: [{ id: "call", type: "function", function: { name: "read", arguments: "{}" } }] });
      return complete();
    },
  });
  const result = await runtime.run({ taskId: "t", profile, prompt: "go" });
  expect(result.summary).toBe("done");
  expect(bodies).toHaveLength(8);
});

test("recovers a later stream failure without repeating an already executed tool", async () => {
  const bodies: unknown[] = [];
  const events: AgentEvent[] = [];
  const executeTool = vi.fn(async () => "tool receipt");
  const runtime = new AgentRuntime({ catalog: { providerTools: () => [], parseCall: name => ({ name, input: {} }) }, executeTool,
    onEvent: event => { events.push(event); }, fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length === 1) return complete({ role: "assistant", content: null, tool_calls: [{ id: "executed", type: "function", function: { name: "write", arguments: "{}" } }] });
      if (bodies.length === 2) return failedStream({ tool_calls: [{ index: 0, id: "unfinished", function: { name: "write", arguments: "{" } }] });
      return complete();
    } });
  expect((await runtime.run({ taskId: "t", profile, prompt: "go" })).summary).toBe("done");
  expect(executeTool).toHaveBeenCalledTimes(1);
  expect(bodies[2]).toEqual(bodies[1]);
  const completed = events.find(event => event.type === "tool-result");
  const reset = events.find(event => event.type === "response-reset");
  expect(reset).toMatchObject({ toolEventIds: [expect.any(String)] });
  if (completed?.type === "tool-result" && reset?.type === "response-reset") expect(reset.toolEventIds).not.toContain(completed.toolEventId);
});

test("cancellation during transport retry stops before another request", async () => {
  const controller = new AbortController();
  const fetcher = vi.fn(async () => failedStream());
  const runtime = new AgentRuntime({ catalog: noToolsCatalog, executeTool: async () => undefined, fetch: fetcher,
    onEvent: event => { if (event.type === "activity" && event.content.includes("重试")) controller.abort(); } });
  await expect(runtime.run({ taskId: "t", profile, prompt: "go", signal: controller.signal })).rejects.toMatchObject({ code: "MODEL_ERROR", message: "The agent run was cancelled." });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
