import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { UsageRecordSchema, type UsageRecord } from "../../shared/contracts";

const MAX_RECORDS = 20_000;
const MAX_BYTES = 16 * 1024 * 1024;

/** Append-only model usage log. Raw records back the usage page. */
export class UsageStore {
  private queue: Promise<void> = Promise.resolve();
  private readonly file: string;

  constructor(private readonly root: string) { this.file = path.join(root, "usage.jsonl"); }

  append(record: UsageRecord): Promise<void> {
    const parsed = UsageRecordSchema.parse(record);
    const line = JSON.stringify(parsed) + "\n";
    const run = this.queue.then(async () => {
      await mkdir(this.root, { recursive: true });
      await appendFile(this.file, line, "utf8");
      await this.trimIfNeeded();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async list(): Promise<UsageRecord[]> {
    await this.queue;
    try {
      const lines = (await readFile(this.file, "utf8")).split(/\r?\n/u).filter(Boolean);
      const records: UsageRecord[] = [];
      for (const line of lines) {
        try { records.push(UsageRecordSchema.parse(JSON.parse(line))); } catch { /* skip a damaged record */ }
      }
      return records.slice(-MAX_RECORDS);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async trimIfNeeded(): Promise<void> {
    try {
      const content = await readFile(this.file, "utf8");
      const all = content.split(/\r?\n/u).filter(Boolean);
      if (all.length <= MAX_RECORDS && Buffer.byteLength(content, "utf8") <= MAX_BYTES) return;
      const lines = all.slice(-MAX_RECORDS);
      await writeFile(this.file, lines.join("\n") + (lines.length ? "\n" : ""), "utf8");
    } catch { /* best effort; never lose the append that just succeeded */ }
  }
}
