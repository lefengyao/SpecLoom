import { randomUUID } from "node:crypto";
import { FileStore } from "../file-store";
import { ProjectError } from "../errors";
import { ToolCatalog } from "../tool-catalog";
import type { SessionCapabilities } from "../../../shared/chat";
import { WorkspaceCatalog } from "./catalog";
import { WorkFiles, skillMetadata } from "./files";
import { WorkProcesses, type WorkProgress } from "./processes";
import { WorkState } from "./state";
import { WorkspaceMcp } from "./mcp-client";
import { ComputerUse, type ComputerAction } from "./computer-use";
import { getGodotMcpToolDefinition } from "../godot-mcp/tool-definitions";
import { godotMcpHostRegistry, type GodotMcpHostRegistry } from "../godot-mcp/host-registry";
import { WorkMaterials } from "./materials";
import { materialToolDefinitions } from "./material-tool-catalog";
import type { OfflineDocumentStore } from "../offline-documents";
import { DEFAULT_APPROVAL_MODE, type ApprovalMode, type ToolApprovalInput } from "../../../shared/approvals";
import { toolApproval, mcpConnectionApproval } from "./approval-policy";
import { ExternalFiles } from "./external-files";
import { WorkWebSearch, isWebSearchTool, webSearchDefinitions, type WebSearchContext } from "./web-search";

