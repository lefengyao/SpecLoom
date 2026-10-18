import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readChatClipboard, type ClipboardReader } from "../../src/main/chat-clipboard";
import { serializeError } from "../../src/main/core/errors";

const temporary: string[] = [];
afterEach(async () => { for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true }); });
function clipboard(patch: Partial<ClipboardReader> = {}): ClipboardReader {
  return { availableFormats: () => [], readBuffer: () => Buffer.alloc(0), readImage: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), toPNG: () => Buffer.alloc(0) }), readText: () => "", ...patch };
}
function nativeFile(names: string[]): Partial<ClipboardReader> { return { availableFormats: () => ["FileNameW", "image/png"], readBuffer: () => Buffer.from(names.join("\0") + "\0", "utf16le") }; }
async function directory() { const target = await mkdtemp(path.join(tmpdir(), "specloom-clipboard-test-")); temporary.push(target); return target; }

describe("native chat clipboard snapshot", () => {
  it("reads actual file bytes before a document preview image and reports the single-file limit", async () => {
    const target = await directory(); const file = path.join(target, "document.pdf"); await writeFile(file, "%PDF-actual file contents");
    const readImage = vi.fn(() => { throw new Error("must not read preview bitmap"); });
    const result = await readChatClipboard(clipboard({ ...nativeFile([file, path.join(target, "second.pdf")]), readImage }));
    expect(result.files).toHaveLength(1); expect(result.files[0]!.name).toBe("document.pdf"); expect(Buffer.from(result.files[0]!.bytes).toString()).toBe("%PDF-actual file contents"); expect(result.notices.join()).toContain("一个"); expect(readImage).not.toHaveBeenCalled();
  });
  it("rejects malformed or unsupported native file representations without image fallback", async () => {
    const readImage = vi.fn(() => { throw new Error("no fallback"); });
    for (const bytes of [Buffer.from([0xff]), Buffer.from("C:\\file.txt", "utf16le"), Buffer.alloc(65538), Buffer.from("\0", "utf16le")]) await expect(readChatClipboard(clipboard({ availableFormats: () => ["FileNameW"], readBuffer: () => bytes, readImage }))).rejects.toThrow(/无效|过长/);
    await expect(readChatClipboard(clipboard({ availableFormats: () => ["FileName"], readImage }))).rejects.toThrow(/不受支持/); expect(readImage).not.toHaveBeenCalled();
    const invalid = await readChatClipboard(clipboard({ availableFormats: () => ["FileNameW"] })).catch(error => error);
    expect(serializeError(invalid)).toMatchObject({ code: "VALIDATION_FAILED", message: expect.stringContaining("无效") });
  });
  it("reads FileNameW when Electron advertises only the normalized URI-list format", async () => {
    const target = await directory(); const file = path.join(target, "native document.pdf"); await writeFile(file, "%PDF-normalized native file");
    const readImage = vi.fn(() => { throw new Error("must not read preview bitmap"); });
    const readBuffer = vi.fn((format: string) => format === "FileNameW" ? Buffer.from(file + "\0", "utf16le") : Buffer.alloc(0));
    const result = await readChatClipboard(clipboard({ availableFormats: () => ["text/uri-list"], readBuffer, readImage }));
    expect(result.files[0]?.name).toBe("native document.pdf"); expect(Buffer.from(result.files[0]!.bytes).toString()).toBe("%PDF-normalized native file");
    expect(readBuffer).toHaveBeenCalledWith("FileNameW"); expect(readImage).not.toHaveBeenCalled();
  });
  it("reads an explicit local file URI-list without guessing plain clipboard text", async () => {
    const target = await directory(); const file = path.join(target, "中文 notes.txt"); await writeFile(file, "URI-list 实际正文");
    const readImage = vi.fn(() => { throw new Error("must not read preview bitmap"); }); const readText = vi.fn(() => { throw new Error("must not guess ordinary text"); });
    const uriList = `# Copied files\r\n${pathToFileURL(file).href}\r\n${pathToFileURL(path.join(target, "second.txt")).href}\r\n`;
    const result = await readChatClipboard(clipboard({ availableFormats: () => ["text/uri-list"], readBuffer: format => format === "text/uri-list" ? Buffer.from(uriList) : Buffer.alloc(0), readImage, readText }));
    expect(result.files).toHaveLength(1); expect(result.files[0]?.name).toBe("中文 notes.txt"); expect(Buffer.from(result.files[0]!.bytes).toString()).toBe("URI-list 实际正文"); expect(result.notices.join()).toContain("一个");
    expect(readImage).not.toHaveBeenCalled(); expect(readText).not.toHaveBeenCalled();
  });
  it("rejects invalid, network and nonfile URI-list representations without fallback", async () => {
    const readImage = vi.fn(() => { throw new Error("no fallback"); }); const readText = vi.fn(() => "C:\\private\\file.txt");
    for (const uriList of [Buffer.alloc(0), Buffer.from([0xff]), Buffer.from("# Empty list\r\n"), Buffer.from("C:\\private\\file.txt"), Buffer.from("https://example.com/doc.txt"), Buffer.from("file://server/share/doc.txt"), Buffer.from("file:///C:/doc.txt?secret=1"), Buffer.alloc(65537)]) {
      await expect(readChatClipboard(clipboard({ availableFormats: () => ["text/uri-list"], readBuffer: format => format === "text/uri-list" ? uriList : Buffer.alloc(0), readImage, readText }))).rejects.toThrow();
    }
    expect(readImage).not.toHaveBeenCalled(); expect(readText).not.toHaveBeenCalled();
  });
  it("rejects network/device/ADS paths, directories, symlinks and junction ancestors", async () => {
    for (const source of ["\\\\server\\share\\doc.txt", "\\\\?\\C:\\doc.txt", "\\\\.\\pipe\\file", "C:\\doc.txt:secret"]) await expect(readChatClipboard(clipboard(nativeFile([source])))).rejects.toThrow(/本地|路径/);
    const target = await directory(); const actual = path.join(target, "actual"); await mkdir(actual); const file = path.join(actual, "note.txt"); await writeFile(file, "actual");
    await expect(readChatClipboard(clipboard(nativeFile([actual])))).rejects.toThrow(/普通文件/);
    const linked = path.join(target, "linked"); await symlink(actual, linked, process.platform === "win32" ? "junction" : "dir");
    await expect(readChatClipboard(clipboard(nativeFile([path.join(linked, "note.txt")])))).rejects.toThrow(/链接|联接/);
    const large = path.join(target, "large.txt"); await writeFile(large, Buffer.alloc(6 * 1024 * 1024 + 1)); await expect(readChatClipboard(clipboard(nativeFile([large])))).rejects.toThrow(/6 MiB/);
  });
  it("checks empty images and pixel caps before encoding PNG", async () => {
    const toPNG = vi.fn(() => Buffer.from("PNG bytes"));
    await expect(readChatClipboard(clipboard({ readImage: () => ({ isEmpty: () => false, getSize: () => ({ width: 8192, height: 8192 }), toPNG }) }))).rejects.toThrow(/像素/); expect(toPNG).not.toHaveBeenCalled();
    const result = await readChatClipboard(clipboard({ readImage: () => ({ isEmpty: () => false, getSize: () => ({ width: 20, height: 10 }), toPNG }) }));
    expect(result.files[0]).toMatchObject({ name: "clipboard.png", declaredMime: "image/png" }); expect(toPNG).toHaveBeenCalledOnce();
    await expect(readChatClipboard(clipboard({ readImage: () => ({ isEmpty: () => false, getSize: () => ({ width: 20, height: 10 }), toPNG: () => Buffer.alloc(2 * 1024 * 1024 + 1) }) }))).rejects.toThrow(/2 MiB/);
  });
  it("returns ordinary text as text without guessing paths", async () => {
    expect(await readChatClipboard(clipboard({ readText: () => "C:\\private\\file.txt" }))).toEqual({ files: [], text: "C:\\private\\file.txt", notices: [] });
    expect(await readChatClipboard(clipboard())).toEqual({ files: [], notices: [] });
    await expect(readChatClipboard(clipboard({ readText: () => "a".repeat(65537) }))).rejects.toThrow(/64 KiB/);
  });
});
