import { describe, expect, it } from "vitest";
import {
  GENERIC_FALLBACK,
  MODEL_FAMILIES,
  applyReasoningMap,
  estimateTokens,
  matchModelFamily,
  parseReasoningValue,
  reasoningBudget,
  resolveCapability,
  resolveContextWindow,
  resolveModelSettings,
  setByPath,
  temperatureFromPreference,
  validateReasoningMapPath,
} from "../../src/main/core/model-settings";

describe("effective model settings", () => {
  it("matches the most specific built-in family after stripping a vendor prefix", () => {
    expect(matchModelFamily("openai/gpt-4o-mini")?.id).toBe("gpt-4o");
    expect(matchModelFamily("anthropic/claude-3-7-sonnet")?.id).toBe("claude-3-7");
    expect(MODEL_FAMILIES.length).toBeGreaterThan(5);
  });

  it("matches model versions without confusing adjacent model numbers", () => {
    expect(matchModelFamily("openai/gpt-5.1")?.id).toBe("gpt-5");
    expect(matchModelFamily("vendor/o3-mini")?.id).toBe("o3");
    for (const model of ["gpt-50", "gpt-40", "o10", "o30", "o3x", "qwen30", "gemini-30", "gemini-3x"]) {
      expect(matchModelFamily(model)).toBeNull();
      expect(resolveModelSettings(model)).toMatchObject({
        reasoningSupport: false, vision: false, outputTokenParam: "max_tokens", source: "通用回退",
      });
    }
  });

  it("retains valid named families and Qwen version stems", () => {
    expect(matchModelFamily("gpt-4o")?.id).toBe("gpt-4o");
    expect(matchModelFamily("gpt-4o-mini")?.id).toBe("gpt-4o");
    expect(matchModelFamily("qwen2.5-coder")?.id).toBe("qwen");
    expect(matchModelFamily("qwen3.5-plus")?.id).toBe("qwen3");
    expect(matchModelFamily("qwen-vl-max")?.id).toBe("qwen-vl");
    expect(matchModelFamily("claude-haiku-4-5")?.id).toBe("claude");
    expect(matchModelFamily("deepseek-chat")?.id).toBe("deepseek");
    expect(matchModelFamily("grok-4")?.id).toBe("grok");
  });

  it("covers common StoryFabric model family limits", () => {
    expect(resolveModelSettings("claude-sonnet-4-5")).toMatchObject({ reasoningSupport: true, vision: true, contextTokens: 200000, maxOutputTokens: 64000 });
    expect(resolveModelSettings("gemini-2.5-pro")).toMatchObject({ reasoningSupport: true, contextTokens: 1048576, maxOutputTokens: 65536 });
    expect(resolveModelSettings("qwen3-max")).toMatchObject({ reasoningSupport: true, contextTokens: 1048576 });
    expect(resolveModelSettings("deepseek-chat")).toMatchObject({ reasoningSupport: false, vision: false });
    expect(resolveModelSettings("gpt-4-turbo")).toMatchObject({ maxOutputTokens: 4096 });
    expect(resolveModelSettings("gemini-3-pro")).toMatchObject({ reasoningSupport: true, maxOutputTokens: 64000 });
  });

  it("enables default reasoning for DeepSeek Flash and V4 models", () => {
    for (const model of ["deepseek-flash", "deepseek-v4", "vendor/deepseek-flash", "vendor/deepseek-v4"]) {
      expect(resolveModelSettings(model)).toMatchObject({ reasoningSupport: true, reasoning: "high", vision: false, contextTokens: 131072, maxOutputTokens: 8192 });
    }
    expect(resolveModelSettings("deepseek-chat")).toMatchObject({ reasoningSupport: false, reasoning: "off" });
  });

  it("keeps explicit DeepSeek reasoning overrides above family defaults", () => {
    expect(resolveModelSettings("deepseek-flash", { reasoning: "off" })).toMatchObject({ reasoningSupport: true, reasoning: "off" });
    expect(resolveModelSettings("deepseek-v4", { reasoningSupport: false })).toMatchObject({ reasoningSupport: false, reasoning: "high" });
  });

  it("uses conservative values for unknown models", () => {
    expect(resolveModelSettings("custom-company/model-x", undefined)).toMatchObject({
      reasoningSupport: GENERIC_FALLBACK.reasoningSupport,
      vision: GENERIC_FALLBACK.vision,
      reasoning: "off",
      contextTokens: 131072,
      maxOutputTokens: 8192,
      source: "通用回退",
    });
  });

  it("ignores legacy tool round settings and does not generate a round cap", () => {
    for (const model of ["gpt-5", "deepseek-flash", "unknown/model"]) {
      const defaults = resolveModelSettings(model);
      expect(defaults).not.toHaveProperty("maxToolRounds");
      expect(resolveModelSettings(model, { maxToolRounds: 12 })).toEqual(defaults);
      expect(resolveModelSettings(model, { maxToolRounds: 256 })).toEqual(defaults);
    }
  });

  it("applies user overrides above family defaults, including explicit false", () => {
    const resolved = resolveModelSettings("gpt-5", {
      reasoningSupport: false,
      vision: false,
      reasoning: "high",
      contextTokens: 10000,
      maxOutputTokens: 2000,
      maxToolRounds: 20,
    });
    expect(resolved).toMatchObject({
      reasoningSupport: false,
      vision: false,
      reasoning: "high",
      contextTokens: 10000,
      maxOutputTokens: 2000,
    });
    expect(resolved.overridden).toEqual(expect.arrayContaining([
      "reasoningSupport", "vision", "reasoning", "contextTokens", "maxOutputTokens",
    ]));
    expect(resolved.overridden).not.toContain("maxToolRounds");
    expect(resolved.source).toContain("手动覆盖");
  });

  it("maps reasoning values to native JSON values and safely creates nested paths", () => {
    const body: Record<string, unknown> = { generationConfig: { maxOutputTokens: 8192 } };
    const map = { path: "generationConfig.thinkingConfig.thinkingBudget", values: { high: "4096" } } as const;
    expect(applyReasoningMap(body, map, "high")).toBe(true);
    expect(body).toEqual({ generationConfig: { maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 4096 } } });
    expect(parseReasoningValue("true")).toBe(true);
    expect(parseReasoningValue("raw-value")).toBe("raw-value");
    expect(parseReasoningValue("null")).toBeUndefined();
  });

  it("rejects prototype and request skeleton paths", () => {
    for (const path of ["__proto__.polluted", "constructor.x", "prototype.x", "messages.0", "max_tokens", "a..b", ".x", "x."]) {
      expect(() => validateReasoningMapPath(path)).toThrow();
    }
    const target: Record<string, unknown> = {};
    setByPath(target, "__proto__.polluted", true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(target).toEqual({});
  });

  it("uses bounded reasoning budgets for Anthropic and Gemini", () => {
    expect(reasoningBudget("off", 8192)).toBe(0);
    expect(reasoningBudget("low", 8192)).toBe(2048);
    expect(reasoningBudget("high", 4096)).toBe(3072);
    expect(reasoningBudget("high", 1500)).toBe(0);
  });

  it("exposes capability, context accounting, and temperature helpers", () => {
    expect(resolveCapability("gpt-5")).toEqual({ reasoning: true, vision: true });
    expect(resolveCapability("unknown/model")).toEqual({ reasoning: false, vision: false });
    expect(resolveCapability("gpt-5", { reasoningSupport: false, vision: false })).toEqual({ reasoning: false, vision: false });
    expect(resolveContextWindow("gpt-5", { contextTokens: 10_000, maxOutputTokens: 20_000 })).toEqual({ contextTokens: 10_000, maxOutputTokens: 10_000 });
    expect(resolveContextWindow("unknown/model")).toEqual({ contextTokens: 131_072, maxOutputTokens: 8_192 });
    expect(estimateTokens("abcd")).toBe(3);
    expect(temperatureFromPreference(80)).toBeCloseTo(0.4);
    expect(temperatureFromPreference(-10)).toBeCloseTo(1.3);
    expect(temperatureFromPreference(110)).toBeCloseTo(0.1);
  });
});
