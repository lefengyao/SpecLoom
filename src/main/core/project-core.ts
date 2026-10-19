import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { ChangeSetDataSchema, TaskScopeSpecSchema, ValidationResultSchema } from "../../shared/contracts";
import type { ChangeEntry, ChangeSetData, FileReadResult, FileVersion, ModelProfile, ProjectMetadata, TaskScopeSpec, ValidationResult, VersionToken } from "../../shared/contracts";
import type { ChangeReview, RecoveryIssue, TaskView } from "../../shared/desktop-api";
import { AgentConversationSchema, AgentRuntime, boundConversation, type AgentMessage, type AgentRunResult, type AgentRuntimeOptions } from "./agent-runtime";
import { chatMessage } from "./agent-chat";
import { systemPrompt } from "./agent-prompts";
import { readProjectContext } from "./project-context";
import { readWorkspacePrompt, saveWorkspacePrompt } from "./workspace-prompt";
import { StagedChangeSet } from "./change-set";
import { ProjectError, serializeError } from "./errors";
import { FileStore } from "./file-store";
import { ProjectDocuments } from "./project-documents";
import { ProjectLayout } from "./project-layout";
import { SkillRegistry } from "./skill-registry";
import { SnapshotRunner } from "./snapshot-runner";
import { digestBytes } from "./store-fs";
import { TaskScope } from "./task-scope";
import { toolCatalog } from "./tool-catalog";
import { Validator } from "./validator";
import type { JournalRecord } from "./change-journal";
import type { DiagnosticsLogStore } from "./diagnostics-log";
import { getGodotMcpToolDefinition } from "./godot-mcp/tool-definitions";
import { godotMcpHostRegistry, type GodotMcpHostRegistry } from "./godot-mcp/host-registry";

interface CoreTask {
  scope: TaskScope;
  changes: StagedChangeSet;
  receipts: Map<string, VersionToken>;
  before: Record<string, string>;
  internalDependencies: Record<string, VersionToken>;
  inventory?: string[];
  approval?: string;
  validation?: { digest: string; result: ValidationResult };
  pending: Promise<void>;
  running: boolean;
  summary: string;
  messages: AgentMessage[];
  events: TaskView["events"];
  historical?: ChangeSetData;
}
export interface ProjectCoreOptions {
  bundledSkillsDirectory?: string;
  installedSkillsDirectory?: string;
  resolveCredential?: AgentRuntimeOptions["resolveCredential"];
  fetch?: typeof fetch;
  snapshotRunner?: SnapshotRunner;
  validator?: Pick<Validator, "validateWithDependencies">;
  /** Operator instructions from the settings view, appended after the built-in prompt. */
  customInstructions?: () => string;
  diagnostics?: DiagnosticsLogStore;
  godotMcpHosts?: GodotMcpHostRegistry;
}

export class ProjectCore {
  readonly store: FileStore;
  readonly snapshot: SnapshotRunner;
  readonly recoveryIssues: RecoveryIssue[] = [];
  private readonly registries = new Map<string, SkillRegistry>();
  private readonly validator: Pick<Validator, "validateWithDependencies">;
  private readonly tasks = new Map<string, CoreTask>();
  private godotMcpLease = false;

  private constructor(readonly metadata: ProjectMetadata, private readonly options: ProjectCoreOptions) {
    this.store = new FileStore(metadata.path);
    this.snapshot = options.snapshotRunner ?? new SnapshotRunner(this.store);
    this.validator = options.validator ?? new Validator(this.store, this.snapshot);
  }

  static async open(root: string, options: ProjectCoreOptions = {}): Promise<ProjectCore> {
    const metadata = await new ProjectLayout({ ...(options.bundledSkillsDirectory === undefined ? {} : { bundledSkillsDirectory: options.bundledSkillsDirectory }), ...(options.installedSkillsDirectory === undefined ? {} : { installedSkillsDirectory: options.installedSkillsDirectory }) }).initialize(root);
    const core = new ProjectCore(metadata, options);
    core.recoveryIssues.push(...await core.snapshot.recoverAbandoned());
    await StagedChangeSet.recover(core.store);
    await core.restoreDrafts(await StagedChangeSet.inspectHistory(core.store));
    if (metadata.engine === "godot") {
      await (options.godotMcpHosts ?? godotMcpHostRegistry).acquire(metadata.path);
      core.godotMcpLease = true;
    }
    return core;
  }

