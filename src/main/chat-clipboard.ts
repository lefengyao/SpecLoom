import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHAT_ATTACHMENT_LIMITS, type ChatAttachmentInput } from "../shared/chat-attachments";
import { ProjectError } from "./core/errors";

export interface ClipboardReader {
  availableFormats(): string[];
  readBuffer(format: string): Buffer;
  readImage(): { isEmpty(): boolean; getSize(): { width: number; height: number }; toPNG(): Buffer };
  readText(): string;
}
export interface ChatClipboardSnapshot { files: ChatAttachmentInput[]; text?: string; notices: string[] }

function nativeFileNames(bytes: Buffer): string[] {
  if (!bytes.length || bytes.length % 2 || bytes.length > 65536) throw new Error("剪贴板文件路径表示无效或过长");
  const value = bytes.toString("utf16le");
  if (!value.endsWith("\0") || /[\ud800-\udfff]/u.test(value.replace(/[\ud800-\udbff][\udc00-\udfff]/gu, ""))) throw new Error("剪贴板文件路径表示无效");
  const names = value.replace(/\0+$/u, "").split("\0");
  if (!names.length || names.some(name => !name)) throw new Error("剪贴板文件路径表示无效");
  return names;
}

function uriFileNames(bytes: Buffer): string[] {
  if (!bytes.length || bytes.length > 65536) throw new Error("剪贴板文件 URI 表示无效或过长");
  let value: string;
  try { value = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("剪贴板文件 URI 表示无效"); }
  const lines = value.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
  if (!lines.length) throw new Error("剪贴板文件 URI 表示无效");
  return lines.map(line => {
    try {
      const uri = new URL(line);
      if (uri.protocol !== "file:" || uri.hostname && uri.hostname.toLowerCase() !== "localhost" || uri.search || uri.hash) throw new Error();
      return fileURLToPath(uri);
    } catch { throw new Error("仅支持剪贴板中的本地文件 URI；不支持网络或其他地址"); }
  });
}

async function readLocalFile(source: string): Promise<ChatAttachmentInput> {
  if (source.length > 32767 || Array.from(source).some(character => character.charCodeAt(0) < 32) || source.startsWith("\\") || source.startsWith("//") || source.startsWith("\\?\\") || source.startsWith("\\.\\") || (process.platform === "win32" ? !/^[a-z]:[\\/]/iu.test(source) || source.slice(2).includes(":") : !path.isAbsolute(source) || source.includes(":"))) throw new Error("仅支持剪贴板中的本地普通文件；不支持网络、设备或数据流路径");
  const target = path.resolve(source);
  let current = target;
  while (true) {
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error("剪贴板文件路径不允许符号链接或目录联接");
    if (current === target ? !info.isFile() : !info.isDirectory()) throw new Error("剪贴板内容不是本地普通文件");
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  if (normalize(await realpath(target)) !== normalize(target)) throw new Error("剪贴板文件路径包含重定向");
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > CHAT_ATTACHMENT_LIMITS.documentBytes) throw new Error("剪贴板文件超过 6 MiB 或不是普通文件");
    const bytes = Buffer.alloc(Math.min(before.size + 1, CHAT_ATTACHMENT_LIMITS.documentBytes + 1));
    let length = 0;
    while (length < bytes.length) { const read = await handle.read(bytes, length, bytes.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
    const after = await handle.stat();
    if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || normalize(await realpath(target)) !== normalize(target)) throw new Error("读取期间剪贴板文件发生变化，请重试");
    return { name: path.basename(target), bytes: new Uint8Array(bytes.subarray(0, length)) };
  } finally { await handle.close(); }
}

/** Native file representations take precedence over document preview bitmaps. */
export async function readChatClipboard(clipboard: ClipboardReader): Promise<ChatClipboardSnapshot> {
  try { return await readClipboardSnapshot(clipboard); }
  catch (error) {
    if (error instanceof ProjectError) throw error;
    const message = error instanceof Error && !("code" in error) ? error.message : "无法读取剪贴板文件，请确认文件存在且可以访问";
    throw new ProjectError("VALIDATION_FAILED", message);
  }
}

async function readClipboardSnapshot(clipboard: ClipboardReader): Promise<ChatClipboardSnapshot> {
  const formats = clipboard.availableFormats();
  const nativeFormat = formats.find(format => format.toLowerCase() === "filenamew");
  const uriFormat = formats.find(format => format.toLowerCase() === "text/uri-list");
  if (nativeFormat || uriFormat) {
    // Electron normalizes Windows FileNameW to text/uri-list in availableFormats().
    // Probe the explicit native representation before parsing its normalized form.
    const nativeBytes = clipboard.readBuffer(nativeFormat ?? "FileNameW");
    const names = nativeFormat || nativeBytes.length ? nativeFileNames(nativeBytes) : uriFileNames(clipboard.readBuffer(uriFormat!));
    const file = await readLocalFile(names[0]!);
    return { files: [file], notices: names.length > 1 ? ["当前剪贴板仅支持一次读取一个本地文件，已读取第一个文件"] : [] };
  }
  if (formats.some(format => /^(filename|filedrop|cf_hdrop)$/iu.test(format))) throw new Error("剪贴板文件表示不受支持，请使用添加文件选择器");
  const image = clipboard.readImage();
  if (!image.isEmpty()) {
    const { width, height } = image.getSize();
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width > 8192 || height > 8192 || width * height > 16_777_216) throw new Error("剪贴板图片尺寸过大，最多支持 1600 万像素");
    const bytes = image.toPNG();
    if (bytes.byteLength > CHAT_ATTACHMENT_LIMITS.imageBytes) throw new Error("剪贴板图片超过 2 MiB");
    if (!bytes.byteLength) throw new Error("剪贴板图片为空");
    return { files: [{ name: "clipboard.png", declaredMime: "image/png", bytes: new Uint8Array(bytes) }], notices: [] };
  }
  const text = clipboard.readText();
  if (Buffer.byteLength(text, "utf8") > CHAT_ATTACHMENT_LIMITS.textBytes) throw new Error("剪贴板文本超过 64 KiB");
  return { files: [], ...(text ? { text } : {}), notices: [] };
}
