import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  MAX_MODEL_TOOL_ROUNDS,
  ProviderInputSchema,
  ProviderPublicSchema,
  ProtocolSchema,
  ModelSettingsSchema,
  type ModelReference,
  type ProviderInput,
  type ProviderPublic,
  type ModelSettings,
} from "../../shared/contracts";
import { ProjectError } from "./errors";
import type { EncryptionAdapter } from "./model-vault";
/** Provider vault uses the same small adapter contract as the legacy model vault. */
export type ProviderEncryptionAdapter = EncryptionAdapter;

const MAX_VAULT_BYTES = 2 * 1024 * 1024;
const MAX_PROVIDERS = 128;
const MAX_MODELS = 2048;

const CredentialSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("encrypted"), ciphertext: z.string().min(1).max(32_768) }).strict(),
  z.object({ kind: z.literal("plain"), value: z.string().max(8_192) }).strict(),
  z.object({ kind: z.literal("none") }).strict(),
]);
const StoredProviderSchema = z.object({
  id: z.string().trim().min(1).max(256),
  name: z.string().trim().min(1).max(256),
  protocol: ProtocolSchema,
  baseUrl: z.string().url(),
  models: z.array(z.string().trim().min(1).max(512)).max(MAX_MODELS),
  modelSettings: z.record(z.string().trim().min(1).max(512), ModelSettingsSchema),
  credential: CredentialSchema,
  approved: z.boolean().default(true),
}).strict();
const VaultSchema = z.object({ version: z.literal(1), providers: z.array(StoredProviderSchema).max(MAX_PROVIDERS) }).strict();
type StoredProvider = z.infer<typeof StoredProviderSchema>;

const SealedCredentialSchema = z.object({ endpoint: z.string(), secret: z.string().min(1).max(8_192) }).strict();
const CREDENTIAL_RECONFIGURATION_MESSAGE = "供应商密钥已失效，请进入“供应商 → 编辑供应商”重新输入 API 密钥后保存。";

function cleanModels(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const model = typeof value === "string" ? value.trim() : "";
    if (!model || seen.has(model)) continue;
    seen.add(model);
    result.push(model);
  }
  return result.slice(0, MAX_MODELS);
}

function cleanSettings(models: readonly string[], settings: Record<string, ModelSettings> | undefined): Record<string, ModelSettings> {
  const allowed = new Set(models);
  return Object.fromEntries(Object.entries(settings ?? {}).filter(([id]) => allowed.has(id)).map(([id, value]) => [id, structuredClone(value)]));
}

function preview(secret: string): string | undefined {
  if (!secret) return undefined;
  if (secret.length <= 8) return "****";
  return `${secret.slice(0, 4)}****${secret.slice(-4)}`;
}

function endpoint(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    throw new ProjectError("MODEL_ERROR", "Invalid provider endpoint.");
  }
}

function credentialEndpoint(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/chat\/completions$/, "").replace(/\/messages$/, "");
  url.hash = "";
  url.searchParams.sort();
  return url.toString();
}

