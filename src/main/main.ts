import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, safeStorage } from "electron";
import { DesktopController } from "./desktop-controller";
import { registerIpc } from "./ipc";
import { ModelVault } from "./core/model-vault";
import { startMcpServer, type LocalMcpServer } from "./mcp-server";

let activeWindow: BrowserWindow | undefined;
let controller: DesktopController;
let mcp: LocalMcpServer | undefined;

if (!app.isPackaged && process.env.SPECLOOM_USER_DATA_DIR) app.setPath("userData", path.resolve(process.env.SPECLOOM_USER_DATA_DIR));

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 620,
    show: false,
    title: "SpecLoom",
    backgroundColor: "#f7f9f8",
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
  ipcMain.removeHandler("specloom:invoke");
  registerIpc(ipcMain, controller, () => activeWindow, rendererUrl, async () => {
    const selection = await dialog.showOpenDialog(window, { title: "选择 Godot 项目", properties: ["openDirectory"] });
    return selection.canceled ? undefined : selection.filePaths[0];
  });
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

void app.whenReady().then(async () => {
  const vault = new ModelVault(app.getPath("userData"), { isAvailable: () => safeStorage.isEncryptionAvailable(), encrypt: (value) => safeStorage.encryptString(value), decrypt: (value) => safeStorage.decryptString(value) });
  controller = new DesktopController(vault, app.getPath("userData"), path.join(app.getAppPath(), "skills"));
  mcp = await startMcpServer(() => controller.currentCore());
  controller.mcp = { url: mcp.url, token: mcp.token };
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  controller?.cancelAll();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => { controller?.cancelAll(); void mcp?.close(); });
