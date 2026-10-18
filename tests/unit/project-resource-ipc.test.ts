import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerIpc } from "../../src/main/ipc";
import { DesktopController } from "../../src/main/desktop-controller";
import type { ModelVault } from "../../src/main/core/model-vault";
import type { ProjectCore } from "../../src/main/core/project-core";
import { ChatAttachmentService } from "../../src/main/core/chat-attachments";
import type { ChatSession } from "../../src/shared/chat";
import type { ClipboardReader } from "../../src/main/chat-clipboard";

type Reply = { ok: boolean; data?: unknown; error?: { code: string; message: string } };
type Invoke = (event: IpcMainInvokeEvent, operation: string, payload: unknown) => Promise<Reply>;
const rendererUrl = "file:///specloom/renderer/index.html";
const disposals: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(fulfill => { resolve = fulfill; }); return { promise, resolve }; }
function bridge(controller: DesktopController, clipboard?: ClipboardReader) {
  const contents = Object.assign(new EventEmitter(), { mainFrame: { url: rendererUrl }, isDestroyed: () => false, send: vi.fn() });
  const window = { webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow;
  const event = { sender: contents, senderFrame: contents.mainFrame } as unknown as IpcMainInvokeEvent;
  let invoke!: Invoke;
  const ipc = { handle: (_channel: string, listener: Invoke) => { invoke = listener; } } as unknown as IpcMain;
  const dispose = registerIpc(ipc, controller, () => window, rendererUrl, async () => undefined, undefined, undefined, undefined, undefined, clipboard ? { clipboard } : {});
  disposals.push(dispose);
  return { contents, event, dispose, reply: (operation: string, payload: unknown) => invoke(event, operation, payload), invoke: (altered: IpcMainInvokeEvent, operation: string, payload: unknown) => invoke(altered, operation, payload) };
}
function attachment(bytes: unknown = new Uint8Array([65])) { return { projectPath: "P", sessionId: "s", requestId: randomUUID(), input: { name: "context.txt", bytes } }; }

describe("project resource IPC boundary", () => {
  it("bounds typed-array payloads without JSON-serializing their contents or accepting alternate byte representations", async () => {
    const prepareChatAttachment = vi.fn(async () => ({ kind: "document", text: "actual" }));
    const controller = { prepareChatAttachment, revokeWindowResources: vi.fn() } as unknown as DesktopController;
    const ipc = bridge(controller);
    const bytes = new Uint8Array(6 * 1024 * 1024);
    Object.assign(bytes, { toJSON: () => { throw new Error("binary payload must not be JSON serialized"); } });
    await expect(ipc.reply("chatAttachmentPrepare", attachment(bytes))).resolves.toMatchObject({ ok: true });
    expect(((prepareChatAttachment.mock.calls as unknown[][])[0]?.[4] as { bytes: Uint8Array }).bytes).toBe(bytes);
    for (const invalid of [[], [65], new ArrayBuffer(1), new DataView(new ArrayBuffer(1)), new Uint16Array([65]), new Uint8Array(), new Uint8Array(6 * 1024 * 1024 + 1)]) await expect(ipc.reply("chatAttachmentPrepare", attachment(invalid))).resolves.toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    const forged = attachment();
    await expect(ipc.reply("chatAttachmentPrepare", { ...forged, input: { ...forged.input, sourcePath: "C:/private.txt" } })).resolves.toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    await expect(ipc.reply("chatAttachmentPrepare", { ...forged, requestId: "not-a-uuid" })).resolves.toMatchObject({ ok: false });
    await expect(ipc.invoke({ ...ipc.event, senderFrame: { url: rendererUrl } } as IpcMainInvokeEvent, "chatAttachmentPrepare", forged)).resolves.toMatchObject({ ok: false, error: { code: "TASK_SCOPE_DENIED" } });
    expect(prepareChatAttachment).toHaveBeenCalledOnce();
  });

  it("assigns distinct owner identities to windows and carries only the calling owner through cancellation/release", async () => {
    const prepareChatAttachment = vi.fn(async () => ({})); const cancelChatAttachment = vi.fn(); const releaseProjectMedia = vi.fn(); const revokeWindowResources = vi.fn();
    const controller = { prepareChatAttachment, cancelChatAttachment, releaseProjectMedia, revokeWindowResources } as unknown as DesktopController;
    const first = bridge(controller), second = bridge(controller); const payload = attachment();
    await first.reply("chatAttachmentPrepare", payload); await second.reply("chatAttachmentPrepare", payload);
    const ownerA = (prepareChatAttachment.mock.calls as unknown[][])[0]?.[0], ownerB = (prepareChatAttachment.mock.calls as unknown[][])[1]?.[0];
    expect(typeof ownerA).toBe("symbol"); expect(ownerA).not.toBe(ownerB);
    await second.reply("chatAttachmentCancel", { projectPath: "P", sessionId: "s", requestId: payload.requestId });
    expect(cancelChatAttachment).toHaveBeenCalledWith(ownerB, "P", "s", payload.requestId);
    await second.reply("projectMediaRelease", { id: "first-window-lease" });
    expect(releaseProjectMedia).toHaveBeenCalledWith(ownerB, "first-window-lease");
    first.contents.emit("render-process-gone"); expect(revokeWindowResources).toHaveBeenCalledWith(ownerA); expect(revokeWindowResources).not.toHaveBeenCalledWith(ownerB);
    second.contents.emit("did-start-navigation", {}, "https://foreign.example"); expect(revokeWindowResources).toHaveBeenCalledWith(ownerB);
    expect(first.contents.listenerCount("destroyed")).toBe(1); first.dispose(); expect(first.contents.listenerCount("destroyed")).toBe(0);
  });

  it("discards in-flight clipboard snapshots when its trusted window navigates away", async () => {
    const validateClipboardProject = vi.fn();
    const controller = { validateClipboardProject, revokeWindowResources: vi.fn() } as unknown as DesktopController;
    let started!: () => void; const entered = new Promise<void>(resolve => { started = resolve; });
    const clipboard: ClipboardReader = { availableFormats: () => { started(); return []; }, readBuffer: () => Buffer.alloc(0), readImage: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), toPNG: () => Buffer.alloc(0) }), readText: () => "clipboard context" };
    const ipc = bridge(controller, clipboard);
    const pending = ipc.reply("chatClipboardRead", { projectPath: "P" });
    await entered; ipc.contents.emit("did-start-navigation", {}, "https://foreign.example");
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "TASK_SCOPE_DENIED" } });
    await expect(ipc.reply("chatClipboardRead", { projectPath: "P", sourcePath: "C:/private.txt" })).resolves.toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
  });
});

