import { Worker } from "node:worker_threads";
import { CHAT_ATTACHMENT_LIMITS, type ChatAttachmentInput, type PreparedChatAttachment } from "../../shared/chat-attachments";
import { extractPlainAttachment, type AttachmentText } from "./attachment-text";
import { ProjectError } from "./errors";

type Owner = symbol | string | number;
type DocumentKind = "pdf" | "docx";
interface Job {
  owner: Owner; key: string; name: string; size: number; kind: DocumentKind; bytes: Uint8Array;
  resolve: (value: PreparedChatAttachment) => void; reject: (error: Error) => void;
  worker?: Worker; timer?: ReturnType<typeof setTimeout>; settled: boolean;
}
export interface ChatAttachmentServiceOptions { workerPath?: string | undefined; timeoutMs?: number; maxWorkers?: number }

export function sanitizeAttachmentName(input: string): string {
  if (typeof input !== "string" || input.length > 32768) throw new Error("附件文件名无效");
  const name = Array.from(input.replaceAll("\\", "/").split("/").at(-1)!).map(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || '<>:"|?*'.includes(character) ? "_" : character).join("").trim().slice(0, 256);
  if (!name || name === "." || name === "..") throw new Error("附件文件名无效");
  return name;
}

/** Signatures are authoritative; renderer MIME and file extensions are hints only. */
export function attachmentImageMime(bytes: Uint8Array): string | undefined {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && buffer.toString("ascii", 12, 16) === "IHDR") return "image/png";
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buffer.length >= 10 && ["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6))) return "image/gif";
  return undefined;
}

const textExtensions = new Set(["txt", "md", "markdown", "json", "jsonl", "yaml", "yml", "toml", "csv", "tsv", "xml", "html", "htm", "css", "scss", "js", "jsx", "mjs", "cjs", "ts", "tsx", "py", "gd", "gdshader", "godot", "tscn", "tres", "ini", "cfg", "conf", "log", "sql", "sh", "ps1", "bat", "c", "h", "cpp", "hpp", "cs", "rs", "go", "java", "rb", "lua"]);

/** Parser jobs belong to one trusted owner and its exact project/session key. */
export class ChatAttachmentService {
  private readonly jobs = new Map<Owner, Map<string, Job>>();
  private readonly queue: Job[] = [];
  private readonly maxWorkers: number;
  private active = 0;
  private pendingBytes = 0;
  private closed = false;
  constructor(private readonly options: ChatAttachmentServiceOptions = {}) {
    this.maxWorkers = Math.min(CHAT_ATTACHMENT_LIMITS.workers, Math.max(1, options.maxWorkers ?? CHAT_ATTACHMENT_LIMITS.workers));
  }

  async prepare(owner: Owner, sessionKey: string, requestId: string, input: ChatAttachmentInput): Promise<PreparedChatAttachment> {
    try { return await this.prepareInput(owner, sessionKey, requestId, input); }
    catch (error) {
      if (error instanceof ProjectError) throw error;
      throw new ProjectError("VALIDATION_FAILED", error instanceof Error ? error.message : "附件处理失败");
    }
  }

