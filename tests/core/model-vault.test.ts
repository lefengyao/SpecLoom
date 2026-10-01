import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ModelVault, type EncryptionAdapter } from "../../src/main/core/model-vault";
import type { ModelProfile } from "../../src/shared/contracts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const adapter: EncryptionAdapter = {
  isAvailable: () => true,
  encrypt: (value) => Buffer.from(Buffer.from(value).map((byte) => byte ^ 0x5a)),
  decrypt: (value) => Buffer.from(value).map((byte) => byte ^ 0x5a).toString(),
};
function profile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return { id: "local", name: "Local model", provider: "openai-compatible", model: "mock", baseUrl: "http://localhost:11434/v1/",
    approved: true, timeoutMs: 1000, maxToolRounds: 3, ...overrides };
}
async function directory() { const path = await mkdtemp(join(tmpdir(), "specloom-vault-")); directories.push(path); return path; }

describe("ModelVault", () => {
  it("persists encrypted credentials only outside projects and never lists them", async () => {
    const root = await directory();
    const vault = new ModelVault(root, adapter);
    await vault.save(profile(), "test-secret-key");
    expect(await vault.list()).toEqual([profile()]);
    const raw = await readFile(join(root, "model-profiles.json"), "utf8");
    expect(raw).not.toContain("test-secret-key");
    expect(await new ModelVault(root, adapter).resolveCredential(profile())).toBe("test-secret-key");
    await vault.remove("local");
    expect(await vault.list()).toEqual([]);
  });

  it("binds approval and credentials to the normalized endpoint", async () => {
    const vault = new ModelVault(await directory(), adapter);
    await vault.save(profile(), "test-secret-key");
    expect(await vault.resolveCredential(profile({ baseUrl: "http://localhost:11434/v1" }))).toBe("test-secret-key");
    await expect(vault.resolveCredential(profile({ baseUrl: "https://elsewhere.example/v1" }))).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    await expect(vault.save(profile({ baseUrl: "https://elsewhere.example/v1" }))).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    expect((await vault.get("local"))!.baseUrl).toBe(profile().baseUrl);
    await vault.save(profile({ baseUrl: "https://elsewhere.example/v1" }), "new-key");
    expect(await vault.resolveCredential(profile({ baseUrl: "https://elsewhere.example/v1" }))).toBe("new-key");
  });

  it("supports explicit approved keyless profiles and rejects stale or unapproved configuration", async () => {
    const vault = new ModelVault(await directory(), adapter);
    await expect(vault.save(profile())).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    await vault.save(profile(), "");
    expect(await vault.resolveCredential(profile())).toBeUndefined();
    await expect(vault.resolveCredential(profile({ approved: false }))).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    await expect(vault.resolveCredential(profile({ baseUrl: "https://other.example" }))).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
  });

  it("fails closed when the encryption adapter is unavailable", async () => {
    const vault = new ModelVault(await directory(), { ...adapter, isAvailable: () => false });
    await expect(vault.save(profile(), "private-key")).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
    expect(await vault.list()).toEqual([]);
  });

  it("detects a public profile edit even when its approval field is copied", async () => {
    const root = await directory();
    const vault = new ModelVault(root, adapter);
    await vault.save(profile(), "private-key");
    const raw = JSON.parse(await readFile(vault.path, "utf8"));
    const changed = profile({ baseUrl: "https://other.example/v1" });
    raw.records[0].profile = changed;
    raw.records[0].approvedEndpoint = "https://other.example/v1/chat/completions";
    await writeFile(vault.path, JSON.stringify(raw));
    await expect(vault.resolveCredential(changed)).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
  });

  it("rejects an oversized aggregate save and preserves a readable vault", async () => {
    const vault = new ModelVault(await directory(), adapter);
    let previous = "";
    let rejected = false;
    for (let index = 0; index < 128; index++) {
      try { await vault.save(profile({ id: `profile-${index}` }), "x".repeat(8192)); }
      catch (error) { expect(error).toMatchObject({ code: "MODEL_ERROR" }); rejected = true; break; }
      previous = await readFile(vault.path, "utf8");
    }
    expect(rejected).toBe(true);
    expect(await readFile(vault.path, "utf8")).toBe(previous);
    expect((await vault.list()).length).toBeGreaterThan(0);
    await vault.remove("profile-0");
  });
});
