import { expect, test } from "vitest";
import { AgentRuntime } from "../../src/main/core/agent-runtime";
import { requestProtocolCompletion } from "../../src/main/core/protocols";
import { resolveModelSettings } from "../../src/main/core/model-settings";

test.each([false, true])("retains DeepSeek reasoning through tool execution and durable history (stream=%s)", async (streaming) => {
  const bodies: Array<Record<string, unknown>> = [];
  const checkpoints: unknown[] = [];
  const secret = "SECRET-CREDENTIAL";
  const runtime = new AgentRuntime({
    executeTool: async () => ({ text: "read" }),
    onConversation: messages => { checkpoints.push(messages); },
    ...(streaming ? { onEvent: () => {} } : {}),
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      if (bodies.length > 1) return Response.json({ choices: [{ message: { role: "assistant", content: "done", reasoning_content: "finish" } }] });
      const call = { id: "c", type: "function", function: { name: "files_read", arguments: '{"path":"a.txt"}' } };
      if (!streaming) return Response.json({ choices: [{ message: { role: "assistant", content: null, reasoning_content: `check ${secret}`, tool_calls: [call] } }] });
      const frames = [
        { choices: [{ delta: { reasoning_content: `check ${secret}` } }] },
        { choices: [{ delta: { tool_calls: [{ ...call, index: 0 }] }, finish_reason: "tool_calls" }] },
      ];
      return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    },
  });
  const result = await runtime.run({ taskId: "s", prompt: "go", secret,
    profile: { id: "m", name: "DeepSeek", provider: "openai-compatible", protocol: "openai", model: "deepseek-flash",
      baseUrl: "https://api.deepseek.com/v1", approved: true, timeoutMs: 1000, maxToolRounds: 2,
      reasoningSupport: true, reasoning: "medium" } });
  const assistant = (bodies[1]!.messages as Array<Record<string, unknown>>).find(message => message.role === "assistant");
  expect(assistant).toMatchObject({ content: "", reasoning_content: `check ${secret}` });
  expect(bodies[0]).not.toHaveProperty("tool_choice");
  expect(bodies[0]).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "high" });
  expect(JSON.stringify(checkpoints)).not.toContain(secret);
  expect(JSON.stringify(checkpoints)).toContain("check [redacted]");
  expect(result.messages.find(message => message.role === "assistant")).toHaveProperty("reasoning_content", "check [redacted]");
});

test("disables default DeepSeek thinking when the user selects off", async () => {
  let body: Record<string, unknown> = {};
  await requestProtocolCompletion({ protocol: "openai", model: "deepseek-flash", baseUrl: "https://api.deepseek.com/v1",
    messages: [{ role: "user", content: "hello" }], tools: [], settings: { reasoningSupport: true, reasoning: "off" },
    fetcher: async (_url, init) => { body = JSON.parse(String(init?.body)); return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] }); } });
  expect(body).toHaveProperty("thinking.type", "disabled");
  expect(body).not.toHaveProperty("reasoning_effort");
});

test.each(["deepseek-flash", "deepseek-v4"])("resolves and sends default reasoning for %s", async (model) => {
  const settings = resolveModelSettings(model);
  let body: Record<string, unknown> = {};
  await requestProtocolCompletion({ protocol: "openai", model, baseUrl: "https://api.deepseek.com/v1",
    messages: [{ role: "user", content: "hello" }], tools: [], settings,
    fetcher: async (_url, init) => { body = JSON.parse(String(init?.body)); return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] }); } });
  expect(settings.reasoningSupport).toBe(true);
  expect(body).toHaveProperty("thinking.type", "enabled");
  expect(body).toHaveProperty("reasoning_effort", "high");
});

test("keeps vendor-prefixed DeepSeek model identity while applying DeepSeek request compatibility", async () => {
  let body: Record<string, unknown> = {};
  await requestProtocolCompletion({ protocol: "openai", model: "vendor/deepseek-flash", baseUrl: "https://api.deepseek.com/v1",
    messages: [{ role: "user", content: "hello" }], tools: [], settings: resolveModelSettings("vendor/deepseek-flash"),
    fetcher: async (_url, init) => { body = JSON.parse(String(init?.body)); return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] }); } });
  expect(body.model).toBe("vendor/deepseek-flash");
  expect(body).not.toHaveProperty("tool_choice");
  expect(body).toHaveProperty("thinking.type", "enabled");
  expect(body).toHaveProperty("reasoning_effort", "high");
});

test("keeps generic OpenAI provider fields unchanged", async () => {
  let body: Record<string, unknown> = {};
  await requestProtocolCompletion({ protocol: "openai", model: "model", baseUrl: "https://model.test/v1",
    messages: [{ role: "user", content: "hello" }], tools: [], settings: { reasoningSupport: true, reasoning: "medium" },
    fetcher: async (_url, init) => { body = JSON.parse(String(init?.body)); return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] }); } });
  expect(body).toHaveProperty("reasoning_effort", "medium");
  expect(body).toHaveProperty("tool_choice", "auto");
  expect(body).not.toHaveProperty("thinking");
});
