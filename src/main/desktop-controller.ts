import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModelProfile, ModelReference, ProviderInput, SessionModelPreference, TaskScopeSpec, VersionToken } from "../shared/contracts";
import type { Preferences } from "../shared/preferences";
import type { ConversationMessage, McpConnection, WorkspaceState } from "../shared/desktop-api";
import { ProjectCore } from "./core/project-core";
import { ProjectError } from "./core/errors";
import { ModelVault } from "./core/model-vault";
import { PreferencesStore } from "./core/preferences";
import { ProjectLayout } from "./core/project-layout";
import { RecentProjects } from "./core/recent-projects";
import { ProviderVault } from "./core/provider-vault";
import { resolveModelSettings, temperatureFromPreference } from "./core/model-settings";
import type { AgentMessage } from "./core/agent-runtime";
import { chatMessage } from "./core/agent-chat";
import { DesktopSessions } from "./desktop-sessions";
import { FileStore } from "./core/file-store";
import { spawn } from "node:child_process";
import { OfflineDocumentStore } from "./core/offline-documents";
import type { OfflineDocumentImportOptions } from "../shared/offline-documents";
import { HooksStore } from "./core/hooks";
import type { HookDefinitionInput } from "../shared/hooks";
import { SkillStore } from "./core/skill-store";
import type { SkillImportOptions } from "../shared/skill-management";
import { McpConfigStore } from "./core/mcp-config-store";
import type { McpConfigScope, McpServerConfig } from "../shared/mcp-config";
import { DiagnosticsLogStore } from "./core/diagnostics-log";
import type { DiagnosticQuery } from "../shared/diagnostics";
import { GodotProjectPluginManager } from "./core/plugins/godot-project-plugins";
import { godotMcpHostRegistry } from "./core/godot-mcp/host-registry";
import { readProjectOverview } from "./core/project-overview";
import { readProjectText } from "./core/project-files";
import { ProjectMediaRegistry } from "./project-media-registry";
import { ChatAttachmentService } from "./core/chat-attachments";
import type { ChatAttachmentInput } from "../shared/chat-attachments";
import type { WorkflowUpdate } from "../shared/workflow-api";
import type { OrchestrationUpdate } from "../shared/orchestration-api";
import { createWorkflowToolRuntime } from "./core/workflow-tool-runtime";
import { WorkflowService } from "./core/workflow-service";
import type { WorkflowTriggerChatInput, WorkflowTriggerResult } from "./core/workflow-trigger";

function launchExecutable(executable: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { detached: true, stdio: "ignore", windowsHide: false });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

export interface DesktopSharedServices {
  preferences: PreferencesStore;
  recentProjects: RecentProjects;
  offlineDocuments: OfflineDocumentStore;
  hooks: HooksStore;
  skills: SkillStore;
  godotMcpResourceRoot?: string;
  chatAttachmentWorkerPath?: string;
}

export class DesktopController {
  private readonly media = new ProjectMediaRegistry();
  private readonly attachments: ChatAttachmentService;
  private readonly pendingAttachments = new Map<string, { owner: symbol; sessionKey: string; requestId: string; sessionId: string; cancelled: boolean }>();
  private readonly attachmentOwnerEpochs = new Map<symbol, number>();
  readonly sessions: DesktopSessions;
  readonly diagnosticsLog: DiagnosticsLogStore;
  private core?: ProjectCore;
  private workflow?: { core: ProjectCore; service: WorkflowService };
  private readonly workflowUpdateListeners = new Set<(event: WorkflowUpdate) => void>();
  private readonly orchestrationUpdateListeners = new Set<(event: OrchestrationUpdate) => void>();
  private readonly runs = new Map<string, AbortController>();
  private readonly chatRuns = new Map<string, AbortController>();
  private readonly runCompletions = new Set<Promise<void>>();
  private readonly recentProjects: RecentProjects;
  private readonly preferences: PreferencesStore;
  private opening = false;
  private materialWrites = 0;
  mcp: McpConnection | undefined;

