import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DiagnosticEventInputSchema, DiagnosticEventSchema, DiagnosticQuerySchema,
  type DiagnosticEvent, type DiagnosticEventInput, type DiagnosticListResult, type DiagnosticQuery, type DiagnosticSummary,
} from "../../shared/diagnostics";

export const DIAGNOSTIC_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const DIAGNOSTIC_MAX_BYTES = 25 * 1024 * 1024;
export const DIAGNOSTIC_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const filePattern = /^diagnostics-(\d{8})-(\d{4})\.jsonl$/;

export interface DiagnosticsLogOptions {
  now?: () => Date;
  maxFileBytes?: number;
  maxBytes?: number;
  retentionMs?: number;
}

interface LogFile { name: string; filePath: string; size: number; modifiedAt: number }

/** Main-process, allowlist-only JSONL storage for model lifecycle events. */
export class DiagnosticsLogStore {
  private readonly directory: string;
  private readonly now: () => Date;
  private readonly maxFileBytes: number;
  private readonly maxBytes: number;
  private readonly retentionMs: number;
  private tail: Promise<void> = Promise.resolve();
  private readIssues = 0;
  private cleanupError?: string;

  constructor(userDataDirectory: string, options: DiagnosticsLogOptions = {}) {
    this.directory = path.join(userDataDirectory, "logs");
    this.now = options.now ?? (() => new Date());
    this.maxFileBytes = options.maxFileBytes ?? DIAGNOSTIC_MAX_FILE_BYTES;
    this.maxBytes = options.maxBytes ?? DIAGNOSTIC_MAX_BYTES;
    this.retentionMs = options.retentionMs ?? DIAGNOSTIC_RETENTION_MS;
  }

  record(input: DiagnosticEventInput): Promise<void> {
    const safeInput = DiagnosticEventInputSchema.parse(input);
    return this.enqueue(async () => {
      await this.cleanupInternal();
      const now = this.now();
      const severity = safeInput.severity ?? (["connection_error", "stream_read_error", "protocol_parse_error", "request_failed"].includes(safeInput.type) ? "error"
        : safeInput.type === "retry_scheduled" ? "warning" : "info");
      const event = DiagnosticEventSchema.parse({ ...safeInput, severity, schemaVersion: 1, eventId: randomUUID(), at: now.toISOString() });
      const line = `${JSON.stringify(event)}\n`;
      await mkdir(this.directory, { recursive: true });
      const file = await this.activeFile(now, Buffer.byteLength(line));
      await appendFile(file, line, { encoding: "utf8" });
      await this.enforceTotalLimit();
    });
  }

  async list(input: DiagnosticQuery): Promise<DiagnosticListResult> {
    await this.flush();
    await this.enqueue(() => this.cleanupInternal()).then(() => undefined);
    const query = DiagnosticQuerySchema.parse(input);
    const { events, readIssues } = await this.readAll();
    this.readIssues = readIssues;
    const filtered = events.filter((event) => {
      if (query.diagnosticId && event.diagnosticId !== query.diagnosticId) return false;
      if (query.text && !JSON.stringify(event).toLowerCase().includes(query.text.toLowerCase())) return false;
      return true;
    });
    return { events: filtered.slice(-query.limit), readIssues };
  }

  async summary(): Promise<DiagnosticSummary> {
    await this.flush();
    await this.enqueue(() => this.cleanupInternal()).then(() => undefined);
    const files = await this.files();
    const { events, readIssues } = await this.readAll();
    this.readIssues = readIssues;
    return {
      files: files.length,
      bytes: files.reduce((sum, file) => sum + file.size, 0),
      events: events.length,
      retentionDays: Math.ceil(this.retentionMs / 86_400_000),
      maxBytes: this.maxBytes,
      maxFileBytes: this.maxFileBytes,
      readIssues,
      ...(this.cleanupError ? { cleanupError: this.cleanupError } : {}),
    };
  }

  clearExpired(): Promise<number> {
    return this.enqueue(async () => this.cleanupInternal());
  }

  clearAll(): Promise<number> {
    return this.enqueue(async () => {
      const files = await this.files();
      await Promise.all(files.map((file) => unlink(file.filePath)));
      delete this.cleanupError;
      return files.length;
    });
  }

  async exportTo(destination: string): Promise<void> {
    await this.flush();
    await this.enqueue(() => this.cleanupInternal()).then(() => undefined);
    const { events } = await this.readAll();
    const output = events.map((event) => JSON.stringify(event)).join("\n");
    await writeFile(destination, output ? `${output}\n` : "", { encoding: "utf8" });
  }

  flush(): Promise<void> { return this.tail; }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.tail.then(work);
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async activeFile(now: Date, nextBytes: number): Promise<string> {
    const date = now.toISOString().slice(0, 10).replaceAll("-", "");
    const files = await this.files();
    const matching = files.filter((file) => file.name.startsWith(`diagnostics-${date}-`)).sort((a, b) => a.name.localeCompare(b.name));
    const latest = matching.at(-1);
    if (latest && latest.size + nextBytes <= this.maxFileBytes) return latest.filePath;
    const sequence = latest ? Number(latest.name.match(filePattern)?.[2] ?? 0) + 1 : 1;
    return path.join(this.directory, `diagnostics-${date}-${String(sequence).padStart(4, "0")}.jsonl`);
  }

  private async files(): Promise<LogFile[]> {
    try { await mkdir(this.directory, { recursive: true }); }
    catch { throw new Error("Unable to access diagnostics directory"); }
    const names = (await readdir(this.directory)).filter((name) => filePattern.test(name)).sort();
    const result: LogFile[] = [];
    for (const name of names) {
      const filePath = path.join(this.directory, name);
      try {
        const info = await stat(filePath);
        if (info.isFile()) result.push({ name, filePath, size: info.size, modifiedAt: info.mtimeMs });
      } catch { /* A file removed concurrently is omitted from the snapshot. */ }
    }
    return result;
  }

  private async readAll(): Promise<{ events: DiagnosticEvent[]; readIssues: number }> {
    const files = await this.files();
    const events: DiagnosticEvent[] = [];
    let readIssues = 0;
    for (const file of files) {
      let content: string;
      try { content = await readFile(file.filePath, "utf8"); }
      catch { readIssues += 1; continue; }
      for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try { events.push(DiagnosticEventSchema.parse(JSON.parse(line))); }
        catch { readIssues += 1; }
      }
    }
    return { events, readIssues };
  }

  private async cleanupInternal(): Promise<number> {
    let removed = 0;
    try {
      const files = await this.files();
      const cutoff = this.now().getTime() - this.retentionMs;
      for (const file of files) {
        const match = file.name.match(filePattern);
        const dateKey = match?.[1] ?? "19700101";
        const fileDate = Date.UTC(Number(dateKey.slice(0, 4)), Number(dateKey.slice(4, 6)) - 1, Number(dateKey.slice(6, 8)));
        if (fileDate < cutoff) { await unlink(file.filePath); removed++; }
      }
      removed += await this.enforceTotalLimit();
      delete this.cleanupError;
      return removed;
    } catch {
      this.cleanupError = "日志目录清理失败";
      throw new Error("Unable to clean diagnostics logs");
    }
  }

  private async enforceTotalLimit(): Promise<number> {
    const files = await this.files();
    let total = files.reduce((sum, file) => sum + file.size, 0);
    let removed = 0;
    for (const file of files) {
      if (total <= this.maxBytes) break;
      await unlink(file.filePath);
      total -= file.size;
      removed++;
    }
    return removed;
  }
}
