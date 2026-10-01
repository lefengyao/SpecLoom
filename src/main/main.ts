import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow } from "electron";

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
  window.removeMenu();

  const rendererFile = path.resolve(__dirname, "../renderer/index.html");
  const developmentUrl = !app.isPackaged ? process.env.SPECLOOM_DEV_SERVER_URL : undefined;
  const rendererUrl = developmentUrl ?? pathToFileURL(rendererFile).href;
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

void app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
