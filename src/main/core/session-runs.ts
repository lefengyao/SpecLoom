import { createHash, randomUUID } from "node:crypto";
import { ChatGuidanceInputSchema, chatId, sessionFileLimit, validateAnswer, type ChatImageAttachment, type ChatSession, type QuestionAnswer, type QuestionInput, type SessionEvent, type SessionCapabilities, type ResponseMetrics, type RunFileChanges } from "../../shared/chat";
import type { AgentEvent, AgentMessage, AgentRunResult, AgentRuntimeOptions } from "./agent-runtime";
import { boundConversation, PERSISTED_CONVERSATION_MESSAGE_LIMIT, PERSISTED_CONVERSATION_JSON_LIMIT } from "./agent-conversation";
import { conversationStorageSize } from "./agent-compression";
import { ProjectError } from "./errors";
import { SessionStore } from "./session-store";
import { estimateTokens } from "./model-settings";
import { ToolApprovalInputSchema, type ToolApprovalInput } from "../../shared/approvals";
import { z } from "zod";
import { RunFileChangeTracker } from "./run-file-changes";

export interface SessionRunOptions extends Pick<AgentRuntimeOptions, "onEvent" | "onQuestion" | "onConversation" | "onUsage"> {
  prompt: string; previousMessages: AgentMessage[]; contextSummary?: string; signal: AbortSignal; session: ChatSession; images?: ChatImageAttachment[];
  onApproval(input: ToolApprovalInput): Promise<boolean>;
  takeGuidance(final: boolean): Promise<AgentMessage[]>;
}
type Executor = (options: SessionRunOptions) => Promise<AgentRunResult>;
interface LiveRun {
  id: string;
  controller: AbortController;
  startedAt: number;
  firstTokenAt?: number;
  thinkingStartedAt?: number;
  thinkingMs: number;
  acceptingGuidance: boolean;
  guidance: Map<string, AgentMessage>;
  guidanceTail: Promise<void>;
  answer?: { questionId: string; resolve: (answer: QuestionAnswer) => void; reject: (error: Error) => void };
  approvals: Map<string, { resolve: (approved: boolean) => void; reject: (error: Error) => void; toolId?: string }>;
}
function answerKey(answer: QuestionAnswer): string { return JSON.stringify(Object.entries(answer).sort(([a], [b]) => a.localeCompare(b)).map(([id, value]) => [id, Array.isArray(value) ? [...value].sort() : value])); }

/** UI cancellation cannot depend on a third-party tool or an inherited pipe ever settling. */
function untilCancelled<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(new ProjectError("MODEL_ERROR", "The agent run was cancelled.")); };
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
  });
}

function preserveConversation(messages: AgentMessage[]): AgentMessage[] {
  const storage = conversationStorageSize(messages);
  if (storage.messages > PERSISTED_CONVERSATION_MESSAGE_LIMIT || storage.jsonChars > PERSISTED_CONVERSATION_JSON_LIMIT) {
    throw new ProjectError("MODEL_ERROR", "上下文无法完整保存，请等待当前请求压缩后重试；如运行已中断，请继续会话。", { reason: "CONTEXT_STORAGE_LIMIT" });
  }
  return boundConversation(messages);
}

