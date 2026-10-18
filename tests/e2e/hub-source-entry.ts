import { app, BrowserWindow, ipcMain, safeStorage, type IpcMainInvokeEvent } from "electron";
import { createRuntime } from "../../src/main/hub-module";

// A source test host supplies real BrowserWindows, preload isolation, native clipboard and per-window IPC routing.
const rendererUrl = process.env.SPECLOOM_DEV_SERVER_URL!;
const dataDirectory = process.env.SPECLOOM_USER_DATA_DIR!;
const moduleRoot = process.env.SPECLOOM_HUB_SMOKE_MODULE_ROOT!;
const preload = process.env.SPECLOOM_HUB_SMOKE_PRELOAD!;
app.setPath("userData", dataDirectory);
type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
const handlers = new Map<number, Map<string, Handler>>();
const runtimes = new Map<number, { dispose(): Promise<void> }>();
const disposals = new Set<Promise<void>>();
ipcMain.handle("specloom:invoke", (event, ...args: unknown[]) => {
  const handler = handlers.get(event.sender.id)?.get("specloom:invoke");
  if (!handler) throw new Error("The Hub smoke window has no module handler");
  return handler(event, ...args);
});

async function createModuleWindow(index: number) {
  const window = new BrowserWindow({ width: 1280, height: 900, show: false, title: `Hub source smoke ${index}`, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const id = window.webContents.id;
  const scoped = new Map<string, Handler>();
  handlers.set(id, scoped);
  const runtime = await createRuntime({
    apiVersion: 1, moduleRoot, dataDirectory, window, rendererUrl,
    ipc: { handle: (channel, listener) => { scoped.set(channel, listener); } },
    selectFiles: async () => [],
    encryption: { isAvailable: () => safeStorage.isEncryptionAvailable(), encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value) },
  });
  runtimes.set(id, runtime);
  window.once("closed", () => {
    handlers.delete(id); runtimes.delete(id);
    const closing = runtime.dispose(); disposals.add(closing);
    void closing.finally(() => disposals.delete(closing)).catch(() => undefined);
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => { if (url !== rendererUrl) event.preventDefault(); });
  await window.loadURL(rendererUrl);
  window.show();
}
let closing = false;
app.on("before-quit", event => {
  if (closing) return;
  closing = true; event.preventDefault();
  void Promise.allSettled([...runtimes.values()].map(runtime => runtime.dispose()).concat([...disposals])).then(() => app.exit());
});
void app.whenReady().then(async () => { await createModuleWindow(1); await createModuleWindow(2); });