  async close(): Promise<void> {
    if (!this.godotMcpLease) return;
    this.godotMcpLease = false;
    await (this.options.godotMcpHosts ?? godotMcpHostRegistry).release(this.metadata.path);
  }

  async createTask(spec: TaskScopeSpec): Promise<TaskView> {
    const active = [...this.tasks.values()].filter((task) => !task.historical && ["staged", "validated", "committing"].includes(task.changes.preview().status)).length;
    if (active >= 128 || this.tasks.has(spec.id)) throw new ProjectError("TASK_SCOPE_DENIED", "Task identity is already used or active task capacity was reached");
    const scope = new TaskScope(spec);
    const task: CoreTask = { scope, changes: new StagedChangeSet(this.store, { taskId: spec.id }), receipts: new Map(), before: {}, internalDependencies: {}, pending: Promise.resolve(), running: false, summary: "", messages: [], events: [] };
    this.tasks.set(spec.id, task);
    this.trimHistory();
    await this.persist(task);
    return this.taskView(task);
  }

  listTasks(): TaskView[] { return [...this.tasks.values()].map((task) => this.taskView(task)); }
  /** The persisted scope of one task, including its optional goal. */
  taskScope(taskId: string): TaskScopeSpec { return this.task(taskId).scope.describe(); }
  /** Removes one finished task and its persisted history record. */
  async removeTask(taskId: string): Promise<void> {
    const task = this.task(taskId);
    if (task.running) {
      throw new ProjectError("MODEL_ERROR", "运行中的任务或待处理任务需要保留");
    }
    await task.pending;
    const relative = `.specloom/history/tasks/${digestBytes(taskId).slice(7)}.json`;
    const current = await this.store.listInternalVersion(relative);
    if (current.exists) await this.store.removeInternal(relative, current.version);
    this.tasks.delete(taskId);
    this.registries.delete(taskId);
  }

  async documents(): Promise<FileVersion[]> { return (await this.store.listFiles("specs")).filter((file) => file.path.endsWith(".md")); }
  saveDocument(path: string, content: string, version: VersionToken) { return new ProjectDocuments(this.store).save(path, content, version); }
  importMaterialImage(dataUrl: string) { return new ProjectDocuments(this.store).importImage(dataUrl); }
  readMaterialImage(path: string) { return new ProjectDocuments(this.store).readImage(path); }
  async projectTree() { return this.store.listTree(); }
  readWorkspacePrompt() { return readWorkspacePrompt(this.store); }
  saveWorkspacePrompt(content: string, expectedVersion: VersionToken) { return saveWorkspacePrompt(this.store, content, expectedVersion); }
  async readDocument(path: string, expectedVersion: VersionToken): Promise<FileReadResult> {
    const normalized = this.store.normalizePath(path);
    if (!normalized.startsWith("specs/") && !normalized.startsWith(".specloom/skills/")) throw new ProjectError("TASK_SCOPE_DENIED", "Document inspection is limited to project specifications and Skills");
    return this.store.read(normalized, expectedVersion);
  }

  async executeTool(taskId: string, name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const definition = toolCatalog.getTool(name);
    const parsed = definition?.schema.safeParse(input);
    if (!definition || !parsed?.success) throw new ProjectError("VALIDATION_FAILED", "Unknown tool or invalid tool arguments");
    return this.withTask(taskId, async (task) => {
      try {
        if (task.historical || !["staged", "validated"].includes(task.changes.preview().status)) {
          if (name === "changes.preview") return this.review(task);
          if (name === "godot.validate") return this.validateTask(task, input.smokeScene as string | undefined, signal);
          throw new ProjectError("TASK_SCOPE_DENIED", "This task is finished; create a new task for further changes");
        }
        if (signal?.aborted) throw new ProjectError("COMMAND_FAILED", "Task operation was cancelled");
        const result = await this.dispatch(task, name, parsed.data as Record<string, unknown>, signal);
        this.event(task, name, true, "完成");
        await this.persist(task);
        return result;
      } catch (error) {
        this.event(task, name, false, serializeError(error).message);
        await this.persist(task);
        throw error;
      }
    });
  }

