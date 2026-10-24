import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** Stable per-project loopback credentials; the token only changes on explicit refresh. */
export interface McpCredential {
  token: string;
  port?: number;
}

type CredentialFile = { version: 1; entries: Record<string, McpCredential> };
const fileName = "mcp-credentials.json";

function valid(entry: unknown): entry is McpCredential {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const value = entry as Record<string, unknown>;
  if (typeof value.token !== "string" || !/^[a-f0-9]{64}$/i.test(value.token)) return false;
  if (value.port !== undefined && (!Number.isInteger(value.port) || (value.port as number) < 1024 || (value.port as number) > 65535)) return false;
  return true;
}

export class McpCredentialStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly directory: string) {}

  private get file(): string { return path.join(this.directory, fileName); }

  static token(): string { return randomBytes(32).toString("hex"); }

  async get(key: string): Promise<McpCredential | undefined> {
    const entries = await this.read();
    return entries[key];
  }

  async remember(key: string, credential: McpCredential): Promise<void> {
    await this.mutate((entries) => { entries[key] = credential; });
  }

  /** Issue a fresh token while keeping the project's port when possible. */
  async rotate(key: string): Promise<McpCredential> {
    const existing = await this.get(key);
    const credential: McpCredential = { token: McpCredentialStore.token(), ...(existing?.port ? { port: existing.port } : {}) };
    await this.mutate((entries) => { entries[key] = credential; });
    return credential;
  }

  private mutate(action: (entries: Record<string, McpCredential>) => void): Promise<void> {
    const run = this.queue.then(async () => {
      const entries = await this.read();
      action(entries);
      await this.write(entries);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async read(): Promise<Record<string, McpCredential>> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as Partial<CredentialFile>;
      if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== "object") return {};
      return Object.fromEntries(Object.entries(parsed.entries).filter(([, entry]) => valid(entry)));
    } catch {
      return {};
    }
  }

  private async write(entries: Record<string, McpCredential>): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const temporary = `${this.file}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, entries } satisfies CredentialFile, null, 2)}\n`, "utf8");
    await rename(temporary, this.file);
  }
}
