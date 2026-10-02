import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import type { DesktopController } from "../../src/main/desktop-controller";
import { isTrustedSender, registerIpc } from "../../src/main/ipc";

const url = "file:///app/index.html";
function fixture() {
  const frame = { url };
  const contents = { mainFrame: frame };
  const window = { webContents: contents } as unknown as BrowserWindow;
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  return { window, event, contents };
}
describe("Desktop IPC authority", () => {
  it("accepts only the exact main frame and configured renderer URL", () => {
    const { event, window, contents } = fixture();
    expect(isTrustedSender(event, window, url)).toBe(true);
    expect(isTrustedSender({ ...event, senderFrame: { url } } as unknown as IpcMainInvokeEvent, window, url)).toBe(false);
    contents.mainFrame.url = "https://foreign.example";
    expect(isTrustedSender(event, window, url)).toBe(false);
  });
  it("rejects untrusted and malformed approval payloads before dispatch", async () => {
    const { event, window } = fixture();
    let handler: (event: IpcMainInvokeEvent, operation: unknown, input: unknown) => Promise<unknown> = async () => undefined;
    const ipc = { handle: (_channel: string, callback: typeof handler) => { handler = callback; } } as unknown as IpcMain;
    const approve = vi.fn();
    const controller = { currentCore: () => ({ approveChanges: approve }) } as unknown as DesktopController;
    registerIpc(ipc, controller, () => window, url, async () => undefined);
    expect(await handler(event, "approve", { taskId: "task", digest: "digest", grant: "*" })).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(await handler({ ...event, senderFrame: { url } } as unknown as IpcMainInvokeEvent, "approve", { taskId: "task", digest: "digest" })).toMatchObject({ ok: false, error: { code: "TASK_SCOPE_DENIED" } });
    expect(approve).not.toHaveBeenCalled();
    await handler(event, "approve", { taskId: "task", digest: "digest" });
    expect(approve).toHaveBeenCalledWith("task", "digest");
  });
});