  async previewChanges(taskId: string): Promise<ChangeReview> {
    return this.withTask(taskId, async (task) => this.review(task));
  }

  async approveChanges(taskId: string, digest: string): Promise<ReturnType<StagedChangeSet["preview"]>> {
    return this.withTask(taskId, async (task) => {
      if (task.running) throw new ProjectError("APPROVAL_REQUIRED", "Wait for the current agent run before approving changes");
      if (task.changes.preview().digest !== digest) throw new ProjectError("APPROVAL_REQUIRED", "The change preview has changed; inspect the current diff");
      task.approval = digest;
      return this.commit(task, digest);
    });
  }

  async rejectChanges(taskId: string): Promise<ReturnType<StagedChangeSet["preview"]>> {
    return this.withTask(taskId, async (task) => {
      if (task.historical) throw new ProjectError("APPROVAL_REQUIRED", "Historical changes cannot be rejected again");
      if (task.running) throw new ProjectError("APPROVAL_REQUIRED", "Cancel the agent before rejecting its changes");
      const result = task.changes.reject();
      delete task.approval;
      await this.persist(task);
      return result;
    });
  }

  async validate(taskId: string, signal?: AbortSignal): Promise<ValidationResult> {
    return this.withTask(taskId, (task) => this.validateTask(task, undefined, signal));
  }

  async agentMessage(taskId: string, profile: ModelProfile, prompt: string, signal?: AbortSignal, hooks: Pick<AgentRuntimeOptions, "onEvent" | "onQuestion" | "onConversation"> = {}): Promise<AgentRunResult> {
    const task = this.task(taskId);
    if (task.historical || !["staged", "validated"].includes(task.changes.preview().status)) throw new ProjectError("TASK_SCOPE_DENIED", "Create a new task before starting another agent run");
    if (task.running) throw new ProjectError("MODEL_ERROR", "This task already has an active agent run");
    task.running = true;
    const runtime = new AgentRuntime({
      ...(hooks.onEvent ? { onEvent: hooks.onEvent } : {}),
      ...(hooks.onQuestion ? { onQuestion: hooks.onQuestion } : {}),
      ...(this.options.diagnostics ? { onDiagnostic: event => this.options.diagnostics!.record(event) } : {}),
      executeTool: (call) => this.executeTool(call.taskId, call.name, call.input, call.signal),
      onConversation: (messages) => this.withTask(taskId, async () => { task.messages = messages; await this.persist(task); await hooks.onConversation?.(messages); }),
      ...(this.options.resolveCredential ? { resolveCredential: this.options.resolveCredential } : {}),
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      ...(this.options.diagnostics ? { onDiagnostic: event => this.options.diagnostics!.record(event) } : {}),
    });
    try {
      const workspace = await this.readWorkspacePrompt();
      const projectContext = await readProjectContext(this.store.root, !task.messages.some(message => message.role === "assistant"));
      const result = await runtime.run({ taskId, profile, prompt, systemPrompt: systemPrompt(this.options.customInstructions?.() ?? "", workspace.content, task.scope.describe(), projectContext),
        ...(task.messages.length ? { previousMessages: task.messages } : {}), ...(signal ? { signal } : {}) });
      task.messages = boundConversation(result.messages);
      task.summary = result.summary;
      return result;
    } finally { task.running = false; await this.persist(task); }
  }

  async chatMessage(profile: ModelProfile, prompt: string, previousMessages: AgentMessage[] = [], signal?: AbortSignal): Promise<AgentRunResult> {
    const workspace = await this.readWorkspacePrompt();
    return chatMessage({
      workspaceRoot: this.store.root,
      ...(this.options.resolveCredential ? { resolveCredential: this.options.resolveCredential } : {}),
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    }, profile, prompt, this.options.customInstructions?.() ?? "", workspace.content, previousMessages, signal);
  }