  readonly providers: ProviderVault;
  readonly offlineDocuments: OfflineDocumentStore;
  readonly hooks: HooksStore;
  readonly skills: SkillStore;
  private readonly godotMcpResourceRoot: string | undefined;
  readonly mcpConfig: McpConfigStore;
  constructor(readonly vault: ModelVault, private readonly userData: string, private readonly skillsDirectory: string, providers?: ProviderVault, shared?: Partial<DesktopSharedServices>) {
    this.attachments = new ChatAttachmentService({ workerPath: shared?.chatAttachmentWorkerPath });
    this.diagnosticsLog = new DiagnosticsLogStore(userData);
    void this.diagnosticsLog.clearExpired().catch(() => undefined);
    this.providers = providers ?? new ProviderVault(userData, { isAvailable: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => "" });
    this.offlineDocuments = shared?.offlineDocuments ?? new OfflineDocumentStore(userData);
    this.hooks = shared?.hooks ?? new HooksStore(userData);
    this.skills = shared?.skills ?? new SkillStore(userData);
    this.godotMcpResourceRoot = shared?.godotMcpResourceRoot;
    this.mcpConfig = new McpConfigStore(userData, () => this.core?.metadata.path);
    this.recentProjects = shared?.recentProjects ?? new RecentProjects(userData);
    this.preferences = shared?.preferences ?? new PreferencesStore(userData);
    this.sessions = new DesktopSessions(userData, () => this.opening ? undefined : this.core, async (preference) => {
      const settings = await this.preferences.get();
      const selectedPreference = preference ?? settings.sessionModel;
      const reference = selectedPreference ?? settings.defaultModel;
      if (!reference) throw new ProjectError("MODEL_ERROR", "先配置并选择一个模型");
      const profile = await this.providerRuntimeProfile(reference);
      return selectedPreference?.reasoning && selectedPreference.reasoning !== "inherit" ? { ...profile, reasoning: selectedPreference.reasoning } : profile;
    }, async () => (await this.preferences.get()).customInstructions,
    (profile) => profile.providerId ? this.providers.resolveCredential({ providerId: profile.providerId, model: profile.model }) : this.vault.resolveCredential(profile),
    async (event, payload, permissions) => {
      const hooks = await this.hooks.list();
      await Promise.allSettled(hooks.filter((hook) => hook.enabled && hook.event === event).map((hook) => this.hooks.run(hook.id, { ...payload, event }, permissions)));
    }, this.offlineDocuments, this.diagnosticsLog, (core) => createWorkflowToolRuntime({ service: this.workflowServiceFor(core) }));
  }

  get busy(): boolean { return !!(this.runs.size || this.chatRuns.size || this.sessions.running || this.opening || this.materialWrites); }

  currentCore(): ProjectCore {
    if (this.opening) throw new ProjectError("MODEL_ERROR", "项目正在切换，请等待打开完成");
    if (!this.core) throw new ProjectError("INVALID_PROJECT", "先打开一个项目工作区");
    return this.core;
  }

