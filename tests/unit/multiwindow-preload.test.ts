import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../src/shared/desktop-api";

const electron = vi.hoisted(() => ({ exposeInMainWorld: vi.fn(), invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }));
vi.mock("electron", () => ({ contextBridge: { exposeInMainWorld: electron.exposeInMainWorld }, ipcRenderer: { invoke: electron.invoke, on: electron.on, removeListener: electron.removeListener } }));
afterEach(() => { vi.resetModules(); vi.resetAllMocks(); });

describe("multi-window preload change subscriptions", () => {
  it("forwards state invalidations without IPC metadata and detaches listeners", async () => {
    await import("../../src/main/preload");
    const api = electron.exposeInMainWorld.mock.calls[0]![1] as DesktopApi;
    const listener = vi.fn(); const close = api.onStateChanged!(listener);
    const receive = electron.on.mock.calls.find(call => call[0] === "specloom:state-changed")![1] as (event: unknown) => void;
    receive({ sender: "private" }); expect(listener).toHaveBeenCalledExactlyOnceWith();
    close(); expect(electron.removeListener).toHaveBeenCalledWith("specloom:state-changed", receive);
  });

  it("forwards only the project path for session metadata changes", async () => {
    await import("../../src/main/preload");
    const api = electron.exposeInMainWorld.mock.calls[0]![1] as DesktopApi;
    const listener = vi.fn(); const close = api.sessions!.subscribeChanges!(listener);
    const receive = electron.on.mock.calls.find(call => call[0] === "specloom:sessions-changed")![1] as (event: unknown, path: string) => void;
    receive({ sender: "private" }, "P"); expect(listener).toHaveBeenCalledExactlyOnceWith("P");
    close(); expect(electron.removeListener).toHaveBeenCalledWith("specloom:sessions-changed", receive);
  });
});
