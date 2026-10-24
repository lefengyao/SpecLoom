import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi, MaterialChange } from "../shared/desktop-api";
import type { OfflineDocumentImportOptions } from "../shared/offline-documents";
import type { SessionDeltaEvent, SessionEvent } from "../shared/chat";
import type { WorkflowUpdate } from "../shared/workflow-api";
import type { OrchestrationUpdate } from "../shared/orchestration-api";

async function invoke<T>(operation: string, payload: unknown = {}): Promise<T> {
  const reply = await ipcRenderer.invoke("specloom:invoke", operation, payload) as { ok: true; data: T } | { ok: false; error: { message: string; code: string; details?: Record<string, unknown> } };
  // contextBridge drops custom Error properties; a cloned error record preserves code and details.
  if (!reply.ok) throw reply.error;
  return reply.data;
}

const api: DesktopApi = {
  projectOverview: { read: (projectPath) => invoke("projectOverviewRead", { projectPath }) },
  projectFiles: {
    readText: (projectPath, path) => invoke("projectFileReadText", { projectPath, path }),
    openMedia: (projectPath, path) => invoke("projectMediaOpen", { projectPath, path }),
    releaseMedia: (id) => invoke("projectMediaRelease", { id }),
  },
  chatAttachments: {
    prepare: (projectPath, sessionId, requestId, input) => invoke("chatAttachmentPrepare", { projectPath, sessionId, requestId, input }),
    cancel: (projectPath, sessionId, requestId) => invoke("chatAttachmentCancel", { projectPath, sessionId, requestId }),
    readClipboard: (projectPath) => invoke("chatClipboardRead", { projectPath }),
  },
  onStateChanged: (listener) => {
    const receive = () => listener();
    ipcRenderer.on("specloom:state-changed", receive);
    return () => { ipcRenderer.removeListener("specloom:state-changed", receive); };
  },
  onMaterialChanged: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, payload: MaterialChange) => listener(payload);
    ipcRenderer.on("specloom:material", receive);
    return () => { ipcRenderer.removeListener("specloom:material", receive); };
  },
  sessions: {
    subscribeChanges: (listener) => {
      const receive = (_event: Electron.IpcRendererEvent, projectPath: string) => listener(projectPath);
      ipcRenderer.on("specloom:sessions-changed", receive);
      return () => { ipcRenderer.removeListener("specloom:sessions-changed", receive); };
    },
    list: (projectPath) => invoke("sessionsList", { projectPath }),
    create: (projectPath, title, taskId) => invoke("sessionsCreate", { projectPath, ...(title ? { title } : {}), ...(taskId ? { taskId } : {}) }),
    patch: (projectPath, sessionId, patch) => invoke("sessionsPatch", { projectPath, sessionId, patch }),
    remove: (projectPath, sessionId) => invoke("sessionsRemove", { projectPath, sessionId }),
    export: (projectPath, sessionId) => invoke("sessionsExport", { projectPath, sessionId }),
    import: (projectPath, json) => invoke("sessionsImport", { projectPath, json }),
    send: (projectPath, sessionId, prompt, draftRevision, images) => invoke("sessionsSend", { projectPath, sessionId, prompt, ...(draftRevision === undefined ? {} : { draftRevision }), ...(images?.length ? { images } : {}) }),
    guide: (projectPath, sessionId, runId, guidanceId, prompt, images) => invoke("sessionsGuide", { projectPath, sessionId, runId, guidanceId, prompt, ...(images?.length ? { images } : {}) }),
    cancel: (projectPath, sessionId) => invoke("sessionsCancel", { projectPath, sessionId }),
    answer: (projectPath, sessionId, runId, questionId, answers) => invoke("sessionsAnswer", { projectPath, sessionId, runId, questionId, answers }),
    approve: (projectPath, sessionId, runId, approvalId, approved) => invoke("sessionsApprove", { projectPath, sessionId, runId, approvalId, approved }),
    subscribe: (listener) => {
      const receive = (_event: Electron.IpcRendererEvent, payload: SessionEvent) => listener(payload);
      ipcRenderer.on("specloom:session", receive);
      return () => { ipcRenderer.removeListener("specloom:session", receive); };
    },
    subscribeDelta: (listener) => {
      const receive = (_event: Electron.IpcRendererEvent, payload: SessionDeltaEvent) => listener(payload);
      ipcRenderer.on("specloom:session-delta", receive);
      return () => { ipcRenderer.removeListener("specloom:session-delta", receive); };
    },
  },
  entityLayout: {
    read: () => invoke("entityLayoutRead"),
    save: (layout) => invoke("entityLayoutSave", { layout }),
  },
  workflow: {
    list: () => invoke("workflowList"),
    read: (id) => invoke("workflowRead", { id }),
    save: (id, content, expectedVersion) => invoke("workflowSave", { id, content, expectedVersion }),
    remove: async (id, expectedVersion) => { await invoke("workflowRemove", { id, expectedVersion }); },
    copyOfficial: (id) => invoke("workflowCopyOfficial", { id }),
    start: (definition, inputs) => invoke("workflowStart", { definition, inputs }),
    startForTask: (taskId, message) => invoke("workflowStartForTask", { taskId, ...(message === undefined ? {} : { message }) }),
    startForChat: (input) => invoke("workflowStartForChat", { input }),
    getRun: (runId) => invoke("workflowGetRun", { runId }),
    listRuns: () => invoke("workflowListRuns"),
    approve: async (runId, digest) => { await invoke("workflowApprove", { runId, digest }); },
    reject: async (runId) => { await invoke("workflowReject", { runId }); },
    retry: async (runId, action) => { await invoke("workflowRetry", { runId, action }); },
    cancel: async (runId) => { await invoke("workflowCancel", { runId }); },
    defaults: {
      read: () => invoke("workflowDefaultsRead"),
      save: (settings) => invoke("workflowDefaultsSave", { settings }),
      clear: () => invoke("workflowDefaultsClear"),
    },
    orchestrations: {
      list: () => invoke("orchestrationList"),
      read: (id) => invoke("orchestrationRead", { id }),
      save: (id, content, expectedVersion) => invoke("orchestrationSave", { id, content, expectedVersion }),
      remove: async (id, expectedVersion) => { await invoke("orchestrationRemove", { id, expectedVersion }); },
      start: (id, inputs) => invoke("orchestrationStart", { id, inputs }),
      getRun: (runId) => invoke("orchestrationGetRun", { runId }),
      listRuns: () => invoke("orchestrationListRuns"),
      approveStep: async (runId, digest) => { await invoke("orchestrationApproveStep", { runId, digest }); },
      rejectStep: async (runId) => { await invoke("orchestrationRejectStep", { runId }); },
      retryStep: async (runId, action) => { await invoke("orchestrationRetryStep", { runId, action }); },
      cancel: async (runId) => { await invoke("orchestrationCancel", { runId }); },
    },
    onUpdate: (listener) => {
      const receive = (_event: Electron.IpcRendererEvent, payload: WorkflowUpdate) => listener(payload);
      ipcRenderer.on("specloom:workflow", receive);
      return () => { ipcRenderer.removeListener("specloom:workflow", receive); };
    },
    onOrchestrationUpdate: (listener) => {
      const receive = (_event: Electron.IpcRendererEvent, payload: OrchestrationUpdate) => listener(payload);
      ipcRenderer.on("specloom:orchestration", receive);
      return () => { ipcRenderer.removeListener("specloom:orchestration", receive); };
    },
  },
  diagnostics: {
    list: (query) => invoke("diagnosticsList", { query }),
    summary: () => invoke("diagnosticsSummary"),
    clearExpired: () => invoke("diagnosticsClearExpired"),
    clearAll: () => invoke("diagnosticsClearAll"),
    export: () => invoke("diagnosticsExport"),
  },
  usage: {
    list: () => invoke("usageList"),
  },
  plugins: {
    list: () => invoke("specPluginsList"),
    setEnabled: (id, enabled) => invoke("specPluginsSetEnabled", { id, enabled }),
    invoke: (id, command, input) => invoke("specPluginsInvoke", { id, command, input }),
    install: () => invoke("specPluginsInstall"),
    uninstall: (id) => invoke("specPluginsUninstall", { id }),
    reveal: async (id) => { await invoke("specPluginsReveal", { id }); },
  },
  pluginManagement: {
    list: () => invoke("pluginsList"),
    setGodotPluginEnabled: (id, enabled) => invoke("pluginsSetGodotPluginEnabled", { id, enabled }),
    setGodotMcpEnabled: (enabled) => invoke("pluginsSetGodotMcpEnabled", { enabled }),
    installGodotMcp: () => invoke("pluginsInstallGodotMcp"),
    revealDirectory: async (target) => { await invoke("pluginsRevealDirectory", { target }); },
  },
  state: () => invoke("state"), selectProject: () => invoke("selectProject"), openProject: (path) => invoke("openProject", { path }), closeProject: () => invoke("closeProject"), forgetProject: (path) => invoke("forgetProject", { path }), updatePreferences: (patch) => invoke("updatePreferences", { patch }), openGodot: () => invoke("openGodot"), openExternalEditor: () => invoke("openExternalEditor"), rotateMcp: () => invoke("rotateMcp"), removeTask: (taskId) => invoke("removeTask", { taskId }), createExample: () => invoke("createExample"),
  createTask: (scope) => invoke("createTask", { scope }), updateTaskScope: (taskId, scope) => invoke("updateTaskScope", { taskId, scope }), tool: (taskId, name, input) => invoke("tool", { taskId, name, input }),
  preview: (taskId) => invoke("preview", { taskId }), approve: (taskId, digest) => invoke("approve", { taskId, digest }),
  reject: (taskId) => invoke("reject", { taskId }), validate: (taskId) => invoke("validate", { taskId }),
  agent: (taskId, modelId, prompt) => invoke("agent", { taskId, modelId, prompt }), cancel: (taskId) => invoke("cancel", { taskId }),
  chat: (modelId, prompt, previousMessages) => invoke("chat", { modelId, prompt, ...(previousMessages === undefined ? {} : { previousMessages }) }),
  cancelChat: () => invoke("cancelChat"),
  saveModel: (profile, secret) => invoke("saveModel", { profile, ...(secret === undefined ? {} : { secret }) }), removeModel: (id) => invoke("removeModel", { id }),
  saveProvider: (input, secret) => invoke("saveProvider", { input, ...(secret === undefined ? {} : { secret }) }),
  removeProvider: (id) => invoke("removeProvider", { id }),
  addProviderModels: (id, models) => invoke("addProviderModels", { id, models }),
  removeProviderModel: (id, model) => invoke("removeProviderModel", { id, model }),
  discoverProviderModels: (id) => invoke("discoverProviderModels", { id }),
  setDefaultModel: (reference) => invoke("setDefaultModel", { reference }),
  setSessionModel: (preference) => invoke("setSessionModel", { preference }),
  readDocument: (path, expectedVersion) => invoke("readDocument", { path, expectedVersion }), documents: () => invoke("documents"), projectTree: () => invoke("projectTree"),
  saveDocument: (projectPath, path, content, expectedVersion) => invoke("saveDocument", { projectPath, path, content, expectedVersion }),
  importMaterialImage: (projectPath, dataUrl) => invoke("importMaterialImage", { projectPath, dataUrl }),
  readMaterialImage: (projectPath, path) => invoke("readMaterialImage", { projectPath, path }),
  readWorkspacePrompt: (projectPath) => invoke("readWorkspacePrompt", { projectPath }),
  saveWorkspacePrompt: (projectPath, content, expectedVersion) => invoke("saveWorkspacePrompt", { projectPath, content, expectedVersion }),
  offlineDocuments: {
    list: () => invoke("offlineDocumentsList"),
    subscribe: (listener) => {
      const receive = () => listener();
      ipcRenderer.on("specloom:offline-documents-changed", receive);
      return () => { ipcRenderer.removeListener("specloom:offline-documents-changed", receive); };
    },
    importFiles: (paths, name, version, enabled, options?: OfflineDocumentImportOptions) => invoke("offlineDocumentsImportFiles", { paths, name, version, enabled, ...(options?.setCurrent === undefined ? {} : { setCurrent: options.setCurrent }) }),
    importDirectory: (path, name, version, enabled, options?: OfflineDocumentImportOptions) => invoke("offlineDocumentsImportDirectory", { path, name, version, enabled, ...(options?.setCurrent === undefined ? {} : { setCurrent: options.setCurrent }) }),
    setEnabled: (id, enabled) => invoke("offlineDocumentsSetEnabled", { id, enabled }),
    setVersion: (id, versionId) => invoke("offlineDocumentsSetVersion", { id, versionId }),
    read: (id, versionId, path) => invoke("offlineDocumentsRead", { id, versionId, path }),
    remove: (id, versionId) => invoke("offlineDocumentsRemove", { id, ...(versionId === undefined ? {} : { versionId }) }),
    selectFiles: () => invoke<string[]>("offlineDocumentsSelectFiles"),
    selectDirectory: () => invoke<string | undefined>("offlineDocumentsSelectDirectory"),
  },
  hooks: {
    list: () => invoke("hooksList"),
    save: (input) => invoke("hooksSave", input),
    remove: (id) => invoke("hooksRemove", { id }),
    setEnabled: (id, enabled) => invoke("hooksSetEnabled", { id, enabled }),
    test: (id) => invoke("hooksTest", { id }),
  },
  skills: {
    list: () => invoke("skillsList"),
    installDirectory: async (path, options) => invoke("skillsInstallDirectory", { path, ...(options === undefined ? {} : { options }) }),
    installArchive: async (path, options) => invoke("skillsInstallArchive", { path, ...(options === undefined ? {} : { options }) }),
    listProject: (projectPath) => invoke("skillsListProject", { projectPath }),
    installProjectDirectory: (path, projectPath, options) => invoke("skillsInstallProjectDirectory", { path, projectPath, ...(options === undefined ? {} : { options }) }),
    setProjectEnabled: (id, enabled, projectPath) => invoke("skillsSetProjectEnabled", { id, enabled, projectPath }),
    removeProject: (id, projectPath) => invoke("skillsRemoveProject", { id, projectPath }),
    refresh: () => invoke("skillsRefresh"),
    setEnabled: (id, enabled) => invoke("skillsSetEnabled", { id, enabled }),
    remove: (id) => invoke("skillsRemove", { id }),
    selectDirectory: () => invoke<string | undefined>("skillsSelectDirectory"),
    selectArchive: () => invoke<string | undefined>("skillsSelectArchive"),
  },
  mcpConfig: {
    list: (projectPath) => invoke("mcpConfigList", projectPath === undefined ? {} : { projectPath }),
    save: (scope, projectPath, name, config) => invoke("mcpConfigSave", { scope, ...(projectPath === undefined ? {} : { projectPath }), name, config }),
    setEnabled: (scope, projectPath, name, enabled) => invoke("mcpConfigSetEnabled", { scope, ...(projectPath === undefined ? {} : { projectPath }), name, enabled }),
    remove: (scope, projectPath, name) => invoke("mcpConfigRemove", { scope, ...(projectPath === undefined ? {} : { projectPath }), name }),
    test: (config) => invoke("mcpConfigTest", { config }),
  },
};
api.providers = {
  list: async () => (await invoke<import("../shared/desktop-api").WorkspaceState>("state")).providers ?? [],
  save: (input, secret) => invoke("saveProvider", { input, ...(secret === undefined ? {} : { secret }) }),
  remove: (id) => invoke("removeProvider", { id }),
  fetchModels: (id) => invoke("discoverProviderModels", { id }),
  listModels: async (id) => {
    const result = await invoke<{ list: import("../shared/contracts").ProviderPublic[]; added: string[]; message: string }>("discoverProviderModels", { id });
    const provider = result.list.find((item) => item.id === id);
    return { ids: result.added, known: provider?.models ?? [] };
  },
  addModels: (id, models) => invoke("addProviderModels", { id, models }).then(async () => (await invoke<import("../shared/desktop-api").WorkspaceState>("state")).providers ?? []),
  test: async (id) => {
    try {
      const result = await invoke<{ message: string }>("discoverProviderModels", { id });
      return { ok: true, message: `连接成功，${result.message}` };
    } catch (error) {
      return { ok: false, message: typeof error === "object" && error !== null && "message" in error ? String(error.message) : "供应商连接失败" };
    }
  },
};
contextBridge.exposeInMainWorld("specloom", Object.freeze(api));
