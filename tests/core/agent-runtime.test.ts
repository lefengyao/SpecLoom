import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as timers from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentConversationSchema, AgentRuntime, boundConversation, chatCompletionsUrl, fitConversationContext, noToolsCatalog, type AgentEvent, type AgentMessage } from "../../src/main/core/agent-runtime";
import { estimateConversationTokens } from "../../src/main/core/agent-client";
import { PERSISTED_CONVERSATION_JSON_LIMIT } from "../../src/main/core/agent-conversation";
import { estimateTokens } from "../../src/main/core/model-settings";
import type { RuntimeModelProfile } from "../../src/main/core/model-config";
import type { ProviderTool } from "../../src/main/core/tool-catalog";
import { ProjectError } from "../../src/main/core/errors";
import type { ModelProfile } from "../../src/shared/contracts";

vi.mock("node:timers/promises", { spy: true });

type RequestBody = { messages: Array<Record<string, unknown>>; tools: Array<{ function: { name: string } }> };
const cleanup: Array<() => Promise<void>> = [];
const smallPersistenceLimits = { maxMessages: 96, maxJsonChars: 262_144 };
afterEach(async () => { await Promise.all(cleanup.splice(0).map((close) => close())); });

async function mockEndpoint(handler: (request: IncomingMessage, response: ServerResponse, body: RequestBody) => void) {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as RequestBody;
    handler(request, response, body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP port");
  return `http://127.0.0.1:${address.port}`;
}

function completion(response: ServerResponse, message: Record<string, unknown>) {
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ choices: [{ message }] }));
}

function profile(baseUrl: string, overrides: Partial<ModelProfile> = {}): ModelProfile {
  return { id: "mock", name: "Mock", provider: "openai-compatible", model: "local", baseUrl,
    approved: true, timeoutMs: 2_000, maxToolRounds: 3, ...overrides };
}

