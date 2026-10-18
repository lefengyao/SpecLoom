import type { DesktopApi } from "../../shared/desktop-api";
import { CHAT_ATTACHMENT_LIMITS, type ChatAttachmentInput, type PreparedChatAttachment } from "../../shared/chat-attachments";

export type AttachmentTarget = { kind: "session"; sessionId: string } | { kind: "creating"; creationToken: string };
export interface AttachmentEntry {
  id: string;
  name: string;
  size: number;
  status: "pending" | "ready" | "error";
  value?: PreparedChatAttachment;
  error?: string;
  input?: ChatAttachmentInput;
  target: AttachmentTarget;
}
export interface PreparedDraftSnapshot {
  draftText: string;
  draftRevision: number;
  attachments: { id: string; value: PreparedChatAttachment }[];
}
export function composePrompt(snapshot: PreparedDraftSnapshot): string {
  const documents = snapshot.attachments.flatMap(({ value }) => value.kind === "document"
    ? [`附件：${value.name}\n${value.notices.join("\n")}\n${value.text}`] : []);
  return [snapshot.draftText, ...documents].filter(text => text.trim()).join("\n\n")
    || (snapshot.attachments.some(({ value }) => value.kind === "image") ? "请查看附件并说明你观察到的内容。" : "");
}

async function fileBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === "function") return new Uint8Array(await file.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`无法读取 ${file.name}`));
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.readAsArrayBuffer(file);
  });
}