function safeParseStored(value: unknown): StoredProvider | undefined {
  const parsed = StoredProviderSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function decryptCredential(credential: StoredProvider["credential"], encryption: EncryptionAdapter, expectedEndpoint?: string): string {
  if (credential.kind === "none") return "";
  if (credential.kind === "plain") return credential.value;
  if (!encryption.isAvailable()) throw new ProjectError("BACKEND_UNAVAILABLE", "Secure credential decryption is unavailable.");
  try {
    const sealed = SealedCredentialSchema.parse(JSON.parse(encryption.decrypt(Buffer.from(credential.ciphertext, "base64"))));
    if (expectedEndpoint !== undefined && credentialEndpoint(sealed.endpoint) !== credentialEndpoint(expectedEndpoint)) throw new ProjectError("APPROVAL_REQUIRED", "The credential belongs to another provider endpoint.");
    return sealed.secret;
  } catch (error) {
    if (error instanceof ProjectError) throw error;
    throw new ProjectError("BACKEND_UNAVAILABLE", CREDENTIAL_RECONFIGURATION_MESSAGE);
  }
}

function sealCredential(secret: string, providerEndpoint: string, encryption: EncryptionAdapter): StoredProvider["credential"] {
  if (!secret) return { kind: "none" };
  if (!encryption.isAvailable()) throw new ProjectError("BACKEND_UNAVAILABLE", "Secure credential encryption is unavailable.");
  try {
    return { kind: "encrypted", ciphertext: encryption.encrypt(JSON.stringify({ endpoint: providerEndpoint, secret })).toString("base64") };
  } catch { throw new ProjectError("BACKEND_UNAVAILABLE", "Secure credential encryption failed."); }
}

function publicProvider(provider: StoredProvider, secret = "", credentialStatus: ProviderPublic["credentialStatus"] = "configured", hasKeyOverride?: boolean): ProviderPublic {
  const keyStorage = provider.credential.kind === "encrypted"
    ? "encrypted"
    : provider.credential.kind === "plain" && provider.credential.value
      ? "plain"
      : "none";
  return ProviderPublicSchema.parse({
    id: provider.id,
    name: provider.name,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    models: [...provider.models],
    modelSettings: structuredClone(provider.modelSettings),
    hasKey: hasKeyOverride ?? (provider.credential.kind === "encrypted" || Boolean(secret)),
    ...(preview(secret) ? { keyPreview: preview(secret) } : {}),
    keyStorage,
    credentialStatus,
  });
}

/** Listing providers should remain possible when the OS key store is temporarily unavailable. */
function publicProviderBestEffort(provider: StoredProvider, encryption: EncryptionAdapter): ProviderPublic {
  if (provider.credential.kind !== "encrypted") return publicProvider(provider, provider.credential.kind === "plain" ? provider.credential.value : "");
  // An unavailable OS key store is usually temporary (for example while the
  // desktop keychain is starting). Keep the configured state in that case so
  // the UI does not ask the user to replace a key that may still be usable.
  if (!encryption.isAvailable()) return publicProvider(provider, "", "configured");
  try {
    return publicProvider(provider, decryptCredential(provider.credential, encryption, provider.baseUrl));
  } catch (error) {
    // The encrypted record remains untouched. A decrypt failure means the
    // ciphertext is no longer recoverable with this key store and the user
    // must enter a replacement API key in the provider editor.
    if (error instanceof ProjectError && error.code !== "BACKEND_UNAVAILABLE") return publicProvider(provider);
    return publicProvider(provider, "", "needs-reconfiguration", false);
  }
}

function migrateLegacyProfileRecords(value: unknown): StoredProvider[] {
  if (!value || typeof value !== "object") return [];
  const root = value as Record<string, unknown>;
  const records = Array.isArray(root.records) ? root.records : [];
  const byEndpoint = new Map<string, { baseUrl: string; name: string; models: string[]; settings: Record<string, ModelSettings>; credentials: string[]; approved: boolean }>();
  for (const raw of records) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const profile = record.profile;
    if (!profile || typeof profile !== "object") continue;
    const model = profile as Record<string, unknown>;
    const baseUrl = typeof model.baseUrl === "string" ? model.baseUrl : "";
    const modelId = typeof model.model === "string" ? model.model.trim() : "";
    if (!baseUrl || !modelId) continue;
    let normalizedEndpoint: string;
    try { normalizedEndpoint = endpoint(baseUrl); } catch { continue; }
    const groupingKey = `${credentialEndpoint(normalizedEndpoint)}|${JSON.stringify(record.credential)}|${model.approved === true}`;
    let group = byEndpoint.get(groupingKey);
    if (!group) {
      group = { baseUrl: normalizedEndpoint, name: "Migrated OpenAI models", models: [], settings: {}, credentials: [], approved: model.approved === true };
      byEndpoint.set(groupingKey, group);
    }
    if (!group.models.includes(modelId)) group.models.push(modelId);
    if (model.approved === false) group.approved = false;
    const settings: ModelSettings = {};
    if (typeof model.temperature === "number") { /* legacy temperature is not a model setting */ }
    if (typeof model.maxOutputTokens === "number" && Number.isSafeInteger(model.maxOutputTokens) && model.maxOutputTokens > 0) settings.maxOutputTokens = model.maxOutputTokens;
    if (typeof model.maxToolRounds === "number" && Number.isSafeInteger(model.maxToolRounds) && model.maxToolRounds > 0 && model.maxToolRounds <= MAX_MODEL_TOOL_ROUNDS) settings.maxToolRounds = model.maxToolRounds;
    if (Object.keys(settings).length) group.settings[modelId] = settings;
    const credential = record.credential;
    if (credential && typeof credential === "object") {
      const encrypted = credential as Record<string, unknown>;
      if (encrypted.kind === "encrypted" && typeof encrypted.ciphertext === "string") group.credentials.push(encrypted.ciphertext);
    }
  }
  return [...byEndpoint.values()].map((group, index) => ({
    id: index === 0 ? "openai" : `openai-${index + 1}`,
    name: group.name,
    protocol: "openai" as const,
    baseUrl: group.baseUrl,
    models: cleanModels(group.models),
    modelSettings: cleanSettings(group.models, group.settings),
    credential: group.credentials[0] ? { kind: "encrypted" as const, ciphertext: group.credentials[0] } : { kind: "none" as const },
    approved: group.approved,
  }));
}

