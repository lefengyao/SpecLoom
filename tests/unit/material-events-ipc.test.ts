import { expect, test, vi } from "vitest";
import type { BrowserWindow, IpcMain } from "electron";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { registerIpc } from "../../src/main/ipc";
import type { DesktopController } from "../../src/main/desktop-controller";
import { WorkspaceTools } from "../../src/main/core/tools/workspace-tools";

test("material saves publish only to the current trusted project renderer and unsubscribe on close", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "specloom-events-"));
  const tools = new WorkspaceTools(root, "events");
  const send = vi.fn(); const frame = { url: "file:///app/index.html" };
  let current = root;
  const controller = { currentCore: () => ({ metadata: { path: current } }) } as unknown as DesktopController;
  const window = { webContents: { mainFrame: frame, isDestroyed: () => false, send } } as unknown as BrowserWindow;
  const ipc = { handle: vi.fn() } as unknown as IpcMain;
  const close = registerIpc(ipc, controller, () => window, frame.url, async () => undefined);
  try {
    const file = await tools.execute("MaterialCreate", { category: "entity", id: "hero", title: "主角" });
    expect(send).toHaveBeenCalledWith("specloom:material", expect.objectContaining({ projectPath: root, path: "specs/entities/hero.md", version: expect.stringMatching(/^sha256:/) }));
    const count = send.mock.calls.length;
    current = path.join(root, "other");
    await tools.execute("MaterialCreate", { category: "entity", id: "hidden", title: "另一项目" });
    expect(send).toHaveBeenCalledTimes(count);
    current = root; frame.url = "https://untrusted.example";
    await tools.execute("MaterialCreate", { category: "entity", id: "untrusted", title: "不可信页面" });
    expect(send).toHaveBeenCalledTimes(count);
    frame.url = "file:///app/index.html"; close();
    await tools.execute("MaterialCreate", { category: "entity", id: "closed", title: "已关闭" });
    expect(send).toHaveBeenCalledTimes(count);
    expect(file).toBeDefined();
  } finally { close(); await tools.close(); await rm(root, { recursive: true, force: true }); }
});
