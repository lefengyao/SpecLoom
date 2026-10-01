import { describe, expect, it } from "vitest";
import {
  ChangeEntrySchema,
  ChangeSetDataSchema,
  ModelProfileSchema,
  TaskScopeSpecSchema,
  TextPatchSchema,
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