export interface ProviderVaultOptions {
  /** Legacy profile vault path can be overridden in tests. */
  legacyPath?: string;
}

export class ProviderVault {
  readonly path: string;
  private readonly legacyPath: string;
  private pending: Promise<void> = Promise.resolve();

  constructor(userDataDirectory: string, private readonly encryption: EncryptionAdapter, options: ProviderVaultOptions = {}) {
    const root = resolve(userDataDirectory);
    this.path = join(root, "providers.json");
    this.legacyPath = options.legacyPath ?? join(root, "model-profiles.json");
  }

  async list(): Promise<ProviderPublic[]> {
    await this.pending;
    const records = await this.readRecords();
    return records.map((provider) => publicProviderBestEffort(provider, this.encryption));
  }

  async get(id: string): Promise<ProviderPublic | undefined> {
    await this.pending;
    const records = await this.readRecords();
    const provider = records.find((candidate) => candidate.id === id);
    return provider ? publicProviderBestEffort(provider, this.encryption) : undefined;
  }

  async save(input: ProviderInput, secret?: string): Promise<ProviderPublic[]> {
    const parsed = ProviderInputSchema.parse(input);
    return this.enqueue(async () => {
      const records = await this.readRecords();
      const id = parsed.id ?? `provider-${randomUUID()}`;
      const existing = records.find((candidate) => candidate.id === id);
      const models = cleanModels(parsed.models);
      const baseUrl = endpoint(parsed.baseUrl);
      const suppliedSecret = secret === undefined ? parsed.apiKey : secret;
      if (existing && credentialEndpoint(existing.baseUrl) !== credentialEndpoint(baseUrl) && !suppliedSecret?.trim()) {
        throw new ProjectError("APPROVAL_REQUIRED", "Supply a credential when changing the provider endpoint.");
      }
      const nextCredential = suppliedSecret?.trim()
        ? sealCredential(suppliedSecret.trim(), baseUrl, this.encryption)
        : existing && credentialEndpoint(existing.baseUrl) === credentialEndpoint(baseUrl)
          ? existing.credential
          : { kind: "none" as const };
      const provider: StoredProvider = {
        id,
        name: parsed.name.trim(),
        protocol: parsed.protocol,
        baseUrl,
        models,
        modelSettings: cleanSettings(models, parsed.modelSettings),
        credential: nextCredential,
        approved: existing?.approved ?? true,
      };
      const next = [...records.filter((candidate) => candidate.id !== id), provider];
      await this.writeRecords(next);
      return next.map((candidate) => publicProviderBestEffort(candidate, this.encryption));
    });
  }

  async remove(id: string): Promise<ProviderPublic[]> {
    return this.enqueue(async () => {
      const records = await this.readRecords();
      const next = records.filter((provider) => provider.id !== id);
      await this.writeRecords(next);
      return next.map((candidate) => publicProviderBestEffort(candidate, this.encryption));
    });
  }

  /** Compatibility name used by the renderer/provider IPC layer. */
  async removeModel(id: string, model: string): Promise<ProviderPublic> { return this.deleteModel(id, model); }

