import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import type { WorkspaceState } from "../../src/shared/desktop-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime } from "../../src/main/hub-module";
import { DesktopSessions } from "../../src/main/desktop-sessions";
import type { ChatSession } from "../../src/shared/chat";
import type { HubRuntimeContext } from "../../src/shared/hub-runtime";
import { AgentRuntime } from "../../src/main/core/agent-runtime";
import { shell } from "electron";
import { randomUUID } from "node:crypto";
import type { ProjectMediaLease } from "../../src/shared/project-files";
import type { PreparedChatAttachment } from "../../src/shared/chat-attachments";

vi.mock("electron", () => ({ shell: { showItemInFolder: vi.fn() }, clipboard: { availableFormats: vi.fn(() => []), readBuffer: vi.fn(() => Buffer.alloc(0)), readImage: vi.fn(() => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), toPNG: () => Buffer.alloc(0) })), readText: vi.fn(() => "Hub clipboard text") } }));

const roots: string[] = [];
const runtimes: { dispose(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Hub runtime", () => {
  async function windowRuntime(dataDirectory: string, selectFiles: HubRuntimeContext["selectFiles"] = async () => []) {
    const rendererUrl = "file:///specloom/renderer/index.html";
    const send = vi.fn();
    const webContents = { mainFrame: { url: rendererUrl }, isDestroyed: () => false, send };
    const window = { webContents, isDestroyed: () => false } as unknown as BrowserWindow;
    let invoke!: (event: IpcMainInvokeEvent, operation: string, payload: unknown) => Promise<{ ok: boolean; data: unknown; error?: { message: string } }>;
    const context: HubRuntimeContext = {
      apiVersion: 1, moduleRoot: process.cwd(), dataDirectory, window, rendererUrl,
      ipc: { handle: (_channel, listener) => { invoke = listener as typeof invoke; } },
      selectFiles,
      encryption: { isAvailable: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => "" },
    };
    const runtime = await createRuntime(context); runtimes.push(runtime);
    const event = { sender: webContents, senderFrame: webContents.mainFrame } as unknown as IpcMainInvokeEvent;
    return { runtime, send, reply: (operation: string, payload: unknown = {}) => invoke(event, operation, payload),
      call: async <T = WorkspaceState>(operation: string, payload: unknown = {}): Promise<T> => {
        const reply = await invoke(event, operation, payload);
        if (!reply.ok) throw new Error(reply.error?.message); return reply.data as T;
      } };
  }

  it("shares a project's sessions and MCP until its last window closes, without changing other window selection", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "specloom-hub-windows-")); roots.push(root);
    const [first, second] = await Promise.all([windowRuntime(root), windowRuntime(root)]);
    const example = await first.call("createExample"); const projectPath = example.project!.path;
    expect((await second.call("state")).project).toBeUndefined();
    const selected = await second.call("openProject", { path: projectPath });
    expect(selected.mcp?.url).toBe(example.mcp?.url);
    const session = await first.call<ChatSession>("sessionsCreate", { projectPath, title: "Shared history" });
    expect((await second.call<ChatSession[]>("sessionsList", { projectPath })).some(item => item.id === session.id)).toBe(true);
    await second.call("sessionsPatch", { projectPath, sessionId: session.id, patch: { draft: "Shared draft", title: "Changed in another window" } });
    expect((await first.call<ChatSession[]>("sessionsList", { projectPath })).find(item => item.id === session.id)?.draft).toBe("Shared draft");
    await first.runtime.dispose();
    expect((await fetch(selected.mcp!.url)).status).toBe(401);
    expect((await second.call("state")).project?.path).toBe(projectPath);
    await second.runtime.dispose();
    await expect(fetch(selected.mcp!.url)).rejects.toThrow();
  });

  it("keeps media capabilities isolated between windows when one releases, switches projects, or closes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "specloom-hub-media-owners-")); roots.push(root);
    const [first, second] = await Promise.all([windowRuntime(root), windowRuntime(root)]);
    const state = await first.call("createExample"); const projectPath = state.project!.path;
    await second.call("openProject", { path: projectPath });
    const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lN8AAAAASUVORK5CYII=", "base64");
    await writeFile(path.join(projectPath, "preview.png"), image);
    const one = await first.call<ProjectMediaLease>("projectMediaOpen", { projectPath, path: "preview.png" });
    const peer = await second.call<ProjectMediaLease>("projectMediaOpen", { projectPath, path: "preview.png" });
    await second.call("projectMediaRelease", { id: one.id });
    expect(Buffer.from(await (await fetch(one.url)).arrayBuffer())).toEqual(image);
    await first.call("createExample");
    expect((await fetch(one.url)).status).toBe(404);
    expect((await fetch(peer.url)).status).toBe(200);
    await expect(first.reply("projectMediaOpen", { projectPath, path: "preview.png" })).resolves.toMatchObject({ ok: false, error: { code: "INVALID_PROJECT" } });
    await first.runtime.dispose();
    expect((await fetch(peer.url)).status).toBe(200);
    const third = await windowRuntime(root); await third.call("openProject", { path: projectPath });
    const thirdLease = await third.call<ProjectMediaLease>("projectMediaOpen", { projectPath, path: "preview.png" });
    await second.runtime.dispose();
    expect((await fetch(peer.url)).status).toBe(404);
    expect((await fetch(thirdLease.url)).status).toBe(200);
    await third.runtime.dispose();
    await expect(fetch(thirdLease.url)).rejects.toThrow();
  });

  it("prepares actual text and clipboard content only for the selected project and existing active sessions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "specloom-hub-attachment-scope-")); roots.push(root);
    const [first, second] = await Promise.all([windowRuntime(root), windowRuntime(root)]);
    const state = await first.call("createExample"); const projectPath = state.project!.path;
    const other = await second.call("createExample");
    const session = await first.call<ChatSession>("sessionsCreate", { projectPath });
    const payload = { projectPath, sessionId: session.id, requestId: randomUUID(), input: { name: "notes.md", bytes: new Uint8Array(Buffer.from("# Real attachment context")) } };
    await expect(first.call<PreparedChatAttachment>("chatAttachmentPrepare", payload)).resolves.toMatchObject({ kind: "document", name: "notes.md", text: "# Real attachment context" });
    await expect(second.reply("chatAttachmentPrepare", { ...payload, requestId: randomUUID() })).resolves.toMatchObject({ ok: false, error: { code: "INVALID_PROJECT" } });
    await expect(first.reply("chatAttachmentPrepare", { ...payload, sessionId: "missing", requestId: randomUUID() })).resolves.toMatchObject({ ok: false, error: { code: "TASK_SCOPE_DENIED" } });
    await expect(first.reply("chatAttachmentPrepare", { ...payload, requestId: randomUUID(), input: { name: "invalid.txt", bytes: new Uint8Array([0xff]) } })).resolves.toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED", message: expect.stringContaining("UTF-8") } });
    await first.call("sessionsPatch", { projectPath, sessionId: session.id, patch: { archived: true } });
    await expect(first.reply("chatAttachmentPrepare", { ...payload, requestId: randomUUID() })).resolves.toMatchObject({ ok: false, error: { code: "TASK_SCOPE_DENIED" } });
    await expect(first.reply("chatClipboardRead", { projectPath })).resolves.toMatchObject({ ok: true, data: { files: [], text: "Hub clipboard text" } });
    await expect(second.reply("chatClipboardRead", { projectPath })).resolves.toMatchObject({ ok: false, error: { code: "INVALID_PROJECT" } });
    await expect(first.reply("chatClipboardRead", { projectPath, sourcePath: "C:/private/document.txt" })).resolves.toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect((await second.call("state")).project?.path).toBe(other.project!.path);
  });

  it("manages Godot plugins in the Hub module and resolves reveal targets in the main process", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "specloom-hub-plugin-manager-")); roots.push(dataDirectory);
    const hub = await windowRuntime(dataDirectory);
    const state = await hub.call("createExample");
    const projectRoot = state.project!.path;
    await mkdir(path.join(projectRoot, "addons/demo"), { recursive: true });
    await writeFile(path.join(projectRoot, "addons/demo/plugin.cfg"), '[plugin]\nname="Hub Demo"\ndescription="Hub plugin"\nscript="plugin.gd"\n');

    await expect(hub.call("pluginsList")).resolves.toMatchObject({ plugins: [{ id: "addons/demo/plugin.cfg", name: "Hub Demo" }] });
    await hub.call("pluginsSetGodotPluginEnabled", { id: "addons/demo/plugin.cfg", enabled: true });
    expect(await readFile(path.join(projectRoot, "project.godot"), "utf8")).toContain('"res://addons/demo/plugin.cfg"');
    await expect(hub.reply("pluginsRevealDirectory", { target: "addons/demo/plugin.cfg" })).resolves.toMatchObject({ ok: true, data: true });
    expect(shell.showItemInFolder).toHaveBeenCalledWith(path.join(projectRoot, "addons/demo"));
    await expect(hub.reply("pluginsRevealDirectory", { target: "C:/private" })).resolves.toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(shell.showItemInFolder).toHaveBeenCalledOnce();
  });

  it("isolates projects while sharing concurrent global preferences and serializing recent project writes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "specloom-hub-settings-")); roots.push(root);
    const [first, second] = await Promise.all([windowRuntime(root), windowRuntime(root)]);
    await Promise.all([first.call("state"), second.call("state")]);
    await Promise.all([first.call("updatePreferences", { patch: { customInstructions: "Shared instructions" } }), second.call("updatePreferences", { patch: { godotPath: "C:/Godot/godot.exe" } })]);
    const [one, two] = await Promise.all([first.call("createExample"), second.call("createExample")]);
    expect(one.project?.path).not.toBe(two.project?.path);
    const state = await first.call("state");
    expect(state.preferences.customInstructions).toBe("Shared instructions");
    expect(state.preferences.godotPath).toBe("C:/Godot/godot.exe");
    expect(state.recent.map(project => project.path)).toEqual(expect.arrayContaining([one.project!.path, two.project!.path]));
    const session = await second.call<ChatSession>("sessionsCreate", { projectPath: two.project!.path });
    expect((await first.call<ChatSession[]>("sessionsList", { projectPath: one.project!.path })).some(item => item.id === session.id)).toBe(false);
    await first.runtime.dispose();
    expect((await fetch(two.mcp!.url)).status).toBe(401);
    expect((await second.call("state")).project?.path).toBe(two.project?.path);
  });

  it("continues a shared run after its sending window closes, admits peer guidance and cancels on final close", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "specloom-hub-live-")); roots.push(root);
    const [first, second] = await Promise.all([windowRuntime(root), windowRuntime(root)]);
    const state = await first.call("createExample"); const projectPath = state.project!.path;
    await second.call("openProject", { path: projectPath });
    await first.call("saveProvider", { input: { id: "fixture", name: "Fixture", protocol: "openai", baseUrl: "http://127.0.0.1:1234/v1", models: ["fixture"], modelSettings: {} }, secret: "" });
    await first.call("setDefaultModel", { reference: { providerId: "fixture", model: "fixture" } });
    const session = await first.call<ChatSession>("sessionsCreate", { projectPath });
    let signal: AbortSignal | undefined;
    const execution = vi.spyOn(AgentRuntime.prototype, "run").mockImplementation(async options => {
      signal = options.signal;
      await new Promise<void>((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(new Error("Stopped by final window")), { once: true });
        if (signal!.aborted) reject(new Error("Stopped by final window"));
      });
      throw new Error("Unreachable");
    });
    try {
      let earlyReply: unknown;
      const send = first.reply("sessionsSend", { projectPath, sessionId: session.id, prompt: "Keep working" }).then(reply => { earlyReply = reply; return reply; });
      await vi.waitFor(() => expect(signal, JSON.stringify(earlyReply)).toBeDefined(), { timeout: 10000 });
      const running = (await second.call<ChatSession[]>("sessionsList", { projectPath })).find(item => item.id === session.id)!;
      expect(running.status).toBe("running");
      expect((await second.reply("sessionsSend", { projectPath, sessionId: session.id, prompt: "Duplicate" })).ok).toBe(false);
      expect(execution).toHaveBeenCalledTimes(1);
      await first.runtime.dispose();
      expect(signal!.aborted).toBe(false);
      expect((await fetch(state.mcp!.url)).status).toBe(401);
      const guided = await second.call<ChatSession>("sessionsGuide", { projectPath, sessionId: session.id, runId: running.runId, guidanceId: "peer", prompt: "Add this work" });
      expect(guided.items.some(item => item.kind === "message" && item.content === "Add this work")).toBe(true);
      await second.runtime.dispose();
      expect(signal!.aborted).toBe(true);
      expect((await send).ok).toBe(false);
      await expect(fetch(state.mcp!.url)).rejects.toThrow();
    } finally { execution.mockRestore(); }
  });

  it("keeps a failed project selection local and publishes metadata changes only to its project's windows", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "specloom-hub-notify-")); roots.push(root);
    const [first, second, third] = await Promise.all([windowRuntime(root), windowRuntime(root), windowRuntime(root)]);
    const state = await first.call("createExample"); const projectPath = state.project!.path;
    await second.call("openProject", { path: projectPath });
    await expect(second.call("openProject", { path: path.join(root, "missing-project") })).rejects.toThrow();
    expect((await second.call("state")).project?.path).toBe(projectPath);
    first.send.mockClear(); second.send.mockClear(); third.send.mockClear();
    const session = await first.call<ChatSession>("sessionsCreate", { projectPath });
    expect(second.send).toHaveBeenCalledWith("specloom:sessions-changed", projectPath);
    expect(third.send).not.toHaveBeenCalledWith("specloom:sessions-changed", projectPath);
    await first.call("sessionsRemove", { projectPath, sessionId: session.id });
    expect((await second.call<ChatSession[]>("sessionsList", { projectPath })).some(item => item.id === session.id)).toBe(false);
    await first.call("updatePreferences", { patch: { customInstructions: "Global notification" } });
    expect(third.send).toHaveBeenCalledWith("specloom:state-changed", undefined);
    expect((await third.call("state")).preferences.customInstructions).toBe("Global notification");
    expect((await third.call("state")).project).toBeUndefined();
  });

  it("refreshes recent projects in home windows and task lists only in the owning project's windows", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "specloom-hub-task-notify-")); roots.push(root);
    const [first, second, home] = await Promise.all([windowRuntime(root), windowRuntime(root), windowRuntime(root)]);
    const state = await first.call("createExample");
    expect(home.send).toHaveBeenCalledWith("specloom:state-changed", undefined);
    expect((await home.call("state")).recent.some(item => item.path === state.project!.path)).toBe(true);
    await second.call("openProject", { path: state.project!.path });
    first.send.mockClear(); second.send.mockClear(); home.send.mockClear();
    const task = await first.call<{ scope: { id: string } }>("createTask", { scope: { title: "Shared task", readPaths: ["*"], writePaths: [], allowDelete: false, mode: "manual" } });
    expect(second.send).toHaveBeenCalledWith("specloom:state-changed", state.project!.path);
    expect(home.send).not.toHaveBeenCalled();
    expect((await second.call("state")).tasks).toHaveLength(1);
    second.send.mockClear();
    await first.call("removeTask", { taskId: task.scope.id });
    expect(second.send).toHaveBeenCalledWith("specloom:state-changed", state.project!.path);
    expect((await second.call("state")).tasks).toHaveLength(0);
  });

  it("waits for retiring a project before a concurrent window reopens its history", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "specloom-hub-retire-")); roots.push(root);
    const first = await windowRuntime(root);
    const state = await first.call("createExample"); const projectPath = state.project!.path;
    let finish!: () => void;
    const barrier = new Promise<void>(resolve => { finish = resolve; });
    const shutdown = vi.spyOn(DesktopSessions.prototype, "shutdown").mockReturnValueOnce(barrier);
    try {
      const closing = first.runtime.dispose();
      await vi.waitFor(() => expect(shutdown).toHaveBeenCalled());
      const second = await windowRuntime(root);
      let opened = false;
      const opening = second.call("openProject", { path: projectPath }).then(value => { opened = true; return value; });
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(opened).toBe(false);
      finish(); await closing;
      expect((await opening).project?.path).toBe(projectPath);
    } finally { finish(); shutdown.mockRestore(); }
  });

  it("serves the existing desktop API from isolated storage and closes MCP on disposal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "specloom-hub-"));
    roots.push(root);
    const dataDirectory = path.join(root, "data");
    await mkdir(dataDirectory);
    const rendererUrl = "file:///specloom/renderer/index.html";
    const webContents = { mainFrame: { url: rendererUrl }, isDestroyed: () => false, send: () => undefined };
    const window = { webContents, isDestroyed: () => false } as unknown as BrowserWindow;
    let invoke!: (event: IpcMainInvokeEvent, operation: string, payload: unknown) => Promise<{ ok: boolean; data: WorkspaceState }>;
    const context = {
      apiVersion: 1 as const, moduleRoot: process.cwd(), dataDirectory, window, rendererUrl,
      ipc: { handle: (_channel: string, listener: Parameters<IpcMain["handle"]>[1]) => { invoke = listener as typeof invoke; } },
      selectFiles: async () => [],
      encryption: { isAvailable: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => "" },
    };
    const runtime = await createRuntime(context);
    runtimes.push(runtime);
    const event = { sender: webContents, senderFrame: webContents.mainFrame } as unknown as IpcMainInvokeEvent;
    const call = (operation: string, payload: unknown = {}) => invoke(event, operation, payload);
    const state = await call("state");
    expect(state.ok).toBe(true);
    const { url } = state.data.mcp as { url: string };
    expect((await fetch(url)).status).toBe(401);
    expect((await call("updatePreferences", { patch: { customInstructions: "Hub module persistence" } })).ok).toBe(true);
    expect(await stat(path.join(dataDirectory, "preferences.json"))).toBeTruthy();
    const untrusted = await invoke({ ...event, senderFrame: {} } as IpcMainInvokeEvent, "state", {});
    expect(untrusted.ok).toBe(false);
    let finishCancellation!: () => void;
    const cancelling = new Promise<void>((resolve) => { finishCancellation = resolve; });
    const cancellation = vi.spyOn(DesktopSessions.prototype, "cancelAll").mockReturnValueOnce(cancelling);
    let disposed = false;
    const closing = runtime.dispose().then(() => { disposed = true; });
    try {
      await vi.waitFor(() => expect(cancellation).toHaveBeenCalled());
      expect(disposed).toBe(false);
      expect((await call("state")).ok).toBe(false);
    } finally { finishCancellation(); }
    await Promise.all([closing, runtime.dispose()]);
    cancellation.mockRestore();
    await expect(fetch(url)).rejects.toThrow();
    const reopened = await createRuntime(context);
    runtimes.push(reopened);
    expect((await call("state")).data.preferences.customInstructions).toBe("Hub module persistence");
  });

  it("exports diagnostics into a Hub-selected directory without requiring a newer host API", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "specloom-hub-diagnostics-export-")); roots.push(root);
    const exportDirectory = path.join(root, "exports"); await mkdir(exportDirectory);
    const selectFiles = vi.fn(async options => {
      expect(options.title).toBe("选择诊断日志导出目录");
      expect(options.properties).toContain("openDirectory");
      return [exportDirectory];
    });
    const module = await windowRuntime(path.join(root, "data"), selectFiles);

    expect(await module.call("diagnosticsExport")).toBe(true);
    expect(selectFiles).toHaveBeenCalledOnce();
    const files = await readdir(exportDirectory);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^specloom-diagnostics-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.jsonl$/);
    expect(await stat(path.join(exportDirectory, files[0]!)).then(value => value.size)).toBe(0);
  });
})
