import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderInputSchema } from "../../src/shared/contracts";
import {
  agentTemperatureRange,
  defaultPreferences,
  PreferencesPatchSchema,
  normalizePreferences,
} from "../../src/shared/preferences";
import { requestProtocolCompletion } from "../../src/main/core/protocols";
import { requestCompletion, reservedOutputTokens as clientReservedOutputTokens } from "../../src/main/core/agent-client";
import { SessionStore } from "../../src/main/core/session-store";
import { SessionRuns } from "../../src/main/core/session-runs";
import { AgentRuntime, noToolsCatalog } from "../../src/main/core/agent-runtime";
import type { RuntimeModelProfile } from "../../src/main/core/model-config";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function openAiFetcher(): { fetcher: typeof fetch; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  const fetcher = (async (_url: string | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetcher, bodies };
}

const messages = [
  { role: "system" as const, content: "Be concise" },
  { role: "user" as const, content: "hello" },
];

const runtimeProfile = (overrides: Partial<RuntimeModelProfile>): RuntimeModelProfile => ({
  id: "p", name: "p", provider: "openai-compatible", model: "test-model", baseUrl: "https://api.test/v1",
  approved: true, timeoutMs: 5000, maxToolRounds: 3, ...overrides,
});

describe("provider mapping paths follow the StoryFabric protocol constraints", () => {
  it("rejects Anthropic mappings whose path is not thinking", () => {
    const base = { name: "A", protocol: "anthropic" as const, baseUrl: "https://api.test", models: ["claude-4"] };
    const valid = ProviderInputSchema.safeParse({ ...base, modelSettings: { "claude-4": { reasoningMap: { path: "thinking", values: { high: '{"type":"enabled","budget_tokens":4096}' } } } } });
    expect(valid.success).toBe(true);
    const invalid = ProviderInputSchema.safeParse({ ...base, modelSettings: { "claude-4": { reasoningMap: { path: "thinking.custom", values: { high: "1" } } } } });
    expect(invalid.success).toBe(false);
  });

  it("rejects Gemini mappings outside generationConfig and accepts paths below it", () => {
    const base = { name: "G", protocol: "gemini" as const, baseUrl: "https://api.test", models: ["gemini-2.5-pro"] };
    const invalid = ProviderInputSchema.safeParse({ ...base, modelSettings: { "gemini-2.5-pro": { reasoningMap: { path: "thinkingBudget", values: { high: "4096" } } } } });
    expect(invalid.success).toBe(false);
    const valid = ProviderInputSchema.safeParse({ ...base, modelSettings: { "gemini-2.5-pro": { reasoningMap: { path: "generationConfig.thinkingConfig.thinkingBudget", values: { high: "4096" } } } } });
    expect(valid.success).toBe(true);
  });

  it("rejects Gemini reasoning mappings that target reserved output fields", () => {
    const base = { name: "G", protocol: "gemini" as const, baseUrl: "https://api.test", models: ["gemini-2.5-pro"] };
    for (const path of ["generationConfig.maxOutputTokens", "generationConfig.thinkingConfig.maxOutputTokens"]) {
      const parsed = ProviderInputSchema.safeParse({ ...base, modelSettings: { "gemini-2.5-pro": { reasoningMap: { path, values: { high: "4096" } } } } });
      expect(parsed.success).toBe(false);
    }
  });

  it("rejects reasoning mappings that target temperature controlled by model settings", () => {
    const cases = [
      { protocol: "openai" as const, model: "gpt-5", path: "temperature" },
      { protocol: "gemini" as const, model: "gemini-2.5-pro", path: "generationConfig.temperature" },
    ];
    for (const { protocol, model, path } of cases) {
      const parsed = ProviderInputSchema.safeParse({
        name: "Provider", protocol, baseUrl: "https://api.test", models: [model],
        modelSettings: { [model]: { reasoningMap: { path, values: { high: "0.1" } } } },
      });
      expect(parsed.success).toBe(false);
    }
  });

  it("falls back to built-in thinking when a request carries a mapping path outside the protocol", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetcher = (async (_url: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await requestProtocolCompletion({
      protocol: "gemini", baseUrl: "https://api.test/v1beta", model: "gemini-2.5-pro", messages, tools: [], fetcher,
      settings: { reasoningSupport: true, reasoning: "high", maxOutputTokens: 16_384, reasoningMap: { path: "thinkingBudget", values: { high: "4096" } } },
    });
    const config = bodies[0]?.generationConfig as Record<string, unknown> | undefined;
    expect(config?.maxOutputTokens).toBe(16_384);
    expect(config?.thinkingConfig).toEqual({ thinkingBudget: 16_384 - 1024 });
    expect(bodies[0]?.thinkingBudget).toBeUndefined();
  });

  it("applies Anthropic thinking mappings and keeps the configured output limit", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetcher = (async (_url: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ role: "assistant", content: [{ type: "text", text: "ok" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await requestProtocolCompletion({
      protocol: "anthropic", baseUrl: "https://api.test", model: "claude-4", messages, tools: [], fetcher,
      settings: { reasoningSupport: true, reasoning: "high", maxOutputTokens: 8192, reasoningMap: { path: "thinking", values: { high: '{"type":"enabled","budget_tokens":4096}' } } },
    });
    expect(bodies[0]?.max_tokens).toBe(8192);
    expect(bodies[0]?.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
  });

  it("preserves DeepSeek thinking mappings through the model-specific compatibility branch", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetcher = (async (_url: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await requestProtocolCompletion({
      protocol: "openai", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-flash", messages, tools: [], fetcher,
      settings: { reasoningSupport: true, reasoning: "high", reasoningMap: { path: "thinking", values: { high: '{"type":"enabled","budget_tokens":4096}' } } },
    });
    expect(bodies[0]?.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
  });

  it.each([
    { protocol: "anthropic" as const, model: "claude-4", path: "thinking", value: '{"type":"enabled","budget_tokens":8192}' },
    { protocol: "gemini" as const, model: "gemini-2.5-pro", path: "generationConfig.thinkingConfig.thinkingBudget", value: "8192" },
  ])("rejects $protocol mapped thinking budgets beyond the output limit before sending", async ({ protocol, model, path, value }) => {
    const { fetcher, bodies } = openAiFetcher();
    await expect(requestProtocolCompletion({
      protocol, model, baseUrl: "https://api.test", messages, tools: [], fetcher,
      settings: { reasoningSupport: true, reasoning: "high", maxOutputTokens: 4096, reasoningMap: { path, values: { high: value } } },
    })).rejects.toMatchObject({ code: "MODEL_ERROR", message: "The mapped thinking budget exceeds the configured output limit." });
    expect(bodies).toHaveLength(0);
  });
});

describe("agent output reservation against the context window", () => {
  it("passes the configured limit through when no context window is known", () => {
    expect(clientReservedOutputTokens(runtimeProfile({ maxOutputTokens: 8192 }), messages)).toBe(8192);
  });

  it("clamps the output limit to the remaining context space", () => {
    const long = [{ role: "user" as const, content: "x".repeat(6000) }];
    const reserved = clientReservedOutputTokens(runtimeProfile({ maxOutputTokens: 8192, contextTokens: 8192 }), long);
    expect(reserved).toBeGreaterThan(0);
    expect(reserved).toBeLessThan(8192);
  });

  it("omits the output limit when the estimated input already fills the context", () => {
    const huge = [{ role: "user" as const, content: "x".repeat(20_000) }];
    expect(clientReservedOutputTokens(runtimeProfile({ maxOutputTokens: 8192, contextTokens: 4096 }), huge)).toBeUndefined();
  });

  it("sends the reserved output limit in real requests", async () => {
    const { fetcher, bodies } = openAiFetcher();
    await requestCompletion({
      profile: runtimeProfile({ protocol: "openai", maxOutputTokens: 8192, contextTokens: 4096, reasoningSupport: false, temperature: 0.5 }),
      messages: [{ role: "user", content: "y".repeat(4000) }], tools: [], canRetry: false,
    }, fetcher);
    const maxTokens = bodies[0]?.max_tokens as number | undefined;
    expect(maxTokens).toBeDefined();
    expect(maxTokens).toBeLessThan(8192);
    expect(bodies[0]?.temperature).toBe(0.5);
  });

  it("rejects an exhausted context instead of falling back to the protocol default", async () => {
    const { fetcher, bodies } = openAiFetcher();
    await expect(requestCompletion({
      profile: runtimeProfile({ protocol: "openai", maxOutputTokens: 8192, contextTokens: 4096 }),
      messages: [{ role: "user", content: "z".repeat(20_000) }], tools: [], canRetry: false,
    }, fetcher)).rejects.toMatchObject({ code: "MODEL_ERROR", message: "The current prompt does not fit the model context window." });
    expect(bodies).toHaveLength(0);
  });

  it("bounds legacy profiles that declare a context window without an output limit", async () => {
    const { fetcher, bodies } = openAiFetcher();
    await requestCompletion({
      profile: runtimeProfile({ protocol: "openai", contextTokens: 4096 }),
      messages: [{ role: "user", content: "y".repeat(4000) }], tools: [], canRetry: false,
    }, fetcher);
    expect(bodies[0]?.max_tokens).toBeLessThanOrEqual(8192);
    expect(bodies[0]?.max_tokens).toBeGreaterThan(0);
  });
});

describe("agent stability preference", () => {
  it("defaults to 50 and normalizes out-of-range values", () => {
    expect(defaultPreferences.agentTemperature).toBe(50);
    expect(agentTemperatureRange).toEqual({ min: 0, max: 100 });
    expect(normalizePreferences({}).agentTemperature).toBe(50);
    expect(normalizePreferences({ ...defaultPreferences, agentTemperature: 101 }).agentTemperature).toBe(50);
    expect(normalizePreferences({ ...defaultPreferences, agentTemperature: 72.5 }).agentTemperature).toBe(50);
    expect(normalizePreferences({ ...defaultPreferences, agentTemperature: 80 }).agentTemperature).toBe(80);
  });

  it("rejects preference patches outside 0..100", () => {
    expect(PreferencesPatchSchema.safeParse({ agentTemperature: 0 }).success).toBe(true);
    expect(PreferencesPatchSchema.safeParse({ agentTemperature: 100 }).success).toBe(true);
    expect(PreferencesPatchSchema.safeParse({ agentTemperature: -1 }).success).toBe(false);
    expect(PreferencesPatchSchema.safeParse({ agentTemperature: 101 }).success).toBe(false);
    expect(PreferencesPatchSchema.safeParse({ agentTemperature: 50.5 }).success).toBe(false);
  });
});

describe("session usage records distinguish actual API usage", () => {
  it("stores normalized usage from the last completed run", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "specloom-usage-"));
    roots.push(root);
    const store = await SessionStore.open(root);
    const runs = new SessionRuns(store, root);
    const session = await store.create("usage");
    const fetcher = (async () => new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: "done" } }], usage: { prompt_tokens: 21, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 4 } } }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
    const execute = runs.executor((options) => new AgentRuntime({ ...options, catalog: noToolsCatalog, executeTool: async () => { throw new Error("forbidden"); }, fetch: fetcher }).run({ taskId: "chat", profile: runtimeProfile({ protocol: "openai" }), prompt: options.prompt, signal: options.signal }));
    await runs.send(session.id, "统计用量", execute);
    expect(store.get(session.id).usage).toEqual({ promptTokens: 21, completionTokens: 7, cachedTokens: 4, cacheWriteTokens: 0, source: "actual" });
  });
});