describe("attachment controller admission lifetime", () => {
  async function fixture() {
    const directory = await mkdtemp(path.join(tmpdir(), "specloom-attachment-admission-"));
    disposals.push(() => rm(directory, { recursive: true, force: true }));
    const controller = new DesktopController({ list: async () => [] } as unknown as ModelVault, directory, path.resolve("skills"));
    disposals.push(() => controller.shutdown());
    vi.spyOn(controller, "currentCore").mockReturnValue({ metadata: { path: "P" } } as ProjectCore);
    const session = { id: "s", archived: false } as ChatSession;
    const list = vi.spyOn(controller.sessions, "list").mockResolvedValue([session]);
    const preparation = vi.spyOn(ChatAttachmentService.prototype, "prepare").mockResolvedValue({ kind: "document", name: "context.txt", size: 1, text: "A", notices: [], truncated: false });
    return { controller, session, list, preparation };
  }
  it("rejects an owner revoked while validating its session before starting the parser", async () => {
    const { controller, session, list, preparation } = await fixture(); const gate = deferred<ChatSession[]>(); list.mockReturnValueOnce(gate.promise);
    const owner = Symbol("window"); const pending = controller.prepareChatAttachment(owner, "P", "s", randomUUID(), { name: "context.txt", bytes: new Uint8Array([65]) });
    controller.revokeWindowResources(owner); gate.resolve([session]);
    await expect(pending).rejects.toMatchObject({ code: "TASK_SCOPE_DENIED" }); expect(preparation).not.toHaveBeenCalled();
  });
  it("rejects session removal or request cancellation during asynchronous session validation", async () => {
    const { controller, session, list, preparation } = await fixture();
    for (const reason of ["session", "request"] as const) {
      const gate = deferred<ChatSession[]>(); list.mockReturnValueOnce(gate.promise); const owner = Symbol("window"), requestId = randomUUID();
      const pending = controller.prepareChatAttachment(owner, "P", "s", requestId, { name: "context.txt", bytes: new Uint8Array([65]) });
      if (reason === "session") controller.cancelSessionAttachments("s"); else controller.cancelChatAttachment(owner, "P", "s", requestId);
      gate.resolve([session]); await expect(pending).rejects.toMatchObject({ code: "TASK_SCOPE_DENIED" });
    }
    expect(preparation).not.toHaveBeenCalled();
  });
});