  async addModels(id: string, modelIds: readonly string[]): Promise<ProviderPublic> {
    return this.enqueue(async () => {
      const records = await this.readRecords();
      const provider = records.find((candidate) => candidate.id === id);
      if (!provider) throw new ProjectError("MODEL_ERROR", "Provider not found.");
      const models = cleanModels([...provider.models, ...modelIds]);
      const next = { ...provider, models, modelSettings: cleanSettings(models, provider.modelSettings) };
      await this.writeRecords(records.map((candidate) => candidate.id === id ? next : candidate));
      return publicProviderBestEffort(next, this.encryption);
    });
  }

  async deleteModel(id: string, model: string): Promise<ProviderPublic> {
    return this.enqueue(async () => {
      const records = await this.readRecords();
      const provider = records.find((candidate) => candidate.id === id);
      if (!provider) throw new ProjectError("MODEL_ERROR", "Provider not found.");
      const models = provider.models.filter((candidate) => candidate !== model.trim());
      const settings = { ...provider.modelSettings };
      delete settings[model.trim()];
      const next = { ...provider, models, modelSettings: cleanSettings(models, settings) };
      await this.writeRecords(records.map((candidate) => candidate.id === id ? next : candidate));
      return publicProviderBestEffort(next, this.encryption);
    });
  }