describe("AgentRuntime", () => {
  it("feeds a malformed model response back to the agent for one bounded correction", async () => {
    let requests = 0;
    const bodies: RequestBody[] = [];
    const runtime = new AgentRuntime({
      catalog: noToolsCatalog,
      executeTool: async () => undefined,
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as RequestBody);
        requests++;
        if (requests === 1) return new Response("{not-json", { headers: { "content-type": "application/json" } });
        return Response.json({ choices: [{ message: { role: "assistant", content: "修正成功" } }] });
      },
    });

    const result = await runtime.run({ taskId: "t", profile: profile("http://127.0.0.1:1234"), prompt: "go" });

    expect(result.summary).toBe("修正成功");
    expect(requests).toBe(2);
    expect(bodies[1]?.messages.at(-1)).toMatchObject({ role: "user", content: expect.stringContaining("valid JSON") });
  });

  it("stops correcting after two malformed model responses", async () => {
    let requests = 0;
    const runtime = new AgentRuntime({
      catalog: noToolsCatalog,
      executeTool: async () => undefined,
      fetch: async () => { requests++; return new Response("{not-json", { headers: { "content-type": "application/json" } }); },
    });

    await expect(runtime.run({ taskId: "t", profile: profile("http://127.0.0.1:1234"), prompt: "go" }))
      .rejects.toMatchObject({ code: "MODEL_ERROR", message: "The model returned invalid JSON or UTF-8." });
    expect(requests).toBe(3);
  });

  it("feeds an empty model response back to the agent for correction", async () => {
    let requests = 0;
    const bodies: RequestBody[] = [];
    const runtime = new AgentRuntime({
      catalog: noToolsCatalog,
      executeTool: async () => undefined,
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as RequestBody);
        requests++;
        if (requests === 1) return new Response(null, { headers: { "content-type": "application/json" } });
        return Response.json({ choices: [{ message: { role: "assistant", content: "空响应已修正" } }] });
      },
    });

    const result = await runtime.run({ taskId: "t", profile: profile("http://127.0.0.1:1234"), prompt: "go" });

    expect(result.summary).toBe("空响应已修正");
    expect(requests).toBe(2);
    expect(bodies[1]?.messages.at(-1)).toMatchObject({ role: "user", content: expect.stringContaining("malformed response") });
  });

  it("resets partial streamed output before requesting a response correction", async () => {
    let requests = 0;
    const events: AgentEvent[] = [];
    const runtime = new AgentRuntime({
      catalog: noToolsCatalog,
      executeTool: async () => undefined,
      onEvent: (event) => { events.push(event); },
      fetch: async () => {
        requests++;
        if (requests === 1) return new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: {bad}\n\n', { headers: { "content-type": "text/event-stream" } });
        return Response.json({ choices: [{ message: { role: "assistant", content: "fixed" } }] });
      },
    });

    const result = await runtime.run({ taskId: "t", profile: profile("http://127.0.0.1:1234"), prompt: "go" });

    expect(result.summary).toBe("fixed");
    expect(events.some((event) => event.type === "response-reset" && event.messageIds.length === 1)).toBe(true);
  });

  it.each(["consumer", "transport"] as const)("does not request model correction for a %s failure", async (failure) => {
    if (failure === "transport") vi.mocked(timers.setTimeout).mockResolvedValue(undefined);
    let requests = 0;
    const bodies: RequestBody[] = [];
    const runtime = new AgentRuntime({
      catalog: noToolsCatalog, executeTool: async () => undefined,
      onEvent: (event) => { if (failure === "consumer" && event.type === "text") throw new Error("persistence failed"); },
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as RequestBody);
        requests++;
        if (failure === "transport") return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(new TypeError("socket terminated")); } }));
        return new Response('data: {"choices":[{"delta":{"content":"partial output"}}]}\n\n', { headers: { "content-type": "text/event-stream" } });
      },
    });
    await expect(runtime.run({ taskId: "t", profile: profile("http://127.0.0.1:1234"), prompt: "go" }))
      .rejects.toMatchObject({ details: { reason: failure === "consumer" ? "response_consumer_error" : "response_stream_error" } });
    expect(requests).toBe(failure === "consumer" ? 1 : 6);
    expect(bodies.every(body => JSON.stringify(body.messages) === JSON.stringify(bodies[0]?.messages))).toBe(true);
  });

  it("preserves the real goal and a large tool batch in a durable screenshot checkpoint", async () => {
    const goal = "Current user goal: inspect the screenshot. ".padEnd(131_033, "x");
    const checkpoints: AgentMessage[][] = [];
    let requests = 0;
    const runtime = new AgentRuntime({
      catalog: { providerTools: () => [{ type: "function", function: { name: "screenshot", description: "Capture image", parameters: { type: "object" } } }],
        parseCall: () => ({ name: "screenshot", input: {} }) },
      executeTool: async () => ({ mimeType: "image/png", base64: "AA==" }),
      onConversation: (messages) => { checkpoints.push(messages); },
      fetch: async () => {
        if (++requests > 1) return new Response("fixture unavailable", { status: 503 });
        return Response.json({ choices: [{ message: { role: "assistant", content: "a".repeat(131_072),
          tool_calls: [{ id: "screen", type: "function", function: { name: "screenshot", arguments: "{}" } }] } }] });
      },
    });
    await expect(runtime.run({ taskId: "t", profile: { ...profile("http://127.0.0.1:1234"), vision: true }, prompt: goal }))
      .rejects.toMatchObject({ code: "MODEL_ERROR", message: "The model request failed with HTTP 503." });
    const saved = checkpoints.at(-1)!;
    expect(saved.some((message) => message.role === "user" && message.content === goal)).toBe(true);
    expect(JSON.stringify(saved).length).toBeLessThanOrEqual(PERSISTED_CONVERSATION_JSON_LIMIT);
    expect(AgentConversationSchema.safeParse(saved).success).toBe(true);
  });

  it.each([true, false])("keeps the original goal and screenshot batch atomic when vision is %s", async (vision) => {
    const goal = "Original user goal: verify this implementation. ".repeat(50);
    const systemPrompt = "Follow the user goal.";
    const tools: ProviderTool[] = [{ type: "function", function: { name: "screenshot", description: "Capture the tool result image.", parameters: { type: "object" } } }];
    const initial: AgentMessage[] = [{ role: "system", content: systemPrompt }, { role: "user", content: goal }];
    const configured: RuntimeModelProfile = { ...profile("http://127.0.0.1:1234"), vision,
      contextTokens: estimateConversationTokens(initial, tools) + 900, maxOutputTokens: 128 };
    const requests: RequestBody[] = [];
    const checkpoints: AgentMessage[][] = [];
    let executions = 0;
    let mainRequests = 0;
    const runtime = new AgentRuntime({ catalog: { providerTools: () => tools, parseCall: () => ({ name: "screenshot", input: {} }) },
      executeTool: async () => { executions++; return { mimeType: "image/png", base64: "AA==" }; },
      onConversation: (messages) => { checkpoints.push(messages); },
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as RequestBody; requests.push(body);
        if (body.messages[0]?.role === "system" && String(body.messages[0].content).startsWith("Summarize")) return Response.json({ choices: [{ message: { role: "assistant", content: "historical summary" } }] });
        mainRequests++;
        return Response.json({ choices: [{ message: mainRequests === 1
          ? { role: "assistant", content: null, tool_calls: [{ id: "screen", type: "function", function: { name: "screenshot", arguments: "{}" } }] }
          : { role: "assistant", content: "done" } }] });
      } });
    const runPromise = runtime.run({ taskId: "t", profile: configured, prompt: goal, systemPrompt,
      previousMessages: [{ role: "user", content: "old goal ".repeat(1000) }] });
    if (vision) {
      await expect(runPromise).rejects.toMatchObject({ code: "MODEL_ERROR", message: "The current prompt does not fit the model context window." });
    } else {
      await expect(runPromise).resolves.toMatchObject({ summary: "done", toolCalls: 1 });
    }
    expect(executions).toBe(1);
    expect(mainRequests).toBe(vision ? 1 : 2);
    expect(requests.some(request => request.messages.at(-1)?.content === goal)).toBe(true);
    const saved = checkpoints.at(-1)!;
    expect(saved[0]).toEqual({ role: "user", content: goal });
    expect(saved.map((message) => message.role)).toEqual(vision ? ["user", "assistant", "tool", "user"] : ["user", "assistant", "tool", "user", "assistant"]);
    expect(saved.every((message) => message.images === undefined)).toBe(true);
    expect(AgentConversationSchema.safeParse(saved).success).toBe(true);
  });

  it("retains the original goal and tool images together while dropping older turns", () => {
    const goal: AgentMessage = { role: "user", content: "Inspect the screenshot against the goal." };
    const currentTurn: AgentMessage[] = [goal,
      { role: "assistant", content: null, tool_calls: [{ id: "screen", type: "function", function: { name: "screenshot", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "screen", content: "screenshot receipt" },
      { role: "user", content: "Tool image", images: [{ mimeType: "image/png", base64: "AA==" }] },
    ];
    const messages: AgentMessage[] = [{ role: "user", content: "old goal ".repeat(1000) }, ...currentTurn];
    const fit = fitConversationContext(messages, estimateConversationTokens(currentTurn) + 128, 128, [], goal);
    expect(fit).toEqual(currentTurn);
    expect(AgentConversationSchema.safeParse(fit).success).toBe(true);
  });

  it("treats a real user image as a new turn after older tool exchanges", () => {
    const latest: AgentMessage = { role: "user", content: "New goal with my image", images: [{ mimeType: "image/png", base64: "AA==" }] };
    const messages: AgentMessage[] = [{ role: "user", content: "old goal ".repeat(1000) },
      { role: "assistant", content: null, tool_calls: [{ id: "screen", type: "function", function: { name: "screenshot", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "screen", content: "previous screenshot receipt" }, latest,
    ];
    expect(fitConversationContext(messages, estimateConversationTokens([latest]) + 128, 128, [], latest)).toEqual([latest]);
  });

  it("includes tool schemas when trimming complete older turns", () => {
    const current: AgentMessage[] = [{ role: "user", content: "current goal" }];
    const messages: AgentMessage[] = [{ role: "user", content: "previous goal ".repeat(40) }, ...current];
    const tools: ProviderTool[] = [{ type: "function", function: { name: "inspect", description: "details ".repeat(50), parameters: { type: "object" } } }];
    const contextTokens = estimateTokens(JSON.stringify({ messages: current, tools })) + 20;
    expect(fitConversationContext(messages, contextTokens, 20, tools)).toEqual(current);
  });

  it("rejects a current turn that cannot fit alongside its tools", () => {
    const messages: AgentMessage[] = [{ role: "user", content: "current goal" }];
    const tools: ProviderTool[] = [{ type: "function", function: { name: "inspect", description: "details ".repeat(50), parameters: { type: "object" } } }];
    const contextTokens = estimateTokens(JSON.stringify({ messages, tools })) + 19;
    expect(() => fitConversationContext(messages, contextTokens, 20, tools)).toThrow(/context window/);
  });

  it("accounts for both clarification tools before dispatching a model request", async () => {
    let requests = 0;
    const runtime = new AgentRuntime({ catalog: noToolsCatalog, executeTool: async () => undefined,
      onQuestion: async () => ({}), fetch: async () => {
        requests++;
        return Response.json({ choices: [{ message: { role: "assistant", content: "done" } }] });
      } });
    const configured: RuntimeModelProfile = { ...profile("http://127.0.0.1:1234"), contextTokens: 512, maxOutputTokens: 128 };
    await expect(runtime.run({ taskId: "t", profile: configured, prompt: "go" }))
      .rejects.toMatchObject({ code: "MODEL_ERROR", message: "The current prompt does not fit the model context window." });
    expect(requests).toBe(0);
  });

  it("fits context by dropping complete older exchanges while retaining system and latest goal", () => {
    const messages: AgentMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "old goal" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "files_list_versions", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "old result" },
      { role: "user", content: "latest goal" },
    ];
    const fit = fitConversationContext(messages, estimateConversationTokens([messages[0]!, messages.at(-1)!]) + 10, 10);
    expect(fit.map((message) => message.content)).toEqual(["system", "latest goal"]);
  });

  it("fails explicitly when the latest prompt cannot fit the reserved output budget", () => {
    expect(() => fitConversationContext([{ role: "user", content: "x".repeat(1000) }], 32, 16)).toThrow(/context window/);
  });

  it("keeps the current goal before its completed tool batches when trimming context", () => {
    const currentTurn: AgentMessage[] = [
      { role: "user", content: "current goal" },
      { role: "assistant", content: null, tool_calls: [
        { id: "c1", type: "function", function: { name: "files_list_versions", arguments: "{}" } },
        { id: "c2", type: "function", function: { name: "files_list_versions", arguments: "{}" } },
      ] },
      { role: "tool", tool_call_id: "c1", content: "first result" },
      { role: "tool", tool_call_id: "c2", content: "second result" },
    ];
    const messages: AgentMessage[] = [{ role: "user", content: "old goal".repeat(1000) }, ...currentTurn];
    const fit = fitConversationContext(messages, estimateConversationTokens(currentTurn) + 10, 10);
    expect(fit).toEqual(currentTurn);
    expect(AgentConversationSchema.safeParse(fit).success).toBe(true);
  });

  it("retains the user preceding a tool batch when that complete history still fits", () => {
    const retained: AgentMessage[] = [
      { role: "user", content: "previous goal" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "files_list_versions", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "previous result" },
      { role: "user", content: "current goal" },
    ];
    const messages: AgentMessage[] = [
      { role: "user", content: "old goal".repeat(1000) }, { role: "assistant", content: "old answer" }, ...retained,
    ];
    const fit = fitConversationContext(messages, estimateConversationTokens(retained) + 10, 10);
    expect(fit).toEqual(retained);
    expect(AgentConversationSchema.safeParse(fit).success).toBe(true);
  });

  it("fits legacy context-only profiles using the available window", () => {
    const fit = fitConversationContext([{ role: "user", content: "x".repeat(1000) }], 4096, undefined);
    expect(fit).toHaveLength(1);
  });
  it("joins OpenAI and custom API roots without duplicating chat/completions", () => {
    expect(chatCompletionsUrl("https://example.com/v1/")).toBe("https://example.com/v1/chat/completions");
    expect(chatCompletionsUrl("https://example.com")).toBe("https://example.com/chat/completions");
    expect(chatCompletionsUrl("https://example.com/api/chat/completions")).toBe("https://example.com/api/chat/completions");
    expect(() => chatCompletionsUrl("https://key:secret@example.com")).toThrow();
  });

  it("authenticates and preserves tool-call IDs in a real HTTP tool roundtrip", async () => {
    const seen: RequestBody[] = [];
    const events: Array<{ type: string }> = [];
    const baseUrl = await mockEndpoint((request, response, body) => {
      expect(request.url).toBe("/v1/chat/completions");
      expect(request.headers.authorization).toBe("Bearer local-test-key");
      seen.push(body);
      if (seen.length === 1) {
        completion(response, { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function",
          function: { name: "files_list_versions", arguments: '{"prefix":"specs"}' } }] });
      } else completion(response, { role: "assistant", content: "Reviewed the specifications." });
    });
    const calls: unknown[] = [];
    const runtime = new AgentRuntime({ resolveCredential: async () => "local-test-key", onEvent: (event) => { events.push(event); },
      executeTool: async (call) => { calls.push(call); return [{ path: "specs/game.md", version: "absent" }]; } });
    const result = await runtime.run({ taskId: "task-1", profile: profile(`${baseUrl}/v1`), prompt: "Review specs" });
    expect(result.summary).toBe("Reviewed the specifications.");
    expect(result.toolCalls).toBe(1);
    expect(calls).toEqual([expect.objectContaining({ taskId: "task-1", name: "files.list_versions", input: { prefix: "specs" } })]);
    expect(seen[0]!.tools.map((tool) => tool.function.name)).toContain("skills_load");
    expect(seen[1]!.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call-1" });
    expect(events.map((event) => event.type)).toEqual(["request", "tool-start", "tool-result", "request", "text", "summary"]);
  });

  it("reports invalid arguments and guarded tool failures as structured messages", async () => {
    let requests = 0;
    const outputs: string[] = [];
    const baseUrl = await mockEndpoint((_request, response, body) => {
      requests++;
      if (requests === 1) completion(response, { role: "assistant", content: null, tool_calls: [
        { id: "bad", type: "function", function: { name: "files_read", arguments: "{}" } },
        { id: "unknown", type: "function", function: { name: "bad_tool", arguments: "{}" } },
        { id: "conflict", type: "function", function: { name: "files_list_versions", arguments: "{}" } },
      ] });
      else {
        for (const message of body.messages.filter((item) => item.role === "tool")) outputs.push(String(message.content));
        completion(response, { role: "assistant", content: "Need revised inputs" });
      }
    });
    let executions = 0;
    const runtime = new AgentRuntime({ executeTool: async () => { executions++; throw new ProjectError("VERSION_CONFLICT", "Changed externally"); } });
    await runtime.run({ taskId: "t", profile: profile(baseUrl), prompt: "read" });
    expect(executions).toBe(1);
    expect(outputs.map((output) => JSON.parse(output))).toEqual([
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "MODEL_ERROR" }) }),
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "MODEL_ERROR" }) }),
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "VERSION_CONFLICT" }) }),
    ]);
  });

  it("retries transient HTTP responses at most twice before tool actions", async () => {
    let requests = 0;
    const baseUrl = await mockEndpoint((_request, response) => {
      requests++;
      if (requests < 3) { response.statusCode = requests === 1 ? 429 : 503; response.end("private vendor details"); }
      else completion(response, { role: "assistant", content: "OK" });
    });
    const runtime = new AgentRuntime({ executeTool: async () => undefined });
    expect((await runtime.run({ taskId: "t", profile: profile(baseUrl), prompt: "go" })).summary).toBe("OK");
    expect(requests).toBe(3);
  });

  it("does not retry requests once a tool has executed", async () => {
    let requests = 0;
    const baseUrl = await mockEndpoint((_request, response) => {
      requests++;
      if (requests === 1) completion(response, { role: "assistant", content: null,
        tool_calls: [{ id: "write", type: "function", function: { name: "files_list_versions", arguments: "{}" } }] });
      else { response.statusCode = 503; response.end("private local-test-key"); }
    });
    const runtime = new AgentRuntime({ executeTool: async () => true, resolveCredential: async () => "local-test-key" });
    await expect(runtime.run({ taskId: "t", profile: profile(baseUrl), prompt: "go" })).rejects.toMatchObject({ code: "MODEL_ERROR" });
    expect(requests).toBe(2);
  });

  it("continues from the last complete tool batch after a model HTTP failure", async () => {
    const requests: RequestBody[] = [];
    const checkpoints: AgentMessage[][] = [];
    let executions = 0;
    const baseUrl = await mockEndpoint((_request, response, body) => {
      requests.push(body);
      if (requests.length === 1) completion(response, { role: "assistant", content: null,
        tool_calls: [{ id: "read-versions", type: "function", function: { name: "files_list_versions", arguments: "{}" } }] });
      else if (requests.length === 2) { response.statusCode = 503; response.end("unavailable"); }
      else completion(response, { role: "assistant", content: "Resumed using the previous tool result." });
    });
    const runtime = new AgentRuntime({ executeTool: async () => { executions++; return { version: "current" }; },
      onConversation: (messages) => { checkpoints.push(messages); } });
    await expect(runtime.run({ taskId: "t", profile: profile(baseUrl), prompt: "Inspect project versions" }))
      .rejects.toMatchObject({ code: "MODEL_ERROR" });
    expect(checkpoints.map((messages) => messages.map((message) => message.role)))
      .toEqual([["user"], ["user", "assistant", "tool"]]);
    const previousMessages = checkpoints.at(-1)!;
    const result = await runtime.run({ taskId: "t", profile: profile(baseUrl), prompt: "Continue", previousMessages });
    const wireHistory = previousMessages.map((message) => { const wireMessage = { ...message }; delete wireMessage.tool_name; return wireMessage; });
    expect(requests[2]!.messages).toEqual([...wireHistory, { role: "user", content: "Continue" }]);
    expect(previousMessages.at(-1)?.tool_name).toBe("files_list_versions");
    expect(executions).toBe(1);
    expect(result.summary).toContain("Resumed");
    expect(checkpoints.at(-1)?.at(-1)).toMatchObject({ role: "assistant", content: result.summary });
  });

  it("retains the preceding checkpoint when cancellation interrupts a later tool batch", async () => {
    let requests = 0;
    let executions = 0;
    const checkpoints: AgentMessage[][] = [];
    const controller = new AbortController();
    const call = (id: string) => ({ id, type: "function", function: { name: "skills_list", arguments: "{}" } });
    const baseUrl = await mockEndpoint((_request, response) => {
      requests++;
      completion(response, { role: "assistant", content: null,
        tool_calls: requests === 1 ? [call("completed")] : [call("partial"), call("cancelled")] });
    });
    const runtime = new AgentRuntime({ executeTool: async () => { if (++executions === 3) controller.abort(); return []; },
      onConversation: (messages) => { checkpoints.push(messages); } });
    await expect(runtime.run({ taskId: "t", profile: profile(baseUrl), prompt: "go", signal: controller.signal }))
      .rejects.toMatchObject({ code: "MODEL_ERROR", message: expect.stringMatching(/cancelled/) });
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints.at(-1)?.at(-1)).toMatchObject({ role: "tool", tool_call_id: "completed" });
    expect(JSON.stringify(checkpoints)).not.toContain("partial");
    expect(JSON.stringify(checkpoints)).not.toContain("cancelled");
  });

  it("redacts every checkpoint field without mutating the live request conversation", async () => {
    const secret = "local-test-key";
    const checkpoints: AgentMessage[][] = [];
    const events: string[] = [];
    let requests = 0;
    const baseUrl = await mockEndpoint((_request, response, body) => {
      requests++;
      expect(body.messages[0]).toMatchObject({ role: "system", content: "private system instructions" });
      expect(body.messages[1]).toMatchObject({ role: "user", content: `Check ${secret}` });
      if (requests === 1) completion(response, { role: "assistant", content: `Echo ${secret}`, tool_calls: [
        { id: secret, type: "function", function: { name: "files_list_versions", arguments: JSON.stringify({ prefix: secret }) } },
        { id: "other", type: "function", function: { name: `unknown_${secret}`, arguments: "{}" } },
      ] });
      else completion(response, { role: "assistant", content: `Bearer ${secret}` });
    });
    const runtime = new AgentRuntime({ executeTool: async () => ({ value: secret }), resolveCredential: async () => secret,
      onConversation: (messages) => {
        checkpoints.push(structuredClone(messages));
        events.push("checkpoint");
        messages[0]!.content = "consumer mutation";
      }, onEvent: (event) => { events.push(event.type); } });
    await runtime.run({ taskId: "t", profile: profile(baseUrl), prompt: `Check ${secret}`, systemPrompt: "private system instructions" });
    expect(checkpoints).toHaveLength(3);
    expect(JSON.stringify(checkpoints)).not.toContain(secret);
    expect(checkpoints.flat().every((message) => message.role !== "system")).toBe(true);
    expect(checkpoints.every((messages) => AgentConversationSchema.safeParse(messages).success)).toBe(true);
    expect(events.slice(-2)).toEqual(["checkpoint", "summary"]);
  });

  it("bounds persisted history by removing whole tool batches", () => {
    const history: AgentMessage[] = [{ role: "user", content: "Old request" }];
    for (let index = 0; index < 40; index++) history.push(
      { role: "assistant", content: null, tool_calls: [
        { id: `one-${index}`, type: "function", function: { name: "skills_list", arguments: "{}" } },
        { id: `two-${index}`, type: "function", function: { name: "skills_list", arguments: "{}" } },
      ] },
      { role: "tool", content: "[]", tool_call_id: `one-${index}` },
      { role: "tool", content: "[]", tool_call_id: `two-${index}` },
    );
    history.push({ role: "user", content: "Latest request" });
    const bounded = boundConversation(history, undefined, undefined, smallPersistenceLimits);
    expect(bounded.length).toBeLessThanOrEqual(96);
    expect(bounded[0]?.role).toBe("assistant");
    expect(bounded.at(-1)).toEqual({ role: "user", content: "Latest request" });
    expect(AgentConversationSchema.safeParse(bounded).success).toBe(true);
    const incomplete = [{ role: "assistant", content: null, tool_calls: [
      { id: "missing", type: "function", function: { name: "skills_list", arguments: "{}" } },
    ] }] as AgentMessage[];
    expect(AgentConversationSchema.safeParse(incomplete).success).toBe(false);
    expect(AgentConversationSchema.safeParse([{ role: "tool", content: "[]", tool_call_id: "orphan" }]).success).toBe(false);
  });

  it("protects the anchored real goal instead of a generated image prompt at the durable message bound", () => {
    const goal: AgentMessage = { role: "user", content: "Current goal" };
    const history: AgentMessage[] = [goal];
    for (let index = 0; index < 40; index++) history.push(
      { role: "assistant", content: null, tool_calls: [{ id: `screen-${index}`, type: "function", function: { name: "screenshot", arguments: "{}" } }] },
      { role: "tool", tool_call_id: `screen-${index}`, content: "screenshot receipt" },
      { role: "user", content: "Generated tool image", images: [{ mimeType: "image/png", base64: "AA==" }] },
    );
    const saved = boundConversation(history, undefined, goal, smallPersistenceLimits);
    expect(saved.some((message) => message.role === "user" && message.content === goal.content)).toBe(true);
    expect(saved.length).toBeLessThanOrEqual(96);
    expect(AgentConversationSchema.safeParse(saved).success).toBe(true);
  });

  it("protects and redacts an anchored real user image goal when a later generated prompt exceeds durable capacity", () => {
    const secret = "private-test-token";
    const goal: AgentMessage = { role: "user", content: `Inspect my image with ${secret}. `.padEnd(131_033, "x"), images: [{ mimeType: "image/png", base64: "AA==" }] };
    const history: AgentMessage[] = [goal,
      { role: "assistant", content: "a".repeat(131_072), tool_calls: [{ id: "screen", type: "function", function: { name: "screenshot", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "screen", content: "screenshot receipt" },
      { role: "user", content: "Generated tool image", images: [{ mimeType: "image/png", base64: "AA==" }] },
    ];
    const saved = boundConversation(history, secret, goal, smallPersistenceLimits);
    expect(saved.some((message) => message.role === "user" && message.content?.startsWith("Inspect my image with [redacted]."))).toBe(true);
    expect(saved.every((message) => message.images === undefined)).toBe(true);
    expect(JSON.stringify(saved)).not.toContain(secret);
    expect(JSON.stringify(saved).length).toBeLessThanOrEqual(262_144);
    expect(AgentConversationSchema.safeParse(saved).success).toBe(true);
  });

  it("enforces the persisted JSON size limit without changing tool arguments", () => {
    const history: AgentMessage[] = [{ role: "system", content: "not persisted" }];
    for (let index = 0; index < 4; index++) history.push(
      { role: "assistant", content: "x".repeat(65_000), tool_calls: [
        { id: `call-${index}`, type: "function", function: { name: "files_list_versions", arguments: JSON.stringify({ prefix: `prefix-${index}` }) } },
      ] }, { role: "tool", content: "x".repeat(65_000), tool_call_id: `call-${index}` },
    );
    const bounded = boundConversation(history, undefined, undefined, smallPersistenceLimits);
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(262_144);
    expect(bounded).toHaveLength(4);
    expect(bounded[0]!.tool_calls?.[0]?.id).toBe("call-2");
    expect(bounded[0]!.tool_calls?.[0]?.function.arguments).toBe('{"prefix":"prefix-2"}');
    expect(AgentConversationSchema.safeParse(bounded).success).toBe(true);
  });

  it("keeps the latest user goal when tool batches exceed either history bound", () => {
    const history: AgentMessage[] = [{ role: "user", content: "Current goal" }];
    for (let index = 0; index < 40; index++) history.push(
      { role: "assistant", content: null, tool_calls: [
        { id: `one-${index}`, type: "function", function: { name: "skills_list", arguments: "{}" } },
        { id: `two-${index}`, type: "function", function: { name: "skills_list", arguments: "{}" } },
      ] }, { role: "tool", content: "[]", tool_call_id: `one-${index}` },
      { role: "tool", content: "[]", tool_call_id: `two-${index}` },
    );
    const bounded = boundConversation(history, undefined, undefined, smallPersistenceLimits);
    expect(bounded[0]).toEqual(history[0]);
    expect(bounded.at(-1)?.tool_call_id).toBe("two-39");
    expect(AgentConversationSchema.safeParse(bounded).success).toBe(true);
    history.push({ role: "assistant", content: null, tool_calls: [
      { id: "oversized", type: "function", function: { name: "skills_list", arguments: JSON.stringify({ content: "x".repeat(300_000) }) } },
    ] }, { role: "tool", content: "[]", tool_call_id: "oversized" });
    expect(boundConversation(history, undefined, undefined, smallPersistenceLimits)).toEqual([history[0]]);
    const escaped = boundConversation([{ role: "user", content: "\0".repeat(131_072) }], undefined, undefined, smallPersistenceLimits);
    expect(escaped[0]!.content).toContain("[truncated]");
    expect(AgentConversationSchema.safeParse(escaped).success).toBe(true);
  });

  it("keeps tool-call IDs unique and paired when redaction causes collisions", async () => {
    const secret = "local-test-key";
    let requests = 0;
    const baseUrl = await mockEndpoint((_request, response) => {
      requests++;
      completion(response, requests === 1 ? { role: "assistant", content: null, tool_calls: [secret, "[redacted]"].map((id) =>
        ({ id, type: "function", function: { name: "skills_list", arguments: "{}" } })) } : { role: "assistant", content: "OK" });
    });
    const checkpoints: AgentMessage[][] = [];
    const runtime = new AgentRuntime({ executeTool: async () => [], resolveCredential: async () => secret,
      onConversation: (messages) => { checkpoints.push(messages); } });
    const result = await runtime.run({ taskId: "t", profile: profile(baseUrl), prompt: "go" });
    expect(AgentConversationSchema.safeParse(checkpoints.at(-1)).success).toBe(true);
    expect(AgentConversationSchema.safeParse(result.messages).success).toBe(true);
    expect(JSON.stringify(result.messages)).not.toContain(secret);
  });

  it.each(['local-"test\\key', 'local-"quoted-key', "local-backslash\\key"])(
    "redacts JSON-escaped credentials in checkpoint and returned tool arguments: %s", async (secret) => {
      let requests = 0;
      const checkpoints: AgentMessage[][] = [];
      const baseUrl = await mockEndpoint((_request, response, body) => {
        requests++;
        if (requests === 1) completion(response, { role: "assistant", content: null, tool_calls: [
          { id: "valid", type: "function", function: { name: "files_list_versions", arguments: JSON.stringify({ prefix: secret }) } },
          { id: "untrusted", type: "function", function: { name: "unknown", arguments: JSON.stringify({ [secret]: secret, nested: [{ value: secret }], count: 1234 }) } },
        ] });
        else {
          const original = body.messages.find((message) => message.role === "assistant")!.tool_calls as Array<{ function: { arguments: string } }>;
          expect(JSON.parse(original[0]!.function.arguments)).toEqual({ prefix: secret });
          completion(response, { role: "assistant", content: "OK" });
        }
      });
      const runtime = new AgentRuntime({ executeTool: async (call) => { expect(call.input).toEqual({ prefix: secret }); return []; },
        resolveCredential: async () => secret, onConversation: (messages) => { checkpoints.push(messages); } });
      const result = await runtime.run({ taskId: "t", profile: profile(baseUrl), prompt: "go" });
      for (const messages of [result.messages, ...checkpoints.slice(1)]) {
        const calls = messages.find((message) => message.role === "assistant" && message.tool_calls)!.tool_calls!;
        expect(JSON.parse(calls[0]!.function.arguments)).toEqual({ prefix: "[redacted]" });
        const decoded = JSON.parse(calls[1]!.function.arguments) as Record<string, unknown>;
        expect(Object.keys(decoded)).not.toContain(secret);
        expect(decoded["[redacted]"]).toBe("[redacted]");
        expect(decoded.nested).toEqual([{ value: "[redacted]" }]);
        expect(decoded.count).toBe(1234);
      }
    });

  it("preserves numeric arguments and bounds malformed or deeply nested JSON during checkpoint redaction", () => {
    const conversation = (argumentsJson: string): AgentMessage[] => [{ role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [
        { id: "call", type: "function", function: { name: "unknown", arguments: argumentsJson } },
      ] }, { role: "tool", content: "[]", tool_call_id: "call" }];
    const argument = (messages: AgentMessage[]) => messages[1]!.tool_calls![0]!.function.arguments;
    const numeric = boundConversation(conversation('{"count":1234,"label":"1234","enabled":true}'), "1234");
    expect(JSON.parse(argument(numeric))).toEqual({ count: 1234, label: "[redacted]", enabled: true });
    const secret = 'local-"test\\key';
    const malformed = boundConversation(conversation(`${JSON.stringify({ secret })} trailing`), secret);
    expect(JSON.parse(argument(malformed))).toBe("[invalid tool arguments omitted]");
    let nested: unknown = { value: secret };
    for (let index = 0; index < 100; index++) nested = { nested };
    const deep = argument(boundConversation(conversation(JSON.stringify(nested)), secret));
    expect(deep).toContain("[truncated]");
    expect(deep.length).toBeLessThan(2_000);
    const oversized = argument(boundConversation(conversation(JSON.stringify({ content: "x".repeat(524_288) })), secret));
    expect(JSON.parse(oversized)).toBe("[tool arguments omitted: size limit]");
  });

  it("rejects orphaned tool history before dispatching a model request", async () => {
    let requests = 0;
    const runtime = new AgentRuntime({ executeTool: async () => [], fetch: async () => {
      requests++;
      return Response.json({ choices: [{ message: { role: "assistant", content: "OK" } }] });
    } });
    await expect(runtime.run({ taskId: "t", profile: profile("http://127.0.0.1:1234"), prompt: "go",
      previousMessages: [{ role: "tool", content: "[]", tool_call_id: "orphan" }] }))
      .rejects.toMatchObject({ code: "MODEL_ERROR" });
    expect(requests).toBe(0);
  });

  it("rejects redirects without sending the credential to the destination", async () => {
    let redirectedRequests = 0;
    const target = await mockEndpoint((_request, response) => { redirectedRequests++; completion(response, { role: "assistant", content: "bad" }); });
    const source = await mockEndpoint((_request, response) => { response.statusCode = 307; response.setHeader("Location", target); response.end(); });
    const runtime = new AgentRuntime({ executeTool: async () => true, resolveCredential: async () => "local-test-key" });
    await expect(runtime.run({ taskId: "t", profile: profile(source), prompt: "go" })).rejects.toMatchObject({ code: "MODEL_ERROR" });
    expect(redirectedRequests).toBe(0);
  });

  it("aborts slow requests and externally cancelled runs", async () => {
    const baseUrl = await mockEndpoint(() => undefined);
    const runtime = new AgentRuntime({ executeTool: async () => true });
    await expect(runtime.run({ taskId: "t", profile: profile(baseUrl, { timeoutMs: 20 }), prompt: "go" }))
      .rejects.toMatchObject({ code: "MODEL_ERROR", message: expect.stringMatching(/timed out/) });
    const controller = new AbortController();
    controller.abort();
    await expect(runtime.run({ taskId: "t", profile: profile(baseUrl), prompt: "go", signal: controller.signal }))
      .rejects.toMatchObject({ code: "MODEL_ERROR", message: expect.stringMatching(/cancelled/) });
  });

  it("does not enforce the legacy configured tool round value", async () => {
    let requests = 0;
    let executions = 0;
    const runtime = new AgentRuntime({
      executeTool: async () => { executions++; return "receipt"; },
      fetch: async () => Response.json({ choices: [{ message: ++requests === 3
        ? { role: "assistant", content: "done" }
        : { role: "assistant", content: null, tool_calls: [{ id: `call-${requests}`, type: "function", function: { name: "skills_list", arguments: "{}" } }] } }] }),
    });
    const result = await runtime.run({ taskId: "t", profile: profile("http://127.0.0.1:1234", { maxToolRounds: 1 }), prompt: "go" });
    expect(result).toMatchObject({ summary: "done", rounds: 2, toolCalls: 2 });
    expect(requests).toBe(3);
    expect(executions).toBe(2);
  });

  it("continues past old numeric limits with small complete tool exchanges", async () => {
    let requests = 0;
    let executions = 0;
    let checkpoint: AgentMessage[] = [];
    const events: AgentEvent[] = [];
    const runtime = new AgentRuntime({
      executeTool: async () => { executions++; return "ok"; },
      onConversation: messages => { checkpoint = messages; },
      onEvent: event => { events.push(event); },
      fetch: async () => Response.json({ choices: [{ message: ++requests > 330
        ? { role: "assistant", content: "done" }
        : { role: "assistant", content: null, tool_calls: [{ id: `call-${requests}`, type: "function", function: { name: "skills_list", arguments: "{}" } }] } }] }),
    });
    const input = { taskId: "t", profile: profile("http://127.0.0.1:1234", { maxToolRounds: 1 }), prompt: "go" };
    const result = await runtime.run(input);
    expect(result).toMatchObject({ summary: "done", rounds: 330, toolCalls: 330 });
    expect(executions).toBe(330);
    expect(AgentConversationSchema.safeParse(checkpoint).success).toBe(true);
    const saved = structuredClone(checkpoint);
    events.length = 0;
    expect((await runtime.run({ ...input, prompt: "continue", previousMessages: saved })).rounds).toBe(0);
    expect(events.find(event => event.type === "request")).toEqual({ type: "request", round: 0 });
  });

  it("bounds tool outputs and redacts credentials from returned summaries", async () => {
    let requests = 0;
    let output = "";
    const baseUrl = await mockEndpoint((_request, response, body) => {
      requests++;
      if (requests === 1) completion(response, { role: "assistant", content: null,
        tool_calls: [{ id: "call", type: "function", function: { name: "skills_list", arguments: "{}" } }] });
      else { output = String(body.messages.at(-1)!.content); completion(response, { role: "assistant", content: "Bearer local-test-key" }); }
    });
    const runtime = new AgentRuntime({ executeTool: async () => ({ content: "x".repeat(50_000), apiKey: "local-test-key" }),
      resolveCredential: async () => "local-test-key" });
    const result = await runtime.run({ taskId: "t", profile: profile(baseUrl), prompt: "go" });
    expect(output.length).toBeLessThanOrEqual(16_384);
    expect(() => JSON.parse(output)).not.toThrow();
    expect(output).not.toContain("local-test-key");
    expect(JSON.stringify(result)).not.toContain("local-test-key");
  });

  it("redacts credentials echoed in untrusted tool-call IDs and event fields", async () => {
    let requests = 0;
    const events: unknown[] = [];
    const baseUrl = await mockEndpoint((_request, response) => {
      requests++;
      if (requests === 1) completion(response, { role: "assistant", content: null,
        tool_calls: [{ id: "local-test-key", type: "function", function: { name: "skills_list", arguments: "{}" } }] });
      else completion(response, { role: "assistant", content: "OK" });
    });
    const runtime = new AgentRuntime({ executeTool: async () => [], resolveCredential: async () => "local-test-key",
      onEvent: (event) => { events.push(event); } });
    const result = await runtime.run({ taskId: "t", profile: profile(baseUrl), prompt: "go" });
    expect(JSON.stringify(result)).not.toContain("local-test-key");
    expect(JSON.stringify(events)).not.toContain("local-test-key");
  });

  it("bounds repeated transient failures and suppresses vendor error bodies", async () => {
    let requests = 0;
    const baseUrl = await mockEndpoint((_request, response) => { requests++; response.statusCode = 429; response.end("private vendor details local-test-key"); });
    const runtime = new AgentRuntime({ executeTool: async () => undefined, resolveCredential: async () => "local-test-key" });
    let error: unknown;
    try { await runtime.run({ taskId: "t", profile: profile(baseUrl), prompt: "go" }); }
    catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: "MODEL_ERROR", message: "The model request failed with HTTP 429." });
    expect(JSON.stringify(error)).not.toContain("local-test-key");
    expect(requests).toBe(3);
  });

  it("redacts credentials in object keys before exposing tool events", async () => {
    let requests = 0;
    const events: unknown[] = [];
    const baseUrl = await mockEndpoint((_request, response) => {
      requests++;
      completion(response, requests === 1 ? { role: "assistant", content: null, tool_calls: [{ id: "call", type: "function", function: { name: "skills_list", arguments: "{}" } }] } : { role: "assistant", content: "OK" });
    });
    const runtime = new AgentRuntime({ executeTool: async () => ({ "local-test-key": "value" }), resolveCredential: async () => "local-test-key", onEvent: (event) => { events.push(event); } });
    await runtime.run({ taskId: "t", profile: profile(baseUrl), prompt: "go" });
    expect(JSON.stringify(events)).not.toContain("local-test-key");
  });

  it("rejects unapproved profiles, malformed replies and oversized history", async () => {
    const baseUrl = await mockEndpoint((_request, response) => completion(response, { role: "assistant", tool_calls: "malformed" }));
    const runtime = new AgentRuntime({ executeTool: async () => undefined });
    await expect(runtime.run({ taskId: "t", profile: profile(baseUrl, { approved: false }), prompt: "go" }))
      .rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    await expect(runtime.run({ taskId: "t", profile: profile(baseUrl), prompt: "go" })).rejects.toMatchObject({ code: "MODEL_ERROR" });
    await expect(runtime.run({ taskId: "t", profile: profile(baseUrl), prompt: "go", previousMessages: [{ role: "user", content: "x".repeat(131_073) }] }))
      .rejects.toMatchObject({ code: "MODEL_ERROR" });
  });
});