export interface WorkspaceToolOptions {
  legacyExecute?: (name: string, input: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
  delegate?: (prompt: string, signal?: AbortSignal, progress?: WorkProgress) => Promise<unknown>;
  offlineDocuments?: OfflineDocumentStore;
  globalMcpConfigPath?: string;
  godotMcpHosts?: GodotMcpHostRegistry;
}
export class WorkspaceTools {
  readonly catalog = new WorkspaceCatalog();
  readonly files: WorkFiles;
  private readonly externalFiles: ExternalFiles;
  private readonly materials: WorkMaterials;
  private readonly processes: WorkProcesses;
  private readonly state: WorkState;
  private readonly mcp: WorkspaceMcp;
  private readonly computer = new ComputerUse();
  private initialized?: Promise<SessionCapabilities>;
  private approvalMode: ApprovalMode = DEFAULT_APPROVAL_MODE;
  private onApproval: ((input: ToolApprovalInput) => Promise<boolean>) | undefined;
  private permissionGeneration = 0;
  private webSearch = new WorkWebSearch({ mode: "off" });
  constructor(root: string, readonly sessionId: string, private readonly options: WorkspaceToolOptions = {}) {
    const store = new FileStore(root); this.files = new WorkFiles(store); this.materials = new WorkMaterials(store); this.processes = new WorkProcesses(root); this.state = new WorkState(store, sessionId); this.mcp = new WorkspaceMcp(store, options.globalMcpConfigPath);
    this.externalFiles = new ExternalFiles(this.files);
    if (options.legacyExecute) for (const tool of new ToolCatalog().listTools()) if (!getGodotMcpToolDefinition(tool.name)) this.catalog.add({ name: tool.providerName, description: tool.description, schema: tool.schema, initial: true });
  }
  capabilities(signal?: AbortSignal): Promise<SessionCapabilities> {
    this.initialized ??= this.discover(signal); return this.initialized;
  }
  async refresh(signal?: AbortSignal): Promise<SessionCapabilities> {
    signal?.throwIfAborted();
    await this.mcp.close();
    signal?.throwIfAborted();
    this.catalog.removePrefix("mcp_"); delete this.initialized; return this.capabilities(signal);
  }
  setDelegate(delegate: NonNullable<WorkspaceToolOptions["delegate"]>): void { this.options.delegate = delegate; }
  setWebSearch(context: WebSearchContext): void {
    this.webSearch = new WorkWebSearch(context);
    this.catalog.remove("web_search"); this.catalog.remove("web_extract");
    for (const definition of webSearchDefinitions(context.mode)) this.catalog.add(definition);
    this.permissionGeneration++; delete this.initialized;
  }
  setPermissions(mode: ApprovalMode, onApproval?: (input: ToolApprovalInput) => Promise<boolean>): void {
    this.approvalMode = mode; this.onApproval = onApproval; this.permissionGeneration++;
    delete this.initialized;
  }
  private async approve(request: ToolApprovalInput, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const generation = this.permissionGeneration;
    if (!this.onApproval) throw new ProjectError("APPROVAL_REQUIRED", `需要审批：${request.reason}`);
    let abort!: () => void;
    const answer = this.onApproval(request);
    const allowed = signal ? await Promise.race([answer, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    })]).finally(() => signal.removeEventListener("abort", abort)) : await answer;
    signal?.throwIfAborted();
    if (generation !== this.permissionGeneration || !allowed) throw new ProjectError("APPROVAL_REQUIRED", "操作未获批准，请调整方案或等待用户授权");
  }
  private async discover(signal?: AbortSignal): Promise<SessionCapabilities> {
    signal?.throwIfAborted();
    const skills = await skillMetadata(this.files.store);
    signal?.throwIfAborted();
    const mcp = await this.mcp.discover(this.catalog, signal, async (name, server) => {
      if (this.approvalMode !== "full") await this.approve(mcpConnectionApproval(name, server), signal);
    });
    signal?.throwIfAborted();
    const godotProject = (await this.files.store.listVersion("project.godot")).exists;
    signal?.throwIfAborted();
    if (godotProject) this.catalog.addGodotMcpTools();
    const registry = this.options.godotMcpHosts ?? godotMcpHostRegistry;
    const plugins = godotProject ? [{ name: "SpecLoom Godot MCP", description: JSON.stringify(registry.status(this.files.store.root)).slice(0, 2000) }] : [];
    return { tools: [...this.catalog.all().filter(t => !t.name.startsWith("mcp_")).map(({ name, description }) => ({ name, description })), { name: "AskUserQuestion", description: "需求澄清与单选/多选问答" }], skills: skills.map(({ id, name, purpose }) => ({ id, name, purpose })), mcp, plugins };
  }
  async execute(name: string, raw: Record<string, unknown>, signal?: AbortSignal, progress?: WorkProgress, redactText?: (text: string) => string): Promise<unknown> {
    if (isWebSearchTool(name)) this.webSearch.assertEnabled(name);
    signal?.throwIfAborted(); const input = this.catalog.parseCall(name, JSON.stringify(raw)).input;
    const approval = toolApproval(this.approvalMode, this.files.store.root, name, input, redactText);
    if (approval) await this.approve(approval, signal);
    signal?.throwIfAborted();
    if (isWebSearchTool(name)) return this.webSearch.execute(name, input, signal);
    if (materialToolDefinitions.some(tool => tool.name === name)) return this.materials.execute(name, input);
    if (name === "Read") return this.externalFiles.read(input as unknown as Parameters<WorkFiles["read"]>[0]);
    if (name === "Write") return this.externalFiles.write(String(input.path), String(input.content));
    if (name === "Edit") return this.externalFiles.edit(input as unknown as Parameters<WorkFiles["edit"]>[0]);
    if (name === "Glob") return this.files.glob(String(input.pattern));
    if (name === "Grep") return this.files.grep(input as unknown as Parameters<WorkFiles["grep"]>[0], async file => {
      const request = toolApproval(this.approvalMode, this.files.store.root, "Read", { path: file }, redactText);
      if (request) await this.approve({ ...request, toolName: "Grep" }, signal);
      signal?.throwIfAborted();
    });
    if (name === "ToolSearch") { await this.capabilities(signal); return { tools: this.catalog.search(String(input.query)) }; }
    if (name === "OfflineDocsList") { if (!this.options.offlineDocuments) throw new ProjectError("MODEL_ERROR", "离线文档不可用"); return this.options.offlineDocuments.listEnabled(); }
    if (name === "OfflineDocsRead") { if (!this.options.offlineDocuments) throw new ProjectError("MODEL_ERROR", "离线文档不可用"); return this.options.offlineDocuments.read(String(input.bundleId), input.versionId ? String(input.versionId) : undefined, String(input.path), { offset: Number(input.offset), limit: Number(input.limit) }, redactText); }
    if (name === "Bash") return this.processes.run(String(input.command), { ...(input.shell ? { shell: String(input.shell) } : {}), ...(input.timeoutMs ? { timeoutMs: Number(input.timeoutMs) } : {}), ...(signal ? { signal } : {}), ...(progress ? { progress } : {}) });
    if (name === "Monitor") return this.processes.monitor(input as unknown as Parameters<WorkProcesses["monitor"]>[0], progress, signal);
    if (name === "code_execution") {
      return this.processes.code(String(input.language), String(input.code), { ...(input.timeoutMs ? { timeoutMs: Number(input.timeoutMs) } : {}), ...(signal ? { signal } : {}), ...(progress ? { progress } : {}) });
    }
    if (name === "Skill") {
      const available = await skillMetadata(this.files.store); if (!input.id) return available;
      const skill = available.find(s => s.id === input.id); if (!skill) throw new ProjectError("FILE_NOT_FOUND", "Skill 不存在，请先列出项目 Skills");
      const version = await this.files.store.listVersion(skill.path); const read = await this.files.store.read(skill.path, version.version);
      const sources = []; for (const pattern of input.sourcePaths as string[] ?? []) for (const file of await this.files.glob(pattern)) sources.push(await this.execute("Read", { path: file, limit: 200 }, signal, undefined, redactText));
      await progress?.(`正在执行 Skill：${skill.name}`);
      return { ...skill, instructions: read.content, sources, instruction: "按照该 Skill 指令完成工作；引用路径相对 Skill 文件目录解析，修改已有文件前 Read。" };
    }
    if (name === "Agent" || name === "Task") {
      if (!this.options.delegate) throw new ProjectError("MODEL_ERROR", "子智能体需要配置模型运行时");
      await progress?.(`派生子智能体：${String(input.title ?? "委派任务")}`); return this.options.delegate(String(input.prompt), signal, progress);
    }
    if (getGodotMcpToolDefinition(name)) {
      return (this.options.godotMcpHosts ?? godotMcpHostRegistry).call(this.files.store.root, name, input, signal);
    }
    if (name.startsWith("Task") || name === "memory") return this.state.run(state => {
      if (name === "TaskList") return state.tasks;
      if (name === "TaskCreate") { const task = { id: randomUUID(), title: String(input.title), description: String(input.description ?? ""), status: "pending" as const }; state.tasks.push(task); return task; }
      if (name === "TaskUpdate") { const task = state.tasks.find(t => t.id === input.id); if (!task) throw new ProjectError("FILE_NOT_FOUND", "待办任务不存在"); for (const key of ["title", "description", "status"] as const) if (input[key] !== undefined) Object.assign(task, { [key]: input[key] }); return task; }
      const key = String(input.key ?? ""); if (input.operation === "list") return Object.entries(state.memory).map(([key, value]) => ({ key, value }));
      if (!key || ["__proto__", "constructor", "prototype"].includes(key)) throw new ProjectError("VALIDATION_FAILED", "memory 需要有效 key");
      if (input.operation === "write") { if (typeof input.value !== "string") throw new ProjectError("VALIDATION_FAILED", "memory write 需要 value"); state.memory[key] = input.value; }
      else if (input.operation === "delete") delete state.memory[key];
      return { key, value: state.memory[key] ?? null };
    });
    if (name === "screenshot" || name === "mouse_move" || name.includes("click") || ["scroll", "type", "key", "hold_key", "wait"].includes(name)) return this.computer.execute({ ...input, action: name } as ComputerAction, signal);
    if (this.mcp.has(name)) return this.mcp.call(name, input, signal);
    if (this.options.legacyExecute) {
      const legacy = new ToolCatalog().listTools().find(t => t.providerName === name);
      if (legacy) return this.options.legacyExecute(legacy.name, input, signal);
    }
    throw new ProjectError("MODEL_ERROR", "工具未注册执行器");
  }
  async close(): Promise<void> { await Promise.allSettled([this.processes.close(), this.mcp.close()]); }
  async cancelProcesses(): Promise<void> { await this.processes.close(); }
}
