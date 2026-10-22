import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, shell } from "electron";
import { DesktopController } from "./desktop-controller";
import { registerIpc } from "./ipc";
import { ModelVault } from "./core/model-vault";
import { ProviderVault } from "./core/provider-vault";
import { startMcpServer, type LocalMcpServer } from "./mcp-server";
import { godotMcpHostRegistry } from "./core/godot-mcp/host-registry";
import { PluginManager } from "./core/plugins/plugin-manager";
import { registerPluginProtocol, registerPluginScheme } from "./plugins/plugin-protocol";

let activeWindow: BrowserWindow | undefined;
let controller: DesktopController;
let mcp: LocalMcpServer | undefined;
let plugins: PluginManager | undefined;
let unsubscribeSessionEvents: (() => void) | undefined;
let shutdownStarted = false;
let shutdownComplete = false;
let shutdownPromise: Promise<void> | undefined;
const applicationRoot = !app.isPackaged && process.env.SPECLOOM_DEV_APP_ROOT ? path.resolve(process.env.SPECLOOM_DEV_APP_ROOT) : app.getAppPath();

function cleanupBeforeQuit(): Promise<void> {
  shutdownPromise ??= Promise.allSettled([
    controller?.shutdown(),
    mcp?.close(),
    plugins?.close(),
    godotMcpHostRegistry.closeAll(),
  ]).then(() => undefined);
  return shutdownPromise;
}

function requestQuit(): void {
  if (shutdownStarted) return;
  shutdownStarted = true;
  void cleanupBeforeQuit().finally(() => { shutdownComplete = true; app.quit(); });
}

if (!app.isPackaged && process.env.SPECLOOM_USER_DATA_DIR) app.setPath("userData", path.resolve(process.env.SPECLOOM_USER_DATA_DIR));

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 620,
    show: false,
    title: "SpecLoom",
    icon: path.join(applicationRoot, app.isPackaged ? "dist/renderer/brand/icon.png" : "src/renderer/public/brand/icon.png"),
    backgroundColor: "#edf1e8",
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  activeWindow = window;
  window.removeMenu();

  const rendererFile = path.resolve(__dirname, "../renderer/index.html");
  const developmentUrl = !app.isPackaged ? process.env.SPECLOOM_DEV_SERVER_URL : undefined;
  const rendererUrl = developmentUrl ?? pathToFileURL(rendererFile).href;
  unsubscribeSessionEvents?.();
  ipcMain.removeHandler("specloom:invoke");
  const unsubscribe = registerIpc(ipcMain, controller, () => activeWindow, rendererUrl, async () => {
    const selection = await dialog.showOpenDialog(window, { title: "选择项目工作区", properties: ["openDirectory"] });
    return selection.canceled ? undefined : selection.filePaths[0];
  }, async () => {
    const selection = await dialog.showOpenDialog(window, { title: "导入离线文档", properties: ["openFile", "multiSelections"] });
    return selection.canceled ? [] : selection.filePaths;
  }, async () => {
    const selection = await dialog.showOpenDialog(window, { title: "导入离线文档目录", properties: ["openDirectory"] });
    return selection.canceled ? undefined : selection.filePaths[0];
  }, async () => {
    const selection = await dialog.showOpenDialog(window, { title: "安装 Skill", properties: ["openDirectory"] });
    return selection.canceled ? undefined : selection.filePaths[0];
  }, async () => {
    const selection = await dialog.showOpenDialog(window, { title: "安装 Skill 归档", properties: ["openFile"], filters: [{ name: "Skill archive", extensions: ["zip", "tgz", "tar"] }] });
    return selection.canceled ? undefined : selection.filePaths[0];
  }, {
    clipboard,
    revealDirectory: (target) => { shell.showItemInFolder(target); },
    selectPluginDirectory: async () => {
      const selection = await dialog.showOpenDialog(window, { title: "安装 SpecLoom 插件", properties: ["openDirectory"] });
      return selection.canceled ? undefined : selection.filePaths[0];
    },
    selectDiagnosticsExport: async () => {
      const selection = await dialog.showSaveDialog(window, { title: "导出诊断日志", defaultPath: "specloom-diagnostics.jsonl", filters: [{ name: "JSON Lines", extensions: ["jsonl"] }] });
      return selection.canceled ? undefined : selection.filePath;
    },
  });
  unsubscribeSessionEvents = unsubscribe;
  window.once("closed", () => { unsubscribe(); if (activeWindow === window) { activeWindow = undefined; unsubscribeSessionEvents = undefined; } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== rendererUrl) event.preventDefault();
  });
  window.once("ready-to-show", () => window.show());

  const loading = developmentUrl ? window.loadURL(developmentUrl) : window.loadFile(rendererFile);
  void loading.catch((error: unknown) => {
    console.error("Unable to load the SpecLoom renderer", error);
    app.quit();
  });
}

registerPluginScheme();

void app.whenReady().then(async () => {
  const vault = new ModelVault(app.getPath("userData"), { isAvailable: () => safeStorage.isEncryptionAvailable(), encrypt: (value) => safeStorage.encryptString(value), decrypt: (value) => safeStorage.decryptString(value) });
  const encryption = { isAvailable: () => safeStorage.isEncryptionAvailable(), encrypt: (value: string) => safeStorage.encryptString(value), decrypt: (value: Buffer) => safeStorage.decryptString(value) };
  controller = new DesktopController(vault, app.getPath("userData"), path.join(applicationRoot, "skills"), new ProviderVault(app.getPath("userData"), encryption), { chatAttachmentWorkerPath: path.join(__dirname, "chat-attachment-worker.cjs") });
  plugins = new PluginManager({
    builtinDirectory: app.isPackaged ? path.join(process.resourcesPath, "plugins") : path.join(applicationRoot, "resources", "plugins"),
    userDataDirectory: app.getPath("userData"),
    getProjectPath: () => { try { return controller.currentCore().metadata.path; } catch { return undefined; } },
  });
  controller.plugins = plugins;
  registerPluginProtocol(plugins);
  mcp = await startMcpServer(() => controller.currentCore());
  controller.mcp = { url: mcp.url, token: mcp.token };
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") requestQuit();
});

app.on("before-quit", (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  requestQuit();
});
