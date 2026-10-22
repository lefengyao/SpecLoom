import type {
  ChangeSetData,
  FileReadResult,
  ModelProfile,
  ModelReference,
  ProjectMetadata,
  ProviderInput,
  ProviderPublic,
  SessionModelPreference,
  TaskScopeSpec,
  UsageRecord,
  VersionToken,
  ValidationResult,
} from "./contracts";
import type { Preferences } from "./preferences";
import type { ChatSession, ChatSessionsApi } from "./chat";
import type { OfflineDocumentBundle, OfflineDocumentRead, OfflineDocumentImportOptions } from "./offline-documents";
import type { HookDefinition, HookDefinitionInput, HookRunResult } from "./hooks";
import type { ManagedSkill, SkillImportOptions } from "./skill-management";
import type { ManagedMcpServer, McpConfigScope, McpServerConfig } from "./mcp-config";
import type { DiagnosticListResult, DiagnosticQuery, DiagnosticSummary } from "./diagnostics";
import type { GodotPluginId, PluginInventory, PluginMutationResult, RevealPluginDirectoryTarget } from "./godot-plugins";
import type { PluginInventory as SpecLoomPluginInventory } from "./plugins";
import type { ProjectOverview } from "./project-overview";
import type { ProjectMediaLease, ProjectTextFile } from "./project-files";
import type { ChatAttachmentInput, PreparedChatAttachment } from "./chat-attachments";
import type { EntityLayout } from "./entity-layout";
import type { WorkflowDefinition } from "./workflow";
import type {
  WorkflowCopyResult,
  WorkflowRetryAction,
  WorkflowRun,
  WorkflowRunInputs,
  WorkflowSaveResult,
  WorkflowSource,
  WorkflowSummary,
  WorkflowTriggerChatInput,
  WorkflowTriggerResult,
  WorkflowUpdate,
} from "./workflow-api";
import type { OrchestrationRun, WorkflowSettings } from "./orchestration";
import type {
  OrchestrationSaveResult,
  OrchestrationSource,
  OrchestrationSummary,
  OrchestrationUpdate,
} from "./orchestration-api";

export interface TaskView {
  id: string;
  scope: TaskScopeSpec;
  status: string;
  running: boolean;
  summary: string;
  events: { time: string; tool: string; ok: boolean; message: string }[];
  conversation?: { role: "user" | "assistant"; content: string }[];
}
export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}
export interface ChangeReview {
  changeSet: ChangeSetData;
  before: Record<string, string>;
  validation?: ValidationResult;
  approved: boolean;
}
export interface McpConnection { url: string; token: string }
export interface HooksApi {
  list(): Promise<HookDefinition[]>;
  save(input: HookDefinitionInput): Promise<HookDefinition>;
  remove(id: string): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<HookDefinition>;
  test(id: string): Promise<HookRunResult>;
}
export interface SkillsApi {
  list(): Promise<ManagedSkill[]>;
  installDirectory(path: string, options?: SkillImportOptions): Promise<ManagedSkill>;
  installArchive(path: string, options?: SkillImportOptions): Promise<ManagedSkill>;
  listProject(projectPath: string): Promise<ManagedSkill[]>;
  installProjectDirectory(path: string, projectPath: string, options?: SkillImportOptions): Promise<ManagedSkill>;
  setProjectEnabled(id: string, enabled: boolean, projectPath: string): Promise<ManagedSkill>;
  removeProject(id: string, projectPath: string): Promise<void>;
  refresh(): Promise<ManagedSkill[]>;
  setEnabled(id: string, enabled: boolean): Promise<ManagedSkill>;
  remove(id: string): Promise<void>;
  selectDirectory?(): Promise<string | undefined>;
  selectArchive?(): Promise<string | undefined>;
}
export interface McpConfigApi {
  list(projectPath?: string): Promise<ManagedMcpServer[]>;
  save(scope: McpConfigScope, projectPath: string | undefined, name: string, config: McpServerConfig): Promise<ManagedMcpServer[]>;
  setEnabled(scope: McpConfigScope, projectPath: string | undefined, name: string, enabled: boolean): Promise<ManagedMcpServer[]>;
  remove(scope: McpConfigScope, projectPath: string | undefined, name: string): Promise<ManagedMcpServer[]>;
  test(config: McpServerConfig): Promise<{ ok: boolean; message: string }>;
}
export interface DiagnosticsApi {
  list(query: DiagnosticQuery): Promise<DiagnosticListResult>;
  summary(): Promise<DiagnosticSummary>;
  clearExpired(): Promise<number>;
  clearAll(): Promise<number>;
  export(): Promise<boolean>;
}
export interface RecoveryIssue { code: string; message: string; path?: string }
export interface ProjectTreeEntry { path: string; kind: "file" | "directory" }
export interface MaterialChange { projectPath: string; path: string; version: VersionToken }
/** A project opened from this installation before; `exists` is checked on every read. */
export interface RecentProject { path: string; name: string; openedAt: string; exists: boolean }
export interface WorkspaceState {
  /** Stable Hub window slot; standalone hosts retain the legacy storage scope. */
  windowId?: string;
  project?: ProjectMetadata;
  tasks: TaskView[];
  sessions?: ChatSession[];
  models: ModelProfile[];
  /** New provider registry; optional during migration from the legacy model list. */
  providers?: ProviderPublic[];
  defaultModel?: ModelReference | undefined;
  sessionModel?: SessionModelPreference | undefined;
  usage?: UsageRecord[] | undefined;
  recent: RecentProject[];
  preferences: Preferences;
  mcp?: McpConnection;
  recoveryIssues?: RecoveryIssue[];
}

