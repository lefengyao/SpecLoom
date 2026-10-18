import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_MODEL_TIMEOUT_MS, MAX_MODEL_TOOL_ROUNDS, ModelReferenceSchema, ProviderInputSchema, type ModelProfile } from "../../src/shared/contracts";
import { parseModelProfile, type RuntimeModelProfile } from "../../src/main/core/model-config";
import { parseModelSettingsJson } from "../../src/main/core/model-json";
import { MODEL_FAMILIES, resolveModelSettings } from "../../src/main/core/model-settings";
import { ModelVault } from "../../src/main/core/model-vault";

function profile(overrides: Partial<RuntimeModelProfile> = {}): RuntimeModelProfile {
  return {
    id: "fixture", name: "Fixture", provider: "openai-compatible", model: "fixture",
    baseUrl: "https://model.test/v1", approved: true, timeoutMs: 1000, maxToolRounds: 1,
    ...overrides,
  };
}

describe("runtime model profile token limits", () => {
  it.each(MODEL_FAMILIES)("accepts the built-in $id output/context defaults", (family) => {
    const effective = resolveModelSettings(family.match);
    const value = profile({ model: family.match, contextTokens: effective.contextTokens, maxOutputTokens: effective.maxOutputTokens });
    expect(parseModelProfile(value)).toEqual(value);
  });

  it("accepts a larger custom output limit already validated by the JSON editor", () => {
    const settings = parseModelSettingsJson(JSON.stringify({
      schemaVersion: 1, reasoningSupport: false, vision: false, reasoning: "off", reasoningMap: null,
      contextTokens: 1_048_576, maxOutputTokens: 262_144,
    }));
    const value = profile({
      reasoningSupport: settings.reasoningSupport,
      vision: settings.vision,
      reasoning: settings.reasoning,
      reasoningMap: settings.reasoningMap,
      contextTokens: settings.contextTokens,
      maxOutputTokens: settings.maxOutputTokens,
    });
    expect(parseModelProfile(value)).toEqual(value);
  });

  it("rejects output exceeding an explicitly configured context window", () => {
    expect(() => parseModelProfile(profile({ contextTokens: 8192, maxOutputTokens: 8193 }))).toThrow(/Invalid or unbounded/);
    expect(parseModelProfile(profile({ contextTokens: 8192, maxOutputTokens: 8192 })).maxOutputTokens).toBe(8192);
  });

  it("rejects unsupported context aliases instead of advertising them in the runtime profile", () => {
    expect(() => parseModelProfile({ ...profile(), maxContextTokens: 8192 })).toThrow(/Invalid or unbounded/);
  });

  it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])("rejects invalid token value %s", (value) => {
    expect(() => parseModelProfile(profile({ maxOutputTokens: value }))).toThrow(/Invalid or unbounded/);
    expect(() => parseModelProfile(profile({ contextTokens: value }))).toThrow(/Invalid or unbounded/);
  });

  it("preserves request duration and legacy profile field validation", () => {
    expect(() => parseModelProfile(profile({ timeoutMs: MAX_MODEL_TIMEOUT_MS + 1 }))).toThrow(/Invalid or unbounded/);
    expect(() => parseModelProfile(profile({ maxToolRounds: MAX_MODEL_TOOL_ROUNDS + 1 }))).toThrow(/Invalid or unbounded/);
  });

  it.each([64, 128, 256])("reads a legacy %s tool round setting without resolving an effective cap", (maxToolRounds) => {
    const provider = ProviderInputSchema.parse({
      id: "provider", name: "Provider", protocol: "openai", baseUrl: "https://model.test/v1", models: ["fixture"],
      modelSettings: { fixture: { maxToolRounds } },
    });
    const settings = resolveModelSettings({ modelSettings: provider.modelSettings ?? {} }, "fixture");
    expect(settings).not.toHaveProperty("maxToolRounds");
    const value = profile({ maxToolRounds });
    expect(parseModelProfile(value)).toEqual(value);
  });

  it("accepts a runtime profile with no legacy tool round setting", () => {
    const value = profile();
    delete value.maxToolRounds;
    expect(parseModelProfile(value)).toEqual(value);
  });

  it("round-trips a legacy profile with a supported larger output limit through the vault", async () => {
    const root = await mkdtemp(join(tmpdir(), "specloom-profile-limits-"));
    try {
      const vault = new ModelVault(root, {
        isAvailable: () => false,
        encrypt: () => { throw new Error("Keyless fixture must not encrypt"); },
        decrypt: () => { throw new Error("Keyless fixture must not decrypt"); },
      });
      const value: ModelProfile = profile({ model: "gpt-5", maxOutputTokens: 128_000 });
      await expect(vault.save(value, "")).resolves.toEqual(value);
      expect(await vault.list()).toEqual([value]);
      await expect(vault.resolveCredential(value)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("runtime provider profile identity limits", () => {
  it.each([
    { label: "long model ID", providerId: "provider", providerName: "Provider", model: "m".repeat(512) },
    { label: "composed profile ID", providerId: "p".repeat(256), providerName: "Provider", model: "mock" },
    { label: "composed profile name", providerId: "provider", providerName: "n".repeat(256), model: "mock" },
    { label: "maximum provider and model identifiers", providerId: "p".repeat(256), providerName: "n".repeat(256), model: "m".repeat(512) },
  ])("accepts $label already accepted by provider configuration", ({ providerId, providerName, model }) => {
    const provider = ProviderInputSchema.parse({ id: providerId, name: providerName, protocol: "openai", baseUrl: "https://model.test/v1", models: [model] });
    const reference = ModelReferenceSchema.parse({ providerId, model });
    const value = profile({
      id: `${provider.id}:${reference.model}`, name: `${provider.name} / ${reference.model}`,
      protocol: provider.protocol, providerId: reference.providerId, model: reference.model,
    });
    expect(parseModelProfile(value)).toEqual(value);
  });

  it.each([
    { field: "id", limit: 769 },
    { field: "name", limit: 771 },
    { field: "model", limit: 512 },
    { field: "providerId", limit: 256 },
  ] as const)("rejects provider runtime $field beyond $limit characters", ({ field, limit }) => {
    expect(() => parseModelProfile(profile({ providerId: "provider", [field]: "x".repeat(limit + 1) }))).toThrow(/Invalid or unbounded/);
  });

  it.each(["id", "name", "model"] as const)("preserves the 256-character legacy $field limit without a provider ID", (field) => {
    const boundary = profile({ [field]: "x".repeat(256) });
    expect(parseModelProfile(boundary)).toEqual(boundary);
    expect(() => parseModelProfile(profile({ [field]: "x".repeat(257) }))).toThrow(/Invalid or unbounded/);
  });

  it("does not allow an empty provider ID to enable the extended limits", () => {
    expect(() => parseModelProfile(profile({ providerId: "", model: "m".repeat(512) }))).toThrow(/Invalid or unbounded/);
  });
});
