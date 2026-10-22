import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readFile, writeFile } from "node:fs/promises";
import { chatId, sessionFileLimit, ChatSessionSchema, SessionPatchSchema, type ChatSession, type SessionPatch } from "../../shared/chat";
import { DEFAULT_APPROVAL_MODE } from "../../shared/approvals";
import { DEFAULT_WEB_SEARCH_MODE } from "../../shared/web-search";
import { AgentConversationSchema, type AgentMessage } from "./agent-runtime";
import { boundConversation, PERSISTED_CONVERSATION_MESSAGE_LIMIT } from "./agent-conversation";
import { FileStore } from "./file-store";
import { digestBytes } from "./store-fs";
import { ProjectError } from "./errors";

const RecordSchema = ChatSessionSchema.extend({ conversation: AgentConversationSchema });
const RequestContextSchema = z.object({
  conversation: AgentConversationSchema,
  contextSummary: z.string().max(131072).optional(),
}).strict();
/** Optional export-only request context; it never grants project permissions. */
const SessionExportSchema = ChatSessionSchema.extend({ requestContext: RequestContextSchema.optional() }).strict();
export type SessionRecord = ChatSession & { conversation: AgentMessage[] };
const directory = ".specloom/history/sessions";
// Active records must still fit their terminal error and pending-item status changes.
const terminationReserve = 65_536;

