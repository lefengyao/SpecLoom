import { describe, expect, it, vi } from "vitest";
import { estimateConversationTokens, requestCompletion, reservedOutputTokens, type AgentMessage } from "../../src/main/core/agent-client";
import type { RuntimeModelProfile } from "../../src/main/core/model-config";
import { estimateTokens } from "../../src/main/core/model-settings";
import type { ProviderTool } from "../../src/main/core/tool-catalog";

const profile: RuntimeModelProfile = { id: "fixture", name: "Fixture", provider: "openai-compatible", model: "gpt-5",
  baseUrl: "https://model.test/v1", approved: true, timeoutMs: 1000, maxToolRounds: 2 };
const messages: AgentMessage[] = [{ role: "user", content: "继续核对中文上下文预算" }];
const tools: ProviderTool[] = [{ type: "function", function: { name: "inspect", description: "schema detail ".repeat(100), parameters: { type: "object" } } }];
const completion = () => Response.json({ choices: [{ message: { role: "assistant", content: "done" } }],
  usage: { prompt_tokens: 7, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } } });

describe("agent completion defaults", () => {
  it("uses the GPT-5 output parameter without an explicit protocol or delta callback", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => completion());
    await requestCompletion({ profile: { ...profile, maxOutputTokens: 128_000 }, messages, tools: [], canRetry: false }, fetcher);
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body.max_completion_tokens).toBe(128_000);
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("reports actual usage without an explicit protocol or delta callback", async () => {
    const onUsage = vi.fn();
    await requestCompletion({ profile, messages, tools: [], canRetry: false, onUsage }, async () => completion());
    expect(onUsage).toHaveBeenCalledWith({ promptTokens: 7, completionTokens: 3, cachedTokens: 2, cacheWriteTokens: 0 });
  });
});

describe("shared conversation token estimate", () => {
  it("uses the same conservative text estimate for Chinese messages and tool schemas", () => {
    expect(estimateConversationTokens(messages, tools)).toBe(estimateTokens(JSON.stringify({ messages, tools })));
  });

  it("reserves output after accounting for tool schemas", () => {
    const inputTokens = estimateTokens(JSON.stringify({ messages, tools }));
    expect(reservedOutputTokens({ ...profile, contextTokens: inputTokens + 128, maxOutputTokens: 1024 }, messages, tools)).toBe(128);
  });

  it("rejects a tool schema that exhausts context before making a request", async () => {
    const fetcher = vi.fn(async () => completion());
    await expect(requestCompletion({ profile: { ...profile, contextTokens: 800, maxOutputTokens: 128 }, messages, tools, canRetry: false }, fetcher))
      .rejects.toMatchObject({ code: "MODEL_ERROR", message: "The current prompt does not fit the model context window." });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
