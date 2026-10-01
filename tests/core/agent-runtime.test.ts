import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRuntime, chatCompletionsUrl } from "../../src/main/core/agent-runtime";
import { ProjectError } from "../../src/main/core/errors";
import type { ModelProfile } from "../../src/shared/contracts";

type RequestBody = { messages: Array<Record<string, unknown>>; tools: Array<{ function: { name: string } }> };
const cleanup: Array<() => Promise<void>> = [];
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
    expect(events.map((event) => event.type)).toEqual(["request", "tool-start", "tool-result", "request", "summary"]);
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

  it("stops before executing tools beyond the configured round limit", async () => {
    const baseUrl = await mockEndpoint((_request, response) => completion(response, { role: "assistant", content: null,
      tool_calls: [{ id: "call", type: "function", function: { name: "skills_list", arguments: "{}" } }] }));
    let executions = 0;
    const runtime = new AgentRuntime({ executeTool: async () => { executions++; return []; } });
    await expect(runtime.run({ taskId: "t", profile: profile(baseUrl, { maxToolRounds: 1 }), prompt: "go" }))
      .rejects.toMatchObject({ code: "MODEL_ERROR", message: expect.stringMatching(/round limit/) });
    expect(executions).toBe(1);
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
