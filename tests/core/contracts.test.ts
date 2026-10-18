import { describe, expect, it } from "vitest";
import {
  ChangeEntrySchema,
  ChangeSetDataSchema,
  CredentialStatusSchema,
  ModelReferenceSchema,
  ModelSettingsJsonV1Schema,
  ModelProfileSchema,
  ProviderInputSchema,
  ProviderPublicSchema,
  ReasoningMapSchema,
  SessionModelPreferenceSchema,
  TaskScopeSpecSchema,
  TextPatchSchema,
  UsageRecordSchema,
  ValidationResultSchema,
  VersionTokenSchema,
} from "../../src/shared/contracts";
import { ProjectError, serializeError } from "../../src/main/core/errors";

const version = `sha256:${"a".repeat(64)}`;

describe("shared contracts", () => {
  it("accepts only absent or complete SHA-256 file versions", () => {
    expect(VersionTokenSchema.parse("absent")).toBe("absent");
    expect(VersionTokenSchema.parse(version)).toBe(version);
    expect(VersionTokenSchema.safeParse("sha256:abc").success).toBe(false);
    expect(VersionTokenSchema.safeParse("mtime:123").success).toBe(false);
  });

  it("requires exact nonempty patch context and replacement contents for writes", () => {
    expect(TextPatchSchema.safeParse({ search: "", replace: "new" }).success).toBe(false);
    expect(ChangeEntrySchema.safeParse({
      path: "specs/project.md", operation: "update", expectedVersion: version,
      sourceTaskId: "task-1", sourceTool: "patch_file",
    }).success).toBe(false);
    expect(ChangeEntrySchema.parse({
      path: "specs/project.md", operation: "update", expectedVersion: version,
      nextContent: "", sourceTaskId: "task-1", sourceTool: "patch_file",
    }).nextContent).toBe("");
  });

  it("defaults task scopes to manual execution and no delete authority", () => {
    const scope = TaskScopeSpecSchema.parse({ id: "task-1", title: "Draft", readPaths: ["specs/**"], writePaths: ["specs/project.md"] });
    expect(scope.mode).toBe("manual");
    expect(scope.allowDelete).toBe(false);
  });

  it("validates durable change journals with file dependencies", () => {
    expect(ChangeSetDataSchema.parse({
      id: "change-1", taskId: "task-1", entries: [], dependencies: { "specs/project.md": version },
      digest: version, status: "recovery-conflict",
    }).status).toBe("recovery-conflict");
  });

  it("represents validation command evidence and structured diagnostics", () => {
    expect(ValidationResultSchema.parse({
      status: "fail", checks: [{ id: "godot", name: "Godot validation", status: "fail", command: ["godot", "--headless"], exitCode: 1, stdout: "", stderr: "Parse failed" }],
      diagnostics: [{ severity: "error", message: "Parse failed", path: "res://main.gd", line: 2 }],
    }).checks[0]?.stderr).toBe("Parse failed");
  });

  it("keeps credentials out of model profiles", () => {
    const profile = { id: "local", name: "Local", provider: "openai-compatible", model: "test-model", baseUrl: "http://localhost:1234/v1", approved: true, timeoutMs: 60000, maxToolRounds: 8 };
    expect(ModelProfileSchema.parse(profile)).toEqual(profile);
    expect(ModelProfileSchema.safeParse({ ...profile, apiKey: "secret" }).success).toBe(false);
    expect(ModelProfileSchema.safeParse({ ...profile, baseUrl: "http://user:password@localhost:1234/v1" }).success).toBe(false);
    expect(ModelProfileSchema.safeParse({ ...profile, baseUrl: "https://example.invalid/v1?api_key=synthetic-secret" }).success).toBe(false);
    expect(ModelProfileSchema.safeParse({ ...profile, baseUrl: "https://example.invalid/v1?accessToken=synthetic-secret" }).success).toBe(false);
  });

  it("validates multi-provider inputs and keeps public credentials redacted", () => {
    const settings = {
      reasoningSupport: true,
      vision: false,
      reasoning: "medium" as const,
      reasoningMap: null,
      contextTokens: 131072,
      maxOutputTokens: 8192,
    };
    const input = {
      id: "provider-openai",
      name: "OpenAI",
      protocol: "openai" as const,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "secret",
      models: ["gpt-5", "gpt-5"],
      modelSettings: { "gpt-5": settings },
    };
    expect(ProviderInputSchema.parse(input)).toEqual(input);
    expect(ProviderInputSchema.safeParse({ ...input, protocol: "openai-compatible" }).success).toBe(false);
    expect(ProviderPublicSchema.safeParse({
      id: input.id,
      name: input.name,
      protocol: input.protocol,
      baseUrl: input.baseUrl,
      models: ["gpt-5"],
      modelSettings: input.modelSettings,
      hasKey: true,
      keyPreview: "sk-...cret",
      keyStorage: "encrypted",
    }).success).toBe(true);
    expect(ProviderPublicSchema.safeParse({
      id: input.id, name: input.name, protocol: input.protocol, baseUrl: input.baseUrl,
      models: ["gpt-5"], modelSettings: input.modelSettings, hasKey: true,
      keyPreview: "sk-...cret", keyStorage: "encrypted", apiKey: "secret",
    }).success).toBe(false);
  });

  it("enforces complete model JSON v1 settings and safe integer limits", () => {
    const settings = {
      schemaVersion: 1 as const,
      reasoningSupport: false,
      vision: false,
      reasoning: "off" as const,
      reasoningMap: null,
      contextTokens: 131072,
      maxOutputTokens: 8192,
    };
    expect(ModelSettingsJsonV1Schema.parse(settings)).toEqual(settings);
    expect(ModelSettingsJsonV1Schema.safeParse({ ...settings, extra: true }).success).toBe(false);
    expect(ModelSettingsJsonV1Schema.safeParse({ ...settings, maxOutputTokens: 131073 }).success).toBe(false);
    expect(ModelSettingsJsonV1Schema.safeParse({ ...settings, contextTokens: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
    expect(ModelSettingsJsonV1Schema.safeParse({ ...settings, maxOutputTokens: 131073, contextTokens: 131072 }).success).toBe(false);
    expect(ModelSettingsJsonV1Schema.safeParse({ ...settings, reasoningMap: {
      path: "__proto__.polluted",
      values: { low: "2048" },
    } }).success).toBe(false);
    expect(ReasoningMapSchema.safeParse({ path: "thinking", values: { low: "2048" } }).success).toBe(true);
    expect(ReasoningMapSchema.safeParse({ path: "generationConfig.temperature", values: { high: "0.1" } }).success).toBe(false);
  });

  it("uses provider/model references and normalizes session reasoning and usage", () => {
    const reference = { providerId: "provider-openai", model: "gpt-5" };
    expect(ModelReferenceSchema.parse(reference)).toEqual(reference);
    expect(SessionModelPreferenceSchema.parse({ ...reference, reasoning: "inherit" })).toEqual({ ...reference, reasoning: "inherit" });
    expect(SessionModelPreferenceSchema.safeParse({ ...reference, reasoning: "turbo" }).success).toBe(false);
    expect(UsageRecordSchema.parse({
      at: Date.now(), providerId: reference.providerId, providerName: "OpenAI", model: reference.model,
      promptTokens: 10, completionTokens: 20, cachedTokens: 0, cacheWriteTokens: 0,
    })).toMatchObject({ providerId: reference.providerId, completionTokens: 20 });
    expect(UsageRecordSchema.safeParse({
      at: 0, providerId: reference.providerId, providerName: "OpenAI", model: reference.model,
      promptTokens: -1, completionTokens: 20, cachedTokens: 0, cacheWriteTokens: 0,
    }).success).toBe(false);
    expect(CredentialStatusSchema.parse({ hasKey: false, keyStorage: "none" })).toEqual({ hasKey: false, keyStorage: "none" });
  });
});

describe("safe error serialization", () => {
  it("retains actionable project errors without stack traces or secret fields", () => {
    const serialized = serializeError(new ProjectError("VERSION_CONFLICT", "File changed", {
      path: "specs/project.md", apiKey: "secret", nested: { authorization: "Bearer secret", expectedVersion: version },
    }));
    expect(serialized).toEqual({ name: "ProjectError", code: "VERSION_CONFLICT", message: "File changed", details: { path: "specs/project.md", nested: { expectedVersion: version } } });
    expect(JSON.stringify(serialized)).not.toContain("secret");
    expect(serialized).not.toHaveProperty("stack");
  });

  it("does not expose unknown exception messages to the renderer", () => {
    expect(serializeError(new Error("endpoint returned secret apiKey=123"))).toEqual({ name: "ProjectError", code: "INTERNAL_ERROR", message: "An unexpected project error occurred." });
  });

  it("retains validated codes from error-like objects across module or IPC boundaries", () => {
    const error = Object.assign(new Error("Secure credential decryption failed."), {
      code: "BACKEND_UNAVAILABLE",
      details: { providerId: "openai", apiKey: "must-not-leak" },
    });
    expect(serializeError(error)).toEqual({
      name: "ProjectError",
      code: "BACKEND_UNAVAILABLE",
      message: "Secure credential decryption failed.",
      details: { providerId: "openai" },
    });
  });

  it("redacts quoted credential fields and token assignments in error strings", () => {
    const error = new ProjectError("MODEL_ERROR", 'Request failed {"apiKey":"synthetic-secret"} token=synthetic-secret', {
      response: '{"access_token":"synthetic-secret","password":"another secret"}',
    });
    const result = JSON.stringify(serializeError(error));
    expect(result).not.toContain("synthetic-secret");
    expect(result).not.toContain("another secret");
    expect(result).toContain("redacted");
  });
});
