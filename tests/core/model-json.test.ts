import { describe, expect, it } from "vitest";
import {
  MODEL_JSON_MAX_CHARS,
  encodeModelSettingsJson,
  parseModelSettingsJson,
} from "../../src/main/core/model-json";

const valid = {
  schemaVersion: 1,
  reasoningSupport: true,
  vision: false,
  reasoning: "medium",
  reasoningMap: { path: "thinking.type", values: { medium: "enabled", off: "disabled" } },
  contextTokens: 131072,
  maxOutputTokens: 8192,
};

describe("model settings JSON v1", () => {
  it("round trips the complete strict document", () => {
    const settings = parseModelSettingsJson(JSON.stringify(valid));
    expect(settings).toEqual({
      reasoningSupport: valid.reasoningSupport,
      vision: valid.vision,
      reasoning: valid.reasoning,
      reasoningMap: valid.reasoningMap,
      contextTokens: valid.contextTokens,
      maxOutputTokens: valid.maxOutputTokens,
    });
    expect(parseModelSettingsJson(encodeModelSettingsJson(settings))).toEqual(settings);
  });

  it("rejects missing and extra fields transactionally", () => {
    expect(() => parseModelSettingsJson(JSON.stringify({ ...valid, extra: true }))).toThrow(/额外字段/);
    const missing = { ...valid } as Record<string, unknown>;
    delete missing.reasoningMap;
    expect(() => parseModelSettingsJson(JSON.stringify(missing))).toThrow(/必需字段/);
  });

  it("rejects malformed JSON, wrong versions and oversized input", () => {
    expect(() => parseModelSettingsJson("{" )).toThrow(/合法 JSON/);
    expect(() => parseModelSettingsJson(JSON.stringify({ ...valid, schemaVersion: 2 }))).toThrow(/schemaVersion/);
    expect(() => parseModelSettingsJson("x".repeat(MODEL_JSON_MAX_CHARS + 1))).toThrow(/64000/);
  });

  it("enforces safe positive integer bounds and output <= context", () => {
    expect(() => parseModelSettingsJson(JSON.stringify({ ...valid, contextTokens: 0 }))).toThrow(/正的安全整数/);
    expect(() => parseModelSettingsJson(JSON.stringify({ ...valid, contextTokens: Number.MAX_SAFE_INTEGER + 1 }))).toThrow(/安全整数/);
    expect(() => parseModelSettingsJson(JSON.stringify({ ...valid, maxOutputTokens: 131073 }))).toThrow(/不能大于/);
    expect(parseModelSettingsJson(JSON.stringify({ ...valid, maxToolRounds: 20 })).maxToolRounds).toBeUndefined();
    expect(() => parseModelSettingsJson(JSON.stringify({ ...valid, maxToolRounds: 257 }))).toThrow(/不能大于 256/);
  });

  it.each([64, 128, 256])("accepts and drops the legacy %s tool round setting", (maxToolRounds) => {
    const settings = parseModelSettingsJson(JSON.stringify({ ...valid, maxToolRounds }));
    expect(settings.maxToolRounds).toBeUndefined();
    expect(parseModelSettingsJson(encodeModelSettingsJson(settings))).toEqual(settings);
  });

  it("does not emit the legacy tool round setting in newly written settings", () => {
    expect(JSON.parse(encodeModelSettingsJson({ ...parseModelSettingsJson(JSON.stringify(valid)), maxToolRounds: 20 }))).not.toHaveProperty("maxToolRounds");
  });

  it("rejects dangerous paths, reserved request fields and invalid reasoning maps", () => {
    for (const path of ["__proto__.polluted", "prototype.x", "constructor.x", "model", "messages.0", "tools", "stream"]) {
      expect(() => parseModelSettingsJson(JSON.stringify({ ...valid, reasoningMap: { path, values: { high: "1" } } }))).toThrow();
    }
    expect(() => parseModelSettingsJson(JSON.stringify({ ...valid, reasoningMap: { path: "thinking", values: {} } }))).toThrow();
    expect(() => parseModelSettingsJson(JSON.stringify({ ...valid, reasoningMap: { path: "thinking", values: { turbo: "1" } } }))).toThrow();
    expect(() => parseModelSettingsJson(JSON.stringify({ ...valid, reasoningMap: { path: "thinking", values: { high: 1 } } }))).toThrow();
  });

  it("allows null reasoningMap and retains zero-like strings as user input", () => {
    const settings = parseModelSettingsJson(JSON.stringify({ ...valid, reasoningMap: null, reasoning: "off" }));
    expect(settings.reasoningMap).toBeNull();
    expect(parseModelSettingsJson(JSON.stringify({ ...valid, reasoningMap: { path: "thinking", values: { off: "false" } } })).reasoningMap).toEqual({ path: "thinking", values: { off: "false" } });
  });
});
