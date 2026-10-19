import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import path from "node:path";
import { subscribeMaterialChanges } from "./core/material-events";
import { z } from "zod";
import type { Preferences } from "../shared/preferences";
import { ModelProfileSchema, ModelReferenceSchema, ProviderInputSchema, SessionModelPreferenceSchema, TaskScopeSpecSchema, VersionTokenSchema } from "../shared/contracts";
import { PreferencesPatchSchema } from "../shared/preferences";
import { workspacePromptLimit } from "../shared/workspace-prompt";
import { materialImagePayloadLimit } from "../shared/material-images";
import { ChatGuidanceInputSchema, ChatImageAttachmentSchema, sessionFileLimit, AnswerSchema, SessionPatchSchema, type SessionEvent } from "../shared/chat";
import type { WorkspaceState } from "../shared/desktop-api";
import { ProjectError, serializeError } from "./core/errors";
import type { DesktopController } from "./desktop-controller";
import type { OfflineDocumentImportOptions } from "../shared/offline-documents";
import { HookDefinitionInputSchema } from "../shared/hooks";
import { McpConfigScopeSchema, McpServerConfigSchema } from "../shared/mcp-config";
import { SkillImportOptionsSchema } from "../shared/skill-management";
import { DiagnosticQuerySchema } from "../shared/diagnostics";
import { GodotPluginIdSchema, RevealPluginDirectoryInputSchema } from "../shared/godot-plugins";
import { CHAT_ATTACHMENT_LIMITS, type ChatAttachmentInput } from "../shared/chat-attachments";
import { WorkflowDefinitionSchema, WORKFLOW_ID_PATTERN, type WorkflowDefinition } from "../shared/workflow";
import { WorkflowRunInputsSchema, type WorkflowRetryAction, type WorkflowRunInputs, type WorkflowUpdate } from "../shared/workflow-api";
import {
  ORCHESTRATION_ID_PATTERN,
  WorkflowSettingsSchema,
  type WorkflowSettings,
} from "../shared/orchestration";
import type { OrchestrationUpdate } from "../shared/orchestration-api";
import { readChatClipboard, type ClipboardReader } from "./chat-clipboard";
import { WorkflowService } from "./core/workflow-service";
import { EntityLayoutStore } from "./core/entity-layout-store";
import type { EntityLayout } from "../shared/entity-layout";

const id = z.string().min(1).max(256);
const conversationMessages = z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(131072) }).strict()).max(64).optional();
/** Workflow ids are file ids; the store applies the same rule to the YAML name. */
const workflowId = z.string().regex(WORKFLOW_ID_PATTERN);
/** Orchestration ids are file ids; the store applies the same rule to the YAML name. */
const orchestrationId = z.string().regex(ORCHESTRATION_ID_PATTERN);
/**
 * Workflow and orchestration run ids name files under .specloom/workflows, so
 * they use the store's file-name rule and reject traversal up front.
 */
const runId = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const retryAction = z.enum(["plan", "implement", "validate"]);
/**
 * The run inputs contract is owned by the shared workflow API and reused here
 * (re-exported for the existing IPC tests) and by the runner for both input and
 * record validation, so the three boundaries cannot drift.
 */