  /**
   * The one workflow service for a project core.
   *
   * The IPC surface and the agent workflow tools share it on purpose: a second
   * service would own a second runner, so a run started by an agent could be
   * reported (or approved) at stale state by the renderer's runner and vice
   * versa. A reopened project builds a new ProjectCore, so the cache is keyed by
   * identity instead of by path.
   */
  workflowServiceFor(core: ProjectCore): WorkflowService {
    if (this.workflow?.core === core) return this.workflow.service;
    const root = core.metadata.path;
    const service = new WorkflowService({
      core,
      resolveProfile: (modelId: string) => this.resolveWorkflowProfile(modelId),
      onUpdate: (run) => this.publishWorkflowUpdate({ projectPath: root, run }),
      onOrchestrationUpdate: (run) => this.publishOrchestrationUpdate({ projectPath: root, run }),
    });
    this.workflow = { core, service };
    return service;
  }
  workflowService(): WorkflowService { return this.workflowServiceFor(this.currentCore()); }
  /** Observe durable workflow transitions; the IPC bridge forwards them to its window. */
  subscribeWorkflowUpdates(listener: (event: WorkflowUpdate) => void): () => void {
    this.workflowUpdateListeners.add(listener);
    return () => { this.workflowUpdateListeners.delete(listener); };
  }
  subscribeOrchestrationUpdates(listener: (event: OrchestrationUpdate) => void): () => void {
    this.orchestrationUpdateListeners.add(listener);
    return () => { this.orchestrationUpdateListeners.delete(listener); };
  }
  private publishWorkflowUpdate(event: WorkflowUpdate): void {
    for (const listener of [...this.workflowUpdateListeners]) {
      try { listener(event); } catch { /* A throwing observer cannot change a transition that is already durable. */ }
    }
  }
  private publishOrchestrationUpdate(event: OrchestrationUpdate): void {
    for (const listener of [...this.orchestrationUpdateListeners]) {
      try { listener(event); } catch { /* A throwing observer cannot change a transition that is already durable. */ }
    }
  }
  async state(): Promise<WorkspaceState> {
    const preferences = await this.preferences.get();
    const { defaultModel, sessionModel } = preferences;
    const providers = await this.providers.list();
    const base: WorkspaceState = { tasks: this.core?.listTasks() ?? [], models: await this.vault.list(), providers, recent: await this.recentProjects.list(), preferences };
    return { ...base, ...(defaultModel ? { defaultModel } : {}), ...(sessionModel ? { sessionModel } : {}), ...(this.core ? { project: this.core.metadata, recoveryIssues: structuredClone(this.core.recoveryIssues) } : {}), ...(this.mcp ? { mcp: this.mcp } : {}) };
  }
  openProject(root: string): Promise<WorkspaceState> { return this.transition(async () => root); }
  /** Drops a remembered project from the home list without touching the project itself. */
  forgetProject(root: string): Promise<WorkspaceState> { return this.recentProjects.forget(root).then(() => this.state()); }
  async updatePreferences(patch: Partial<Preferences>): Promise<WorkspaceState> {
    await this.preferences.update(patch);
    return this.state();
  }
  async openGodot(): Promise<void> {
    const project = this.currentCore().metadata.path;
    const executable = (await this.preferences.get()).godotPath.trim();
    if (!executable) throw new ProjectError("INVALID_PROJECT", "请先在设置中配置 Godot 可执行文件路径");
    await launchExecutable(executable, ["--editor", "--path", project]);
  }
  async openExternalEditor(): Promise<void> {
    const project = this.currentCore().metadata.path;
    const executable = (await this.preferences.get()).externalEditorPath.trim();
    if (!executable) throw new ProjectError("INVALID_PROJECT", "请先在设置中配置外部编辑器路径");
    await launchExecutable(executable, [project]);
  }
  async removeTask(taskId: string): Promise<WorkspaceState> {
    await this.currentCore().removeTask(taskId);
    return this.state();
  }
  private async transition(prepare: () => Promise<string>): Promise<WorkspaceState> {
    if (this.busy) throw new ProjectError("MODEL_ERROR", "先等待当前操作结束，再切换项目");
    this.opening = true;
    try {
      const root = await prepare();
      // Read the preferences before opening so the very first agent run sees them.
      await this.preferences.get();
      await this.skills.syncToProject(root);
      const previous = this.core;
      const next = await ProjectCore.open(root, { bundledSkillsDirectory: this.skillsDirectory, resolveCredential: (profile) => profile.providerId ? this.providers.resolveCredential({ providerId: profile.providerId, model: profile.model }) : this.vault.resolveCredential(profile), customInstructions: () => this.preferences.snapshot.customInstructions, diagnostics: this.diagnosticsLog, godotMcpHosts: godotMcpHostRegistry });
      this.core = next;
      await previous?.close();
      const { path: opened, name } = this.core.metadata;
      // The recent list is a convenience only; never let it break opening a project.
      await this.recentProjects.remember({ path: opened, name }).catch(() => undefined);
      return await this.state();
    } finally { this.opening = false; }
  }
  async createExample(): Promise<WorkspaceState> {
    return this.transition(async () => {
    const root = path.join(this.userData, "examples", `lantern-${randomUUID().slice(0, 8)}`);
    await mkdir(path.join(root, "scenes"), { recursive: true });
    await mkdir(path.join(root, "scripts"), { recursive: true });
    await writeFile(path.join(root, "project.godot"), 'config_version=5\n\n[application]\nconfig/name="灯塔守望"\nconfig/description="探索海岛与修复灯塔的 2D 游戏"\nrun/main_scene="res://scenes/main.tscn"\nconfig/features=PackedStringArray("4.4", "GL Compatibility")\n\n[display]\nwindow/size/viewport_width=960\nwindow/size/viewport_height=540\n\n[rendering]\nrenderer/rendering_method="gl_compatibility"\nenvironment/defaults/default_clear_color=Color(0.08, 0.12, 0.13, 1)\n');
    await writeFile(path.join(root, "scenes/main.tscn"), '[gd_scene format=3]\n\n[node name="Island" type="Node2D"]\n\n[node name="Ground" type="Polygon2D" parent="."]\npolygon = PackedVector2Array(120, 420, 840, 420, 840, 540, 120, 540)\ncolor = Color(0.28, 0.53, 0.42, 1)\n\n[node name="Lighthouse" type="Polygon2D" parent="."]\npolygon = PackedVector2Array(670, 420, 690, 200, 745, 200, 765, 420)\ncolor = Color(0.85, 0.88, 0.82, 1)\n');
    await new ProjectLayout({ bundledSkillsDirectory: this.skillsDirectory }).initialize(root);
    await writeFile(path.join(root, "specs/project.md"), '---\nschemaVersion: 1\nid: project\ntitle: 灯塔守望\ndescription: 探索海岛与修复灯塔的 2D 游戏\nconstraints:\n  maxScriptLines: 250\n  maxSceneNodes: 80\n---\n\n# 灯塔守望\n\n## 开发约束\n\n- Godot 4.4，2D，GDScript。\n- 场景按实体组织，节点使用 PascalCase，脚本使用 snake_case。\n- 每个脚本只承担一个职责，跨实体通信使用信号。\n- MVP 只包含移动、探索和灯塔交互。\n');
    await writeFile(path.join(root, "specs/outline.md"), '---\nschemaVersion: 1\nid: outline\ntitle: 游戏大纲\ndescription: 灯塔守望首版里程碑\n---\n\n# 游戏大纲\n\n## 第一阶段：可玩原型\n\n玩家在海岛移动，靠近灯塔后触发修复交互。\n\n## 第二阶段：探索循环\n\n收集零件，修复灯塔，开启新区域。\n');
    await writeFile(path.join(root, "specs/entities/characters/keeper.md"), '---\nid: keeper\ntype: character\nstatus: draft\nversion: 1\nrelations: []\nsource: developer\n---\n\n# 守灯人\n\n## 职责\n\n玩家控制角色，只负责移动和交互请求。\n\n## 行为\n\n- 使用 CharacterBody2D。\n- 水平移动速度 180，禁止增加战斗系统。\n- 使用信号通知交互，不能直接操作地图状态。\n\n## 生成边界\n\n- scenes/keeper.tscn\n- scripts/keeper.gd\n');
    return root;
    });
  }
  async createTask(scope: Omit<TaskScopeSpec, "id">) { return this.currentCore().createTask({ ...scope, id: randomUUID() }); }
  /**
   * Start the project default workflow for a task's first implementation
   * message. The service records a durable binding, so the task starts once;
   * Task 11 wires this to the task page without changing this contract.
   */
  startTaskWorkflow(taskId: string, message?: string): Promise<WorkflowTriggerResult> {
    return this.workflowService().startForTask(taskId, message);
  }
  /** Start a chat implementation run; an explicit workflow overrides the default. */
  startChatWorkflow(input: WorkflowTriggerChatInput): Promise<WorkflowTriggerResult> {
    return this.workflowService().startForChat(input);
  }
  async agent(taskId: string, modelId: string | ModelReference, prompt: string) {
    const core = this.currentCore();
    if (this.runs.has(taskId)) throw new ProjectError("MODEL_ERROR", "该任务已有运行中的智能体");
    const controller = new AbortController();
    this.runs.set(taskId, controller);
    const finished = this.trackRun();
    try {
      const base = typeof modelId === "string" ? await this.vault.get(modelId) : await this.providerRuntimeProfile(modelId);
      if (!base) throw new ProjectError("MODEL_ERROR", "先配置并选择一个模型");
      const profile = await this.applyAgentTemperature(base);
      const selectedReference = typeof modelId === "string" ? undefined : modelId;
      const sessionPreference = (await this.preferences.get()).sessionModel;
      const sessionReasoning = selectedReference && sessionPreference
        && sessionPreference.providerId === selectedReference.providerId
        && sessionPreference.model === selectedReference.model
        && sessionPreference.reasoning !== "inherit"
        ? sessionPreference.reasoning
        : undefined;
      const selectedProfile = sessionReasoning === undefined ? profile : { ...profile, reasoning: sessionReasoning };
      const result = await core.agentMessage(taskId, selectedProfile, prompt, controller.signal);
      return { summary: result.summary, toolCalls: result.toolCalls };
    } finally { this.runs.delete(taskId); finished(); }
  }
  async chat(modelId: string | ModelReference, prompt: string, previousMessages: ConversationMessage[] = []) {
    if (this.opening) throw new ProjectError("MODEL_ERROR", "项目正在切换，请等待打开完成");
    const core = this.core;
    const runId = "chat";
    if (this.chatRuns.has(runId)) throw new ProjectError("MODEL_ERROR", "已有对话正在运行");
    const controller = new AbortController();
    this.chatRuns.set(runId, controller);
    const finished = this.trackRun();
    try {
      // Standalone callers may start chat before state() has loaded the preferences.
      const instructions = (await this.preferences.get()).customInstructions;
      const base = typeof modelId === "string" ? await this.vault.get(modelId) : await this.providerRuntimeProfile(modelId);
      if (!base) throw new ProjectError("MODEL_ERROR", "先配置并选择一个模型");
      const profile = await this.applyAgentTemperature(base);
      const selectedReference = typeof modelId === "string" ? undefined : modelId;
      const sessionPreference = (await this.preferences.get()).sessionModel;
      const sessionReasoning = selectedReference && sessionPreference
        && sessionPreference.providerId === selectedReference.providerId
        && sessionPreference.model === selectedReference.model
        && sessionPreference.reasoning !== "inherit"
        ? sessionPreference.reasoning
        : undefined;
      const selectedProfile = sessionReasoning === undefined ? profile : { ...profile, reasoning: sessionReasoning };
      const standalone = new FileStore(this.userData);
      const chatRoot = core ? core.metadata.path : await standalone.policy.resolve("conversations", true);
      if (!core) await standalone.policy.ensureParent(path.join(chatRoot, ".entry"));
      const result = core
        ? await core.chatMessage(selectedProfile, prompt, previousMessages as AgentMessage[], controller.signal)
        : await chatMessage({ workspaceRoot: chatRoot, resolveCredential: (runtimeProfile) => runtimeProfile.providerId ? this.providers.resolveCredential({ providerId: runtimeProfile.providerId, model: runtimeProfile.model }) : this.vault.resolveCredential(runtimeProfile), onDiagnostic: event => this.diagnosticsLog.record(event) }, selectedProfile, prompt, instructions, "", previousMessages as AgentMessage[], controller.signal);
      return { summary: result.summary, toolCalls: result.toolCalls };
    } finally { this.chatRuns.delete(runId); finished(); }
  }
  /**
   * Resolve the model a workflow run should use.
   *
   * An explicit run input wins; an empty id falls back to the workspace default
   * model reference. Either way the agent temperature preference is applied, so
   * workflow agents behave like the chat and task agents.
   */
  async resolveWorkflowProfile(modelId: string): Promise<ModelProfile> {
    if (typeof modelId === "string" && modelId.length > 0) {
      const base = await this.vault.get(modelId);
      if (!base) throw new ProjectError("MODEL_ERROR", "找不到模型配置：" + JSON.stringify(modelId));
      return await this.applyAgentTemperature(base);
    }
    const reference = (await this.preferences.get()).defaultModel;
    if (!reference) throw new ProjectError("MODEL_ERROR", "先配置并选择一个模型");
    return await this.applyAgentTemperature(await this.providerRuntimeProfile(reference));
  }
  private async providerRuntimeProfile(reference: ModelReference) {
    const provider = await this.providers.get(reference.providerId);
    if (!provider || !provider.models.includes(reference.model)) throw new ProjectError("MODEL_ERROR", "先配置并选择一个有效的供应商模型");
    const effective = resolveModelSettings(reference.model, provider.modelSettings[reference.model]);
    // StoryFabric baseline: agent temperature comes from the 0..100 stability preference, independent of per-model settings.
    const temperature = temperatureFromPreference((await this.preferences.get()).agentTemperature);
    return {
      id: `${provider.id}:${reference.model}`, name: `${provider.name} / ${reference.model}`, provider: "openai-compatible" as const,
      protocol: provider.protocol, providerId: provider.id, model: reference.model, baseUrl: provider.baseUrl,
      approved: true, timeoutMs: 600_000, maxOutputTokens: effective.maxOutputTokens,
      contextTokens: effective.contextTokens,
      reasoningSupport: effective.reasoningSupport, vision: effective.vision, reasoning: effective.reasoning,
      reasoningMap: effective.reasoningMap,
      temperature,
    };
  }
  /** Applies the agent stability preference to profiles that do not carry an explicit temperature. */
  private async applyAgentTemperature<T extends { temperature?: number | undefined }>(profile: T): Promise<T> {
    if (profile.temperature !== undefined) return profile;
    const temperature = temperatureFromPreference((await this.preferences.get()).agentTemperature);
    return { ...profile, temperature };
  }
  cancel(taskId: string): void { this.runs.get(taskId)?.abort(); }
  cancelChat(): void { this.chatRuns.get("chat")?.abort(); }
  private trackRun(): () => void {
    let resolve!: () => void;
    const completion = new Promise<void>((done) => { resolve = done; });
    this.runCompletions.add(completion);
    return () => { this.runCompletions.delete(completion); resolve(); };
  }
  async cancelAll(): Promise<void> {
    for (const run of this.runs.values()) run.abort();
    for (const run of this.chatRuns.values()) run.abort();
    await Promise.all([this.sessions.cancelAll(), ...this.runCompletions]);
  }
  async shutdown(): Promise<void> {
    this.attachments.close();
    await this.media.close();
    await Promise.all([this.sessions.shutdown(), this.cancelAll()]);
    await this.core?.close();
    await this.diagnosticsLog.flush();
  }
  diagnosticsList(query: DiagnosticQuery) { return this.diagnosticsLog.list(query); }
  diagnosticsSummary() { return this.diagnosticsLog.summary(); }
  diagnosticsClearExpired() { return this.diagnosticsLog.clearExpired(); }
  diagnosticsClearAll() { return this.diagnosticsLog.clearAll(); }
  diagnosticsExport(destination: string) { return this.diagnosticsLog.exportTo(destination); }
  async listProjectPlugins() { return this.godotPluginManager().list(); }
  async setProjectPluginEnabled(id: string, enabled: boolean) { return this.godotPluginManager().setEnabled(id, enabled); }
  async setGodotMcpEnabled(enabled: boolean) { return this.godotPluginManager().setGodotMcpEnabled(enabled); }
  async installGodotMcp() { return this.godotPluginManager().installGodotMcp(); }
  async resolvePluginRevealTarget(target: string) { return this.godotPluginManager().resolveRevealTarget(target); }
  private godotPluginManager(): GodotProjectPluginManager {
    const core = this.currentCore();
    if (core.metadata.engine !== "godot") throw new ProjectError("INVALID_PROJECT", "插件管理仅适用于 Godot 项目");
    return new GodotProjectPluginManager(core.metadata.path, this.godotMcpResourceRoot, () => godotMcpHostRegistry.status(core.metadata.path));
  }
  saveModel(profile: ModelProfile, secret?: string) { return this.vault.save(profile, secret); }
  saveProvider(input: ProviderInput, secret?: string) { return this.providers.save(input, secret); }
  async removeProvider(id: string) {
    const next = await this.providers.remove(id);
    const { defaultModel, sessionModel } = await this.preferences.get();
    if (defaultModel?.providerId === id || sessionModel?.providerId === id) {
      await this.preferences.update({
        ...(defaultModel?.providerId === id ? { defaultModel: undefined } : {}),
        ...(sessionModel?.providerId === id ? { sessionModel: undefined } : {}),
      } as unknown as Partial<Preferences>);
    }
    return next;
  }
  addProviderModels(id: string, models: string[]) { return this.providers.addModels(id, models); }
  removeProviderModel(id: string, model: string) { return this.providers.removeModel(id, model); }
  async discoverProviderModels(id: string) { const discovered = await this.providers.discover(id); const provider = await this.providers.get(id); if (!provider) throw new ProjectError("MODEL_ERROR", "Provider not found."); const existing = new Set(provider.models); const added = discovered.filter((model) => !existing.has(model)); return { list: await this.providers.list(), added, message: `发现 ${discovered.length} 个模型` }; }
  async setDefaultModel(reference: ModelReference | null) {
    await this.preferences.update({ defaultModel: reference ?? undefined } as Partial<Preferences>);
    return this.state();
  }
  async setSessionModel(preference: SessionModelPreference | null) {
    await this.preferences.update({ sessionModel: preference ?? undefined } as Partial<Preferences>);
    return this.state();
  }
  readDocument(path: string, version: VersionToken) { return this.currentCore().readDocument(path, version); }
  async readProjectOverview(projectPath: string) {
    const core = this.projectCoreForPath(projectPath);
    return readProjectOverview(core.metadata.path);
  }
  readProjectText(projectPath: string, relative: string) { return readProjectText(this.projectCoreForPath(projectPath).store, relative); }
  openProjectMedia(owner: symbol, projectPath: string, relative: string) { return this.media.open(owner, this.projectCoreForPath(projectPath).store, relative); }
  releaseProjectMedia(owner: symbol, id: string) { this.media.release(owner, id); }
  revokeWindowResources(owner: symbol) {
    this.attachmentOwnerEpochs.set(owner, (this.attachmentOwnerEpochs.get(owner) ?? 0) + 1);
    for (const request of this.pendingAttachments.values()) if (request.owner === owner) request.cancelled = true;
    this.media.revokeOwner(owner); this.attachments.revokeOwner(owner);
  }
  validateClipboardProject(projectPath: string) { this.projectCoreForPath(projectPath); }
  async prepareChatAttachment(owner: symbol, projectPath: string, sessionId: string, requestId: string, input: ChatAttachmentInput) {
    const core = this.projectCoreForPath(projectPath);
    const epoch = this.attachmentOwnerEpochs.get(owner) ?? 0;
    const sessionKey = JSON.stringify([core.metadata.path, sessionId]);
    const trackingKey = randomUUID();
    const request = { owner, sessionKey, requestId, sessionId, cancelled: false };
    // Register before the first asynchronous session lookup so close, archive
    // and explicit cancel cannot miss a parser that has not started yet.
    this.pendingAttachments.set(trackingKey, request);
    const assertCurrent = () => {
      if (request.cancelled || epoch !== (this.attachmentOwnerEpochs.get(owner) ?? 0)) throw new ProjectError("TASK_SCOPE_DENIED", "附件解析已取消或所属窗口已失效");
      if (this.projectCoreForPath(projectPath) !== core) throw new ProjectError("TASK_SCOPE_DENIED", "附件目标项目已失效");
    };
    try {
      const session = (await this.sessions.list(projectPath)).find(item => item.id === sessionId);
      assertCurrent();
      if (!session || session.archived) throw new ProjectError("TASK_SCOPE_DENIED", "附件目标会话不存在或已归档");
      const value = await this.attachments.prepare(owner, sessionKey, requestId, input);
      assertCurrent();
      const validSession = (await this.sessions.list(projectPath)).some(item => item.id === sessionId && !item.archived);
      assertCurrent();
      if (!validSession) throw new ProjectError("TASK_SCOPE_DENIED", "附件目标会话已失效");
      return value;
    } finally { this.pendingAttachments.delete(trackingKey); }
  }
  cancelSessionAttachments(sessionId: string) {
    for (const request of this.pendingAttachments.values()) if (request.sessionId === sessionId) { request.cancelled = true; this.attachments.cancel(request.owner, request.sessionKey, request.requestId); }
  }
  cancelChatAttachment(owner: symbol, projectPath: string, sessionId: string, requestId: string) {
    const core = this.projectCoreForPath(projectPath);
    const sessionKey = JSON.stringify([core.metadata.path, sessionId]);
    for (const request of this.pendingAttachments.values()) if (request.owner === owner && request.sessionKey === sessionKey && request.requestId === requestId) request.cancelled = true;
    this.attachments.cancel(owner, sessionKey, requestId);
  }
  saveDocument(projectPath: string, path: string, content: string, version: VersionToken) { return this.withMaterialWrite(projectPath, (core) => core.saveDocument(path, content, version)); }
  importMaterialImage(projectPath: string, dataUrl: string) { return this.withMaterialWrite(projectPath, (core) => core.importMaterialImage(dataUrl)); }
  readMaterialImage(projectPath: string, path: string) { return this.projectCoreForPath(projectPath).readMaterialImage(path); }
  private async withMaterialWrite<T>(projectPath: string, operation: (core: ProjectCore) => Promise<T>): Promise<T> {
    const core = this.projectCoreForPath(projectPath);
    this.materialWrites++;
    try { return await operation(core); } finally { this.materialWrites--; }
  }
  private projectCoreForPath(projectPath: string): ProjectCore {
    const core = this.currentCore();
    if (projectPath !== core.metadata.path) throw new ProjectError("INVALID_PROJECT", "当前项目已切换，请重新加载资料");
    return core;
  }
  async readWorkspacePrompt(projectPath: string) { return this.projectCoreForPath(projectPath).readWorkspacePrompt(); }
  async saveWorkspacePrompt(projectPath: string, content: string, expectedVersion: VersionToken) { return this.projectCoreForPath(projectPath).saveWorkspacePrompt(content, expectedVersion); }
  offlineDocumentList() { return this.offlineDocuments.list(); }
  offlineDocumentImportFiles(paths: string[], name: string, version: string, enabled: boolean, options?: OfflineDocumentImportOptions) { return this.offlineDocuments.importFiles(paths, name, version, enabled, options); }
  offlineDocumentImportDirectory(directory: string, name: string, version: string, enabled: boolean, options?: OfflineDocumentImportOptions) { return this.offlineDocuments.importDirectory(directory, name, version, enabled, options); }
  offlineDocumentSetEnabled(id: string, enabled: boolean) { return this.offlineDocuments.setEnabled(id, enabled); }
  offlineDocumentSetVersion(id: string, versionId: string) { return this.offlineDocuments.setVersion(id, versionId); }
  offlineDocumentRead(id: string, versionId: string | undefined, filePath: string) { return this.offlineDocuments.read(id, versionId, filePath); }
  offlineDocumentRemove(id: string, versionId?: string) { return this.offlineDocuments.remove(id, versionId); }
  listHooks() { return this.hooks.list(); }
  saveHook(input: HookDefinitionInput) { return this.hooks.save(input); }
  removeHook(id: string) { return this.hooks.remove(id); }
  setHookEnabled(id: string, enabled: boolean) { return this.hooks.setEnabled(id, enabled); }
  testHook(id: string) { return this.hooks.test(id); }
  listSkills() { return this.skills.list(); }
  refreshSkills() { return this.skills.refresh(); }
  installSkill(directory: string, options?: SkillImportOptions) { return this.skills.importDirectory(directory, options); }
  installSkillArchive(archive: string, options?: SkillImportOptions) { return this.skills.installArchive(archive, options); }
  listProjectSkills(projectPath: string) { return this.skills.listProject(projectPath); }
  installProjectSkill(directory: string, projectPath: string, options?: SkillImportOptions) { return this.skills.installProjectDirectory(directory, projectPath, options); }
  setProjectSkillEnabled(id: string, enabled: boolean, projectPath: string) { return this.skills.setProjectEnabled(id, enabled, projectPath); }
  removeProjectSkill(id: string, projectPath: string) { return this.skills.removeProject(id, projectPath); }
  setSkillEnabled(id: string, enabled: boolean) { return this.skills.setEnabled(id, enabled); }
  removeSkill(id: string) { return this.skills.remove(id); }
  listMcpConfig(projectPath?: string) { return this.mcpConfig.list(projectPath); }
  saveMcpConfig(scope: McpConfigScope, projectPath: string | undefined, name: string, config: McpServerConfig) { return this.mcpConfig.save(scope, projectPath, name, config); }
  setMcpEnabled(scope: McpConfigScope, projectPath: string | undefined, name: string, enabled: boolean) { return this.mcpConfig.setEnabled(scope, projectPath, name, enabled); }
  removeMcpConfig(scope: McpConfigScope, projectPath: string | undefined, name: string) { return this.mcpConfig.remove(scope, projectPath, name); }
  testMcpConfig(config: McpServerConfig) { return this.mcpConfig.test(config); }
}