  private async dispatch(task: CoreTask, name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const taskId = task.scope.describe().id;
    if (getGodotMcpToolDefinition(name)) {
      if (this.metadata.engine !== "godot") throw new ProjectError("INVALID_PROJECT", "Godot MCP tools require a Godot project");
      const registry = this.options.godotMcpHosts ?? godotMcpHostRegistry;
      return registry.call(this.metadata.path, name, input, signal);
    }
    switch (name) {
      case "files.list_versions": {
        const requested = input.paths as string[] | undefined;
        const prefix = input.prefix as string | undefined;
        if (prefix) this.store.normalizePath(prefix);
        const versions = requested ? await Promise.all(requested.map((path) => this.version(task, task.scope.assertRead(path)))) : await this.store.listFiles(prefix);
        const visible = new Map<string, FileVersion>();
        for (const version of versions) {
          try { task.scope.assertRead(version.path); visible.set(this.store.pathIdentity(version.path), await this.version(task, version.path)); }
          catch (error) { if (!(error instanceof ProjectError) || error.code !== "TASK_SCOPE_DENIED" || requested) throw error; }
        }
        if (!requested) for (const entry of task.changes.preview().entries) {
          if (prefix && !entry.path.startsWith(`${prefix}/`) && entry.path !== prefix) continue;
          try { task.scope.assertRead(entry.path); visible.set(this.store.pathIdentity(entry.path), await this.version(task, entry.path)); }
          catch (error) { if (!(error instanceof ProjectError) || error.code !== "TASK_SCOPE_DENIED") throw error; }
        }
        return [...visible.values()].sort((a, b) => a.path.localeCompare(b.path));
      }
      case "files.read": return this.read(task, input.path as string, input.expectedVersion as VersionToken);
      case "files.write": return this.stageWrite(task, input.path as string, input.content as string, input.expectedVersion as VersionToken, name);
      case "files.patch": {
        const path = input.path as string;
        const version = input.expectedVersion as VersionToken;
        this.requireReceipt(task, path, version);
        const file = await this.read(task, path, version);
        const patch = input.patch as { search: string; replace: string };
        const index = file.content.indexOf(patch.search);
        if (index < 0 || file.content.indexOf(patch.search, index + 1) >= 0) throw new ProjectError("INVALID_PATCH", "The patch must match exactly one occurrence", { path });
        return this.stageWrite(task, path, file.content.slice(0, index) + patch.replace + file.content.slice(index + patch.search.length), version, name);
      }
      case "skills.list": return this.registry(task).list(task.scope);
      case "skills.load": {
        const loaded = await this.registry(task).load(input.id as string, input.expectedVersion as VersionToken, task.scope, input.sourcePaths as string[] | undefined);
        for (const source of loaded.sources) task.changes.addDependency(source.path, this.entry(task, source.path)?.expectedVersion ?? source.version);
        task.receipts.set(this.store.pathIdentity(loaded.path), loaded.version);
        for (const source of loaded.referencedContent) task.receipts.set(this.store.pathIdentity(source.path), source.version);
        this.invalidate(task);
        return loaded;
      }
      case "bash.exec": {
        const overlay = task.changes.preview().entries;
        const session = await this.snapshot.create(task.scope, { overlay });
        try {
          const result = await session.exec(input.command as string, { ...(input.timeoutMs ? { timeoutMs: input.timeoutMs as number } : {}), ...(signal ? { signal } : {}) });
          if (result.exitCode !== 0) throw new ProjectError("COMMAND_FAILED", "The isolated command failed", { ...result });
          const changes = await session.collectChanges();
          // A shell may consume every mounted input; bind all snapshot inputs to the eventual commit.
          for (const source of session.sources()) task.changes.addDependency(source.path, source.version);
          for (const entry of changes) {
            task.scope.assertWrite(entry.path, entry.operation);
            if (entry.expectedVersion !== "absent" && task.before[entry.path] === undefined) task.before[entry.path] = (await this.store.read(entry.path, entry.expectedVersion)).content;
            task.changes.stage({ ...entry, sourceTaskId: taskId, sourceTool: name });
          }
          const paths = new Set(changes.map((entry) => this.store.pathIdentity(entry.path)));
          for (const entry of overlay) if (!paths.has(this.store.pathIdentity(entry.path))) task.changes.unstage(entry.path);
          this.invalidate(task);
          return { ...result, changes: changes.map(({ path, operation }) => ({ path, operation })) };
        } finally { await session.dispose(); }
      }
      case "godot.validate": return this.validateTask(task, input.smokeScene as string | undefined, signal);
      case "changes.preview": return this.review(task);
      case "changes.commit": return this.commit(task, input.digest as string);
      default: throw new ProjectError("VALIDATION_FAILED", "Unsupported tool");
    }
  }