export { WorkflowRunInputsSchema };
/** A definition document save: one YAML body of at most 1 MiB against a version token. */
export const WorkflowSaveRequestSchema = z.object({
  id: workflowId,
  content: z.string().max(1_048_576),
  expectedVersion: VersionTokenSchema,
}).strict();
/** Project workflow defaults: one settings document, validated by the shared schema. */
export const WorkflowSettingsRequestSchema = z.object({ settings: WorkflowSettingsSchema }).strict();
/** One orchestration definition document against a version token. */
export const OrchestrationSaveRequestSchema = z.object({
  id: orchestrationId,
  content: z.string().max(1_048_576),
  expectedVersion: VersionTokenSchema,
}).strict();
/** Start one orchestration with the same run inputs a workflow run accepts. */
export const OrchestrationStartRequestSchema = z.object({
  id: orchestrationId,
  inputs: WorkflowRunInputsSchema,
}).strict();
/** A run id used by both workflow and orchestration run operations. */
export const WorkflowRunRequestSchema = z.object({ runId }).strict();
export const OrchestrationApproveRequestSchema = z.object({ runId, digest: id }).strict();
export const OrchestrationRetryRequestSchema = z.object({ runId, action: retryAction }).strict();
export const OrchestrationCancelRequestSchema = z.object({ runId }).strict();
/** Editor-only entity layout; keys are bounded entity/component ids and finite points. */
export const EntityLayoutRequestSchema = z.object({
  layout: z.record(
    z.string().min(1).max(200),
    z.record(
      z.string().min(1).max(200),
      z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
    ),
  ),
}).strict();
const operations = {
  projectOverviewRead: z.object({ projectPath: z.string().min(1).max(4096) }).strict(),
  projectFileReadText: z.object({ projectPath: z.string().min(1).max(4096), path: z.string().min(1).max(2048) }).strict(),
  projectMediaOpen: z.object({ projectPath: z.string().min(1).max(4096), path: z.string().min(1).max(2048) }).strict(),
  projectMediaRelease: z.object({ id: z.string().min(1).max(128) }).strict(),
  chatAttachmentPrepare: z.object({ projectPath: z.string().min(1).max(4096), sessionId: id, requestId: z.uuid(), input: z.object({ name: z.string().min(1).max(512), declaredMime: z.string().max(256).optional(), bytes: z.instanceof(Uint8Array).refine(bytes => bytes.byteLength > 0 && bytes.byteLength <= CHAT_ATTACHMENT_LIMITS.documentBytes) }).strict() }).strict(),
  chatAttachmentCancel: z.object({ projectPath: z.string().min(1).max(4096), sessionId: id, requestId: z.uuid() }).strict(),
  chatClipboardRead: z.object({ projectPath: z.string().min(1).max(4096) }).strict(),
  sessionsList: z.object({ projectPath: z.string().max(4096) }).strict(),
  sessionsCreate: z.object({ projectPath: z.string().max(4096), title: z.string().min(1).max(200).optional(), taskId: id.optional() }).strict(),
  sessionsPatch: z.object({ projectPath: z.string().max(4096), sessionId: id, patch: SessionPatchSchema }).strict(),
  sessionsRemove: z.object({ projectPath: z.string().max(4096), sessionId: id }).strict(),
  sessionsExport: z.object({ projectPath: z.string().max(4096), sessionId: id }).strict(),
  sessionsImport: z.object({ projectPath: z.string().max(4096), json: z.string().max(sessionFileLimit) }).strict(),
  sessionsSend: z.object({ projectPath: z.string().max(4096), sessionId: id, prompt: z.string().min(1).max(131072), draftRevision: z.number().int().nonnegative().optional(), images: z.array(ChatImageAttachmentSchema).max(16).optional() }).strict(),
  sessionsGuide: ChatGuidanceInputSchema.extend({ projectPath: z.string().max(4096), sessionId: id }).strict(),
  sessionsCancel: z.object({ projectPath: z.string().max(4096), sessionId: id }).strict(),
  sessionsAnswer: z.object({ projectPath: z.string().max(4096), sessionId: id, runId: id, questionId: id, answers: AnswerSchema }).strict(),
  sessionsApprove: z.object({ projectPath: z.string().max(4096), sessionId: id, runId: id, approvalId: id, approved: z.boolean() }).strict(),
  state: z.object({}).strict(), selectProject: z.object({}).strict(), openGodot: z.object({}).strict(), openExternalEditor: z.object({}).strict(), removeTask: z.object({ taskId: id }).strict(), createExample: z.object({}).strict(),
  openProject: z.object({ path: z.string().min(1).max(4096) }).strict(),
  forgetProject: z.object({ path: z.string().min(1).max(4096) }).strict(),
  updatePreferences: z.object({ patch: PreferencesPatchSchema }).strict(),
  createTask: z.object({ scope: TaskScopeSpecSchema.omit({ id: true }) }).strict(),
  tool: z.object({ taskId: id, name: id, input: z.record(z.string(), z.unknown()) }).strict(),
  preview: z.object({ taskId: id }).strict(), approve: z.object({ taskId: id, digest: id }).strict(),
  reject: z.object({ taskId: id }).strict(), validate: z.object({ taskId: id }).strict(),
  agent: z.object({ taskId: id, modelId: z.union([id, ModelReferenceSchema]), prompt: z.string().min(1).max(131072) }).strict(),
  chat: z.object({ modelId: z.union([id, ModelReferenceSchema]), prompt: z.string().min(1).max(131072), previousMessages: conversationMessages }).strict(),
  cancel: z.object({ taskId: id }).strict(), saveModel: z.object({ profile: ModelProfileSchema, secret: z.string().max(8192).optional() }).strict(),
  cancelChat: z.object({}).strict(),
  removeModel: z.object({ id }).strict(), documents: z.object({}).strict(), projectTree: z.object({}).strict(),
  saveProvider: z.object({ input: ProviderInputSchema, secret: z.string().max(8192).optional() }).strict(),
  removeProvider: z.object({ id }).strict(), addProviderModels: z.object({ id, models: z.array(z.string().min(1).max(512)).max(2048) }).strict(),
  removeProviderModel: z.object({ id, model: z.string().min(1).max(512) }).strict(), discoverProviderModels: z.object({ id }).strict(),
  setDefaultModel: z.object({ reference: ModelReferenceSchema.nullable() }).strict(),
  setSessionModel: z.object({ preference: SessionModelPreferenceSchema.nullable() }).strict(),
  readDocument: z.object({ path: z.string().min(1).max(2048), expectedVersion: VersionTokenSchema }).strict(),
  saveDocument: z.object({ projectPath: z.string().min(1).max(4096), path: z.string().min(1).max(2048), content: z.string().max(1_048_576), expectedVersion: VersionTokenSchema }).strict(),
  importMaterialImage: z.object({ projectPath: z.string().min(1).max(4096), dataUrl: z.string().max(materialImagePayloadLimit) }).strict(),
  readMaterialImage: z.object({ projectPath: z.string().min(1).max(4096), path: z.string().min(1).max(2048) }).strict(),
  readWorkspacePrompt: z.object({ projectPath: z.string().min(1).max(4096) }).strict(),
  saveWorkspacePrompt: z.object({ projectPath: z.string().min(1).max(4096), content: z.string().max(workspacePromptLimit), expectedVersion: VersionTokenSchema }).strict(),
  offlineDocumentsList: z.object({}).strict(),
  offlineDocumentsImportFiles: z.object({ paths: z.array(z.string().min(1).max(4096)).min(1).max(10_000), name: z.string().trim().min(1).max(256), version: z.string().trim().min(1).max(128), enabled: z.boolean(), setCurrent: z.boolean().optional() }).strict(),
  offlineDocumentsImportDirectory: z.object({ path: z.string().min(1).max(4096), name: z.string().trim().min(1).max(256), version: z.string().trim().min(1).max(128), enabled: z.boolean(), setCurrent: z.boolean().optional() }).strict(),
  offlineDocumentsSetEnabled: z.object({ id, enabled: z.boolean() }).strict(),
  offlineDocumentsSetVersion: z.object({ id, versionId: id }).strict(),
  offlineDocumentsRead: z.object({ id, versionId: id.optional(), path: z.string().min(1).max(2048) }).strict(),
  offlineDocumentsRemove: z.object({ id, versionId: id.optional() }).strict(),
  offlineDocumentsSelectFiles: z.object({}).strict(),
  offlineDocumentsSelectDirectory: z.object({}).strict(),
  hooksList: z.object({}).strict(),
  hooksSave: HookDefinitionInputSchema.strict(),
  hooksRemove: z.object({ id }).strict(),
  hooksSetEnabled: z.object({ id, enabled: z.boolean() }).strict(),
  hooksTest: z.object({ id }).strict(),
  skillsList: z.object({}).strict(),
  skillsInstallDirectory: z.object({ path: z.string().min(1).max(4096), options: SkillImportOptionsSchema.optional() }).strict(),
  skillsInstallArchive: z.object({ path: z.string().min(1).max(4096), options: SkillImportOptionsSchema.optional() }).strict(),
  skillsListProject: z.object({ projectPath: z.string().min(1).max(4096) }).strict(),
  skillsInstallProjectDirectory: z.object({ path: z.string().min(1).max(4096), projectPath: z.string().min(1).max(4096), options: SkillImportOptionsSchema.optional() }).strict(),
  skillsSetProjectEnabled: z.object({ id, enabled: z.boolean(), projectPath: z.string().min(1).max(4096) }).strict(),
  skillsRemoveProject: z.object({ id, projectPath: z.string().min(1).max(4096) }).strict(),
  skillsRefresh: z.object({}).strict(),
  skillsSelectDirectory: z.object({}).strict(),
  skillsSelectArchive: z.object({}).strict(),
  skillsSetEnabled: z.object({ id, enabled: z.boolean() }).strict(),
  skillsRemove: z.object({ id }).strict(),
  mcpConfigList: z.object({ projectPath: z.string().max(4096).optional() }).strict(),
  mcpConfigSave: z.object({ scope: McpConfigScopeSchema, projectPath: z.string().max(4096).optional(), name: z.string().trim().min(1).max(256), config: McpServerConfigSchema }).strict(),
  mcpConfigSetEnabled: z.object({ scope: McpConfigScopeSchema, projectPath: z.string().max(4096).optional(), name: z.string().trim().min(1).max(256), enabled: z.boolean() }).strict(),
  mcpConfigRemove: z.object({ scope: McpConfigScopeSchema, projectPath: z.string().max(4096).optional(), name: z.string().trim().min(1).max(256) }).strict(),
  mcpConfigTest: z.object({ config: McpServerConfigSchema }).strict(),
  diagnosticsList: z.object({ query: DiagnosticQuerySchema }).strict(),
  diagnosticsSummary: z.object({}).strict(),
  diagnosticsClearExpired: z.object({}).strict(),
  diagnosticsClearAll: z.object({}).strict(),
  diagnosticsExport: z.object({}).strict(),
  pluginsList: z.object({}).strict(),
  pluginsSetGodotPluginEnabled: z.object({ id: GodotPluginIdSchema, enabled: z.boolean() }).strict(),
  pluginsSetGodotMcpEnabled: z.object({ enabled: z.boolean() }).strict(),
  pluginsInstallGodotMcp: z.object({}).strict(),
  pluginsRevealDirectory: RevealPluginDirectoryInputSchema.strict(),
  workflowList: z.object({}).strict(),
  workflowRead: z.object({ id: workflowId }).strict(),
  workflowSave: WorkflowSaveRequestSchema,
  workflowRemove: z.object({ id: workflowId, expectedVersion: VersionTokenSchema }).strict(),
  workflowCopyOfficial: z.object({ id: workflowId }).strict(),
  workflowStart: z.object({ definition: WorkflowDefinitionSchema, inputs: WorkflowRunInputsSchema }).strict(),
  workflowGetRun: WorkflowRunRequestSchema,
  workflowListRuns: z.object({}).strict(),
  workflowApprove: OrchestrationApproveRequestSchema,
  workflowReject: WorkflowRunRequestSchema,
  workflowRetry: OrchestrationRetryRequestSchema,
  workflowCancel: OrchestrationCancelRequestSchema,
  workflowDefaultsRead: z.object({}).strict(),
  workflowDefaultsSave: WorkflowSettingsRequestSchema,
  workflowDefaultsClear: z.object({}).strict(),
  orchestrationList: z.object({}).strict(),
  orchestrationRead: z.object({ id: orchestrationId }).strict(),
  orchestrationSave: OrchestrationSaveRequestSchema,
  orchestrationRemove: z.object({ id: orchestrationId, expectedVersion: VersionTokenSchema }).strict(),
  orchestrationStart: OrchestrationStartRequestSchema,
  orchestrationGetRun: WorkflowRunRequestSchema,
  orchestrationListRuns: z.object({}).strict(),
  orchestrationApproveStep: OrchestrationApproveRequestSchema,
  orchestrationRejectStep: WorkflowRunRequestSchema,
  orchestrationRetryStep: OrchestrationRetryRequestSchema,
  orchestrationCancel: OrchestrationCancelRequestSchema,
  entityLayoutRead: z.object({}).strict(),
  entityLayoutSave: EntityLayoutRequestSchema,
};

