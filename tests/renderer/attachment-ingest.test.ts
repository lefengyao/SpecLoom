import { expect, test, vi } from "vitest";
import { AttachmentIngest, composePrompt } from "../../src/renderer/chat/attachment-ingest";

test("creation attachments wait for their own new session and preserve document content", async () => {
  const prepare = vi.fn(async () => ({ kind: "document" as const, name: "notes.txt", size: 3, text: "实际正文", notices: [], truncated: false }));
  const manager = new AttachmentIngest("P", { prepare, cancel: vi.fn(), readClipboard: vi.fn() }, () => undefined);
  const target = { kind: "creating" as const, creationToken: "creation" };
  await manager.addInputs(target, [{ name: "notes.txt", bytes: new Uint8Array([1, 2, 3]) }]);
  expect(prepare).not.toHaveBeenCalled();
  manager.adopt("creation", "new");
  await vi.waitFor(() => expect(manager.entries({ kind: "session", sessionId: "new" })[0]?.status).toBe("ready"));
  expect(prepare.mock.calls[0]?.slice(0, 2)).toEqual(["P", "new"]);
  const snapshot = manager.snapshot({ kind: "session", sessionId: "new" }, { text: "请求", revision: 2 });
  expect(composePrompt(snapshot)).toContain("实际正文");
  manager.detach({ kind: "session", sessionId: "new" }, snapshot);
  expect(manager.entries({ kind: "session", sessionId: "new" })).toEqual([]);
  manager.restore({ kind: "session", sessionId: "new" }, snapshot);
  manager.restore({ kind: "session", sessionId: "new" }, snapshot);
  expect(manager.entries({ kind: "session", sessionId: "new" })).toHaveLength(1);
  manager.dispose();
});

test("removed pending attachments cannot reappear after a late preparation", async () => {
  let finish!: (value: { kind: "document"; name: string; size: number; text: string; notices: string[]; truncated: boolean }) => void;
  const cancel = vi.fn(async () => undefined);
  const manager = new AttachmentIngest("P", { prepare: () => new Promise(resolve => { finish = resolve; }), cancel, readClipboard: vi.fn() }, () => undefined);
  const target = { kind: "session" as const, sessionId: "a" };
  const adding = manager.addInputs(target, [{ name: "a.txt", bytes: new Uint8Array([1]) }]);
  const id = manager.entries(target)[0]!.id;
  manager.remove(target, id);
  finish({ kind: "document", name: "a.txt", size: 1, text: "late", notices: [], truncated: false });
  await adding;
  expect(manager.entries(target)).toEqual([]);
  expect(cancel).toHaveBeenCalledWith("P", "a", id);
  manager.dispose();
});
