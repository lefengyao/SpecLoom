import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopController } from "../../src/main/desktop-controller";
import type { DesktopApi } from "../../src/shared/desktop-api";
import { ProjectError } from "../../src/main/core/errors";
import { registerIpc } from "../../src/main/ipc";

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: { invoke: electron.invoke, on: electron.on, removeListener: electron.removeListener },
}));

const rendererUrl = "file:///app/index.html";
const channel = "specloom:offline-documents-changed";
const closers: (() => void)[] = [];
afterEach(() => { for (const close of closers.splice(0)) close(); });

function renderer() {
  const frame = { url: rendererUrl };
  const contents = { mainFrame: frame, isDestroyed: vi.fn(() => false), send: vi.fn() };
  const window = { webContents: contents, isDestroyed: vi.fn(() => false) };
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  return { frame, contents, window, event };
}

function bridge(methods: Record<string, unknown>) {
  const current = renderer();
  let currentWindow: BrowserWindow | undefined = current.window as unknown as BrowserWindow;
  let invoke!: (event: IpcMainInvokeEvent, operation: unknown, input: unknown) => Promise<unknown>;
  const ipc = { handle: (_channel: string, handler: typeof invoke) => { invoke = handler; } } as unknown as IpcMain;
  const controller = methods as unknown as DesktopController;
  const selectFiles = vi.fn(async () => ["C:/docs/guide.md"]);
  const selectDirectory = vi.fn(async () => "C:/docs");
  closers.push(registerIpc(ipc, controller, () => currentWindow, rendererUrl, selectDirectory, selectFiles));
  return { ...current, invoke: (operation: string, input: unknown) => invoke(current.event, operation, input), setWindow: (next?: BrowserWindow) => { currentWindow = next; } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((release) => { resolve = release; });
  return { promise, resolve };
}

const mutations = [
  { operation: "offlineDocumentsImportFiles", method: "offlineDocumentImportFiles", input: { paths: ["C:/docs/guide.md"], name: "Guide", version: "1", enabled: true } },
  { operation: "offlineDocumentsImportDirectory", method: "offlineDocumentImportDirectory", input: { path: "C:/docs", name: "Guide", version: "1", enabled: true } },
  { operation: "offlineDocumentsSetEnabled", method: "offlineDocumentSetEnabled", input: { id: "guide", enabled: true } },
  { operation: "offlineDocumentsSetVersion", method: "offlineDocumentSetVersion", input: { id: "guide", versionId: "v1" } },
  { operation: "offlineDocumentsRemove", method: "offlineDocumentRemove", input: { id: "guide", versionId: "v1" } },
];

describe("Offline document change bridge", () => {
  it.each(mutations)("notifies after $operation succeeds without changing its response", async ({ operation, method, input }) => {
    const result = operation === "offlineDocumentsRemove" ? undefined : { id: "guide", versions: [{ id: "v1" }] };
    const dispatch = vi.fn(async () => result);
    const fixture = bridge({ [method]: dispatch });
    await expect(fixture.invoke(operation, input)).resolves.toEqual({ ok: true, data: result });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(fixture.contents.send).toHaveBeenCalledExactlyOnceWith(channel);
  });

  it.each(mutations)("preserves $operation failures without publishing a change", async ({ operation, method, input }) => {
    const failure = new ProjectError("VALIDATION_FAILED", "Document import failed", { path: "guide.md" });
    const fixture = bridge({ [method]: vi.fn(async () => { throw failure; }) });
    await expect(fixture.invoke(operation, input)).resolves.toEqual({
      ok: false, error: { name: "ProjectError", code: "VALIDATION_FAILED", message: failure.message, details: { path: "guide.md" } },
    });
    expect(fixture.contents.send).not.toHaveBeenCalled();
  });

  it("does not notify for list, read, pickers or invalid mutation payloads", async () => {
    const fixture = bridge({ offlineDocumentList: async () => [], offlineDocumentRead: async () => ({ content: "Guide" }), offlineDocumentImportDirectory: vi.fn() });
    await expect(fixture.invoke("offlineDocumentsList", {})).resolves.toEqual({ ok: true, data: [] });
    await expect(fixture.invoke("offlineDocumentsRead", { id: "guide", path: "guide.md" })).resolves.toEqual({ ok: true, data: { content: "Guide" } });
    await expect(fixture.invoke("offlineDocumentsSelectFiles", {})).resolves.toEqual({ ok: true, data: ["C:/docs/guide.md"] });
    await expect(fixture.invoke("offlineDocumentsSelectDirectory", {})).resolves.toEqual({ ok: true, data: "C:/docs" });
    await expect(fixture.invoke("offlineDocumentsImportDirectory", {})).resolves.toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(fixture.contents.send).not.toHaveBeenCalled();
  });

  it("notifies the current renderer when an import completes after the initiating renderer was replaced", async () => {
    const pending = deferred<{ id: string }>();
    const dispatch = vi.fn(() => pending.promise);
    const fixture = bridge({ offlineDocumentImportDirectory: dispatch });
    const response = fixture.invoke(mutations[1]!.operation, mutations[1]!.input);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(fixture.contents.send).not.toHaveBeenCalled();
    const replacement = renderer();
    fixture.setWindow(replacement.window as unknown as BrowserWindow);
    pending.resolve({ id: "guide" });
    await expect(response).resolves.toEqual({ ok: true, data: { id: "guide" } });
    expect(fixture.contents.send).not.toHaveBeenCalled();
    expect(replacement.contents.send).toHaveBeenCalledExactlyOnceWith(channel);
  });

  it.each(["navigated", "window destroyed", "web contents destroyed", "no window"])("skips notification if the current renderer is %s when import completes", async (state) => {
    const pending = deferred<{ id: string }>();
    const fixture = bridge({ offlineDocumentImportDirectory: () => pending.promise });
    const response = fixture.invoke(mutations[1]!.operation, mutations[1]!.input);
    if (state === "navigated") fixture.frame.url = "https://untrusted.example";
    if (state === "window destroyed") fixture.window.isDestroyed.mockReturnValue(true);
    if (state === "web contents destroyed") {
      fixture.contents.isDestroyed.mockReturnValue(true);
      Object.defineProperty(fixture.contents, "mainFrame", { get: () => { throw new Error("Cannot access destroyed web contents"); } });
    }
    if (state === "no window") fixture.setWindow();
    pending.resolve({ id: "guide" });
    await expect(response).resolves.toEqual({ ok: true, data: { id: "guide" } });
    expect(fixture.contents.send).not.toHaveBeenCalled();
  });

  it("keeps a committed import successful when notification delivery throws", async () => {
    const result = { id: "guide" };
    const fixture = bridge({ offlineDocumentImportDirectory: async () => result });
    fixture.contents.send.mockImplementation(() => { throw new Error("Renderer closed during delivery"); });
    await expect(fixture.invoke(mutations[1]!.operation, mutations[1]!.input)).resolves.toEqual({ ok: true, data: result });
  });

  it("preload subscriptions detach the old page listener and notify its replacement", async () => {
    const listeners = new Set<() => void>();
    electron.on.mockImplementation((_name, listener: () => void) => { listeners.add(listener); });
    electron.removeListener.mockImplementation((_name, listener: () => void) => { listeners.delete(listener); });
    await import("../../src/main/preload");
    const api = electron.exposeInMainWorld.mock.calls[0]![1] as DesktopApi;
    const oldListener = vi.fn();
    const nextListener = vi.fn();
    expect(api.offlineDocuments?.subscribe).toBeTypeOf("function");
    const closeOld = api.offlineDocuments!.subscribe!(oldListener);
    closeOld();
    const closeNext = api.offlineDocuments!.subscribe!(nextListener);
    try {
      for (const listener of listeners) listener();
      expect(oldListener).not.toHaveBeenCalled();
      expect(nextListener).toHaveBeenCalledExactlyOnceWith();
      expect(electron.on).toHaveBeenCalledWith(channel, expect.any(Function));
      expect(electron.removeListener).toHaveBeenCalledWith(channel, expect.any(Function));
    } finally { closeNext(); }
    expect(listeners.size).toBe(0);
  });
});