/** Provider/model management operations exposed by newer desktop hosts. */
export interface ProviderApi {
  list(): Promise<ProviderPublic[]>;
  save(input: ProviderInput, secret?: string): Promise<ProviderPublic[]>;
  remove(id: string): Promise<ProviderPublic[]>;
  fetchModels(id: string): Promise<{ list: ProviderPublic[]; added: string[]; message: string }>;
  listModels(id: string): Promise<{ ids: string[]; known: string[] }>;
  addModels(id: string, modelIds: string[]): Promise<ProviderPublic[]>;
  test(id: string): Promise<{ ok: boolean; message: string }>;
}
export interface OfflineDocumentsApi {
  list(): Promise<OfflineDocumentBundle[]>;
  subscribe?(listener: () => void): () => void;
  importFiles(paths: string[], name: string, version: string, enabled: boolean, options?: OfflineDocumentImportOptions): Promise<OfflineDocumentBundle>;
  importDirectory(path: string, name: string, version: string, enabled: boolean, options?: OfflineDocumentImportOptions): Promise<OfflineDocumentBundle>;
  setEnabled(id: string, enabled: boolean): Promise<OfflineDocumentBundle>;
  setVersion(id: string, versionId: string): Promise<OfflineDocumentBundle>;
  read(id: string, versionId: string | undefined, path: string): Promise<OfflineDocumentRead>;
  remove(id: string, versionId?: string): Promise<void>;
  selectFiles?(): Promise<string[]>;
  selectDirectory?(): Promise<string | undefined>;
}
/** Project-level default workflow settings. */
export interface WorkflowDefaultsApi {
  /** The stored settings; a missing or invalid file reads as schema version 1. */
  read(): Promise<WorkflowSettings>;
  /** Validate and replace the project override. */
  save(settings: WorkflowSettings): Promise<WorkflowSettings>;
  /** Remove the project override, restoring the global (official) default. */
  clear(): Promise<WorkflowSettings>;
}
/** Sequential orchestration definition and run operations for one project. */
export interface OrchestrationsApi {
  list(): Promise<OrchestrationSummary[]>;
  read(id: string): Promise<OrchestrationSource>;
  save(id: string, content: string, expectedVersion: VersionToken): Promise<OrchestrationSaveResult>;
  remove(id: string, expectedVersion: VersionToken): Promise<void>;
  start(id: string, inputs: WorkflowRunInputs): Promise<OrchestrationRun>;
  getRun(orchestrationRunId: string): Promise<OrchestrationRun>;
  listRuns(): Promise<OrchestrationRun[]>;
  approveStep(orchestrationRunId: string, digest: string): Promise<void>;
  rejectStep(orchestrationRunId: string): Promise<void>;
  retryStep(orchestrationRunId: string, action: WorkflowRetryAction): Promise<void>;
  cancel(orchestrationRunId: string): Promise<void>;
}
/** Workflow definition and run operations for one project workspace. */
export interface WorkflowApi {
  list(): Promise<WorkflowSummary[]>;
  read(id: string): Promise<WorkflowSource>;
  save(id: string, content: string, expectedVersion: VersionToken): Promise<WorkflowSaveResult>;
  remove(id: string, expectedVersion: VersionToken): Promise<void>;
  copyOfficial(id: string): Promise<WorkflowCopyResult>;
  start(definition: WorkflowDefinition, inputs: WorkflowRunInputs): Promise<WorkflowRun>;
  /**
   * Start the project default workflow for a task's first implementation
   * message. The main process records a durable one-run binding, so a repeat
   * returns the same run. Hosts that predate this feature omit the method.
   */
  startForTask?(taskId: string, message?: string): Promise<WorkflowTriggerResult>;
  /** Start a chat implementation turn; an explicit workflow overrides the default. */
  startForChat?(input: WorkflowTriggerChatInput): Promise<WorkflowTriggerResult>;
  getRun(runId: string): Promise<WorkflowRun>;
  listRuns(): Promise<WorkflowRun[]>;
  approve(runId: string, digest: string): Promise<void>;
  reject(runId: string): Promise<void>;
  retry(runId: string, action: WorkflowRetryAction): Promise<void>;
  cancel(runId: string): Promise<void>;
  /** Project defaults; hosts that predate this feature omit the namespace. */
  defaults?: WorkflowDefaultsApi;
  /** Sequential orchestrations; hosts that predate this feature omit the namespace. */
  orchestrations?: OrchestrationsApi;
  onUpdate(listener: (event: WorkflowUpdate) => void): () => void;
  /** Durable orchestration transitions; hosts that predate this feature omit it. */
  onOrchestrationUpdate?: (listener: (event: OrchestrationUpdate) => void) => () => void;
}
export interface EntityLayoutApi {
  read(): Promise<EntityLayout>;
  save(layout: EntityLayout): Promise<EntityLayout>;
}
export interface PluginsApi {
  list(): Promise<SpecLoomPluginInventory>;
  setEnabled(id: string, enabled: boolean): Promise<SpecLoomPluginInventory>;
  invoke(id: string, command: string, input?: unknown): Promise<unknown>;
  install(): Promise<SpecLoomPluginInventory>;
  uninstall(id: string): Promise<SpecLoomPluginInventory>;
  reveal(id: string): Promise<void>;
  pageUrl(id: string, pageId: string): string;
}
export interface PluginManagementApi {
  list(): Promise<PluginInventory>;
  setGodotPluginEnabled(id: GodotPluginId, enabled: boolean): Promise<PluginMutationResult>;
  setGodotMcpEnabled(enabled: boolean): Promise<PluginMutationResult>;
  installGodotMcp(): Promise<PluginMutationResult>;
  revealDirectory(target: RevealPluginDirectoryTarget): Promise<void>;
}
export interface DesktopApi {
  projectOverview?: { read(projectPath: string): Promise<ProjectOverview> };
  projectFiles?: {
    readText(projectPath: string, path: string): Promise<ProjectTextFile>;
    openMedia(projectPath: string, path: string): Promise<ProjectMediaLease>;
    releaseMedia(id: string): Promise<void>;
  };
  chatAttachments?: {
    prepare(projectPath: string, sessionId: string, requestId: string, input: ChatAttachmentInput): Promise<PreparedChatAttachment>;
    cancel(projectPath: string, sessionId: string, requestId: string): Promise<void>;
    readClipboard(projectPath: string): Promise<{ files: ChatAttachmentInput[]; text?: string; notices: string[] }>;
  };
  sessions?: ChatSessionsApi;
  skills?: SkillsApi;
  offlineDocuments?: OfflineDocumentsApi;
  hooks?: HooksApi;
  mcpConfig?: McpConfigApi;
  diagnostics?: DiagnosticsApi;
  entityLayout?: EntityLayoutApi;
  pluginManagement?: PluginManagementApi;
  plugins?: PluginsApi;
  workflow?: WorkflowApi;
  state(): Promise<WorkspaceState>;
  onStateChanged?: (listener: () => void) => () => void;
  selectProject(): Promise<WorkspaceState>;
  openProject(path: string): Promise<WorkspaceState>;
  closeProject(): Promise<WorkspaceState>;
  forgetProject(path: string): Promise<WorkspaceState>;
  updatePreferences(patch: Partial<Preferences>): Promise<WorkspaceState>;
  openGodot(): Promise<void>;
  openExternalEditor(): Promise<void>;
  removeTask(taskId: string): Promise<WorkspaceState>;
  createExample(): Promise<WorkspaceState>;
  createTask(scope: Omit<TaskScopeSpec, "id">): Promise<TaskView>;
  tool(taskId: string, name: string, input: Record<string, unknown>): Promise<unknown>;
  preview(taskId: string): Promise<ChangeReview>;
  approve(taskId: string, digest: string): Promise<ChangeSetData>;
  reject(taskId: string): Promise<ChangeSetData>;
  validate(taskId: string): Promise<ValidationResult>;
  agent(taskId: string, modelId: string | ModelReference, prompt: string): Promise<{ summary: string; toolCalls: number }>;
  cancel(taskId: string): Promise<void>;
  chat?: (modelId: string | ModelReference, prompt: string, previousMessages?: ConversationMessage[]) => Promise<{ summary: string; toolCalls: number }>;
  cancelChat?: () => Promise<void>;
  saveModel(profile: ModelProfile, secret?: string): Promise<ModelProfile>;
  removeModel(id: string): Promise<void>;
  /** Available once the provider registry migration is active. */
  providers?: ProviderApi;
  saveProvider?: (input: ProviderInput, secret?: string) => Promise<ProviderPublic[]>;
  removeProvider?: (id: string) => Promise<ProviderPublic[]>;
  addProviderModels?: (id: string, models: string[]) => Promise<ProviderPublic>;
  removeProviderModel?: (id: string, model: string) => Promise<ProviderPublic>;
  discoverProviderModels?: (id: string) => Promise<{ list: ProviderPublic[]; added: string[]; message: string }>;
  setDefaultModel?: (reference: ModelReference | null) => Promise<WorkspaceState>;
  setSessionModel?: (preference: SessionModelPreference | null) => Promise<WorkspaceState>;
  readDocument(path: string, expectedVersion: string): Promise<FileReadResult>;
  saveDocument(projectPath: string, path: string, content: string, expectedVersion: VersionToken): Promise<FileReadResult>;
  importMaterialImage(projectPath: string, dataUrl: string): Promise<string>;
  readMaterialImage(projectPath: string, path: string): Promise<string>;
  onMaterialChanged?: (listener: (event: MaterialChange) => void) => () => void;
  documents(): Promise<{ path: string; version: string; size: number }[]>;
  projectTree(): Promise<ProjectTreeEntry[]>;
  readWorkspacePrompt(projectPath: string): Promise<FileReadResult>;
  saveWorkspacePrompt(projectPath: string, content: string, expectedVersion: VersionToken): Promise<FileReadResult>;
}

declare global { interface Window { specloom: DesktopApi } }