const offlineDocumentMutations = new Set([
  "offlineDocumentsImportFiles", "offlineDocumentsImportDirectory", "offlineDocumentsSetEnabled", "offlineDocumentsSetVersion", "offlineDocumentsRemove",
]);
const windowResourceReads = new Set(["projectOverviewRead", "projectFileReadText", "projectMediaOpen", "chatAttachmentPrepare", "chatClipboardRead"]);

export function isTrustedSender(event: IpcMainInvokeEvent, window: BrowserWindow, rendererUrl: string): boolean {
  return event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === rendererUrl;
}

interface ProjectActions { open(root: string): Promise<WorkspaceState>; example(): Promise<WorkspaceState> }
interface IpcOptions {
  clipboard?: ClipboardReader;
  subscribeSessions?: (listener: (event: SessionEvent) => void) => () => void;
  projectActions?: ProjectActions;
  /** Hub's wrapper supplies this internal argument, overriding any renderer arguments. */
  requestController?: boolean;
  selectDiagnosticsExport?: () => Promise<string | undefined>;
  revealDirectory?: (path: string) => Promise<void> | void;
}
export function registerIpc(ipc: Pick<IpcMain, "handle">, controller: DesktopController | (() => DesktopController), window: () => BrowserWindow | undefined, rendererUrl: string, selectDirectory: () => Promise<string | undefined>, selectFiles: () => Promise<string[]> = async () => [], selectOfflineDirectory: () => Promise<string | undefined> = selectDirectory, selectSkillDirectory: () => Promise<string | undefined> = selectDirectory, selectSkillArchive: () => Promise<string | undefined> = async () => undefined, options: IpcOptions = {}): () => void {
  const currentController = typeof controller === "function" ? controller : () => controller;
  const owner = Symbol("SpecLoom window");
  let ownerEpoch = 0;
  const resourceControllers = new Set<DesktopController>();
  const revoke = () => { ownerEpoch++; for (const selected of resourceControllers) selected.revokeWindowResources?.(owner); resourceControllers.clear(); };
  const contents = window()?.webContents;
  const navigate = (_event: unknown, url: string) => { if (url !== rendererUrl) revoke(); };
  contents?.on?.("render-process-gone", revoke);
  contents?.on?.("destroyed", revoke);
  contents?.on?.("did-start-navigation", navigate);
  const unsubscribeMaterials = subscribeMaterialChanges((event) => {
    const target = window();
    if (target?.webContents.mainFrame.url !== rendererUrl || target.webContents.isDestroyed()) return;
    let projectPath: string;
    try { projectPath = currentController().currentCore().metadata.path; } catch { return; }
    const identity = (root: string) => process.platform === "win32" ? path.resolve(root).toLowerCase() : path.resolve(root);
    if (identity(projectPath) === identity(event.projectPath)) target.webContents.send("specloom:material", event);
  });
  const subscribeSessions = options.subscribeSessions ?? ((listener: (event: SessionEvent) => void) => currentController().sessions?.subscribe(listener));
  const unsubscribe = subscribeSessions((event) => {
    const target = window();
    // The event bridge only publishes to the currently trusted top-level renderer.
    if (target?.webContents.mainFrame.url === rendererUrl && !target.webContents.isDestroyed()) target.webContents.send("specloom:session", event);
  });
  // A workflow service binds a definition store and a run runner to one project.
  // The controller owns that single instance so the renderer and the agent
  // workflow tools observe the same runner; this bridge only forwards its durable
  // transitions to the currently trusted top-level renderer.
  let workflowWatcher: { controller: DesktopController; stop: () => void } | undefined;
  const sendWorkflowEvent = (channel: "specloom:workflow" | "specloom:orchestration", event: WorkflowUpdate | OrchestrationUpdate): void => {
    const target = window();
    if (!target || target.isDestroyed() || target.webContents.isDestroyed()) return;
    if (target.webContents.mainFrame.url !== rendererUrl) return;
    target.webContents.send(channel, event);
  };
  const watchWorkflow = (selected: DesktopController): void => {
    if (workflowWatcher?.controller === selected) return;
    workflowWatcher?.stop();
    const stopRuns = selected.subscribeWorkflowUpdates((event) => sendWorkflowEvent("specloom:workflow", event));
    const stopOrchestrations = selected.subscribeOrchestrationUpdates((event) => sendWorkflowEvent("specloom:orchestration", event));
    workflowWatcher = { controller: selected, stop: () => { stopRuns(); stopOrchestrations(); } };
  };
  const getWorkflow = (selected: DesktopController): WorkflowService => {
    watchWorkflow(selected);
    return selected.workflowService();
  };
  ipc.handle("specloom:invoke", async (event, operation: unknown, payload: unknown, requestController?: DesktopController) => {
    try {
      const target = window();
      if (!target || !isTrustedSender(event, target, rendererUrl)) throw new ProjectError("TASK_SCOPE_DENIED", "Untrusted IPC sender");
      const requestEpoch = ownerEpoch;
      if (typeof operation !== "string" || !Object.hasOwn(operations, operation)) throw new ProjectError("VALIDATION_FAILED", "Unknown desktop operation");
      // A workflow start carries a full definition snapshot plus run inputs, which
      // must stay inside the default 1 MiB document budget.
      const payloadLimit = operation === "sessionsImport" ? sessionFileLimit * 2 + 8192 : operation === "importMaterialImage" ? materialImagePayloadLimit + 8192 : operation === "sessionsSend" || operation === "sessionsGuide" ? 64 * 1024 * 1024 : operation === "saveDocument" || operation === "workflowSave" || operation === "orchestrationSave" ? 2_097_152 : 1_048_576;
      if (operation !== "chatAttachmentPrepare" && JSON.stringify(payload)?.length > payloadLimit) throw new ProjectError("VALIDATION_FAILED", "IPC payload exceeds the size limit");
      const schema = operations[operation as keyof typeof operations];
      const parsed = schema.safeParse(payload);
      if (!parsed.success) throw new ProjectError("VALIDATION_FAILED", "Invalid desktop operation arguments");
      const data = parsed.data as Record<string, unknown>;
      const selectedController = options.requestController ? requestController! : currentController();
      resourceControllers.add(selectedController);
      let result: unknown;
      switch (operation) {
        case "projectOverviewRead": result = await selectedController.readProjectOverview(data.projectPath as string); break;
        case "projectFileReadText": result = await selectedController.readProjectText(data.projectPath as string, data.path as string); break;
        case "projectMediaOpen": result = await selectedController.openProjectMedia(owner, data.projectPath as string, data.path as string); break;
        case "projectMediaRelease": for (const selected of resourceControllers) selected.releaseProjectMedia(owner, data.id as string); result = undefined; break;
        case "chatAttachmentPrepare": result = await selectedController.prepareChatAttachment(owner, data.projectPath as string, data.sessionId as string, data.requestId as string, data.input as ChatAttachmentInput); break;
        case "chatAttachmentCancel": selectedController.cancelChatAttachment(owner, data.projectPath as string, data.sessionId as string, data.requestId as string); break;
        case "chatClipboardRead": {
          selectedController.validateClipboardProject(data.projectPath as string);
          if (!options.clipboard) throw new ProjectError("BACKEND_UNAVAILABLE", "当前宿主无法读取剪贴板附件");
          result = await readChatClipboard(options.clipboard);
          selectedController.validateClipboardProject(data.projectPath as string);
          break;
        }
        case "workflowList": result = await getWorkflow(selectedController).list(); break;
        case "workflowRead": result = await getWorkflow(selectedController).read(data.id as string); break;
        case "workflowSave": result = await getWorkflow(selectedController).save(data.id as string, data.content as string, data.expectedVersion as z.infer<typeof VersionTokenSchema>); break;
        case "workflowRemove": await getWorkflow(selectedController).remove(data.id as string, data.expectedVersion as z.infer<typeof VersionTokenSchema>); result = undefined; break;
        case "workflowCopyOfficial": result = await getWorkflow(selectedController).copyOfficial(data.id as string); break;
        case "workflowStart": result = await getWorkflow(selectedController).start(data.definition as WorkflowDefinition, data.inputs as WorkflowRunInputs); break;
        case "workflowGetRun": result = await getWorkflow(selectedController).getRun(data.runId as string); break;
        case "workflowListRuns": result = await getWorkflow(selectedController).listRuns(); break;
        case "workflowApprove": await getWorkflow(selectedController).approve(data.runId as string, data.digest as string); result = undefined; break;
        case "workflowReject": await getWorkflow(selectedController).reject(data.runId as string); result = undefined; break;
        case "workflowRetry": await getWorkflow(selectedController).retry(data.runId as string, data.action as WorkflowRetryAction); result = undefined; break;
        case "workflowCancel": await getWorkflow(selectedController).cancel(data.runId as string); result = undefined; break;
        case "workflowDefaultsRead": result = await getWorkflow(selectedController).defaultsRead(); break;
        case "workflowDefaultsSave": result = await getWorkflow(selectedController).defaultsSave(data.settings as WorkflowSettings); break;
        case "workflowDefaultsClear": result = await getWorkflow(selectedController).defaultsClear(); break;
        case "orchestrationList": result = await getWorkflow(selectedController).orchestrationList(); break;
        case "orchestrationRead": result = await getWorkflow(selectedController).orchestrationRead(data.id as string); break;
        case "orchestrationSave": result = await getWorkflow(selectedController).orchestrationSave(data.id as string, data.content as string, data.expectedVersion as z.infer<typeof VersionTokenSchema>); break;
        case "orchestrationRemove": await getWorkflow(selectedController).orchestrationRemove(data.id as string, data.expectedVersion as z.infer<typeof VersionTokenSchema>); result = undefined; break;
        case "orchestrationStart": result = await getWorkflow(selectedController).orchestrationStart(data.id as string, data.inputs as WorkflowRunInputs); break;
        case "orchestrationGetRun": result = await getWorkflow(selectedController).orchestrationGetRun(data.runId as string); break;
        case "orchestrationListRuns": result = await getWorkflow(selectedController).orchestrationListRuns(); break;
        case "orchestrationApproveStep": await getWorkflow(selectedController).orchestrationApproveStep(data.runId as string, data.digest as string); result = undefined; break;
        case "orchestrationRejectStep": await getWorkflow(selectedController).orchestrationRejectStep(data.runId as string); result = undefined; break;
        case "orchestrationRetryStep": await getWorkflow(selectedController).orchestrationRetryStep(data.runId as string, data.action as WorkflowRetryAction); result = undefined; break;
        case "orchestrationCancel": await getWorkflow(selectedController).orchestrationCancel(data.runId as string); result = undefined; break;
        case "entityLayoutRead": result = await new EntityLayoutStore(selectedController.currentCore().metadata.path).read(); break;
        case "entityLayoutSave": result = await new EntityLayoutStore(selectedController.currentCore().metadata.path).save(data.layout as EntityLayout); break;
        default: result = await dispatch(operation, data, selectedController, selectDirectory, selectFiles, selectOfflineDirectory, selectSkillDirectory, selectSkillArchive, options.projectActions, options.selectDiagnosticsExport, options.revealDirectory);
      }
      if (windowResourceReads.has(operation)) {
        const current = window();
        if (requestEpoch !== ownerEpoch || !current || !isTrustedSender(event, current, rendererUrl) || current.webContents.isDestroyed()) throw new ProjectError("TASK_SCOPE_DENIED", "资源请求所属窗口已失效");
      }
      if (["openProject", "selectProject", "createExample"].includes(operation)) revoke();
      if (operation === "sessionsRemove" || (operation === "sessionsPatch" && (data.patch as { archived?: boolean }).archived)) selectedController.cancelSessionAttachments?.(data.sessionId as string);
      if (offlineDocumentMutations.has(operation)) {
        // Delivery can race with navigation or closure after a durable operation succeeds.
        try {
          const current = window();
          if (current && !current.isDestroyed() && !current.webContents.isDestroyed() && current.webContents.mainFrame.url === rendererUrl) {
            current.webContents.send("specloom:offline-documents-changed");
          }
        } catch { /* A failed observer must not change the completed operation's result. */ }
      }
      return { ok: true, data: result };
    } catch (error) { return { ok: false, error: serializeError(error) }; }
  });
  return () => {
    workflowWatcher?.stop();
    workflowWatcher = undefined;
    unsubscribe?.(); unsubscribeMaterials(); revoke();
    contents?.removeListener?.("render-process-gone", revoke);
    contents?.removeListener?.("destroyed", revoke);
    contents?.removeListener?.("did-start-navigation", navigate);
  };
}

