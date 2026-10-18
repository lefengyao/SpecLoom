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
  it("authenticates guidance and accepts only its current-run message identity and content", async () => {
    const { event, window } = fixture();
    let handler: (event: IpcMainInvokeEvent, operation: unknown, input: unknown) => Promise<unknown> = async () => undefined;
    const ipc = { handle: (_channel: string, callback: typeof handler) => { handler = callback; } } as unknown as IpcMain;
    const guide = vi.fn(async () => ({ id: "s" }));
    registerIpc(ipc, { sessions: { guide, subscribe: vi.fn() } } as unknown as DesktopController, () => window, url, async () => undefined);
    const payload = { projectPath: "P", sessionId: "s", runId: "r", guidanceId: "g", prompt: "continue this work" };
    for (const patch of [{ runId: "" }, { guidanceId: "" }, { prompt: "" }, { approvalMode: "full" }, { model: { model: "other" } }, { images: [{ name: "a", mimeType: "image/png", base64: "" }] }]) expect(await handler(event, "sessionsGuide", { ...payload, ...patch })).toMatchObject({ ok: false });
    expect(await handler({ ...event, senderFrame: { url } } as unknown as IpcMainInvokeEvent, "sessionsGuide", payload)).toMatchObject({ ok: false, error: { code: "TASK_SCOPE_DENIED" } });
    expect(guide).not.toHaveBeenCalled();
    expect(await handler(event, "sessionsGuide", payload)).toMatchObject({ ok: true });
    expect(guide).toHaveBeenCalledWith("P", "s", "r", "g", "continue this work", undefined);
  });
  it("validates and authenticates permission selection and current invocation approvals", async () => {
    const { event, window } = fixture();
    let handler: (event: IpcMainInvokeEvent, operation: unknown, input: unknown) => Promise<unknown> = async () => undefined;
    const ipc = { handle: (_channel: string, callback: typeof handler) => { handler = callback; } } as unknown as IpcMain;
    const approve = vi.fn(async () => ({ id: "s" })); const patch = vi.fn(async () => ({ id: "s" }));
    registerIpc(ipc, { sessions: { approve, patch, subscribe: vi.fn() } } as unknown as DesktopController, () => window, url, async () => undefined);
    const payload = { projectPath: "P", sessionId: "s", runId: "r", approvalId: "a", approved: true };
    expect(await handler(event, "sessionsApprove", { ...payload, approved: "true" })).toMatchObject({ ok: false });
    expect(await handler(event, "sessionsApprove", { ...payload, grant: "*" })).toMatchObject({ ok: false });
    expect(await handler({ ...event, senderFrame: { url } } as unknown as IpcMainInvokeEvent, "sessionsApprove", payload)).toMatchObject({ ok: false, error: { code: "TASK_SCOPE_DENIED" } });
    expect(approve).not.toHaveBeenCalled();
    expect(await handler(event, "sessionsApprove", payload)).toMatchObject({ ok: true });
    expect(approve).toHaveBeenCalledWith("P", "s", "r", "a", true);
    for (const approvalMode of ["ask", "auto", "full"]) expect(await handler(event, "sessionsPatch", { projectPath: "P", sessionId: "s", patch: { approvalMode } })).toMatchObject({ ok: true });
    expect(await handler(event, "sessionsPatch", { projectPath: "P", sessionId: "s", patch: { approvalMode: "anything" } })).toMatchObject({ ok: false });
    expect(patch).toHaveBeenCalledTimes(3);
  });
  it("authenticates manual material writes and requires project and version identity", async () => {
    const { event, window } = fixture();
    let handler: (event: IpcMainInvokeEvent, operation: unknown, input: unknown) => Promise<unknown> = async () => undefined;
    const ipc = { handle: (_channel: string, callback: typeof handler) => { handler = callback; } } as unknown as IpcMain;
    const saveDocument = vi.fn(async () => ({ path: "specs/entities/hero.md" }));
    registerIpc(ipc, { saveDocument } as unknown as DesktopController, () => window, url, async () => undefined);
    const payload = { projectPath: "P", path: "specs/entities/hero.md", content: "entity", expectedVersion: "absent" };
    expect(await handler(event, "saveDocument", { ...payload, expectedVersion: "bad" })).toMatchObject({ ok: false });
    expect(await handler(event, "saveDocument", { ...payload, taskId: "forged" })).toMatchObject({ ok: false });
    expect(await handler({ ...event, senderFrame: { url } } as unknown as IpcMainInvokeEvent, "saveDocument", payload)).toMatchObject({ ok: false });
    expect(saveDocument).not.toHaveBeenCalled();
    expect(await handler(event, "saveDocument", payload)).toMatchObject({ ok: true });
    expect(saveDocument).toHaveBeenCalledWith("P", payload.path, "entity", "absent");
  });
  it("authenticates session operations and rejects forged task/permission patches", async () => {
    const { event, window } = fixture();
    let handler: (event: IpcMainInvokeEvent, operation: unknown, input: unknown) => Promise<unknown> = async () => undefined;
    const ipc = { handle: (_channel: string, callback: typeof handler) => { handler = callback; } } as unknown as IpcMain;
    const patch = vi.fn(async () => ({ id: "s" })); const answer = vi.fn(async () => ({ id: "s" }));
    registerIpc(ipc, { sessions: { patch, answer, subscribe: vi.fn() } } as unknown as DesktopController, () => window, url, async () => undefined);
    const base = { projectPath: "P", sessionId: "s" };
    expect(await handler(event, "sessionsPatch", { ...base, patch: { taskId: "forged" } })).toMatchObject({ ok: false });
    expect(await handler(event, "sessionsAnswer", { ...base, runId: "r", questionId: "q", answers: { f: "yes" }, approve: true })).toMatchObject({ ok: false });
    expect(await handler({ ...event, senderFrame: { url } } as unknown as IpcMainInvokeEvent, "sessionsPatch", { ...base, patch: { draft: "hi" } })).toMatchObject({ ok: false, error: { code: "TASK_SCOPE_DENIED" } });
    expect(patch).not.toHaveBeenCalled(); expect(answer).not.toHaveBeenCalled();
    expect(await handler(event, "sessionsAnswer", { ...base, runId: "r", questionId: "q", answers: { f: "yes" } })).toMatchObject({ ok: true });
    expect(answer).toHaveBeenCalledWith("P", "s", "r", "q", { f: "yes" });
  });
  it("validates and authenticates the dedicated workspace prompt operations", async () => {
    const { event, window } = fixture();
    let handler: (event: IpcMainInvokeEvent, operation: unknown, input: unknown) => Promise<unknown> = async () => undefined;
    const ipc = { handle: (_channel: string, callback: typeof handler) => { handler = callback; } } as unknown as IpcMain;
    const readWorkspacePrompt = vi.fn(async () => ({ content: "项目要求", version: "absent" }));
    const saveWorkspacePrompt = vi.fn(async () => ({ content: "新要求", version: "absent" }));
    registerIpc(ipc, { readWorkspacePrompt, saveWorkspacePrompt } as unknown as DesktopController, () => window, url, async () => undefined);
    const payload = { projectPath: "C:/Godot/test", content: "新要求", expectedVersion: "absent" };
    expect(await handler(event, "saveWorkspacePrompt", { ...payload, content: "x".repeat(16001) })).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(await handler(event, "saveWorkspacePrompt", { ...payload, path: "../escape.md" })).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(await handler(event, "saveWorkspacePrompt", { ...payload, expectedVersion: "bad" })).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(await handler({ ...event, senderFrame: { url } } as unknown as IpcMainInvokeEvent, "saveWorkspacePrompt", payload)).toMatchObject({ ok: false, error: { code: "TASK_SCOPE_DENIED" } });
    expect(saveWorkspacePrompt).not.toHaveBeenCalled();
    expect(await handler(event, "readWorkspacePrompt", { projectPath: payload.projectPath })).toMatchObject({ ok: true, data: { content: "项目要求" } });
    expect(await handler(event, "saveWorkspacePrompt", payload)).toMatchObject({ ok: true, data: { content: "新要求" } });
    expect(readWorkspacePrompt).toHaveBeenCalledWith(payload.projectPath);
    expect(saveWorkspacePrompt).toHaveBeenCalledWith(payload.projectPath, payload.content, payload.expectedVersion);
  });
  it("exposes the project tree only to the trusted renderer with an empty payload", async () => {
    const { event, window } = fixture();
    let handler: (event: IpcMainInvokeEvent, operation: unknown, input: unknown) => Promise<unknown> = async () => undefined;
    const ipc = { handle: (_channel: string, callback: typeof handler) => { handler = callback; } } as unknown as IpcMain;
    const entries = [{ path: "scenes", kind: "directory" as const }];
    const projectTree = vi.fn(async () => entries);
    const controller = { currentCore: () => ({ projectTree }) } as unknown as DesktopController;
    registerIpc(ipc, controller, () => window, url, async () => undefined);
    expect(await handler(event, "projectTree", { prefix: ".." })).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(projectTree).not.toHaveBeenCalled();
    expect(await handler(event, "projectTree", {})).toEqual({ ok: true, data: entries });
    expect(projectTree).toHaveBeenCalledOnce();
    expect(await handler({ ...event, senderFrame: { url } } as unknown as IpcMainInvokeEvent, "projectTree", {})).toMatchObject({ ok: false, error: { code: "TASK_SCOPE_DENIED" } });
  });

  it("validates plugin manager requests and reveals only backend-resolved directories", async () => {
    const { event, window } = fixture();
    let handler: (event: IpcMainInvokeEvent, operation: unknown, input: unknown) => Promise<unknown> = async () => undefined;
    const ipc = { handle: (_channel: string, callback: typeof handler) => { handler = callback; } } as unknown as IpcMain;
    const listProjectPlugins = vi.fn(async () => ({ godotMcp: { status: "missing", enabled: false, connected: false }, plugins: [], scanLimitReached: false }));
    const setProjectPluginEnabled = vi.fn(async () => ({ restartRequired: true }));
    const setGodotMcpEnabled = vi.fn(async () => ({ restartRequired: true }));
    const installGodotMcp = vi.fn(async () => ({ restartRequired: true, installedVersion: "1.1.0", changedPaths: [] }));
    const resolvePluginRevealTarget = vi.fn(async () => "C:/safe/project/addons/example");
    const revealDirectory = vi.fn(async () => undefined);
    const controller = { listProjectPlugins, setProjectPluginEnabled, setGodotMcpEnabled, installGodotMcp, resolvePluginRevealTarget } as unknown as DesktopController;
    registerIpc(ipc, controller, () => window, url, async () => undefined, undefined, undefined, undefined, undefined, { revealDirectory });

    expect(await handler(event, "pluginsSetGodotPluginEnabled", { id: "C:/private", enabled: true })).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(await handler(event, "pluginsRevealDirectory", { target: "C:/private" })).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(resolvePluginRevealTarget).not.toHaveBeenCalled();
    expect(revealDirectory).not.toHaveBeenCalled();
    await expect(handler(event, "pluginsList", {})).resolves.toMatchObject({ ok: true, data: { plugins: [] } });
    await expect(handler(event, "pluginsSetGodotPluginEnabled", { id: "addons/demo/plugin.cfg", enabled: false })).resolves.toMatchObject({ ok: true, data: { restartRequired: true } });
    await expect(handler(event, "pluginsSetGodotMcpEnabled", { enabled: false })).resolves.toMatchObject({ ok: true });
    await expect(handler(event, "pluginsInstallGodotMcp", {})).resolves.toMatchObject({ ok: true });
    await expect(handler(event, "pluginsRevealDirectory", { target: "addons/demo/plugin.cfg" })).resolves.toMatchObject({ ok: true, data: true });
    expect(revealDirectory).toHaveBeenCalledWith("C:/safe/project/addons/example");
    expect(setProjectPluginEnabled).toHaveBeenCalledWith("addons/demo/plugin.cfg", false);
    expect(setGodotMcpEnabled).toHaveBeenCalledWith(false);
    expect(installGodotMcp).toHaveBeenCalledOnce();
  });

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
  it("accepts only known preference fields and rejects unsupported values", async () => {
    const { event, window } = fixture();
    let handler: (event: IpcMainInvokeEvent, operation: unknown, input: unknown) => Promise<unknown> = async () => undefined;
    const ipc = { handle: (_channel: string, callback: typeof handler) => { handler = callback; } } as unknown as IpcMain;
    const updatePreferences = vi.fn(async (patch: unknown) => ({ patch }));
    const controller = { updatePreferences } as unknown as DesktopController;
    registerIpc(ipc, controller, () => window, url, async () => undefined);

    expect(await handler(event, "updatePreferences", { patch: { theme: "dark", grant: "*" } })).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(await handler(event, "updatePreferences", { patch: { theme: "neon" } })).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(await handler(event, "updatePreferences", { patch: { customInstructions: "x".repeat(4096) } })).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(updatePreferences).not.toHaveBeenCalled();

    expect(await handler(event, "updatePreferences", { patch: { theme: "dark", completionSound: false } })).toEqual({ ok: true, data: { patch: { theme: "dark", completionSound: false } } });
    expect(updatePreferences).toHaveBeenCalledOnce();
  });

  it("preserves actionable credential errors when chat crosses the IPC boundary", async () => {
    const { event, window } = fixture();
    let handler: (event: IpcMainInvokeEvent, operation: unknown, input: unknown) => Promise<unknown> = async () => undefined;
    const ipc = { handle: (_channel: string, callback: typeof handler) => { handler = callback; } } as unknown as IpcMain;
    const chat = vi.fn(async () => {
      // Simulate an error crossing a bundled module boundary: the prototype
      // is not the main process's ProjectError constructor.
      throw Object.assign(new Error("供应商密钥已失效，请进入“供应商 → 编辑供应商”重新输入 API 密钥后保存。"), {
        code: "BACKEND_UNAVAILABLE",
      });
    });
    registerIpc(ipc, { chat } as unknown as DesktopController, () => window, url, async () => undefined);

    await expect(handler(event, "chat", { modelId: "openai:gpt-4o", prompt: "你好" })).resolves.toEqual({
      ok: false,
      error: {
        name: "ProjectError",
        code: "BACKEND_UNAVAILABLE",
        message: "供应商密钥已失效，请进入“供应商 → 编辑供应商”重新输入 API 密钥后保存。",
      },
    });
    expect(chat).toHaveBeenCalledWith("openai:gpt-4o", "你好", undefined);
  });
});
