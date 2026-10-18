import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderVault, type ProviderEncryptionAdapter } from "../../src/main/core/provider-vault";
import { ModelVault } from "../../src/main/core/model-vault";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const encryption: ProviderEncryptionAdapter = {
  isAvailable: () => true,
  encrypt: (value) => Buffer.from(Buffer.from(value).map((byte) => byte ^ 0x5a)),
  decrypt: (value) => Buffer.from(value).map((byte) => byte ^ 0x5a).toString(),
};
async function root() { const path = await mkdtemp(join(tmpdir(), "specloom-provider-")); roots.push(path); return path; }
const input = { id: "openai", name: "OpenAI", protocol: "openai" as const, baseUrl: "https://api.example.test/v1", models: ["gpt-4o"] };

describe("ProviderVault", () => {
  it.each([
    ["openai", "/v1/chat/completions/", "/v1/models"],
    ["openai", "/gateway/v1/chat/completions", "/gateway/v1/models"],
    ["openai", "/gateway/v1/models", "/gateway/v1/models"],
    ["anthropic", "/v1/messages", "/v1/models"],
    ["anthropic", "/gateway/v1/messages", "/gateway/v1/models"],
    ["anthropic", "/v1/models", "/v1/models"],
    ["gemini", "/v1beta/models/gemini-2.5-pro:generateContent", "/v1beta/models"],
    ["gemini", "/gateway/v1beta/models/gemini-3-flash:streamGenerateContent", "/gateway/v1beta/models"],
    ["gemini", "/v1beta/openai", "/v1beta/models"],
    ["gemini", "/v1beta/models", "/v1beta/models"],
  ] as const)("discovers %s models from the complete endpoint %s", async (protocol, pathname, expectedPath) => {
    const vault = new ProviderVault(await root(), encryption);
    await vault.save({ ...input, protocol, baseUrl: `https://api.example.test${pathname}?alt=sse#fragment` }, "fixture-key");
    const models = await vault.discover(input.id, async (url) => {
      expect(String(url)).toBe(`https://api.example.test${expectedPath}`);
      return new Response(JSON.stringify({ data: [{ id: "fixture" }], models: [{ name: "models/fixture" }] }), {
        headers: { "content-type": "application/json" },
      });
    });
    expect(models).toEqual(["fixture"]);
  });

  it("bounds real connection checks and propagates an authentication failure", async () => {
    const vault = new ProviderVault(await root(), encryption);
    await vault.save(input, "fixture-key");
    await expect(vault.discover(input.id, async (_url, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.headers).toMatchObject({ Authorization: "Bearer fixture-key" });
      return new Response(null, { status: 401 });
    })).rejects.toMatchObject({ message: "Provider model discovery failed with HTTP 401." });
  });
  it("persists encrypted credentials and exposes only public status", async () => {
    const vault = new ProviderVault(await root(), encryption);
    const saved = await vault.save(input, "sk-secret-value");
    expect(saved[0]).toMatchObject({ id: "openai", hasKey: true, keyPreview: "sk-s****alue", keyStorage: "encrypted" });
    const raw = await readFile(vault.path, "utf8");
    expect(raw).not.toContain("sk-secret-value");
    expect(await vault.resolveCredential({ providerId: "openai", model: "gpt-4o" })).toBe("sk-secret-value");
  });

  it("reuses an existing key when editing without a new key and prunes model settings", async () => {
    const vault = new ProviderVault(await root(), encryption);
    await vault.save({ ...input, modelSettings: { "gpt-4o": { vision: true, maxToolRounds: 20 }, stale: { reasoning: "low" } } }, "old-key");
    expect((await vault.get("openai"))?.modelSettings["gpt-4o"]?.maxToolRounds).toBe(20);
    await vault.save({ ...input, models: ["gpt-4o", "gpt-4o", "manual"], modelSettings: { "manual": { reasoning: "high" } } });
    expect((await vault.list())[0]).toMatchObject({ models: ["gpt-4o", "manual"], modelSettings: { manual: { reasoning: "high" } } });
    expect(await vault.resolveCredential({ providerId: "openai", model: "manual" })).toBe("old-key");
    await vault.removeModel("openai", "manual");
    expect((await vault.get("openai"))?.models).toEqual(["gpt-4o"]);
  });

  it.each([12, 64, 256])("retains an explicit %s tool round limit when reopening a provider", async (maxToolRounds) => {
    const directory = await root();
    const vault = new ProviderVault(directory, encryption);
    await vault.save({ ...input, modelSettings: { "gpt-4o": { maxToolRounds } } });
    const reopened = new ProviderVault(directory, encryption);
    expect((await reopened.get(input.id))?.modelSettings["gpt-4o"]?.maxToolRounds).toBe(maxToolRounds);
  });

  it("migrates legacy model profiles into one provider on first read", async () => {
    const directory = await root();
    await writeFile(join(directory, "model-profiles.json"), JSON.stringify({ version: 1, records: [{
      profile: { id: "legacy", name: "Legacy", provider: "openai-compatible", model: "local", baseUrl: "http://localhost:1234/v1", approved: true, timeoutMs: 1000, maxToolRounds: 3 },
      credential: { kind: "keyless", endpoint: "http://localhost:1234/v1/chat/completions" },
      approvedEndpoint: "http://localhost:1234/v1/chat/completions",
    }] }));
    const vault = new ProviderVault(directory, encryption);
    expect(await vault.list()).toEqual([expect.objectContaining({ protocol: "openai", models: ["local"], hasKey: false, modelSettings: { local: { maxToolRounds: 3 } } })]);
    expect(await vault.resolveCredential({ providerId: "openai", model: "local" })).toBeUndefined();
  });

  it("reuses credentials supplied through ProviderInput for both omitted and blank edits", async () => {
    const directory = await root();
    const vault = new ProviderVault(directory, encryption);
    await vault.save({ ...input, apiKey: "old-secret" });
    await vault.save({ ...input, apiKey: "" });
    await vault.save({ ...input, apiKey: "   ", name: "Edited" });
    expect(await new ProviderVault(directory, encryption).resolveCredential({ providerId: "openai", model: "gpt-4o" })).toBe("old-secret");
  });

  it("does not rebind an old credential when the provider endpoint changes", async () => {
    const directory = await root();
    const vault = new ProviderVault(directory, encryption);
    await vault.save({ ...input, apiKey: "old-secret" });
    await expect(vault.save({ ...input, baseUrl: "https://other.example/v1", apiKey: "" })).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    expect((await vault.get("openai"))?.baseUrl).toBe(input.baseUrl);
  });

  it("preserves endpoint separation, keys and approval while migrating legacy profiles", async () => {
    const directory = await root();
    const legacy = new ModelVault(directory, encryption);
    await legacy.save({ id: "a", name: "A", provider: "openai-compatible", model: "same", baseUrl: "https://a.example/v1", approved: true, timeoutMs: 1000, maxToolRounds: 3 }, "a-key");
    await legacy.save({ id: "b", name: "B", provider: "openai-compatible", model: "same", baseUrl: "https://b.example/v1", approved: false, timeoutMs: 1000, maxToolRounds: 3 }, "b-key");
    const vault = new ProviderVault(directory, encryption);
    const providers = await vault.list();
    expect(providers).toHaveLength(2);
    const a = providers.find((provider) => provider.baseUrl.includes("a.example"))!;
    const b = providers.find((provider) => provider.baseUrl.includes("b.example"))!;
    expect(await vault.resolveCredential({ providerId: a.id, model: "same" })).toBe("a-key");
    await expect(vault.resolveCredential({ providerId: b.id, model: "same" })).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
  });

  it("fails closed on encryption and decryption errors without replacing saved state", async () => {
    const directory = await root();
    const vault = new ProviderVault(directory, encryption);
    await vault.save({ ...input, apiKey: "saved-secret" });
    const before = await readFile(vault.path, "utf8");
    const broken = new ProviderVault(directory, { ...encryption, encrypt: () => { throw new Error("secret"); } });
    await expect(broken.save({ ...input, apiKey: "new-secret" })).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
    expect(await readFile(vault.path, "utf8")).toBe(before);
    const unavailable = new ProviderVault(directory, { ...encryption, isAvailable: () => false });
    await expect(unavailable.resolveCredential({ providerId: input.id, model: "gpt-4o" })).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
  });

  it("gives an actionable recovery message when an encrypted key can no longer be decrypted", async () => {
    const directory = await root();
    const vault = new ProviderVault(directory, encryption);
    await vault.save({ ...input, apiKey: "saved-secret" });
    const broken = new ProviderVault(directory, {
      ...encryption,
      decrypt: () => { throw new Error("safeStorage key changed"); },
    });

    await expect(broken.resolveCredential({ providerId: input.id, model: "gpt-4o" })).rejects.toMatchObject({
      code: "BACKEND_UNAVAILABLE",
      message: "供应商密钥已失效，请进入“供应商 → 编辑供应商”重新输入 API 密钥后保存。",
    });
  });

  it("keeps encrypted provider metadata visible when credentials cannot be decrypted", async () => {
    const directory = await root();
    const vault = new ProviderVault(directory, encryption);
    await vault.save({ ...input, apiKey: "saved-secret" });

    const unavailable = new ProviderVault(directory, { ...encryption, isAvailable: () => false });
    expect(await unavailable.list()).toEqual([expect.objectContaining({
      id: input.id,
      name: input.name,
      models: input.models,
      hasKey: true,
      keyStorage: "encrypted",
    })]);
    expect((await unavailable.get(input.id))?.keyPreview).toBeUndefined();
  });

  it("marks an undecryptable encrypted key for reconfiguration without rewriting the vault", async () => {
    const directory = await root();
    const vault = new ProviderVault(directory, encryption);
    await vault.save({ ...input, apiKey: "saved-secret" });
    const before = await readFile(vault.path, "utf8");
    const broken = new ProviderVault(directory, {
      ...encryption,
      decrypt: () => { throw new Error("safeStorage key changed"); },
    });

    expect(await broken.list()).toEqual([expect.objectContaining({
      id: input.id,
      name: input.name,
      models: input.models,
      hasKey: false,
      keyStorage: "encrypted",
      credentialStatus: "needs-reconfiguration",
    })]);
    expect(await broken.get(input.id)).toEqual(expect.objectContaining({ credentialStatus: "needs-reconfiguration" }));
    expect(await readFile(vault.path, "utf8")).toBe(before);
  });

  it("serializes concurrent mutations and deletes model overrides and credentials", async () => {
    const directory = await root();
    const vault = new ProviderVault(directory, encryption);
    await Promise.all([
      vault.save({ ...input, apiKey: "a-key" }),
      vault.save({ ...input, id: "other", apiKey: "b-key", modelSettings: { "gpt-4o": { vision: true } } }),
    ]);
    expect(await vault.list()).toHaveLength(2);
    await vault.addModels("other", [" manual ", "manual", "second"]);
    expect((await vault.get("other"))?.models).toEqual(["gpt-4o", "manual", "second"]);
    await vault.removeModel("other", "gpt-4o");
    expect((await vault.get("other"))?.modelSettings).toEqual({});
    await vault.remove("other");
    await expect(vault.resolveCredential({ providerId: "other", model: "manual" })).rejects.toMatchObject({ code: "MODEL_ERROR" });
  });
});