async function dispatch(operation: string, input: Record<string, unknown>, controller: DesktopController, selectDirectory: () => Promise<string | undefined>, selectFiles: () => Promise<string[]>, selectOfflineDirectory: () => Promise<string | undefined>, selectSkillDirectory: () => Promise<string | undefined>, selectSkillArchive: () => Promise<string | undefined>, projects?: ProjectActions, selectDiagnosticsExport?: () => Promise<string | undefined>, revealDirectory?: (path: string) => Promise<void> | void): Promise<unknown> {
  switch (operation) {
    case "pluginsList": return controller.listProjectPlugins();
    case "pluginsSetGodotPluginEnabled": return controller.setProjectPluginEnabled(input.id as string, input.enabled as boolean);
    case "pluginsSetGodotMcpEnabled": return controller.setGodotMcpEnabled(input.enabled as boolean);
    case "pluginsInstallGodotMcp": return controller.installGodotMcp();
    case "pluginsRevealDirectory": {
      if (!revealDirectory) throw new ProjectError("BACKEND_UNAVAILABLE", "项目目录定位在当前宿主不可用");
      const verifiedPath = await controller.resolvePluginRevealTarget(input.target as string);
      await revealDirectory(verifiedPath);
      return true;
    }
    case "diagnosticsList": return controller.diagnosticsList(input.query as z.infer<typeof DiagnosticQuerySchema>);
    case "diagnosticsSummary": return controller.diagnosticsSummary();
    case "diagnosticsClearExpired": return controller.diagnosticsClearExpired();
    case "diagnosticsClearAll": return controller.diagnosticsClearAll();
    case "diagnosticsExport": {
      const destination = await selectDiagnosticsExport?.();
      if (!destination) return false;
      await controller.diagnosticsExport(destination);
      return true;
    }
    case "sessionsList": return controller.sessions.list(input.projectPath as string);
    case "sessionsCreate": return controller.sessions.create(input.projectPath as string, input.title as string | undefined, input.taskId as string | undefined);
    case "sessionsPatch": return controller.sessions.patch(input.projectPath as string, input.sessionId as string, input.patch as z.infer<typeof SessionPatchSchema>);
    case "sessionsRemove": return controller.sessions.remove(input.projectPath as string, input.sessionId as string);
    case "sessionsExport": return controller.sessions.export(input.projectPath as string, input.sessionId as string);
    case "sessionsImport": return controller.sessions.import(input.projectPath as string, input.json as string);
    case "sessionsSend": return controller.sessions.send(input.projectPath as string, input.sessionId as string, input.prompt as string, input.draftRevision as number | undefined, input.images as z.infer<typeof ChatImageAttachmentSchema>[] | undefined);
    case "sessionsGuide": return controller.sessions.guide(input.projectPath as string, input.sessionId as string, input.runId as string, input.guidanceId as string, input.prompt as string, input.images as z.infer<typeof ChatImageAttachmentSchema>[] | undefined);
    case "sessionsCancel": return controller.sessions.cancel(input.projectPath as string, input.sessionId as string);
    case "sessionsAnswer": return controller.sessions.answer(input.projectPath as string, input.sessionId as string, input.runId as string, input.questionId as string, input.answers as z.infer<typeof AnswerSchema>);
    case "sessionsApprove": return controller.sessions.approve(input.projectPath as string, input.sessionId as string, input.runId as string, input.approvalId as string, input.approved as boolean);
    case "state": return controller.state();
    case "selectProject": { const root = await selectDirectory(); return root ? projects ? projects.open(root) : controller.openProject(root) : controller.state(); }
    case "openProject": return projects ? projects.open(input.path as string) : controller.openProject(input.path as string);
    case "forgetProject": return controller.forgetProject(input.path as string);
    case "updatePreferences": return controller.updatePreferences(input.patch as Partial<Preferences>);
    case "openGodot": return controller.openGodot();
    case "openExternalEditor": return controller.openExternalEditor();
    case "removeTask": return controller.removeTask(input.taskId as string);
    case "createExample": return projects ? projects.example() : controller.createExample();
    case "createTask": return controller.createTask(input.scope as z.infer<typeof TaskScopeSpecSchema>);
    case "tool": return controller.currentCore().executeTool(input.taskId as string, input.name as string, input.input as Record<string, unknown>);
    case "preview": return controller.currentCore().previewChanges(input.taskId as string);
    case "approve": return controller.currentCore().approveChanges(input.taskId as string, input.digest as string);
    case "reject": return controller.currentCore().rejectChanges(input.taskId as string);
    case "validate": return controller.currentCore().validate(input.taskId as string);
    case "agent": return controller.agent(input.taskId as string, input.modelId as string | z.infer<typeof ModelReferenceSchema>, input.prompt as string);
    case "chat": return controller.chat(input.modelId as string | z.infer<typeof ModelReferenceSchema>, input.prompt as string, input.previousMessages as { role: "user" | "assistant"; content: string }[] | undefined);
    case "cancel": return controller.cancel(input.taskId as string);
    case "cancelChat": return controller.cancelChat();
    case "saveModel": return controller.saveModel(input.profile as z.infer<typeof ModelProfileSchema>, input.secret as string | undefined);
    case "removeModel": return controller.vault.remove(input.id as string);
    case "saveProvider": return controller.saveProvider(input.input as z.infer<typeof ProviderInputSchema>, input.secret as string | undefined);
    case "removeProvider": return controller.removeProvider(input.id as string);
    case "addProviderModels": return controller.addProviderModels(input.id as string, input.models as string[]);
    case "removeProviderModel": return controller.removeProviderModel(input.id as string, input.model as string);
    case "discoverProviderModels": return controller.discoverProviderModels(input.id as string);
    case "setDefaultModel": return controller.setDefaultModel(input.reference as z.infer<typeof ModelReferenceSchema> | null);
    case "setSessionModel": return controller.setSessionModel(input.preference as z.infer<typeof SessionModelPreferenceSchema> | null);
    case "documents": return controller.currentCore().documents();
    case "projectTree": return controller.currentCore().projectTree();
    case "readDocument": return controller.readDocument(input.path as string, input.expectedVersion as z.infer<typeof VersionTokenSchema>);
    case "saveDocument": return controller.saveDocument(input.projectPath as string, input.path as string, input.content as string, input.expectedVersion as z.infer<typeof VersionTokenSchema>);
    case "importMaterialImage": return controller.importMaterialImage(input.projectPath as string, input.dataUrl as string);
    case "readMaterialImage": return controller.readMaterialImage(input.projectPath as string, input.path as string);
    case "readWorkspacePrompt": return controller.readWorkspacePrompt(input.projectPath as string);
    case "saveWorkspacePrompt": return controller.saveWorkspacePrompt(input.projectPath as string, input.content as string, input.expectedVersion as z.infer<typeof VersionTokenSchema>);
    case "offlineDocumentsList": return controller.offlineDocumentList();
    case "offlineDocumentsImportFiles": return controller.offlineDocumentImportFiles(input.paths as string[], input.name as string, input.version as string, input.enabled as boolean, { ...(input.setCurrent === undefined ? {} : { setCurrent: input.setCurrent as boolean }) } as OfflineDocumentImportOptions);
    case "offlineDocumentsImportDirectory": return controller.offlineDocumentImportDirectory(input.path as string, input.name as string, input.version as string, input.enabled as boolean, { ...(input.setCurrent === undefined ? {} : { setCurrent: input.setCurrent as boolean }) } as OfflineDocumentImportOptions);
    case "offlineDocumentsSetEnabled": return controller.offlineDocumentSetEnabled(input.id as string, input.enabled as boolean);
    case "offlineDocumentsSetVersion": return controller.offlineDocumentSetVersion(input.id as string, input.versionId as string);
    case "offlineDocumentsRead": return controller.offlineDocumentRead(input.id as string, input.versionId as string | undefined, input.path as string);
    case "offlineDocumentsRemove": return controller.offlineDocumentRemove(input.id as string, input.versionId as string | undefined);
    case "offlineDocumentsSelectFiles": return selectFiles();
    case "offlineDocumentsSelectDirectory": return selectOfflineDirectory();
    case "hooksList": return controller.listHooks();
    case "hooksSave": return controller.saveHook(input as z.infer<typeof HookDefinitionInputSchema>);
    case "hooksRemove": return controller.removeHook(input.id as string);
    case "hooksSetEnabled": return controller.setHookEnabled(input.id as string, input.enabled as boolean);
    case "hooksTest": return controller.testHook(input.id as string);
    case "skillsList": return controller.listSkills();
    case "skillsInstallDirectory": return controller.installSkill(input.path as string, input.options as { enabled?: boolean } | undefined);
    case "skillsInstallArchive": return controller.installSkillArchive(input.path as string, input.options as { enabled?: boolean } | undefined);
    case "skillsListProject": return controller.listProjectSkills(input.projectPath as string);
    case "skillsInstallProjectDirectory": return controller.installProjectSkill(input.path as string, input.projectPath as string, input.options as { enabled?: boolean; overwrite?: boolean } | undefined);
    case "skillsSetProjectEnabled": return controller.setProjectSkillEnabled(input.id as string, input.enabled as boolean, input.projectPath as string);
    case "skillsRemoveProject": return controller.removeProjectSkill(input.id as string, input.projectPath as string);
    case "skillsRefresh": return controller.refreshSkills();
    case "skillsSelectDirectory": return selectSkillDirectory();
    case "skillsSelectArchive": return selectSkillArchive();
    case "skillsSetEnabled": return controller.setSkillEnabled(input.id as string, input.enabled as boolean);
    case "skillsRemove": return controller.removeSkill(input.id as string);
    case "mcpConfigList": return controller.listMcpConfig(input.projectPath as string | undefined);
    case "mcpConfigSave": return controller.saveMcpConfig(input.scope as "global" | "project", input.projectPath as string | undefined, input.name as string, input.config as never);
    case "mcpConfigSetEnabled": return controller.setMcpEnabled(input.scope as "global" | "project", input.projectPath as string | undefined, input.name as string, input.enabled as boolean);
    case "mcpConfigRemove": return controller.removeMcpConfig(input.scope as "global" | "project", input.projectPath as string | undefined, input.name as string);
    case "mcpConfigTest": return controller.testMcpConfig(input.config as never);
    default: throw new ProjectError("VALIDATION_FAILED", "Unknown operation");
  }
}