  /** Fetch model identifiers from the provider's protocol-specific listing endpoint. */
  async discover(id: string, fetcher: (input: string | URL, init?: RequestInit) => Promise<Response> = fetch): Promise<string[]> {
    await this.pending;
    const records = await this.readRecords();
    const provider = records.find((candidate) => candidate.id === id);
    if (!provider) throw new ProjectError("MODEL_ERROR", "Provider not found.");
    const secret = decryptCredential(provider.credential, this.encryption, provider.baseUrl);
    const url = this.discoveryUrl(provider);
    const headers: Record<string, string> = {};
    if (provider.protocol === "anthropic") {
      if (secret) headers["x-api-key"] = secret;
      headers["anthropic-version"] = "2023-06-01";
    } else if (provider.protocol === "gemini") {
      if (secret) headers["x-goog-api-key"] = secret;
    } else if (secret) headers.Authorization = `Bearer ${secret}`;
    const response = await fetcher(url, { headers, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new ProjectError("MODEL_ERROR", `Provider model discovery failed with HTTP ${response.status}.`);
    const body = await response.json() as unknown;
    const ids = this.parseDiscovery(provider.protocol, body);
    return cleanModels(ids);
  }

  async resolveCredential(reference: ModelReference): Promise<string | undefined> {
    await this.pending;
    const records = await this.readRecords();
    const provider = records.find((candidate) => candidate.id === reference.providerId);
    if (!provider || !provider.models.includes(reference.model)) throw new ProjectError("MODEL_ERROR", "The selected provider/model is unavailable.");
    if (!provider.approved) throw new ProjectError("APPROVAL_REQUIRED", "The selected provider requires approval before use.");
    const secret = decryptCredential(provider.credential, this.encryption, provider.baseUrl);
    return secret || undefined;
  }

  private discoveryUrl(provider: StoredProvider): string {
    const parsed = new URL(provider.baseUrl);
    const path = parsed.pathname.replace(/\/+$/, "");
    if (provider.protocol === "anthropic") {
      const root = path.replace(/\/(?:messages|models)$/, "");
      parsed.pathname = `${root.endsWith("/v1") ? root : `${root}/v1`}/models`;
    } else if (provider.protocol === "gemini") {
      const root = path
        .replace(/\/models(?:\/[^/]+:(?:generateContent|streamGenerateContent))?$/, "")
        .replace(/\/v1beta\/openai$/, "/v1beta");
      parsed.pathname = `${root.endsWith("/v1beta") ? root : `${root}/v1beta`}/models`;
    } else {
      const root = path.replace(/\/chat\/completions$/, "");
      parsed.pathname = root.endsWith("/models") ? root : `${root}/models`;
    }
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  }

  private parseDiscovery(protocol: StoredProvider["protocol"], body: unknown): string[] {
    if (protocol === "gemini") {
      const models = body && typeof body === "object" && Array.isArray((body as { models?: unknown }).models) ? (body as { models: unknown[] }).models : [];
      return models.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const name = (item as { name?: unknown }).name;
        return typeof name === "string" ? [name.replace(/^models\//, "")] : [];
      });
    }
    const data = body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data) ? (body as { data: unknown[] }).data : [];
    return data.flatMap((item) => item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string" ? [(item as { id: string }).id] : []);
  }

  private async readRecords(): Promise<StoredProvider[]> {
    let raw: string | undefined;
    try { raw = await readFile(this.path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ProjectError("BACKEND_UNAVAILABLE", "The provider vault could not be read.");
    }
    if (raw !== undefined) {
      if (Buffer.byteLength(raw) > MAX_VAULT_BYTES) throw new ProjectError("MODEL_ERROR", "The provider vault exceeds the size limit.");
      try {
        const parsed = JSON.parse(raw) as unknown;
        const envelope = VaultSchema.safeParse(parsed);
        if (envelope.success) return envelope.data.providers;
        if (Array.isArray(parsed)) {
          const migrated = this.parseLegacyProviderArray(parsed);
          if (migrated.length) { await this.writeRecords(migrated); return migrated; }
        }
      } catch {
        throw new ProjectError("MODEL_ERROR", "The provider vault is invalid.");
      }
      throw new ProjectError("MODEL_ERROR", "The provider vault is invalid.");
    }
    try {
      const legacy = JSON.parse(await readFile(this.legacyPath, "utf8")) as unknown;
      const migrated = migrateLegacyProfileRecords(legacy);
      if (migrated.length) { await this.writeRecords(migrated); return migrated; }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ProjectError("MODEL_ERROR", "The legacy model vault is invalid.");
    }
    return [];
  }

  private parseLegacyProviderArray(values: unknown[]): StoredProvider[] {
    return values.map((value) => {
      if (!value || typeof value !== "object") return undefined;
      const raw = value as Record<string, unknown>;
      const models = cleanModels(Array.isArray(raw.models) ? raw.models.filter((model): model is string => typeof model === "string") : []);
      const settings = cleanSettings(models, raw.modelSettings && typeof raw.modelSettings === "object" && !Array.isArray(raw.modelSettings) ? raw.modelSettings as Record<string, ModelSettings> : undefined);
      const credential = raw.credential && typeof raw.credential === "object" ? raw.credential as Record<string, unknown> : undefined;
      const apiKey = raw.apiKey && typeof raw.apiKey === "object" ? raw.apiKey as Record<string, unknown> : undefined;
      const stored: unknown = {
        id: typeof raw.id === "string" ? raw.id : undefined,
        name: typeof raw.name === "string" ? raw.name : undefined,
        protocol: raw.protocol,
        baseUrl: raw.baseUrl,
        models,
        modelSettings: settings,
        credential: credential?.kind === "encrypted" && typeof credential.ciphertext === "string"
          ? { kind: "encrypted", ciphertext: credential.ciphertext }
          : apiKey?.storage === "safeStorage" && typeof apiKey.value === "string"
            ? { kind: "encrypted", ciphertext: apiKey.value }
            : apiKey?.storage === "plaintext" && typeof apiKey.value === "string"
              ? { kind: "plain", value: apiKey.value }
              : { kind: "none" },
      };
      return safeParseStored(stored);
    }).filter((value): value is StoredProvider => value !== undefined);
  }

  private async writeRecords(providers: StoredProvider[]): Promise<void> {
    const parsed = VaultSchema.safeParse({ version: 1, providers });
    if (!parsed.success) throw new ProjectError("MODEL_ERROR", "The provider vault capacity was exceeded.");
    const serialized = JSON.stringify(parsed.data);
    if (Buffer.byteLength(serialized) > MAX_VAULT_BYTES) throw new ProjectError("MODEL_ERROR", "The provider vault exceeds the size limit.");
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await mkdir(resolve(this.path, ".."), { recursive: true });
      await writeFile(temporary, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporary, this.path);
    } catch { throw new ProjectError("BACKEND_UNAVAILABLE", "The provider vault could not be saved."); }
    finally { await unlink(temporary).catch(() => undefined); }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const action = this.pending.then(operation);
    this.pending = action.then(() => undefined, () => undefined);
    return action;
  }

}