  private entry(task: CoreTask, path: string): ChangeEntry | undefined {
    const key = this.store.pathIdentity(path);
    return task.changes.preview().entries.find((entry) => this.store.pathIdentity(entry.path) === key);
  }
  private registry(task: CoreTask): SkillRegistry {
    const id = task.scope.describe().id;
    let registry = this.registries.get(id);
    if (!registry) {
      registry = new SkillRegistry({
        listFiles: async (prefix) => {
          const versions = await this.store.listFiles(prefix);
          const paths = new Set([...versions.map((file) => file.path), ...task.changes.preview().entries.filter((entry) => !prefix || entry.path.startsWith(`${prefix}/`)).map((entry) => entry.path)]);
          return (await Promise.all([...paths].map((path) => this.version(task, path)))).filter((file) => file.exists);
        },
        listVersion: (path) => this.version(task, path),
        read: (path, expected) => this.read(task, path, expected, false),
      });
      this.registries.set(id, registry);
    }
    return registry;
  }
  private async version(task: CoreTask, path: string): Promise<FileVersion> {
    const staged = this.entry(task, path);
    if (!staged) return this.store.listVersion(path);
    return staged.operation === "delete" ? { path: staged.path, version: "absent", exists: false, size: 0 }
      : { path: staged.path, version: digestBytes(staged.nextContent!), exists: true, size: Buffer.byteLength(staged.nextContent!) };
  }
  private async read(task: CoreTask, path: string, expected: VersionToken, issueReceipt = true): Promise<FileReadResult> {
    const normalized = task.scope.assertRead(path);
    const staged = this.entry(task, normalized);
    let result: FileReadResult;
    if (staged) {
      this.store.assertVersion(normalized, (await this.version(task, normalized)).version, expected);
      if (staged.operation === "delete") throw new ProjectError("FILE_NOT_FOUND", "This file is deleted in the staged view", { path: normalized });
      result = { path: staged.path, version: expected, content: staged.nextContent! };
    } else {
      result = await this.store.read(normalized, expected);
      task.changes.addDependency(normalized, result.version);
      this.invalidate(task);
    }
    if (issueReceipt) task.receipts.set(this.store.pathIdentity(normalized), expected);
    return result;
  }
  private requireReceipt(task: CoreTask, path: string, expected: VersionToken): void {
    if (expected !== "absent" && task.receipts.get(this.store.pathIdentity(path)) !== expected) throw new ProjectError("READ_REQUIRED", "Read this file at its current version before changing it", { path });
  }
  private async stageWrite(task: CoreTask, path: string, content: string, expected: VersionToken, tool: string): Promise<FileVersion> {
    const normalized = task.scope.assertRead(path);
    this.requireReceipt(task, normalized, expected);
    const current = await this.version(task, normalized);
    this.store.assertVersion(normalized, current.version, expected);
    const staged = this.entry(task, normalized);
    const baseline = staged?.expectedVersion ?? expected;
    const operation = baseline === "absent" ? "create" : "update";
    task.scope.assertWrite(normalized, operation);
    const entries = task.changes.preview().entries.filter((entry) => this.store.pathIdentity(entry.path) !== this.store.pathIdentity(normalized));
    if (entries.length >= 128 || entries.reduce((sum, entry) => sum + Buffer.byteLength(entry.nextContent ?? ""), Buffer.byteLength(content)) > 4 * 1024 * 1024) throw new ProjectError("VALIDATION_FAILED", "Task change capacity exceeded; split this work into smaller tasks");
    if (baseline !== "absent" && task.before[normalized] === undefined) task.before[normalized] = (await this.store.read(normalized, baseline)).content;
    task.changes.stage({ path: staged?.path ?? normalized, operation, expectedVersion: baseline, nextContent: content, sourceTaskId: task.scope.describe().id, sourceTool: tool });
    this.invalidate(task);
    return this.version(task, normalized);
  }
  private async validateTask(task: CoreTask, smokeScene?: string, signal?: AbortSignal): Promise<ValidationResult> {
    if (smokeScene) task.scope.assertRead(smokeScene);
    const preview = task.historical ?? task.changes.preview();
    const mutable = ["staged", "validated"].includes(preview.status);
    const validation = await this.validator.validateWithDependencies({ taskId: preview.taskId, scope: task.scope, overlay: mutable ? preview.entries : [], ...(smokeScene ? { smokeScene } : {}), ...(signal ? { signal } : {}) });
    for (const [path, version] of Object.entries(validation.dependencies)) {
      if (!mutable) break;
      if (path.startsWith(".specloom/") && !path.startsWith(".specloom/skills/")) task.internalDependencies[path] = version;
      else task.changes.addDependency(path, version);
    }
    this.invalidate(task);
    if (mutable) task.inventory = validation.inventory;
    const digest = (task.historical ?? task.changes.preview()).digest;
    task.validation = { digest, result: validation.result };
    if (mutable && validation.result.status === "pass") task.changes.markValidated(digest);
    await this.writeState(`.specloom/history/validations/${randomUUID()}.json`, validation.result);
    await this.persist(task);
    return validation.result;
  }
  private async commit(task: CoreTask, digest: string): Promise<ReturnType<StagedChangeSet["preview"]>> {
    if (task.historical) throw new ProjectError("APPROVAL_REQUIRED", "Historical changes cannot be committed again");
    const manual = task.scope.describe().mode === "manual";
    if (manual && task.approval !== digest) throw new ProjectError("APPROVAL_REQUIRED", "Approve this exact change digest in the desktop application");
    if (!manual && (task.validation?.digest !== digest || task.validation.result.status !== "pass")) throw new ProjectError("VALIDATION_FAILED", "Automatic commits require passing validation of the current changes");
    try { return await task.changes.commit(digest, async () => {
      if (task.inventory) {
        const current = (await this.store.listFiles()).map((file) => file.path).sort();
        if (JSON.stringify(current) !== JSON.stringify([...task.inventory].sort())) throw new ProjectError("VERSION_CONFLICT", "Project file inventory changed since validation; validate again");
      }
      for (const [path, expected] of Object.entries(task.internalDependencies)) {
        const target = await this.store.policy.resolve(path, true);
        let current: VersionToken = "absent";
        try { current = digestBytes(await readFile(target)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        this.store.assertVersion(path, current, expected);
      }
    }); }
    finally { delete task.approval; await this.persist(task); }
  }
  private review(task: CoreTask): ChangeReview {
    const changeSet = task.historical ?? task.changes.preview();
    return { changeSet, before: { ...task.before }, approved: task.approval === changeSet.digest,
      ...(task.validation?.digest === changeSet.digest ? { validation: structuredClone(task.validation.result) } : {}) };
  }
  private invalidate(task: CoreTask): void { delete task.approval; delete task.validation; delete task.inventory; }
  private task(id: string): CoreTask {
    const task = this.tasks.get(id);
    if (!task) throw new ProjectError("TASK_SCOPE_DENIED", "Choose an existing approved task");
    return task;
  }
  private taskView(task: CoreTask): TaskView {
    return { id: task.scope.describe().id, scope: task.scope.describe(), status: (task.historical ?? task.changes.preview()).status, running: task.running, summary: task.summary, events: structuredClone(task.events),
      conversation: task.messages.flatMap((message) => (message.role === "user" || message.role === "assistant") && message.content ? [{ role: message.role, content: message.content }] : []) };
  }
  private withTask<T>(id: string, action: (task: CoreTask) => Promise<T>): Promise<T> {
    const task = this.task(id);
    const result = task.pending.then(() => action(task));
    task.pending = result.then(() => undefined, () => undefined);
    return result;
  }
  private event(task: CoreTask, tool: string, ok: boolean, message: string): void {
    task.events.push({ time: new Date().toISOString(), tool, ok, message });
    if (task.events.length > 200) task.events.shift();
  }
  private async writeState(relative: string, value: unknown): Promise<void> {
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) > 32 * 1024 * 1024) throw new ProjectError("VALIDATION_FAILED", "Task state exceeds the persistence size limit");
    const target = await this.store.policy.resolve(relative, true);
    await this.store.policy.ensureParent(target);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await this.store.policy.assertSafe(temporary, true);
    try { await writeFile(temporary, json, { flag: "wx" }); await this.store.policy.assertSafe(target, true); await this.store.fs.rename(temporary, target); }
    finally { await this.store.fs.unlink(temporary).catch(() => undefined); }
  }
  private async persist(task: CoreTask): Promise<void> {
    const id = digestBytes(task.scope.describe().id).slice(7);
    await this.writeState(`.specloom/history/tasks/${id}.json`, { scope: task.scope.describe(), changeSet: task.historical ?? task.changes.preview(), before: task.before, summary: task.summary, events: task.events, conversation: task.messages, ...(task.validation ? { validation: task.validation } : {}) });
  }
  private trimHistory(): void {
    const finished = [...this.tasks.entries()].filter(([, task]) => !task.running && !["staged", "validated", "committing"].includes((task.historical ?? task.changes.preview()).status));
    for (const [id] of finished.slice(0, Math.max(0, finished.length - 128))) { this.tasks.delete(id); this.registries.delete(id); }
  }
  private async restoreDrafts(history: JournalRecord[]): Promise<void> {
    const directory = await this.store.policy.resolve(".specloom/history/tasks", true);
    let files;
    try { files = await this.store.fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    const candidates = [];
    for (const file of files.filter((file) => /^[a-f0-9]{64}\.json$/.test(file.name))) {
      const target = await this.store.policy.resolve(`.specloom/history/tasks/${file.name}`, true);
      const stat = await this.store.fs.lstat(target);
      candidates.push({ target, stat });
    }
    for (const { target, stat } of candidates.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs)) {
      if (!stat.isFile() || stat.size > 32 * 1024 * 1024) continue;
      try {
        const data = z.object({ scope: TaskScopeSpecSchema, changeSet: ChangeSetDataSchema, before: z.record(z.string(), z.string()), summary: z.string().max(131072), events: z.array(z.object({ time: z.string(), tool: z.string(), ok: z.boolean(), message: z.string() })).max(200), conversation: AgentConversationSchema.optional(), validation: z.object({ digest: z.string(), result: ValidationResultSchema }).strict().optional() }).strict().parse(JSON.parse((await readFile(target)).toString("utf8")));
        const journal = history.find((record) => record.id === data.changeSet.id && record.taskId === data.scope.id);
        if (journal) {
          data.changeSet = { ...data.changeSet, digest: journal.digest, status: journal.status, entries: journal.operations.map((operation) => operation.entry) };
          data.before = Object.fromEntries(journal.operations.filter((operation) => operation.preimage !== null).map((operation) => [operation.entry.path, operation.preimage!]));
        }
        const scope = new TaskScope(data.scope);
        const changes = new StagedChangeSet(this.store, { taskId: data.scope.id, id: data.changeSet.id });
        for (const entry of data.changeSet.entries) { scope.assertWrite(entry.path, entry.operation); changes.stage(entry); }
        for (const [path, version] of Object.entries(data.changeSet.dependencies)) changes.addDependency(path, version);
        this.tasks.set(data.scope.id, { scope, changes, receipts: new Map(), before: data.before, summary: data.summary, events: data.events, internalDependencies: {}, messages: data.conversation ?? [], running: false, pending: Promise.resolve(), ...(["staged", "validated"].includes(data.changeSet.status) ? {} : { historical: data.changeSet, ...(data.validation ? { validation: data.validation } : {}) }) });
      } catch { /* Invalid drafts do not grant task permissions or prevent opening a project. */ }
    }
    this.trimHistory();
  }
}