  private async prepareInput(owner: Owner, sessionKey: string, requestId: string, input: ChatAttachmentInput): Promise<PreparedChatAttachment> {
    if (this.closed) throw new ProjectError("BACKEND_UNAVAILABLE", "附件服务已关闭");
    if (typeof sessionKey !== "string" || !sessionKey || sessionKey.length > 65536 || typeof requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(requestId)) throw new Error("附件请求标识无效");
    if (!input || !(input.bytes instanceof Uint8Array) || !input.bytes.byteLength) throw new Error("附件内容为空或无效");
    const name = sanitizeAttachmentName(input.name);
    const size = input.bytes.byteLength;
    if (size > CHAT_ATTACHMENT_LIMITS.documentBytes) throw new Error("文档附件超过 6 MiB，请拆分文件");
    if (input.declaredMime !== undefined && (typeof input.declaredMime !== "string" || input.declaredMime.length > 256)) throw new Error("附件 MIME 类型无效");
    const imageMime = attachmentImageMime(input.bytes);
    if (imageMime) {
      if (size > CHAT_ATTACHMENT_LIMITS.imageBytes) throw new Error("图片附件超过 2 MiB");
      return { kind: "image", name, size, image: { name, mimeType: imageMime, base64: Buffer.from(input.bytes).toString("base64") } };
    }
    const prefix = Buffer.from(input.bytes.buffer, input.bytes.byteOffset, Math.min(size, 8));
    const extension = name.split(".").at(-1)!.toLowerCase();
    let kind: DocumentKind | undefined;
    if (prefix.toString("ascii", 0, 5) === "%PDF-") kind = "pdf";
    else if (prefix[0] === 0x50 && prefix[1] === 0x4b && prefix[2] === 3 && prefix[3] === 4 && (extension === "docx" || input.declaredMime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document")) kind = "docx";
    if (!kind) {
      if (["pdf", "docx", "png", "jpg", "jpeg", "gif", "webp"].includes(extension) || input.declaredMime?.startsWith("image/")) throw new Error("附件内容与文件格式不匹配或文件已损坏");
      if (!textExtensions.has(extension) && !input.declaredMime?.startsWith("text/") && !["application/json", "application/yaml", "application/xml", "application/toml"].includes(input.declaredMime ?? "")) throw new Error("不支持此附件格式；请选择图片、UTF-8 文本、PDF 或 DOCX");
      return { kind: "document", name, size, ...extractPlainAttachment(input.bytes) };
    }
    if (!this.options.workerPath) throw new ProjectError("BACKEND_UNAVAILABLE", "文档解析工作进程不可用，请重启应用后重试");
    const key = JSON.stringify([sessionKey, requestId]);
    if (this.jobs.get(owner)?.has(key)) throw new Error("附件请求正在处理中");
    if (this.queue.length >= 16 || this.pendingBytes + size > CHAT_ATTACHMENT_LIMITS.pendingBytes) throw new Error("待处理附件过多或总大小超过 16 MiB，请稍后重试");
    return new Promise((resolve, reject) => {
      const job: Job = { owner, key, name, size, kind, bytes: new Uint8Array(input.bytes), resolve, reject, settled: false };
      const owned = this.jobs.get(owner) ?? new Map<string, Job>();
      this.jobs.set(owner, owned); owned.set(key, job);
      this.pendingBytes += size; this.queue.push(job); this.drain();
    });
  }

  cancel(owner: Owner, sessionKey: string, requestId: string): void {
    const job = this.jobs.get(owner)?.get(JSON.stringify([sessionKey, requestId]));
    if (job) this.finish(job, new Error("附件解析已取消"));
  }
  revokeOwner(owner: Owner): void {
    for (const job of this.jobs.get(owner)?.values() ?? []) this.finish(job, new Error("附件解析已取消，所属窗口或项目已关闭"));
  }
  close(): void {
    this.closed = true;
    for (const owner of this.jobs.keys()) this.revokeOwner(owner);
  }

  private drain(): void {
    while (!this.closed && this.active < this.maxWorkers && this.queue.length) {
      const job = this.queue.shift()!;
      if (job.settled) continue;
      try {
        const worker = new Worker(this.options.workerPath!, { workerData: { kind: job.kind, bytes: job.bytes }, transferList: [job.bytes.buffer as ArrayBuffer], resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
        job.worker = worker; this.active++;
        job.timer = setTimeout(() => this.finish(job, new Error("文档解析超过 10 秒，已终止")), this.options.timeoutMs ?? CHAT_ATTACHMENT_LIMITS.workerTimeoutMs);
        worker.once("message", (message: { ok?: boolean; result?: AttachmentText; error?: string }) => {
          if (message.ok && message.result && typeof message.result.text === "string" && Buffer.byteLength(message.result.text) <= CHAT_ATTACHMENT_LIMITS.extractedBytes && Array.isArray(message.result.notices)) this.finish(job, undefined, message.result);
          else this.finish(job, new Error(typeof message.error === "string" ? message.error.slice(0, 1000) : "文档解析失败"));
        });
        worker.once("error", () => this.finish(job, new Error("文档解析工作进程失败或内存超出限制")));
        worker.once("exit", () => { if (!job.settled) this.finish(job, new Error("文档解析工作进程意外退出")); });
      } catch { this.finish(job, new Error("无法启动文档解析工作进程")); }
    }
  }

  private finish(job: Job, error?: Error, result?: AttachmentText): void {
    if (job.settled) return;
    job.settled = true;
    if (job.timer) clearTimeout(job.timer);
    const owned = this.jobs.get(job.owner);
    owned?.delete(job.key); if (!owned?.size) this.jobs.delete(job.owner);
    this.pendingBytes -= job.size;
    const queued = this.queue.indexOf(job); if (queued >= 0) this.queue.splice(queued, 1);
    if (error) job.reject(error); else job.resolve({ kind: "document", name: job.name, size: job.size, ...result! });
    // A slot is reusable only once termination finishes, including parser child threads.
    if (job.worker) void job.worker.terminate().catch(() => undefined).finally(() => { this.active--; this.drain(); });
    else this.drain();
  }
}