export class SessionRuns {
  private readonly live = new Map<string, LiveRun>();
  private readonly listeners = new Set<(event: SessionEvent) => void>();
  constructor(readonly store: SessionStore, readonly projectPath: string) {}
  executor(execute: Executor): Executor { return execute; }
  get running(): boolean { return this.live.size > 0; }
  isRunning(id: string): boolean { return this.live.has(id); }
  subscribe(listener: (event: SessionEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private publish(session: ChatSession): void {
    const event = { projectPath: this.projectPath, sessionId: session.id, ...(session.runId ? { runId: session.runId } : {}), seq: session.seq, session };
    for (const listener of this.listeners) {
      try { listener(structuredClone(event)); } catch { /* Delivery cannot undo a durable run or approval decision. */ }
    }
  }
  async updateCapabilities(id: string, capabilities: SessionCapabilities | undefined, error?: string, owner?: { runId: string; signal: AbortSignal }): Promise<ChatSession> {
    owner?.signal.throwIfAborted();
    const record = await this.store.update(id, record => {
      owner?.signal.throwIfAborted();
      if (owner && record.runId !== owner.runId) throw new ProjectError("MODEL_ERROR", "能力更新所属运行已过期");
      if (capabilities) record.capabilities = capabilities;
      if (error) record.capabilityError = error.slice(0, 2000); else delete record.capabilityError;
    });
    const session = SessionStore.view(record); this.publish(session); return session;
  }
  async send(sessionId: string, prompt: string, execute: Executor, draftRevision?: number, images?: ChatImageAttachment[]): Promise<ChatSession> {
    const before = this.store.get(sessionId);
    if (this.live.has(sessionId) || before.archived) throw new ProjectError("MODEL_ERROR", "会话正在运行或已归档");
    const run: LiveRun = { id: randomUUID(), controller: new AbortController(), startedAt: Date.now(), thinkingMs: 0, approvals: new Map(), acceptingGuidance: true, guidance: new Map(), guidanceTail: Promise.resolve() }; this.live.set(sessionId, run);
    const fileTracker = new RunFileChangeTracker(this.projectPath, run.id, {}, before.approvalMode);
    let fileReport: RunFileChanges | undefined;
    const finishFiles = async (): Promise<RunFileChanges> => {
      if (fileReport) return fileReport;
      try { return fileReport = await fileTracker.finish(run.controller.signal.aborted); }
      catch { return fileReport = { runId: run.id, files: [], complete: false, notes: ["文件变化检查未能完成；任务结果已保留。"] }; }
    };
    // Persisting every token rewrites the whole session file and throttles the
    // provider stream. Apply text/thinking in small batches instead.
    const streamBatchSize = 64;
    const pendingStreams = new Map<string, AgentEvent>();
    let pendingStreamCount = 0;
    let streamChain: Promise<void> = Promise.resolve();
    let streamWriteError: unknown;
    const writeEvents = async (events: AgentEvent[]): Promise<void> => {
      const updated = await this.store.update(sessionId, (record) => {
        if (this.live.get(sessionId) !== run || run.controller.signal.aborted) return;
        for (const event of events) { record.seq++; this.apply(record, run.id, event); }
      });
      if (!run.controller.signal.aborted) this.publish(SessionStore.view(updated));
    };
    const flushStreams = (): Promise<void> => {
      streamChain = streamChain.then(async () => {
        if (!pendingStreams.size) return;
        const events = [...pendingStreams.values()];
        pendingStreams.clear();
        pendingStreamCount = 0;
        await writeEvents(events);
      }).catch((error) => { streamWriteError ??= error; throw error; });
      return streamChain;
    };
    let started = false;
    try {
      const session = await this.store.update(sessionId, (record) => {
        record.status = "running"; record.activity = "正在准备智能体"; record.runId = run.id; record.seq = 0; delete record.error; delete record.diagnosticId; delete record.usage;
        for (const item of record.items) if ((item.kind === "question" || item.kind === "approval") && item.status === "waiting") item.status = "interrupted";
        record.items.push({ id: `${run.id}:user`, kind: "message", role: "user", content: prompt });
        if (draftRevision !== undefined && record.draftRevision === draftRevision) { record.draft = ""; record.draftRevision++; }
        if (record.title === "新会话") record.title = prompt.slice(0, 40);
      });
      started = true; this.publish(SessionStore.view(session));
      await untilCancelled(fileTracker.start(), run.controller.signal);
      const result = await untilCancelled(execute({ prompt, previousMessages: session.conversation, ...(session.contextSummary === undefined ? {} : { contextSummary: session.contextSummary }), signal: run.controller.signal, session: SessionStore.view(session), ...(images?.length ? { images } : {}),
        onEvent: async (event) => {
          if (this.live.get(sessionId) !== run || run.controller.signal.aborted) return;
          if (streamWriteError) throw streamWriteError;
          this.observe(run, event, Date.now());
          await fileTracker.observe(event).catch(() => undefined);
          if (event.type === "text" || event.type === "thinking") {
            pendingStreams.set(`${event.type}:${event.messageId}`, event);
            pendingStreamCount++;
            if (pendingStreamCount >= streamBatchSize) await flushStreams();
            return;
          }
          await flushStreams();
          await writeEvents([event]);
        },
        onConversation: async (messages, contextSummary, contextTokensEstimate, contextCalibration) => {
          if (this.live.get(sessionId) !== run || run.controller.signal.aborted) return;
          await flushStreams();
          const updated = await this.store.update(sessionId, (record) => {
            if (this.live.get(sessionId) !== run || run.controller.signal.aborted) return;
            record.conversation = preserveConversation([...messages, ...this.pendingGuidance(record, run)]);
            if (contextSummary !== undefined) record.contextSummary = contextSummary;
            record.contextTokensEstimate = contextTokensEstimate ?? estimateTokens(JSON.stringify({ summary: contextSummary ?? record.contextSummary ?? "", conversation: record.conversation }));
            if (contextCalibration) record.contextCalibration = contextCalibration; else delete record.contextCalibration;
            record.seq++;
          });
          if (!run.controller.signal.aborted) this.publish(SessionStore.view(updated));
        },
        onUsage: async usage => {
          if (this.live.get(sessionId) !== run || run.controller.signal.aborted) return;
          await flushStreams();
          const updated = await this.store.update(sessionId, record => {
            if (this.live.get(sessionId) !== run || run.controller.signal.aborted) return;
            record.lastRequestUsage = { ...usage, source: "actual" };
            record.usage = {
              promptTokens: (record.usage?.promptTokens ?? 0) + usage.promptTokens,
              completionTokens: (record.usage?.completionTokens ?? 0) + usage.completionTokens,
              cachedTokens: (record.usage?.cachedTokens ?? 0) + usage.cachedTokens,
              cacheWriteTokens: (record.usage?.cacheWriteTokens ?? 0) + usage.cacheWriteTokens,
              source: "actual",
            };
            record.seq++;
          });
          if (!run.controller.signal.aborted) this.publish(SessionStore.view(updated));
        },
        takeGuidance: final => this.takeGuidance(sessionId, run, final),
        onQuestion: (question) => this.ask(sessionId, run, question),
        onApproval: async (input) => {
          const approved = await this.requestApproval(sessionId, run, input);
          if (approved) await fileTracker.approved(input).catch(() => undefined);
          return approved;
        },
      }), run.controller.signal);
      await flushStreams();
      if (streamWriteError) throw streamWriteError;
      // Executors must consume their guidance before returning. Never report an accepted but unhandled message as completed.
      if ((await this.takeGuidance(sessionId, run, true)).length) throw new ProjectError("MODEL_ERROR", "运行结束前未处理引导，已保留在会话历史中");
      const fileChanges = await finishFiles();
      const complete = await this.store.update(sessionId, (record) => {
        if (this.live.get(sessionId) !== run || run.controller.signal.aborted) throw new ProjectError("MODEL_ERROR", "运行已中断");
        const metrics = this.metrics(run, result, Date.now());
        record.conversation = preserveConversation(result.messages);
        if (result.contextSummary !== undefined) record.contextSummary = result.contextSummary;
        if (result.contextCalibration) record.contextCalibration = result.contextCalibration; else delete record.contextCalibration;
        record.contextTokensEstimate = result.contextTokensEstimate ?? estimateTokens(JSON.stringify({ summary: record.contextSummary ?? "", conversation: record.conversation }));
        record.status = "completed"; delete record.activity; delete record.diagnosticId; record.seq++;
        if (result.usage) record.usage = { ...result.usage, source: "actual" };
        const replies = record.items.filter((item) => item.kind === "message" && item.role === "assistant" && item.id.startsWith(`${run.id}:`));
        const finalReply = replies.at(-1);
        if (finalReply?.kind === "message") {
          for (const item of replies) if (item.kind === "message") delete item.metrics;
          finalReply.metrics = metrics;
        } else {
          record.items.push({ id: `${run.id}:reply`, kind: "message", role: "assistant", content: result.summary, metrics });
        }
        for (const item of record.items) {
          if ((item.kind === "message" || item.kind === "thinking") && item.id.startsWith(run.id)) delete item.partial;
          if (item.kind === "approval" && item.request.runId === run.id && item.status === "waiting") item.status = "interrupted";
        }
        this.attachFileChanges(record, run.id, fileChanges);
      });
      this.publish(SessionStore.view(complete)); return SessionStore.view(complete);
    } catch (error) {
      run.acceptingGuidance = false;
      await run.guidanceTail;
      if (started) {
        await flushStreams().catch(() => undefined);
        const fileChanges = await finishFiles();
        const failed = await this.store.update(sessionId, (record) => {
          record.status = run.controller.signal.aborted ? "cancelled" : "error"; record.error = (run.controller.signal.aborted ? "已停止，保留部分回复" : error instanceof Error ? error.message : String(error)).slice(0, 4000);
          const diagnosticId = z.string().uuid().safeParse(error instanceof ProjectError ? error.details?.diagnosticId : undefined);
          if (diagnosticId.success) record.diagnosticId = diagnosticId.data; else delete record.diagnosticId;
          record.seq++;
          delete record.activity;
          for (const item of record.items) { if (item.kind === "question" && item.question.runId === run.id && item.status === "waiting") item.status = "cancelled"; if (item.kind === "approval" && item.request.runId === run.id && item.status === "waiting") item.status = "cancelled"; if (item.kind === "tool" && ["running", "receiving", "waiting"].includes(item.status)) item.status = "cancelled"; }
          this.attachFileChanges(record, run.id, fileChanges);
        }); this.publish(SessionStore.view(failed));
      }
      throw error;
    } finally {
      run.acceptingGuidance = false;
      for (const waiter of run.approvals.values()) waiter.reject(new ProjectError("MODEL_ERROR", "审批所属运行已结束"));
      if (this.live.get(sessionId) === run) this.live.delete(sessionId);
    }
  }
  private attachFileChanges(record: ChatSession, runId: string, fileChanges: RunFileChanges): void {
    let reply = [...record.items].reverse().find(item => item.kind === "message" && item.role === "assistant" && item.id.startsWith(`${runId}:`));
    // The item limit must never prevent a stopped run's terminal state from being saved.
    if (!reply && record.items.length >= 4096) reply = record.items.find(item => item.id === `${runId}:user` && item.kind === "message");
    const synthetic = { id: `${runId}:file-changes`, kind: "message" as const, role: "assistant" as const, content: "" };
    const overhead = reply ? Buffer.byteLength(',"fileChanges":') : Buffer.byteLength(JSON.stringify(synthetic)) + Buffer.byteLength(',"fileChanges":') + 1;
    // Revision/timestamp changes still happen in SessionStore after this callback.
    const available = sessionFileLimit - Buffer.byteLength(JSON.stringify(record)) - overhead - 256;
    let report = fileChanges;
    if (Buffer.byteLength(JSON.stringify(report)) > available) {
      report = { runId, files: [], complete: false, notes: ["会话剩余容量有限，部分文件变化未保存。"] };
      let bytes = Buffer.byteLength(JSON.stringify(report));
      for (const file of fileChanges.files) {
        const size = Buffer.byteLength(JSON.stringify(file)) + (report.files.length ? 1 : 0);
        if (bytes + size > available) break;
        report.files.push(file); bytes += size;
      }
      // Saving the run outcome takes precedence even for records from older capacity rules.
      if (bytes > available) return;
    }
    if (reply?.kind === "message") reply.fileChanges = report;
    else record.items.push({ ...synthetic, fileChanges: report });
  }
  async guide(sessionId: string, runId: string, guidanceId: string, prompt: string, images?: ChatImageAttachment[]): Promise<ChatSession> {
    const parsed = ChatGuidanceInputSchema.safeParse({ runId, guidanceId, prompt, ...(images?.length ? { images } : {}) });
    if (!parsed.success) throw new ProjectError("VALIDATION_FAILED", "引导内容无效或过大");
    const itemId = `${runId}:guidance:${guidanceId}`;
    if (!chatId.safeParse(itemId).success) throw new ProjectError("VALIDATION_FAILED", "引导身份无效");
    const attachments = parsed.data.images;
    const fingerprint = createHash("sha256").update(JSON.stringify([prompt, attachments ?? []])).digest("hex");
    const matches = (record: ChatSession): boolean => {
      const item = record.items.find(candidate => candidate.id === itemId);
      if (!item) return false;
      if (item.kind !== "message" || item.role !== "user" || item.content !== prompt || item.guidance?.fingerprint !== fingerprint) throw new ProjectError("VALIDATION_FAILED", "引导身份已提交不同内容");
      return true;
    };
    const before = this.store.get(sessionId);
    // Durable retries remain successful after a run ends or a new run starts, without redelivery.
    if (matches(before)) return SessionStore.view(before);
    const run = this.live.get(sessionId);
    const assertAdmission = (record: ChatSession) => {
      if (record.runId !== runId || run && run.id !== runId) throw new ProjectError("VALIDATION_FAILED", "引导所属运行已过期");
      if (!run || this.live.get(sessionId) !== run || !run.acceptingGuidance || run.controller.signal.aborted) throw new ProjectError("MODEL_ERROR", "运行已结束或正在结束，请重新发送");
    };
    assertAdmission(before);
    const current = run!;
    const message: AgentMessage = { role: "user", content: prompt, ...(attachments?.length ? { images: attachments.map(({ mimeType, base64 }) => ({ mimeType, base64 })) } : {}) };
    const accepting = this.store.update(sessionId, record => {
      if (matches(record)) return;
      assertAdmission(record);
      const conversation = preserveConversation([...record.conversation, message]);
      record.items.push({ id: itemId, kind: "message", role: "user", content: prompt, guidance: { fingerprint } });
      record.conversation = conversation;
      record.seq++;
      // Register inside the store queue: its next checkpoint can run before update's returned promise settles.
      current.guidance.set(itemId, message);
    }).then(updated => {
      const session = SessionStore.view(updated); this.publish(session); return session;
    }, error => {
      // A concurrent retry may have installed a different message under the same ID.
      if (current.guidance.get(itemId) === message) current.guidance.delete(itemId);
      throw error;
    });
    // Register admission synchronously; a final boundary waits for even a slow durable write.
    current.guidanceTail = Promise.allSettled([current.guidanceTail, accepting]).then(() => undefined);
    return accepting;
  }
  private pendingGuidance(record: ChatSession, run: LiveRun): AgentMessage[] {
    if (!run.guidance.size) return [];
    const receipts = new Set(record.items.map(item => item.id));
    // A failed admission can still have transient map state; only durable receipts reach checkpoints or the model.
    return [...run.guidance].flatMap(([id, message]) => receipts.has(id) ? [message] : []);
  }
  private async takeGuidance(sessionId: string, run: LiveRun, final: boolean): Promise<AgentMessage[]> {
    let tail: Promise<void>;
    do { tail = run.guidanceTail; await tail; } while (tail !== run.guidanceTail);
    if (this.live.get(sessionId) !== run || run.controller.signal.aborted) throw new ProjectError("MODEL_ERROR", "运行已中断");
    const pending = run.guidance.size ? this.pendingGuidance(this.store.get(sessionId), run) : [];
    run.guidance.clear();
    // No await between drain and seal: an empty final boundary cannot race a new admission.
    if (final && !pending.length) run.acceptingGuidance = false;
    return pending;
  }
  /** Record timing boundaries from the stream without persisting transient clock state. */
  private observe(run: LiveRun, event: AgentEvent, now: number): void {
    if ((event.type === "text" || event.type === "thinking") && run.firstTokenAt === undefined) run.firstTokenAt = now;
    if (event.type === "thinking") {
      if (run.thinkingStartedAt === undefined) run.thinkingStartedAt = now;
      return;
    }
    this.closeThinking(run, now);
  }
  private closeThinking(run: LiveRun, now: number): void {
    if (run.thinkingStartedAt !== undefined) {
      run.thinkingMs += Math.max(0, now - run.thinkingStartedAt);
      delete run.thinkingStartedAt;
    }
  }
  private metrics(run: LiveRun, result: AgentRunResult, completedAt: number): ResponseMetrics {
    this.closeThinking(run, completedAt);
    const durationMs = Math.max(0, completedAt - run.startedAt);
    const firstTokenMs = Math.max(0, (run.firstTokenAt ?? completedAt) - run.startedAt);
    const outputTokens = result.usage ? Math.max(0, result.usage.completionTokens) : estimateTokens(result.summary);
    // When no stream event was available, use the full run duration as the output window.
    const outputWindowMs = run.firstTokenAt === undefined ? durationMs : Math.max(0, completedAt - run.firstTokenAt);
    const outputRate = outputWindowMs > 0 ? outputTokens / (outputWindowMs / 1000) : 0;
    return { firstTokenMs, thinkingMs: Math.max(0, run.thinkingMs), outputTokens, outputRate: Number.isFinite(outputRate) ? Math.max(0, outputRate) : 0, durationMs };
  }
  private apply(record: ChatSession, runId: string, event: AgentEvent): void {
    if (event.type === "request") { record.activity = `正在思考 · 第 ${event.round + 1} 轮`; return; }
    if (event.type === "activity") {
      record.activity = event.content.slice(-2000);
      const id = `${runId}:activity`; const previous = record.items.find(i => i.id === id);
      if (previous?.kind === "activity") previous.content = `${previous.content}\n${event.content}`.slice(-16384);
      else record.items.push({ id, kind: "activity", content: event.content.slice(-16384) });
      return;
    }
    if (event.type === "response-reset") {
      const messageIds = new Set(event.messageIds.map((id) => `${runId}:${id}`));
      const toolIds = new Set(event.toolEventIds.map((id) => `${runId}:tool:${id}`));
      record.items = record.items.filter((item) => {
        if (messageIds.has(item.id) && (item.kind === "message" || item.kind === "thinking") && item.partial) return false;
        return !(toolIds.has(item.id) && item.kind === "tool" && item.status === "receiving");
      });
      return;
    }
    if (event.type === "text" || event.type === "thinking") {
      record.activity = event.type === "thinking" ? "正在思考" : "正在输出回复";
      const id = `${runId}:${event.messageId}`;
      const item = record.items.find((i) => i.id === id);
      if (item?.kind === "message" || item?.kind === "thinking") item.content = event.content;
      else if (event.type === "thinking") record.items.push({ id, kind: "thinking", content: event.content, partial: true });
      else record.items.push({ id, kind: "message", role: "assistant", content: event.content, partial: true });
    } else if (event.type === "tool-start" || event.type === "tool-result" || event.type === "tool-args") {
      const id = event.toolEventId ? `${runId}:tool:${event.toolEventId}` : `${runId}:tool:${event.round}:${event.streamIndex ?? event.toolCallId}`;
      let item = record.items.find((i) => i.id === id);
      if (!item) { item = { id, kind: "tool", callId: event.toolCallId, name: event.name ?? "工具", arguments: "", output: "", status: "receiving" }; record.items.push(item); }
      if (item.kind !== "tool") return;
      item.callId = event.toolCallId;
      if (event.name) item.name = event.name;
      if (event.type === "tool-args") { item.arguments = event.arguments; item.status = "receiving"; }
      if (event.type === "tool-start") { item.arguments = event.arguments ?? item.arguments; item.status = "running"; record.activity = `正在调用 ${item.name}`; }
      if (event.type === "tool-result") { item.output = event.output; item.status = event.ok ? "ok" : "error"; }
    }
  }
  private async ask(sessionId: string, run: LiveRun, input: QuestionInput): Promise<QuestionAnswer> {
    const assertCurrent = () => {
      if (this.live.get(sessionId) !== run || run.controller.signal.aborted) throw new ProjectError("MODEL_ERROR", "问题所属运行已中断，请重新发送");
    };
    assertCurrent();
    const question = { ...input, id: randomUUID(), sessionId, runId: run.id };
    // Install a waiter before publishing: an immediate renderer answer cannot race it.
    let resolve!: (answer: QuestionAnswer) => void; let reject!: (error: Error) => void;
    const waiting = new Promise<QuestionAnswer>((ok, fail) => { resolve = ok; reject = fail; });
    // Persistence may fail before the promise is awaited; cancellation still must be handled.
    void waiting.catch(() => undefined);
    run.answer = { questionId: question.id, resolve, reject };
    const abort = () => reject(new ProjectError("MODEL_ERROR", "问答已取消"));
    run.controller.signal.addEventListener("abort", abort, { once: true });
    try {
      const record = await this.store.update(sessionId, (record) => {
        assertCurrent();
        if (record.runId !== run.id) throw new ProjectError("MODEL_ERROR", "问题所属运行已过期");
        record.status = "waiting"; record.activity = "等待你回答"; record.seq++; const tool = [...record.items].reverse().find((item) => item.kind === "tool" && ["ask_user", "AskUserQuestion"].includes(item.name) && item.status === "running"); if (tool?.kind === "tool") tool.status = "waiting"; record.items.push({ id: question.id, kind: "question", question, status: "waiting" });
      });
      assertCurrent();
      this.publish(SessionStore.view(record));
      return await waiting;
    } finally { run.controller.signal.removeEventListener("abort", abort); delete run.answer; }
  }
  async answer(sessionId: string, runId: string, questionId: string, answer: QuestionAnswer): Promise<ChatSession> {
    const record = this.store.get(sessionId);
    const item = record.items.find((i) => i.kind === "question" && i.question.id === questionId);
    if (record.runId !== runId || item?.kind !== "question" || item.question.runId !== runId || item.question.sessionId !== sessionId) throw new ProjectError("VALIDATION_FAILED", "问题身份已过期");
    validateAnswer(item.question, answer);
    if (item.answer) { if (answerKey(item.answer) !== answerKey(answer)) throw new ProjectError("VALIDATION_FAILED", "问题已提交不同答案"); return SessionStore.view(record); }
    const live = this.live.get(sessionId);
    if (!live || live.id !== runId || live.answer?.questionId !== questionId) throw new ProjectError("MODEL_ERROR", "运行已中断，请重新发送");
    const waiter = live.answer;
    const updated = await this.store.update(sessionId, (record) => {
      if (record.runId !== runId || live.controller.signal.aborted) throw new ProjectError("MODEL_ERROR", "运行已中断");
      const pending = record.items.find((i) => i.id === item.id);
      if (pending?.kind === "question" && pending.answer) {
        if (answerKey(pending.answer) !== answerKey(answer)) throw new ProjectError("VALIDATION_FAILED", "问题已提交不同答案");
        return;
      }
      if (pending?.kind === "question") { pending.answer = answer; pending.status = "answered"; }
      this.refreshWaiting(record, runId); record.seq++;
    });
    this.publish(SessionStore.view(updated)); waiter.resolve(answer); return SessionStore.view(updated);
  }
  private assertApprovalRun(sessionId: string, run: LiveRun): void {
    if (this.live.get(sessionId) !== run || run.controller.signal.aborted) throw new ProjectError("MODEL_ERROR", "审批所属运行已中断，请重新发送");
  }
  private refreshWaiting(record: ChatSession, runId: string): void {
    const waiting = record.items.find(item => (item.kind === "approval" && item.request.runId === runId || item.kind === "question" && item.question.runId === runId) && item.status === "waiting");
    record.status = waiting ? "waiting" : "running";
    record.activity = waiting?.kind === "approval" ? "等待你批准" : waiting ? "等待你回答" : "正在继续执行";
  }
  private async requestApproval(sessionId: string, run: LiveRun, value: ToolApprovalInput): Promise<boolean> {
    this.assertApprovalRun(sessionId, run);
    const request = { ...ToolApprovalInputSchema.parse(value), id: randomUUID(), sessionId, runId: run.id };
    let resolve!: (approved: boolean) => void; let reject!: (error: Error) => void;
    const waiting = new Promise<boolean>((ok, fail) => { resolve = ok; reject = fail; });
    void waiting.catch(() => undefined);
    const waiter: { resolve: typeof resolve; reject: typeof reject; toolId?: string } = { resolve, reject };
    run.approvals.set(request.id, waiter);
    const abort = () => reject(new ProjectError("MODEL_ERROR", "审批已取消"));
    run.controller.signal.addEventListener("abort", abort, { once: true });
    try {
      const record = await this.store.update(sessionId, record => {
        this.assertApprovalRun(sessionId, run);
        if (record.runId !== run.id) throw new ProjectError("VALIDATION_FAILED", "审批所属运行已过期");
        record.status = "waiting"; record.activity = "等待你批准"; record.seq++;
        const tool = [...record.items].reverse().find(item => item.kind === "tool" && item.name === request.toolName && item.status === "running");
        if (tool?.kind === "tool") { tool.status = "waiting"; waiter.toolId = tool.id; }
        record.items.push({ id: request.id, kind: "approval", request, status: "waiting" });
      });
      this.publish(SessionStore.view(record));
      this.assertApprovalRun(sessionId, run);
      return await waiting;
    } finally { run.controller.signal.removeEventListener("abort", abort); run.approvals.delete(request.id); }
  }
  async approve(sessionId: string, runId: string, approvalId: string, approved: boolean): Promise<ChatSession> {
    const record = this.store.get(sessionId);
    const item = record.items.find(candidate => candidate.id === approvalId);
    if (record.runId !== runId || item?.kind !== "approval" || item.request.id !== approvalId || item.request.runId !== runId || item.request.sessionId !== sessionId) throw new ProjectError("VALIDATION_FAILED", "审批身份已过期");
    const status = approved ? "approved" : "denied";
    if (item.status === "approved" || item.status === "denied") {
      if (item.status !== status) throw new ProjectError("VALIDATION_FAILED", "审批已提交不同决定");
      return SessionStore.view(record);
    }
    const live = this.live.get(sessionId); const waiter = live?.approvals.get(approvalId);
    if (!live || live.id !== runId || !waiter || item.status !== "waiting") throw new ProjectError("MODEL_ERROR", "审批所属运行已中断，请重新发送");
    const updated = await this.store.update(sessionId, record => {
      this.assertApprovalRun(sessionId, live);
      if (record.runId !== runId || live.approvals.get(approvalId) !== waiter) throw new ProjectError("VALIDATION_FAILED", "审批身份已过期");
      const pending = record.items.find(candidate => candidate.id === approvalId);
      if (pending?.kind !== "approval" || pending.request.id !== approvalId || pending.request.runId !== runId || pending.request.sessionId !== sessionId) throw new ProjectError("VALIDATION_FAILED", "审批身份已过期");
      if (pending.status === "approved" || pending.status === "denied") {
        if (pending.status !== status) throw new ProjectError("VALIDATION_FAILED", "审批已提交不同决定");
        return;
      }
      if (pending.status !== "waiting") throw new ProjectError("MODEL_ERROR", "审批所属运行已中断");
      pending.status = status;
      const tool = record.items.find(candidate => candidate.id === waiter.toolId);
      if (tool?.kind === "tool" && tool.status === "waiting") tool.status = "running";
      this.refreshWaiting(record, runId);
      record.seq++;
    });
    this.assertApprovalRun(sessionId, live);
    this.publish(SessionStore.view(updated)); waiter.resolve(approved); return SessionStore.view(updated);
  }
  cancel(id: string): void { const run = this.live.get(id); if (run) { run.acceptingGuidance = false; run.controller.abort(); } }
  cancelAll(): void { for (const id of this.live.keys()) this.cancel(id); }
}
