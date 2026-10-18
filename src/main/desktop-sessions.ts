import { SessionStore } from "./core/session-store";
import path from "node:path";
import { SessionRuns } from "./core/session-runs";
import { FileStore } from "./core/file-store";
import { AgentRuntime, type AgentEvent } from "./core/agent-runtime";
import { WorkspaceTools } from "./core/tools/workspace-tools";
import { systemPrompt } from "./core/agent-prompts";
import { readProjectContext } from "./core/project-context";
import { ProjectError } from "./core/errors";
import type { ProjectCore } from "./core/project-core";
import type { SessionModelPreference } from "../shared/contracts";
import type { RuntimeModelProfile } from "./core/model-config";
import type { ChatImageAttachment, SessionPatch, SessionEvent, QuestionAnswer } from "../shared/chat";
import type { OfflineDocumentStore } from "./core/offline-documents";
import { DEFAULT_APPROVAL_MODE, type ApprovalMode, type ToolApprovalInput } from "../shared/approvals";
import type { DiagnosticsLogStore } from "./core/diagnostics-log";
import { webSearchGuidance, type WebSearchContext } from "./core/tools/web-search";

export interface SessionHookPermissions {
  mode: ApprovalMode;
  onApproval: (input: ToolApprovalInput) => Promise<boolean>;
  signal: AbortSignal;
}
export type SessionHookRunner = (event: "session.before" | "session.after" | "tool.before" | "tool.after", payload: Record<string, unknown>, permissions: SessionHookPermissions) => Promise<void>;
export class DesktopSessions {
  private readonly workspaces = new Map<string, Promise<SessionRuns>>();
  private readonly listeners = new Set<(event: SessionEvent) => void>();
  private readonly toolboxes = new Map<string, Promise<WorkspaceTools>>();
  private readonly inventories = new Map<string, { controller: AbortController; pending: Promise<void> }>();
  private readonly reservations = new Map<string, Promise<void>>();
  private readonly gitInitSuggestions = new Set<string>();
  private shuttingDown = false;
  constructor(private readonly userData: string, private readonly core: () => ProjectCore | undefined, private readonly profile: (model?: SessionModelPreference) => Promise<RuntimeModelProfile>, private readonly instructions: () => Promise<string>, private readonly resolveCredential: (profile: RuntimeModelProfile) => Promise<string | undefined>, private readonly runHook?: SessionHookRunner, private readonly offlineDocuments?: OfflineDocumentStore, private readonly diagnostics?: DiagnosticsLogStore) {}
  get running(): boolean { return this.reservations.size > 0; }
  /** Acquire before any await so a send cannot enter a session being deleted or reconfigured. */
  private reserve(projectPath: string, id: string): () => void {
    if (this.shuttingDown) throw new ProjectError("MODEL_ERROR", "SpecLoom 正在关闭");
    const key = `${projectPath}\0${id}`;
    if (this.reservations.has(key)) throw new ProjectError("MODEL_ERROR", "会话正在运行或修改，请等待当前操作结束");
    let complete!: () => void;
    const pending = new Promise<void>(resolve => { complete = resolve; });
    this.reservations.set(key, pending);
    return () => { this.reservations.delete(key); complete(); };
  }
  subscribe(listener: (event: SessionEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private async workspace(projectPath: string): Promise<SessionRuns> {
    if (this.shuttingDown) throw new ProjectError("MODEL_ERROR", "SpecLoom 正在关闭");
    if (projectPath !== (this.core()?.metadata.path ?? "")) throw new ProjectError("INVALID_PROJECT", "当前项目已切换，请重新加载会话");
    let found = this.workspaces.get(projectPath);
    if (!found) {
      found = (async () => {
        let root = projectPath;
        if (!root) {
          const files = new FileStore(this.userData);
          root = await files.policy.resolve("conversations", true);
          await files.fs.mkdir(root).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
          await files.policy.assertSafe(root);
        }
        return SessionStore.open(root);
      })().then((store) => {
        const runs = new SessionRuns(store, projectPath);
        runs.subscribe((event) => { for (const listener of this.listeners) { try { listener(structuredClone(event)); } catch { /* A closed renderer cannot block other session observers. */ } } }); return runs;
      });
      this.workspaces.set(projectPath, found);
      void found.catch(() => this.workspaces.delete(projectPath));
    }
    const result = await found;
    if (this.shuttingDown) throw new ProjectError("MODEL_ERROR", "SpecLoom 正在关闭");
    if (projectPath !== (this.core()?.metadata.path ?? "")) throw new ProjectError("INVALID_PROJECT", "当前项目已切换");
    return result;
  }
  async list(projectPath: string) {
    const workspace = await this.workspace(projectPath);
    // Existing tasks get a persistent conversation without changing their scope.
    for (const task of this.core()?.listTasks() ?? []) if (!workspace.store.hasTaskHistory(task.id)) {
      await workspace.store.create(task.scope.title, task.id, task.conversation ?? []);
    }
    for (const session of workspace.store.list()) if (!session.capabilities && !session.capabilityError && !workspace.isRunning(session.id)) this.loadCapabilities(projectPath, session.id);
    return workspace.store.list();
  }
  private async toolbox(projectPath: string, sessionId: string): Promise<WorkspaceTools> {
    if (this.shuttingDown) throw new ProjectError("MODEL_ERROR", "SpecLoom 正在关闭");
    const key = `${projectPath}\0${sessionId}`; const existing = this.toolboxes.get(key); if (existing) return existing;
    const pending = (async () => {
      const runs = await this.workspace(projectPath); const session = runs.store.get(sessionId); const core = this.core();
      const root = projectPath || await new FileStore(this.userData).policy.resolve("conversations", true);
      const tools = new WorkspaceTools(root, sessionId, { ...(session.taskId && core ? { legacyExecute: (name: string, input: Record<string, unknown>, signal?: AbortSignal) => core.executeTool(session.taskId!, name, input, signal) } : {}), ...(this.offlineDocuments ? { offlineDocuments: this.offlineDocuments } : {}), globalMcpConfigPath: path.join(this.userData, "mcp.json") });
      tools.setPermissions(session.approvalMode ?? DEFAULT_APPROVAL_MODE);
      tools.setWebSearch({ mode: session.webSearchMode ?? "off" });
      return tools;
    })();
    this.toolboxes.set(key, pending); void pending.catch(() => { if (this.toolboxes.get(key) === pending) this.toolboxes.delete(key); }); return pending;
  }
  private loadCapabilities(projectPath: string, id: string): void {
    if (this.shuttingDown) return;
    const key = `${projectPath}\0${id}`; if (this.inventories.has(key)) return;
    const controller = new AbortController();
    const pending = (async () => {
      try {
        const tools = await this.toolbox(projectPath, id); controller.signal.throwIfAborted();
        const capabilities = await tools.capabilities(controller.signal); controller.signal.throwIfAborted();
        await (await this.workspace(projectPath)).updateCapabilities(id, capabilities);
      } catch (error) {
        if (controller.signal.aborted || projectPath !== (this.core()?.metadata.path ?? "")) return;
        await (await this.workspace(projectPath)).updateCapabilities(id, undefined, error instanceof Error ? error.message : String(error));
      } finally { if (this.inventories.get(key)?.controller === controller) this.inventories.delete(key); }
    })();
    this.inventories.set(key, { controller, pending }); void pending.catch(() => undefined);
  }
  private async stopCapabilities(projectPath: string, id: string): Promise<void> {
    const key = `${projectPath}\0${id}`; const job = this.inventories.get(key);
    if (job) { job.controller.abort(); this.inventories.delete(key); await job.pending; }
  }
  async create(projectPath: string, title?: string, taskId?: string) {
    const runs = await this.workspace(projectPath);
    if (taskId) {
      const task = this.core()?.listTasks().find((t) => t.id === taskId);
      if (!task) throw new ProjectError("TASK_SCOPE_DENIED", "任务不存在");
      const existing = runs.store.list().find((s) => s.taskId === taskId);
      if (existing) { if (!existing.capabilities && !runs.isRunning(existing.id)) this.loadCapabilities(projectPath, existing.id); return existing; }
      const created = await runs.store.create(title ?? task.scope.title, taskId); this.loadCapabilities(projectPath, created.id); return created;
    }
    const created = await runs.store.create(title); this.loadCapabilities(projectPath, created.id); return created;
  }
  async patch(projectPath: string, id: string, patch: SessionPatch) {
    const release = patch.archived !== undefined || patch.approvalMode !== undefined || patch.webSearchMode !== undefined ? this.reserve(projectPath, id) : undefined;
    try {
      const runs = await this.workspace(projectPath);
      if (patch.archived !== undefined && runs.isRunning(id)) throw new ProjectError("MODEL_ERROR", "先停止运行再归档会话");
      if (patch.approvalMode !== undefined && runs.isRunning(id)) throw new ProjectError("MODEL_ERROR", "先停止运行再修改审批权限");
      if (patch.webSearchMode !== undefined && runs.isRunning(id)) throw new ProjectError("MODEL_ERROR", "先停止运行再修改联网搜索模式");
      const previousMode = runs.store.get(id).approvalMode ?? DEFAULT_APPROVAL_MODE;
      const previousWebSearchMode = runs.store.get(id).webSearchMode ?? "off";
      const session = await runs.store.patch(id, patch);
      if ((patch.approvalMode !== undefined && patch.approvalMode !== previousMode) || (patch.webSearchMode !== undefined && patch.webSearchMode !== previousWebSearchMode)) {
        await this.stopCapabilities(projectPath, id);
        const key = `${projectPath}\0${id}`;
        if (!runs.isRunning(id)) {
          const cached = this.toolboxes.get(key); this.toolboxes.delete(key);
          await (await cached)?.close();
          if (!runs.isRunning(id)) this.loadCapabilities(projectPath, id);
        }
      }
      return session;
    } finally { release?.(); }
  }
  async remove(projectPath: string, id: string) {
    const release = this.reserve(projectPath, id);
    try {
      const runs = await this.workspace(projectPath);
      if (runs.isRunning(id)) throw new ProjectError("MODEL_ERROR", "先停止运行再删除会话");
      await this.stopCapabilities(projectPath, id);
      await runs.store.remove(id);
      const key = `${projectPath}\0${id}`;
      const cached = this.toolboxes.get(key); this.toolboxes.delete(key);
      await (await cached)?.close();
    } finally { release(); }
  }
  async export(projectPath: string, id: string) { return (await this.workspace(projectPath)).store.export(id); }
  async import(projectPath: string, json: string) { const session = await (await this.workspace(projectPath)).store.import(json); this.loadCapabilities(projectPath, session.id); return session; }
  async send(projectPath: string, id: string, prompt: string, draftRevision?: number, images?: ChatImageAttachment[]) {
    const release = this.reserve(projectPath, id);
    try {
      const runs = await this.workspace(projectPath); const core = this.core();
      if (this.shuttingDown) throw new ProjectError("MODEL_ERROR", "SpecLoom 正在关闭");
      return await runs.send(id, prompt, async (options) => {
        const mode = options.session.approvalMode ?? DEFAULT_APPROVAL_MODE;
        const assertCurrent = () => {
          options.signal.throwIfAborted();
          if (runs.store.get(id).runId !== options.session.runId) throw new ProjectError("MODEL_ERROR", "运行已过期");
        };
        let runTools: WorkspaceTools | undefined;
        const permissions: SessionHookPermissions = { mode, onApproval: options.onApproval, signal: options.signal };
        const hook = async (event: Parameters<SessionHookRunner>[0], payload: Record<string, unknown>) => {
          assertCurrent();
          await this.runHook?.(event, payload, permissions).catch(() => undefined);
          assertCurrent();
        };
        await hook("session.before", { projectPath, sessionId: id, prompt: prompt.slice(0, 4000) });
        try {
        const model = await this.profile(options.session.model);
        assertCurrent();
        const tools = await this.toolbox(projectPath, id);
        assertCurrent(); runTools = tools;
        await this.stopCapabilities(projectPath, id);
        assertCurrent();
        tools.setPermissions(mode, options.onApproval);
        const webSearch: WebSearchContext = { mode: options.session.webSearchMode ?? "off", profile: model, resolveCredential: this.resolveCredential };
        tools.setWebSearch(webSearch);
        const capabilities = await tools.refresh(options.signal);
        assertCurrent();
        await runs.updateCapabilities(id, capabilities, undefined, { runId: options.session.runId!, signal: options.signal });
        assertCurrent();
        const workspacePrompt = core ? (await core.readWorkspacePrompt()).content : "";
        assertCurrent();
        const scope = options.session.taskId ? core?.listTasks().find(t => t.id === options.session.taskId)?.scope : undefined;
        const inventory = { tools: capabilities.tools.map(t => t.name), skills: capabilities.skills.map(s => ({ id: s.id, name: s.name })), mcp: capabilities.mcp.map(m => ({ name: m.name, status: m.status })), plugins: capabilities.plugins.map(p => p.name) };
        const suggestionKey = `${projectPath}\0${id}`;
        const hasAssistantHistory = options.previousMessages.some(message => message.role === "assistant") || options.session.items.some(item => item.kind === "message" && item.role === "assistant");
        const projectContext = projectPath ? await readProjectContext(projectPath, !hasAssistantHistory && !this.gitInitSuggestions.has(suggestionKey)) : undefined;
        assertCurrent();
        if (projectContext?.suggestGitInit && projectContext.overview.git.state === "not-repository") this.gitInitSuggestions.add(suggestionKey);
        const globalInstructions = await this.instructions();
        assertCurrent();
        const instructions = systemPrompt(globalInstructions, workspacePrompt, scope, projectContext) + `\n\nApproval permission mode: ${mode}. Project-relative files remain in the workspace; Read/Write/Edit also accept absolute file paths subject to this mode. Tool approval requests are handled by the application. A rejected action must not be retried through another tool or a child agent; continue with an allowed alternative or explain the blocked work. Full access remains subject to operating system permissions.\n\nAvailable capabilities: ${JSON.stringify(inventory).slice(0, 20000)}`;
        const delegate = (parentTools: WorkspaceTools, depth: number) => parentTools.setDelegate(async (childPrompt, signal, progress) => {
          assertCurrent(); signal?.throwIfAborted();
          if (depth >= 8) throw new ProjectError("MODEL_ERROR", "子智能体嵌套过深，请拆分任务");
          const childId = `${id}:agent:${crypto.randomUUID()}`; const child = new WorkspaceTools(tools.files.store.root, childId, { ...(this.offlineDocuments ? { offlineDocuments: this.offlineDocuments } : {}), globalMcpConfigPath: path.join(this.userData, "mcp.json") });
          child.setPermissions(mode, options.onApproval); child.setWebSearch(webSearch); delegate(child, depth + 1);
          try {
            await child.capabilities(signal);
            assertCurrent(); signal?.throwIfAborted();
            const onEvent = async (event: AgentEvent) => {
              if (event.type === "tool-start") await progress?.(`子智能体调用 ${event.name}`);
              if (event.type === "summary") return;
              if (event.type === "request") { await progress?.("子智能体正在思考"); return; }
              if (event.type === "text" || event.type === "thinking") await options.onEvent?.({ ...event, messageId: `${childId}:${event.messageId}` });
              else if (event.type === "activity") await progress?.(`子智能体：${event.content}`);
              else if (event.type === "response-reset") await options.onEvent?.({ ...event, messageIds: event.messageIds.map((messageId) => `${childId}:${messageId}`), toolEventIds: event.toolEventIds.map((toolEventId) => `${childId}:${toolEventId}`) });
              else { const next = { ...event, toolCallId: `${childId}:${event.toolCallId}`, ...(event.toolEventId ? { toolEventId: `${childId}:${event.toolEventId}` } : {}) }; delete next.streamIndex; await options.onEvent?.(next); }
            };
            const runtime = new AgentRuntime({ catalog: child.catalog, resolveCredential: this.resolveCredential, onEvent, ...(this.diagnostics ? { onDiagnostic: event => this.diagnostics!.record(event) } : {}), ...(options.onQuestion ? { onQuestion: options.onQuestion } : {}), executeTool: async (call) => {
              const payload = { projectPath, sessionId: id, childTaskId: childId, event: "tool.before", toolName: call.name, input: JSON.stringify(call.input).slice(0, 4000) };
              await hook("tool.before", payload);
              try {
                const result = await child.execute(call.name, call.input, call.signal, call.onProgress, call.redactText);
                await hook("tool.after", { ...payload, event: "tool.after", result: JSON.stringify(result).slice(0, 4000) });
                return result;
              } catch (error) {
                if (!options.signal.aborted) await hook("tool.after", { ...payload, event: "tool.after", error: error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000) });
                throw error;
              }
            } });
            const result = await runtime.run({ taskId: childId, sessionId: id, ...(options.session.runId ? { runId: options.session.runId } : {}), profile: model, prompt: childPrompt, systemPrompt: `${webSearchGuidance(webSearch.mode)}\n\n${instructions}`.slice(0, 65536), ...(signal ? { signal } : {}) });
            return { summary: result.summary, toolCalls: result.toolCalls, rounds: result.rounds };
          } finally { await child.close(); }
        });
        assertCurrent();
        delegate(tools, 0);
        const runtime = new AgentRuntime({ ...options, ...(this.diagnostics ? { onDiagnostic: event => this.diagnostics!.record(event) } : {}), catalog: tools.catalog, resolveCredential: this.resolveCredential, executeTool: async (call) => {
          const payload = { projectPath, sessionId: id, event: "tool.before", toolName: call.name, input: JSON.stringify(call.input).slice(0, 4000) };
          await hook("tool.before", payload);
          try {
            const result = await tools.execute(call.name, call.input, call.signal, call.onProgress, call.redactText);
            await hook("tool.after", { ...payload, event: "tool.after", result: JSON.stringify(result).slice(0, 4000) });
            return result;
          } catch (error) {
            if (!options.signal.aborted) await hook("tool.after", { ...payload, event: "tool.after", error: error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000) });
            throw error;
          }
        } });
        return await runtime.run({ taskId: options.session.id, sessionId: options.session.id, ...(options.session.runId ? { runId: options.session.runId } : {}), profile: model, prompt, previousMessages: options.previousMessages, ...(options.contextSummary !== undefined ? { contextSummary: options.contextSummary } : {}), ...(options.session.contextCalibration ? { contextCalibration: options.session.contextCalibration } : {}), systemPrompt: `${webSearchGuidance(webSearch.mode)}\n\n${instructions}`.slice(0, 65536), signal: options.signal, ...(options.images?.length ? { images: options.images.map(({ mimeType, base64 }) => ({ mimeType, base64 })) } : {}) });
        } finally {
          try { if (!options.signal.aborted) await hook("session.after", { projectPath, sessionId: id }); }
          finally {
            // A cancelled executor may unwind after the user has already started another run.
            // Its cleanup must never remove the newer run's approval callback or permissions.
            if (runs.store.list().some(session => session.id === id && session.runId === options.session.runId)) runTools?.setPermissions(mode);
          }
        }
      }, draftRevision, images);
    } finally { release(); }
  }
  async cancel(projectPath: string, id: string) { (await this.workspace(projectPath)).cancel(id); await (await this.toolboxes.get(`${projectPath}\0${id}`))?.cancelProcesses(); }
  async guide(projectPath: string, id: string, runId: string, guidanceId: string, prompt: string, images?: ChatImageAttachment[]) { return (await this.workspace(projectPath)).guide(id, runId, guidanceId, prompt, images); }
  async answer(projectPath: string, id: string, runId: string, questionId: string, answers: QuestionAnswer) { return (await this.workspace(projectPath)).answer(id, runId, questionId, answers); }
  async approve(projectPath: string, id: string, runId: string, approvalId: string, approved: boolean) { return (await this.workspace(projectPath)).approve(id, runId, approvalId, approved); }
  async cancelAll(): Promise<void> {
    const inventories = [...this.inventories.values()]; for (const job of inventories) job.controller.abort(); this.inventories.clear();
    const cancelling = [...this.workspaces.values()].map(workspace => workspace.then(runs => runs.cancelAll()));
    const closing = [...this.toolboxes.values()].map(tools => tools.then(t => t.close())); this.toolboxes.clear();
    await Promise.allSettled([...inventories.map(job => job.pending), ...cancelling, ...closing, ...this.reservations.values()]);
  }
  shutdown(): Promise<void> {
    this.shuttingDown = true;
    return this.cancelAll();
  }
}