/** In-memory pending inputs, owned by one mounted project window. */
export class AttachmentIngest {
  private readonly items = new Map<string, AttachmentEntry[]>();
  private readonly adopted = new Map<string, string>();
  private alive = true;
  constructor(private readonly projectPath: string, private readonly api: DesktopApi["chatAttachments"], private readonly changed: () => void) {}
  activate(): void { this.alive = true; }
  resolve(target: AttachmentTarget): AttachmentTarget {
    const id = target.kind === "creating" ? this.adopted.get(target.creationToken) : undefined;
    return id ? { kind: "session", sessionId: id } : target;
  }
  private key(target: AttachmentTarget): string {
    const value = this.resolve(target);
    return value.kind === "session" ? `session:${value.sessionId}` : `creating:${value.creationToken}`;
  }
  entries(target: AttachmentTarget): AttachmentEntry[] { return this.items.get(this.key(target)) ?? []; }
  private contains(entry: AttachmentEntry): boolean { return this.alive && this.entries(entry.target).includes(entry); }
  private reserve(target: AttachmentTarget, name: string, size: number): AttachmentEntry {
    if (!this.alive) throw new Error("项目已切换");
    const entries = this.entries(target);
    if (!Number.isSafeInteger(size) || size < 1 || size > CHAT_ATTACHMENT_LIMITS.documentBytes) throw new Error(`附件为空或超过6MiB：${name}`);
    if (entries.length >= CHAT_ATTACHMENT_LIMITS.files || entries.reduce((sum, entry) => sum + entry.size, size) > CHAT_ATTACHMENT_LIMITS.pendingBytes) throw new Error("待发送附件最多16个、合计16MiB");
    const entry: AttachmentEntry = { id: crypto.randomUUID(), name, size, target: this.resolve(target), status: "pending" };
    this.items.set(this.key(target), [...entries, entry]);
    this.changed();
    return entry;
  }
  async addFiles(target: AttachmentTarget, files: File[]): Promise<void> {
    await Promise.all(files.map(async file => {
      const entry = this.reserve(target, file.name || "clipboard.png", file.size);
      try {
        const bytes = await fileBytes(file);
        if (!this.contains(entry)) return;
        entry.input = { name: entry.name, ...(file.type ? { declaredMime: file.type } : {}), bytes };
        await this.prepare(entry);
      } catch (error) { this.fail(entry, error); }
    }));
  }
  async addInputs(target: AttachmentTarget, inputs: ChatAttachmentInput[]): Promise<void> {
    await Promise.all(inputs.map(async input => {
      const entry = this.reserve(target, input.name, input.bytes.byteLength);
      entry.input = input;
      await this.prepare(entry);
    }));
  }
  private fail(entry: AttachmentEntry, error: unknown): void {
    if (!this.contains(entry)) return;
    entry.status = "error";
    entry.error = error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
    delete entry.input;
    this.changed();
  }
  private async prepare(entry: AttachmentEntry): Promise<void> {
    const target = this.resolve(entry.target);
    if (!this.contains(entry) || !entry.input || target.kind !== "session") return;
    try {
      if (!this.api) throw new Error("当前宿主尚不支持文件附件，请更新后重试");
      const value = await this.api.prepare(this.projectPath, target.sessionId, entry.id, entry.input);
      if (!this.contains(entry)) return;
      entry.value = value;
      entry.status = "ready";
      delete entry.input;
      this.changed();
    } catch (error) { this.fail(entry, error); }
  }
  adopt(creationToken: string, sessionId: string): void {
    const key = `creating:${creationToken}`;
    const entries = this.items.get(key) ?? [];
    this.items.delete(key);
    this.adopted.set(creationToken, sessionId);
    const target: AttachmentTarget = { kind: "session", sessionId };
    for (const entry of entries) entry.target = target;
    this.items.set(this.key(target), [...this.entries(target), ...entries]);
    this.changed();
    for (const entry of entries) void this.prepare(entry);
  }
  remove(target: AttachmentTarget, id: string): void {
    const entries = this.entries(target);
    const entry = entries.find(item => item.id === id);
    if (!entry) return;
    this.items.set(this.key(target), entries.filter(item => item !== entry));
    const resolved = this.resolve(target);
    if (entry.status === "pending" && resolved.kind === "session") void this.api?.cancel(this.projectPath, resolved.sessionId, id).catch(() => undefined);
    this.changed();
  }
  clear(target: AttachmentTarget): void { for (const entry of [...this.entries(target)]) this.remove(target, entry.id); }
  snapshot(target: AttachmentTarget, draft: { text: string; revision: number }): PreparedDraftSnapshot {
    const entries = this.entries(target);
    if (entries.some(entry => entry.status !== "ready")) throw new Error("请等待附件准备完成，或移除失败附件");
    const snapshot = { draftText: draft.text, draftRevision: draft.revision, attachments: entries.map(entry => ({ id: entry.id, value: entry.value! })) };
    if (composePrompt(snapshot).length > 131072 || entries.length > CHAT_ATTACHMENT_LIMITS.files || entries.reduce((sum, entry) => sum + entry.size, 0) > CHAT_ATTACHMENT_LIMITS.pendingBytes) throw new Error("消息或附件超过发送上限，请缩短正文或移除部分附件");
    return snapshot;
  }
  detach(target: AttachmentTarget, snapshot: PreparedDraftSnapshot): void {
    const ids = new Set(snapshot.attachments.map(entry => entry.id));
    this.items.set(this.key(target), this.entries(target).filter(entry => !ids.has(entry.id)));
    this.changed();
  }
  restore(target: AttachmentTarget, snapshot: PreparedDraftSnapshot): void {
    if (!this.alive) return;
    const entries = this.entries(target);
    const restored = snapshot.attachments.filter(item => !entries.some(entry => entry.id === item.id)).map(item => ({ id: item.id, name: item.value.name, size: item.value.size, value: item.value, status: "ready" as const, target: this.resolve(target) }));
    this.items.set(this.key(target), [...restored, ...entries]);
    this.changed();
  }
  dispose(): void {
    for (const entries of this.items.values()) for (const entry of entries) {
      const target = this.resolve(entry.target);
      if (entry.status === "pending" && target.kind === "session") void this.api?.cancel(this.projectPath, target.sessionId, entry.id).catch(() => undefined);
    }
    this.alive = false;
    this.items.clear();
  }
}