export class SessionStore {
  private readonly records = new Map<string, SessionRecord>();
  /** Last successfully written snapshot, used to roll back a failed stream checkpoint. */
  private readonly persisted = new Map<string, SessionRecord>();
  private readonly deletedTasks = new Set<string>();
  private pending = Promise.resolve();
  private constructor(private readonly files: FileStore) {}
  static async open(root: string): Promise<SessionStore> {
    const store = new SessionStore(new FileStore(root));
    const target = await store.files.policy.resolve(directory, true);
    try {
      const file = await store.files.policy.resolve(`${directory}/deleted-tasks.json`, true);
      const deleted = z.array(chatId).max(4096).parse(JSON.parse(await readFile(file, "utf8")));
      for (const id of deleted) store.deletedTasks.add(id);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const files = await store.files.fs.readdir(target, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return []; throw e; });
    for (const file of files) {
      if (!/^[a-f0-9]{64}\.json$/.test(file.name)) continue;
      try {
        const resolved = await store.files.policy.resolve(`${directory}/${file.name}`, true);
        const stat = await store.files.fs.lstat(resolved);
        if (!stat.isFile() || stat.size > sessionFileLimit) continue;
        const record = RecordSchema.parse(JSON.parse(await readFile(resolved, "utf8")));
        record.approvalMode ??= DEFAULT_APPROVAL_MODE;
        record.webSearchMode ??= DEFAULT_WEB_SEARCH_MODE;
        if (digestBytes(record.id).slice(7) + ".json" !== file.name) continue;
        if (["running", "waiting"].includes(record.status)) {
          record.status = "interrupted"; record.error = "上次运行已中断，请重新发送以继续";
          for (const item of record.items) { if ((item.kind === "question" || item.kind === "approval") && item.status === "waiting") item.status = "interrupted"; if (item.kind === "tool" && ["receiving", "running", "waiting"].includes(item.status)) item.status = "cancelled"; }
          record.revision++;
        }
        if (store.records.size < 256) store.records.set(record.id, record);
      } catch { /* Corrupt/untrusted history grants no new task authority. */ }
    }
    return store;
  }
  static view(record: SessionRecord): ChatSession { const copy = structuredClone(record) as Partial<SessionRecord>; delete copy.conversation; return copy as ChatSession; }
  list(): ChatSession[] { return [...this.records.values()].map(SessionStore.view).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  get(id: string): SessionRecord { const record = this.records.get(id); if (!record) throw new ProjectError("VALIDATION_FAILED", "会话不存在"); return structuredClone(record); }
  hasTaskHistory(taskId: string): boolean { return this.deletedTasks.has(taskId) || [...this.records.values()].some((s) => s.taskId === taskId); }
  async create(title = "新会话", taskId?: string, history: { role: "user" | "assistant"; content: string }[] = []): Promise<ChatSession> {
    return this.queue(async () => {
      const existing = taskId && [...this.records.values()].find((s) => s.taskId === taskId);
      if (existing) return SessionStore.view(existing);
      const now = new Date().toISOString(); const id = randomUUID();
      const retained = history.slice(-PERSISTED_CONVERSATION_MESSAGE_LIMIT).map((message) => ({ role: message.role, content: message.content.slice(0, 131072) }));
      const record = await this.write({ id, title, ...(taskId ? { taskId } : {}), createdAt: now, updatedAt: now, archived: false, draft: "", draftRevision: 0, revision: 0, seq: 0, approvalMode: DEFAULT_APPROVAL_MODE, webSearchMode: DEFAULT_WEB_SEARCH_MODE, items: retained.map((message, index) => ({ id: `${id}:history:${index}`, kind: "message", ...message })), conversation: boundConversation(retained), status: "idle" });
      return SessionStore.view(record);
    });
  }
  async patch(id: string, patch: SessionPatch): Promise<ChatSession> {
    const parsed = SessionPatchSchema.parse(patch);
    return SessionStore.view(await this.update(id, (record) => {
      if (parsed.approvalMode !== undefined && ["running", "waiting"].includes(record.status)) throw new ProjectError("MODEL_ERROR", "先停止运行再修改审批权限");
      if (parsed.webSearchMode !== undefined && ["running", "waiting"].includes(record.status)) throw new ProjectError("MODEL_ERROR", "先停止运行再修改联网搜索模式");
      if (parsed.model && (parsed.model.providerId !== record.model?.providerId || parsed.model.model !== record.model?.model)) {
        delete record.contextCalibration;
        delete record.lastRequestUsage;
        delete record.contextTokensEstimate;
      }
      Object.assign(record, parsed); if (parsed.draft !== undefined) record.draftRevision++;
    }));
  }
  /**
   * Apply a streaming update to the in-memory record without touching disk.
   * SessionRuns owns the checkpoint policy for durable writes.
   */
  async mutate(id: string, action: (record: SessionRecord) => void): Promise<SessionRecord> {
    return this.queue(async () => {
      const record = this.records.get(id);
      if (!record) throw new ProjectError("VALIDATION_FAILED", "会话不存在");
      const before = this.persisted.get(id) ?? structuredClone(record);
      if (!this.persisted.has(id)) this.persisted.set(id, before);
      try {
        action(record);
        record.updatedAt = new Date().toISOString();
        return structuredClone(record);
      } catch (error) {
        this.records.set(id, structuredClone(before));
        throw error;
      }
    });
  }

  /** Validate and persist the current in-memory record. */
  async checkpoint(id: string): Promise<SessionRecord> {
    return this.queue(async () => {
      const record = this.records.get(id);
      if (!record) throw new ProjectError("VALIDATION_FAILED", "会话不存在");
      const before = this.persisted.get(id) ?? structuredClone(record);
      if (!this.persisted.has(id)) this.persisted.set(id, before);
      try {
        return await this.write(record);
      } catch (error) {
        this.records.set(id, structuredClone(before));
        throw error;
      }
    });
  }

  async update(id: string, action: (record: SessionRecord) => void): Promise<SessionRecord> {
    return this.queue(async () => { const record = this.get(id); action(record); return this.write(record); });
  }
  async save(record: SessionRecord): Promise<SessionRecord> { return this.queue(() => this.write(structuredClone(record))); }
  private async write(record: SessionRecord): Promise<SessionRecord> {
    if (!this.records.has(record.id) && this.records.size >= 256) throw new ProjectError("VALIDATION_FAILED", "会话数量已达上限，请先导出或删除旧会话");
    record.revision = (this.records.get(record.id)?.revision ?? record.revision) + 1;
    record.updatedAt = new Date().toISOString();
    RecordSchema.parse(record);
    const json = JSON.stringify(record);
    const limit = ["running", "waiting"].includes(record.status) ? sessionFileLimit - terminationReserve : sessionFileLimit;
    if (Buffer.byteLength(json) > limit) throw new ProjectError("VALIDATION_FAILED", "会话历史过大，请新建会话");
    await this.writeJson(`${directory}/${digestBytes(record.id).slice(7)}.json`, json);
    this.records.set(record.id, record);
    this.persisted.set(record.id, structuredClone(record));
    return structuredClone(record);
  }
  private async writeJson(relativePath: string, json: string): Promise<void> {
    const target = await this.files.policy.resolve(relativePath, true);
    await this.files.policy.ensureParent(target);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await this.files.policy.assertSafe(temporary, true);
    try { await writeFile(temporary, json, { flag: "wx" }); await this.files.policy.assertSafe(target, true); await this.files.fs.rename(temporary, target); }
    finally { await this.files.fs.unlink(temporary).catch(() => undefined); }
  }
  async remove(id: string): Promise<void> {
    await this.queue(async () => {
      const record = this.get(id);
      if (record.taskId) {
        const deleted = new Set(this.deletedTasks); deleted.add(record.taskId);
        if (deleted.size > 4096) throw new ProjectError("VALIDATION_FAILED", "已删除任务会话记录达到上限，请归档会话");
        await this.writeJson(`${directory}/deleted-tasks.json`, JSON.stringify([...deleted])); this.deletedTasks.add(record.taskId);
      }
      const target = await this.files.policy.resolve(`${directory}/${digestBytes(id).slice(7)}.json`, true); await this.files.fs.unlink(target); this.records.delete(id);
    });
  }
  export(id: string): string {
    const record = this.get(id);
    return JSON.stringify({
      ...SessionStore.view(record),
      requestContext: {
        conversation: record.conversation,
      },
    });
  }
  async import(json: string): Promise<ChatSession> {
    if (Buffer.byteLength(json) > sessionFileLimit) throw new ProjectError("VALIDATION_FAILED", "导入会话过大");
    const input = SessionExportSchema.parse(JSON.parse(json));
    return this.queue(async () => {
      const now = new Date().toISOString();
      const record: SessionRecord = { id: randomUUID(), title: input.title, createdAt: now, updatedAt: now, archived: false,
        draft: input.draft, draftRevision: 0, revision: 0, seq: 0, approvalMode: DEFAULT_APPROVAL_MODE, webSearchMode: input.webSearchMode ?? DEFAULT_WEB_SEARCH_MODE, items: input.items.filter((item) => item.kind !== "question" && item.kind !== "approval"),
        ...(input.model ? { model: input.model } : {}),
        ...(input.contextSummary !== undefined ? { contextSummary: input.contextSummary } : {}),
        ...(input.contextTokensEstimate !== undefined ? { contextTokensEstimate: input.contextTokensEstimate } : {}),
        ...(input.contextCalibration !== undefined ? { contextCalibration: input.contextCalibration } : {}),
        ...(input.lastRequestUsage !== undefined ? { lastRequestUsage: input.lastRequestUsage } : {}),
        conversation: [], status: "idle" };
      const messages = record.items.filter((item) => item.kind === "message").map((item): AgentMessage => ({ role: item.role, content: item.content }));
      // New exports preserve the actual request context after compression. Legacy
      // exports have no requestContext and rebuild it from visible messages.
      record.conversation = input.requestContext?.conversation
        ? boundConversation(input.requestContext.conversation)
        : boundConversation(messages);
      if (input.requestContext?.contextSummary !== undefined) record.contextSummary = input.requestContext.contextSummary;
      // Derived context uses the remaining file budget. Remove only complete old
      // turns so tool calls stay paired with their results and the current turn
      // stays intact alongside its summary. A current turn that cannot fit is
      // rejected by write rather than silently losing its continuation.
      const turns: AgentMessage[][] = [];
      for (const message of record.conversation) {
        if (message.role === "user" || !turns.length) turns.push([message]);
        else turns[turns.length - 1]!.push(message);
      }
      while (turns.length > 1 && Buffer.byteLength(JSON.stringify(record)) > sessionFileLimit - 32) {
        turns.shift();
        record.conversation = turns.flat();
      }
      return SessionStore.view(await this.write(record));
    });
  }
  private queue<T>(action: () => Promise<T>): Promise<T> { const result = this.pending.then(action); this.pending = result.then(() => undefined, () => undefined); return result; }
}
