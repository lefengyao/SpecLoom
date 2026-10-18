import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import type { DesktopController } from "../../src/main/desktop-controller";
import { registerIpc } from "../../src/main/ipc";

const url = "file:///app/index.html";
function fixture() {
  const frame = { url };
  const contents = { mainFrame: frame, isDestroyed: () => false };
  const window = { webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow;
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  return { window, event };
}

describe("diagnostics IPC", () => {
  it("validates filters and exports only to a path selected by the main process", async () => {
    const { window, event } = fixture();
    let handler!: (event: IpcMainInvokeEvent, operation: unknown, input: unknown) => Promise<unknown>;
    const ipc = { handle: (_channel: string, callback: typeof handler) => { handler = callback; } } as unknown as IpcMain;
    const diagnosticsList = vi.fn(async () => ({ events: [], readIssues: 0 }));
    const diagnosticsExport = vi.fn(async () => undefined);
    const selectDiagnosticsExport = vi.fn(async () => "C:/Users/test/logs.jsonl");
    const controller = { diagnosticsList, diagnosticsExport } as unknown as DesktopController;
    registerIpc(ipc, controller, () => window, url, async () => undefined, undefined, undefined, undefined, undefined, { selectDiagnosticsExport });

    expect(await handler(event, "diagnosticsList", { query: { diagnosticId: "bad", limit: 200 } })).toMatchObject({ ok: false });
    expect(await handler(event, "diagnosticsList", { query: { limit: 200, prompt: "secret" } })).toMatchObject({ ok: false });
    expect(diagnosticsList).not.toHaveBeenCalled();
    expect(await handler(event, "diagnosticsList", { query: { limit: 20 } })).toMatchObject({ ok: true });
    expect(diagnosticsList).toHaveBeenCalledWith({ limit: 20 });

    expect(await handler(event, "diagnosticsExport", { path: "C:/attacker/path.jsonl" })).toMatchObject({ ok: false });
    expect(diagnosticsExport).not.toHaveBeenCalled();
    expect(await handler(event, "diagnosticsExport", {})).toEqual({ ok: true, data: true });
    expect(selectDiagnosticsExport).toHaveBeenCalledOnce();
    expect(diagnosticsExport).toHaveBeenCalledWith("C:/Users/test/logs.jsonl");
    expect(await handler({ ...event, senderFrame: { url } } as unknown as IpcMainInvokeEvent, "diagnosticsList", { query: { limit: 20 } })).toMatchObject({ ok: false, error: { code: "TASK_SCOPE_DENIED" } });
  });

  it("returns false when the save dialog is canceled", async () => {
    const { window, event } = fixture();
    let handler!: (event: IpcMainInvokeEvent, operation: unknown, input: unknown) => Promise<unknown>;
    const ipc = { handle: (_channel: string, callback: typeof handler) => { handler = callback; } } as unknown as IpcMain;
    const diagnosticsExport = vi.fn(async () => undefined);
    registerIpc(ipc, { diagnosticsExport } as unknown as DesktopController, () => window, url, async () => undefined, undefined, undefined, undefined, undefined, { selectDiagnosticsExport: async () => undefined });
    expect(await handler(event, "diagnosticsExport", {})).toEqual({ ok: true, data: false });
    expect(diagnosticsExport).not.toHaveBeenCalled();
  });
});
