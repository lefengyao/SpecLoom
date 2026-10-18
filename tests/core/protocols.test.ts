import { describe, expect, it, vi } from "vitest";
import { buildProtocolParams, protocolRequestUrl, requestProtocolCompletion } from "../../src/main/core/protocols";

function response(body: unknown, status = 200, contentType = "application/json"): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": contentType } });
}

const messages = [
  { role: "system" as const, content: "Be concise" },
  { role: "user" as const, content: "hello" },
];
const tools = [{ type: "function" as const, function: { name: "lookup", description: "Look up", parameters: { type: "object" } } }];

describe("provider protocol completion", () => {
  it.each(["o2", "vendor/o4"])("preserves the legacy completion-token parameter for %s", (model) => {
    expect(buildProtocolParams("openai", { maxOutputTokens: 2048 }, model)).toEqual({ max_completion_tokens: 2048 });
  });

  it.each([
    ["gpt-5", "minimal"],
    ["gpt-5-mini", "minimal"],
    ["vendor/gpt-5-nano-2025-08-07", "minimal"],
    ["gpt-5.1", "none"],
    ["openai/gpt-5.2-2025-12-11", "none"],
  ])("maps reasoning off to the lowest supported effort for %s", (model, effort) => {
    expect(buildProtocolParams("openai", { reasoningSupport: true, reasoning: "off" }, model)).toHaveProperty("reasoning_effort", effort);
  });

  it("retains custom reasoning effort mappings above built-in off mappings", () => {
    expect(buildProtocolParams("openai", { reasoningSupport: true, reasoning: "off", reasoningMap: { path: "reasoning_effort", values: { off: '"low"' } } }, "gpt-5.2")).toHaveProperty("reasoning_effort", "low");
  });

  it.each(["gpt-5", "gpt-5-mini", "gpt-5-nano", "openai/gpt-5.1", "vendor/gpt-5.2", "o1", "o3-mini", "o4-mini", "o2"])("omits unsupported temperature for reasoning model %s", (model) => {
    expect(buildProtocolParams("openai", { reasoningSupport: true, reasoning: "high", temperature: 0.7 }, model)).not.toHaveProperty("temperature");
  });

  it.each(["gpt-5.1", "vendor/gpt-5.2"])("allows temperature when supported reasoning is explicitly off for %s", (model) => {
    expect(buildProtocolParams("openai", { reasoningSupport: true, reasoning: "off", temperature: 0.7 }, model)).toMatchObject({ reasoning_effort: "none", temperature: 0.7 });
  });

  it("uses actual custom reasoning effort when deciding temperature compatibility", () => {
    expect(buildProtocolParams("openai", { reasoningSupport: true, reasoning: "high", temperature: 0.7, reasoningMap: { path: "reasoning_effort", values: { high: '"none"' } } }, "gpt-5.2")).toMatchObject({ reasoning_effort: "none", temperature: 0.7 });
    expect(buildProtocolParams("openai", { reasoningSupport: true, reasoning: "off", temperature: 0.7, reasoningMap: { path: "reasoning_effort", values: { off: '"low"' } } }, "gpt-5.2")).not.toHaveProperty("temperature");
    expect(buildProtocolParams("openai", { reasoningSupport: false, reasoning: "off", temperature: 0.7 }, "gpt-5")).not.toHaveProperty("temperature");
  });

  it("preserves temperature for supported OpenAI-compatible models", () => {
    for (const model of ["gpt-4o", "deepseek-flash", "model-x", "gpt-50", "o3x"]) {
      expect(buildProtocolParams("openai", { temperature: 0.7 }, model)).toHaveProperty("temperature", 0.7);
    }
  });

  it("omits temperature only while Anthropic thinking is actually enabled", () => {
    expect(buildProtocolParams("anthropic", { reasoningSupport: true, reasoning: "high", temperature: 0.7 }, "claude-sonnet-4-5")).not.toHaveProperty("temperature");
    expect(buildProtocolParams("anthropic", { reasoningSupport: true, reasoning: "off", temperature: 0.7 }, "claude-sonnet-4-5")).toHaveProperty("temperature", 0.7);
    expect(buildProtocolParams("anthropic", { reasoningSupport: true, reasoning: "high", maxOutputTokens: 1500, temperature: 0.7 }, "claude-sonnet-4-5")).toHaveProperty("temperature", 0.7);
    expect(buildProtocolParams("anthropic", { reasoningSupport: true, reasoning: "high", temperature: 0.7, reasoningMap: { path: "thinking", values: { high: '{"type":"adaptive"}' } } }, "claude-sonnet-4-6")).not.toHaveProperty("temperature");
    expect(buildProtocolParams("anthropic", { reasoningSupport: true, reasoning: "high", temperature: 0.7, reasoningMap: { path: "thinking", values: { high: '{"type":"disabled"}' } } }, "claude-sonnet-4-5")).toHaveProperty("temperature", 0.7);
  });

  it.each([1.2, 2])("bounds Anthropic sampling temperature %s to its supported maximum", (temperature) => {
    expect(buildProtocolParams("anthropic", { reasoning: "off", temperature }, "claude-3-5-sonnet")).toHaveProperty("temperature", 1);
    expect(buildProtocolParams("openai", { temperature }, "gpt-4o")).toHaveProperty("temperature", temperature);
  });

  it.each([0, 0.4, 1])("preserves valid Anthropic sampling temperature %s", (temperature) => {
    expect(buildProtocolParams("anthropic", { reasoning: "off", temperature }, "claude-3-5-sonnet")).toHaveProperty("temperature", temperature);
  });

  it.each(["generateContent", "streamGenerateContent"])("normalizes a full Gemini %s endpoint while preserving gateway prefixes and queries", (operation) => {
    expect(protocolRequestUrl(`https://api.test/gateway/v1beta/models/old-model:${operation}?region=test#hash`, "gemini", "gemini-2.5-pro")).toBe("https://api.test/gateway/v1beta/models/gemini-2.5-pro:generateContent?region=test");
  });

  it("rejects an explicit non-assistant role in an OpenAI completion", async () => {
    const fetcher = vi.fn(async () => response({ choices: [{ message: { role: "user", content: "malformed reply" } }] }));
    await expect(requestProtocolCompletion({ protocol: "openai", baseUrl: "https://api.test/v1", model: "gpt-4o", messages, tools: [], fetcher })).rejects.toMatchObject({ code: "MODEL_ERROR" });
  });

  it.each([
    ["gemini-2.5-flash", 0],
    ["google/gemini-2.5-flash-lite", 0],
    ["vendor/gemini-2.5-pro-preview", 128],
  ])("maps reasoning off to the lowest supported Gemini 2.5 budget for %s", (model, thinkingBudget) => {
    expect(buildProtocolParams("gemini", { reasoningSupport: true, reasoning: "off" }, model)).toMatchObject({ generationConfig: { thinkingConfig: { thinkingBudget } } });
  });

  it("keeps custom Gemini off mappings above model defaults", () => {
    expect(buildProtocolParams("gemini", { reasoningSupport: true, reasoning: "off", reasoningMap: { path: "generationConfig.thinkingConfig.thinkingBudget", values: { off: "1024" } } }, "gemini-2.5-pro")).toMatchObject({ generationConfig: { thinkingConfig: { thinkingBudget: 1024 } } });
  });

  it("rejects an output limit below the Gemini 2.5 Pro minimum thinking budget", () => {
    expect(() => buildProtocolParams("gemini", { reasoningSupport: true, reasoning: "off", maxOutputTokens: 64 }, "gemini-2.5-pro")).toThrow();
  });

  it("translates typed image attachments for OpenAI, Anthropic, and Gemini", async () => {
    const seen: Record<string, unknown>[] = [];
    const fetcher = vi.fn(async (url: string | URL, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const text = String(url).includes("messages") ? { role: "assistant", content: [{ type: "text", text: "ok" }] } : String(url).includes("generateContent") ? { candidates: [{ content: { parts: [{ text: "ok" }] } }] } : { choices: [{ message: { role: "assistant", content: "ok" } }] };
      return response(text);
    });
    const images = [{ mimeType: "image/png", base64: "AQI=" }];
    await requestProtocolCompletion({ protocol: "openai", baseUrl: "https://api.test/v1", model: "gpt-4o", messages: [{ role: "user", content: "see", images }], tools: [], fetcher });
    await requestProtocolCompletion({ protocol: "anthropic", baseUrl: "https://api.test", model: "claude-4", messages: [{ role: "user", content: "see", images }], tools: [], fetcher });
    await requestProtocolCompletion({ protocol: "gemini", baseUrl: "https://api.test/v1beta", model: "gemini-2.5-pro", messages: [{ role: "user", content: "see", images }], tools: [], fetcher });
    expect(seen[0]?.messages).toEqual([{ role: "user", content: [{ type: "text", text: "see" }, { type: "image_url", image_url: { url: "data:image/png;base64,AQI=" } }] }]);
    const anthropicMessages = seen[1]?.messages as Array<{ content?: unknown }> | undefined;
    const geminiContents = seen[2]?.contents as Array<{ parts?: unknown }> | undefined;
    expect(anthropicMessages?.[0]?.content).toContainEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "AQI=" } });
    expect(geminiContents?.[0]?.parts).toContainEqual({ inlineData: { mimeType: "image/png", data: "AQI=" } });
  });

  it("rejects image attachments when the selected model has no vision support", async () => {
    await expect(requestProtocolCompletion({ protocol: "openai", baseUrl: "https://api.test/v1", model: "deepseek-chat", messages: [{ role: "user", content: "see", images: [{ mimeType: "image/png", base64: "AQI=" }] }], tools: [], settings: { vision: false }, fetcher: vi.fn() })).rejects.toMatchObject({ code: "MODEL_ERROR" });
  });
  it("does not apply a custom reasoning map when reasoning is disabled or mapped value is null", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetcher = vi.fn(async (_url: string | URL, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>); return response({ choices: [{ message: { role: "assistant", content: "ok" } }] }); });
    const map = { path: "enable_thinking", values: { off: "false", high: "null" } };
    await requestProtocolCompletion({ protocol: "openai", baseUrl: "https://api.test/v1", model: "deepseek-chat", messages, tools: [], fetcher, settings: { reasoningSupport: false, reasoning: "off", reasoningMap: map } });
    await requestProtocolCompletion({ protocol: "openai", baseUrl: "https://api.test/v1", model: "deepseek-chat", messages, tools: [], fetcher, settings: { reasoningSupport: true, reasoning: "high", reasoningMap: map } });
    expect(bodies[0]?.enable_thinking).toBeUndefined();
    expect(bodies[1]?.enable_thinking).toBeUndefined();
  });
  it("parses streamed OpenAI tool deltas and usage", async () => {
    const fetcher = vi.fn(async () => new Response([
      'data: {"choices":[{"delta":{"content":"hel"}}]}',
      'data: {"choices":[{"delta":{"content":"lo","tool_calls":[{"index":0,"id":"c1","function":{"name":"lookup","arguments":"{}"}}]}}]}',
      'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":8,"completion_tokens":3}}',
      "data: [DONE]",
    ].join("\n\n"), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const result = await requestProtocolCompletion({ protocol: "openai", baseUrl: "https://api.test/v1", model: "gpt-4o", messages, tools, fetcher });
    expect(result.message.content).toBe("hello");
    expect(result.message.tool_calls?.[0]?.function.name).toBe("lookup");
    expect(result.usage).toMatchObject({ promptTokens: 8, completionTokens: 3 });
  });
  it("replays Anthropic thinking blocks only when thinking is enabled", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetcher = vi.fn(async (_url: string | URL, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>); return response({ role: "assistant", content: [{ type: "text", text: "ok" }] }); });
    const previous = [{ role: "assistant" as const, content: "prior", thinking_blocks: [{ type: "thinking", thinking: "internal", signature: "sig" }] }];
    await requestProtocolCompletion({ protocol: "anthropic", baseUrl: "https://api.test", model: "claude-4", messages: previous, tools: [], fetcher, settings: { reasoningSupport: true, reasoning: "medium", maxOutputTokens: 8192 } });
    await requestProtocolCompletion({ protocol: "anthropic", baseUrl: "https://api.test", model: "claude-4", messages: previous, tools: [], fetcher, settings: { reasoningSupport: false, reasoning: "off", maxOutputTokens: 8192 } });
    expect((bodies[0]?.messages as Array<{ content: Array<{ type: string }> }>)[0]?.content[0]?.type).toBe("thinking");
    expect((bodies[1]?.messages as Array<{ content: Array<{ type: string }> }>)[0]?.content[0]?.type).toBe("text");
  });
  it("builds OpenAI requests with bearer auth, tools, reasoning and normalized usage", async () => {
    let body: Record<string, unknown> | undefined;
    const fetcher = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return response({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: "{}" } }] } }], usage: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 2 } } });
    });
    const result = await requestProtocolCompletion({ protocol: "openai", baseUrl: "https://api.test/v1", model: "o3-mini", messages, tools, secret: "sk-test", fetcher,
      settings: { reasoningSupport: true, reasoning: "high", maxOutputTokens: 4096 } });
    expect((fetcher.mock.calls[0]?.[0] as string)).toBe("https://api.test/v1/chat/completions");
    expect((fetcher.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer sk-test" });
    expect(body).toMatchObject({ model: "o3-mini", max_completion_tokens: 4096, reasoning_effort: "high", tools });
    expect(result.message.tool_calls?.[0]?.id).toBe("call-1");
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 4, cachedTokens: 2, cacheWriteTokens: 0 });
  });

  it.each(["openai/gpt-5", "vendor/o3"])("uses the model-family output parameter for prefixed model %s", async (model) => {
    let body: Record<string, unknown> | undefined;
    const fetcher = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return response({ choices: [{ message: { role: "assistant", content: "ok" } }] });
    });
    await requestProtocolCompletion({ protocol: "openai", baseUrl: "https://api.test/v1", model, messages, tools: [], fetcher, settings: { maxOutputTokens: 2048 } });
    expect(body).toHaveProperty("max_completion_tokens", 2048);
    expect(body).not.toHaveProperty("max_tokens");
  });

  it.each(["gpt-5.1", "vendor/gpt-5.2"])("uses max_completion_tokens for GPT-5 point version %s", async (model) => {
    let body: Record<string, unknown> | undefined;
    const fetcher = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return response({ choices: [{ message: { role: "assistant", content: "ok" } }] });
    });
    await requestProtocolCompletion({ protocol: "openai", baseUrl: "https://api.test/v1", model, messages, tools: [], fetcher, settings: { maxOutputTokens: 2048 } });
    expect(body).toHaveProperty("max_completion_tokens", 2048);
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("translates Anthropic messages, thinking and tool use", async () => {
    let body: Record<string, unknown> | undefined;
    const fetcher = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return response({ role: "assistant", content: [{ type: "text", text: "done" }, { type: "tool_use", id: "t1", name: "lookup", input: { q: "x" } }], usage: { input_tokens: 20, output_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: 1 } });
    });
    const result = await requestProtocolCompletion({ protocol: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-5", messages, tools, secret: "anthropic-key", fetcher,
      settings: { reasoningSupport: true, reasoning: "medium", maxOutputTokens: 8192 } });
    expect((fetcher.mock.calls[0]?.[0] as string)).toBe("https://api.anthropic.com/v1/messages");
    expect((fetcher.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({ "x-api-key": "anthropic-key", "anthropic-version": "2023-06-01" });
    expect(body).toMatchObject({ model: "claude-sonnet-4-5", max_tokens: 8192, thinking: { type: "enabled", budget_tokens: 7168 }, system: "Be concise" });
    expect(result.message.content).toBe("done");
    expect(result.message.tool_calls?.[0]?.function.name).toBe("lookup");
    expect(result.usage?.cachedTokens).toBe(3);
  });

  it("translates Gemini native requests and normalizes function calls", async () => {
    let body: Record<string, unknown> | undefined;
    const fetcher = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return response({ candidates: [{ content: { parts: [{ functionCall: { name: "lookup", args: { q: "x" } } }] } }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 5, cachedContentTokenCount: 1 } });
    });
    const result = await requestProtocolCompletion({ protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.5-pro", messages, tools, secret: "gemini-key", fetcher,
      settings: { reasoningSupport: true, reasoning: "low", maxOutputTokens: 4096, temperature: 0.4 } });
    expect((fetcher.mock.calls[0]?.[0] as string)).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent");
    expect((fetcher.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({ "x-goog-api-key": "gemini-key" });
    expect(body).toMatchObject({ generationConfig: { maxOutputTokens: 4096, temperature: 0.4, thinkingConfig: { thinkingBudget: 2048 } } });
    expect(result.message.tool_calls?.[0]?.function.name).toBe("lookup");
    expect(result.usage).toEqual({ promptTokens: 9, completionTokens: 5, cachedTokens: 1, cacheWriteTokens: 0 });
  });

  it("uses Gemini 3 thinking levels instead of the Gemini 2.5 thinking budget", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetcher = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return response({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });
    });
    await requestProtocolCompletion({ protocol: "gemini", baseUrl: "https://api.test/v1beta", model: "google/gemini-3-pro", messages, tools: [], fetcher,
      settings: { reasoningSupport: true, reasoning: "low", maxOutputTokens: 4096 } });
    const config = bodies[0]?.generationConfig as Record<string, unknown>;
    expect(config).toMatchObject({ maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: "LOW" } });
    expect((config.thinkingConfig as Record<string, unknown>).thinkingBudget).toBeUndefined();
  });

  it("uses Gemini 3 MINIMAL when reasoning is explicitly off", async () => {
    let body: Record<string, unknown> | undefined;
    const fetcher = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return response({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });
    });
    await requestProtocolCompletion({ protocol: "gemini", baseUrl: "https://api.test/v1beta", model: "gemini-3-flash-preview", messages, tools: [], fetcher,
      settings: { reasoningSupport: true, reasoning: "off", maxOutputTokens: 4096 } });
    expect(body).toMatchObject({ generationConfig: { thinkingConfig: { thinkingLevel: "MINIMAL" } } });
    expect(body?.generationConfig && (body.generationConfig as Record<string, unknown>).thinkingConfig).not.toHaveProperty("thinkingBudget");
  });

  it.each([
    ["gemini-3-pro", "off", "LOW"],
    ["gemini-3-pro", "medium", "LOW"],
    ["google/gemini-3.1-pro", "medium", "MEDIUM"],
    ["vendor/gemini-3-flash", "off", "MINIMAL"],
    ["gemini-3.1-flash-lite-image", "low", "MINIMAL"],
    ["gemini-3.1-flash-lite-image", "medium", "MINIMAL"],
  ] as const)("maps unsupported Gemini 3 thinking levels for %s", async (model, reasoning, expected) => {
    let body: Record<string, unknown> | undefined;
    const fetcher = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return response({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });
    });
    await requestProtocolCompletion({ protocol: "gemini", baseUrl: "https://api.test/v1beta", model, messages, tools: [], fetcher,
      settings: { reasoningSupport: true, reasoning, maxOutputTokens: 4096 } });
    expect((body?.generationConfig as Record<string, unknown>)?.thinkingConfig).toEqual({ thinkingLevel: expected });
  });
});
