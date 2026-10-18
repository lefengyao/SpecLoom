import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { ModelProfileSchema, type ModelProfile } from "../../shared/contracts";
import { ProjectError } from "./errors";
import { normalizeEndpoint, parseModelProfile } from "./model-config";

export interface EncryptionAdapter {
  isAvailable(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}
const RecordSchema = z.object({
  profile: ModelProfileSchema, approvedEndpoint: z.string().optional(),
  credential: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("encrypted"), ciphertext: z.string().min(1).max(32_768) }).strict(),
    z.object({ kind: z.literal("keyless"), endpoint: z.string() }).strict(),
  ]),
}).strict();
const VaultSchema = z.object({ version: z.literal(1), records: z.array(RecordSchema).max(128) }).strict();
type VaultRecord = z.infer<typeof RecordSchema>;
const MAX_VAULT_BYTES = 1_048_576;
const SealedCredentialSchema = z.object({ endpoint: z.string(), secret: z.string().min(1).max(8_192) }).strict();
const CREDENTIAL_RECONFIGURATION_MESSAGE = "供应商密钥已失效，请进入“供应商 → 编辑供应商”重新输入 API 密钥后保存。";

export class ModelVault {
  readonly path: string;
  private pending: Promise<void> = Promise.resolve();

  constructor(userDataDirectory: string, private readonly encryption: EncryptionAdapter) {
    this.path = join(resolve(userDataDirectory), "model-profiles.json");
  }

  async list(): Promise<ModelProfile[]> {
    await this.pending;
    return (await this.readRecords()).map((record) => ({ ...record.profile }));
  }

  async get(id: string): Promise<ModelProfile | undefined> { return (await this.list()).find((profile) => profile.id === id); }

  async save(value: ModelProfile, secret?: string): Promise<ModelProfile> {
    const profile = parseModelProfile(value);
    if (secret !== undefined && (secret.length > 8_192 || /[\r\n\0]/.test(secret))) throw new ProjectError("MODEL_ERROR", "Invalid model credential.");
    return this.mutate(async (records) => {
      const existing = records.find((record) => record.profile.id === profile.id);
      const endpoint = normalizeEndpoint(profile.baseUrl);
      if (secret === undefined && (!existing || normalizeEndpoint(existing.profile.baseUrl) !== endpoint)) {
        throw new ProjectError("APPROVAL_REQUIRED", "Supply a credential or explicitly choose keyless access for the new endpoint.");
      }
      let credential: VaultRecord["credential"];
      if (secret === "") credential = { kind: "keyless", endpoint };
      else if (secret !== undefined) {
        this.assertEncryption();
        try { credential = { kind: "encrypted", ciphertext: this.encryption.encrypt(JSON.stringify({ endpoint, secret })).toString("base64") }; }
        catch { throw new ProjectError("BACKEND_UNAVAILABLE", "Secure credential encryption failed."); }
      } else credential = existing!.credential;
      const next: VaultRecord = { profile, credential, ...(profile.approved ? { approvedEndpoint: endpoint } : {}) };
      return { records: [...records.filter((record) => record.profile.id !== profile.id), next], value: { ...profile } };
    });
  }

  async remove(id: string): Promise<void> {
    await this.mutate(async (records) => ({ records: records.filter((record) => record.profile.id !== id), value: undefined }));
  }

  async resolveCredential(value: ModelProfile): Promise<string | undefined> {
    const profile = parseModelProfile(value);
    await this.pending;
    const record = (await this.readRecords()).find((candidate) => candidate.profile.id === profile.id);
    const endpoint = normalizeEndpoint(profile.baseUrl);
    if (!record || !profile.approved || !record.profile.approved || record.approvedEndpoint !== endpoint
      || normalizeEndpoint(record.profile.baseUrl) !== endpoint) {
      throw new ProjectError("APPROVAL_REQUIRED", "The model endpoint has no matching approved credential profile.");
    }
    if (record.credential.kind === "keyless") {
      if (record.credential.endpoint !== endpoint) throw new ProjectError("APPROVAL_REQUIRED", "Keyless approval belongs to another endpoint.");
      return undefined;
    }
    this.assertEncryption();
    let decrypted: z.infer<typeof SealedCredentialSchema>;
    try { decrypted = SealedCredentialSchema.parse(JSON.parse(this.encryption.decrypt(Buffer.from(record.credential.ciphertext, "base64")))); }
    catch { throw new ProjectError("BACKEND_UNAVAILABLE", CREDENTIAL_RECONFIGURATION_MESSAGE); }
    if (decrypted.endpoint !== endpoint) throw new ProjectError("APPROVAL_REQUIRED", "The encrypted credential belongs to another endpoint.");
    return decrypted.secret;
  }

  private assertEncryption(): void {
    if (!this.encryption.isAvailable()) throw new ProjectError("BACKEND_UNAVAILABLE", "OS credential encryption is unavailable; plaintext storage is disabled.");
  }

  private async readRecords(): Promise<VaultRecord[]> {
    let raw: string;
    try { raw = await readFile(this.path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new ProjectError("BACKEND_UNAVAILABLE", "The model profile vault could not be read.");
    }
    if (Buffer.byteLength(raw) > MAX_VAULT_BYTES) throw new ProjectError("MODEL_ERROR", "The model profile vault exceeds the size limit.");
    try {
      const data = VaultSchema.parse(JSON.parse(raw));
      if (new Set(data.records.map((record) => record.profile.id)).size !== data.records.length) throw new Error("Duplicate profile");
      return data.records;
    } catch { throw new ProjectError("MODEL_ERROR", "The model profile vault is invalid."); }
  }

  private mutate<T>(operation: (records: VaultRecord[]) => Promise<{ records: VaultRecord[]; value: T }>): Promise<T> {
    const action = this.pending.then(async () => {
      const result = await operation(await this.readRecords());
      const data = VaultSchema.safeParse({ version: 1, records: result.records });
      if (!data.success) throw new ProjectError("MODEL_ERROR", "The model profile vault capacity was exceeded.");
      const serialized = JSON.stringify(data.data);
      if (Buffer.byteLength(serialized) > MAX_VAULT_BYTES) throw new ProjectError("MODEL_ERROR", "The model profile vault exceeds the size limit.");
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await mkdir(resolve(this.path, ".."), { recursive: true });
        await writeFile(temporary, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
        await rename(temporary, this.path);
      } catch { throw new ProjectError("BACKEND_UNAVAILABLE", "The model profile vault could not be saved."); }
      finally { await unlink(temporary).catch(() => undefined); }
      return result.value;
    });
    this.pending = action.then(() => undefined, () => undefined);
    return action;
  }
}
