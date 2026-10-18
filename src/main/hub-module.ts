import type { HubRuntimeContext } from "../shared/hub-runtime";
import { clipboard, shell } from "electron";
import { join } from "node:path";
import type { SessionEvent } from "../shared/chat";
import { ProjectError } from "./core/errors";
import { registerIpc } from "./ipc";
import { HubWorkspaces, type HubWorkspaceLease } from "./hub-workspaces";

const projectSelections = new Set(["openProject", "selectProject", "createExample"]);
const sessionMutations = new Set(["sessionsCreate", "sessionsPatch", "sessionsRemove", "sessionsImport"]);
const taskMutations = new Set(["createTask", "removeTask", "tool", "approve", "reject", "validate", "agent", "cancel", "pluginsSetGodotPluginEnabled", "pluginsSetGodotMcpEnabled", "pluginsInstallGodotMcp"]);
const globalMutations = new Set([
  "updatePreferences", "forgetProject", "saveModel", "removeModel", "saveProvider", "removeProvider", "addProviderModels", "removeProviderModel", "discoverProviderModels", "setDefaultModel", "setSessionModel",
  "offlineDocumentsImportFiles", "offlineDocumentsImportDirectory", "offlineDocumentsSetEnabled", "offlineDocumentsSetVersion", "offlineDocumentsRemove",
  "hooksSave", "hooksRemove", "hooksSetEnabled", "skillsInstallDirectory", "skillsInstallArchive", "skillsSetEnabled", "skillsRemove", "skillsRefresh",
  "skillsInstallProjectDirectory", "skillsSetProjectEnabled", "skillsRemoveProject", "mcpConfigSave", "mcpConfigSetEnabled", "mcpConfigRemove",
]);
const closingReply = () => ({ ok: false, error: { code: "MODEL_ERROR", message: "SpecLoom 模块正在关闭" } });
function projectPath(lease?: HubWorkspaceLease): string {
  try { return lease?.controller.currentCore().metadata.path ?? ""; } catch { return ""; }
}

/** Each window selects a project; windows of that project share its backend. */
export async function createRuntime(context: HubRuntimeContext): Promise<{ dispose(): Promise<void> }> {
  if (context.apiVersion !== 1) throw new Error("Unsupported Hub runtime API");
  const pool = HubWorkspaces.forContext(context);
  const slot = pool.addWindow();
  let selected: HubWorkspaceLease | undefined;
  let unsubscribe: (() => void) | undefined;
  let disposal: Promise<void> | undefined;
  let disposing = false;
  let selectionTail: Promise<unknown> = Promise.resolve();
  const selections = new Set<Promise<unknown>>();
  const sessionListeners = new Set<(event: SessionEvent) => void>();
  const target = () => !disposing && !context.window.isDestroyed() ? context.window : undefined;
  const send = (channel: string, payload?: unknown) => {
    const window = target();
    if (window && !window.webContents.isDestroyed() && window.webContents.mainFrame.url === context.rendererUrl) window.webContents.send(channel, payload);
  };
  const current = () => {
    if (!selected) throw new ProjectError("MODEL_ERROR", "SpecLoom 模块正在初始化");
    return selected.controller;
  };
  const stopObserving = pool.subscribe({
    session: event => { if (selected && event.projectPath === projectPath(selected)) for (const listener of sessionListeners) listener(event); },
    changed: (channel, root) => { if (root === undefined || root === projectPath(selected)) send(channel, root); },
  });
  const dispose = () => {
    disposing = true;
    return disposal ??= Promise.resolve().then(async () => {
      unsubscribe?.(); stopObserving();
      // Releasing the final viewing window starts cancellation before waiting on sends.
      // Pinned calls belong to the shared backend. A peer viewing that project can
      // continue its run after this window closes; its final release drains them.
      const results = await Promise.allSettled([selected?.release(), ...selections]);
      pool.removeWindow(slot);
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    });
  };
  const select = (root: string, example = false) => {
    const result = selectionTail.then(async () => {
      if (disposing) throw new ProjectError("MODEL_ERROR", "SpecLoom 模块正在关闭");
      const previous = selected!;
      if (previous.controller.busy && previous.entry.refs === 1) throw new ProjectError("MODEL_ERROR", "先等待当前操作结束，再切换项目");
      const next = await pool.acquire(root, example);
      if (disposing) { await next.release(); throw new ProjectError("MODEL_ERROR", "SpecLoom 模块正在关闭"); }
      selected = next;
      await previous.release();
      return next.controller.state();
    });
    selectionTail = result.catch(() => undefined); return result;
  };
  try {
    selected = await pool.acquire("");
    if (context.window.isDestroyed()) throw new ProjectError("MODEL_ERROR", "SpecLoom 模块窗口已关闭");
    const ipc: HubRuntimeContext["ipc"] = {
      handle: (channel, listener) => context.ipc.handle(channel, (event, ...args) => {
        if (disposing) return closingReply();
        const result = Promise.resolve().then(async () => {
          await selectionTail;
          if (disposing) return closingReply();
          const lease = selected!;
          const operation = typeof args[0] === "string" ? args[0] : "";
          const invoke = async () => {
            const reply = await listener(event, args[0], args[1], lease.controller) as { ok: boolean; data?: unknown };
            if (reply.ok) {
              const data = reply.data;
              if (data && typeof data === "object" && "preferences" in data && "tasks" in data) Object.assign(data, { windowId: `hub-window-${slot}` });
              if (globalMutations.has(operation) || projectSelections.has(operation)) {
                pool.changed("specloom:state-changed");
                if (operation.startsWith("offlineDocuments")) pool.changed("specloom:offline-documents-changed");
              }
              if (taskMutations.has(operation)) pool.changed("specloom:state-changed", projectPath(lease));
              if (sessionMutations.has(operation)) pool.changed("specloom:sessions-changed", projectPath(lease));
            }
            return reply;
          };
          return projectSelections.has(operation) ? invoke() : pool.pin(lease, () => globalMutations.has(operation) ? pool.serial(invoke) : invoke());
        });
        if (projectSelections.has(typeof args[0] === "string" ? args[0] : "")) {
          selections.add(result); void result.finally(() => selections.delete(result)).catch(() => undefined);
        }
        return result;
      }),
    };
    unsubscribe = registerIpc(ipc, current, target, context.rendererUrl,
      async () => (await context.selectFiles({ title: "选择项目工作区", properties: ["openDirectory"] }))[0],
      () => context.selectFiles({ title: "导入离线文档", properties: ["openFile", "multiSelections"] }),
      async () => (await context.selectFiles({ title: "导入离线文档目录", properties: ["openDirectory"] }))[0],
      async () => (await context.selectFiles({ title: "安装 Skill", properties: ["openDirectory"] }))[0],
      async () => (await context.selectFiles({ title: "安装 Skill 归档", properties: ["openFile"], filters: [{ name: "Skill archive", extensions: ["zip", "tgz", "tar"] }] }))[0],
      {
        clipboard,
        requestController: true,
        revealDirectory: (directory) => { shell.showItemInFolder(directory); },
        subscribeSessions: listener => { sessionListeners.add(listener); return () => sessionListeners.delete(listener); },
        projectActions: { open: root => select(root), example: () => select("", true) },
        selectDiagnosticsExport: async () => {
          const [directory] = await context.selectFiles({ title: "选择诊断日志导出目录", properties: ["openDirectory", "createDirectory"] });
          return directory ? join(directory, `specloom-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`) : undefined;
        },
      });
    return { dispose };
  } catch (error) {
    await dispose().catch(() => undefined); throw error;
  }
}
