import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type { ProjectMediaKind } from "../../shared/project-files";
import { ProjectError } from "./errors";
import type { FileStore } from "./file-store";
import { hasCode } from "./store-fs";

export const projectImageByteLimit = 32 * 1024 * 1024;
export interface ProjectMediaFile {
  path: string;
  handle: FileHandle;
  kind: ProjectMediaKind;
  mimeType: string;
  size: number;
  generation: string;
}
const types: Record<string, readonly [ProjectMediaKind, string]> = {
  png: ["image", "image/png"], jpg: ["image", "image/jpeg"], jpeg: ["image", "image/jpeg"],
  gif: ["image", "image/gif"], webp: ["image", "image/webp"], bmp: ["image", "image/bmp"],
  ico: ["image", "image/x-icon"], avif: ["image", "image/avif"],
  svg: ["image", "image/svg+xml"],
  mp3: ["audio", "audio/mpeg"], wav: ["audio", "audio/wav"], ogg: ["audio", "audio/ogg"],
  oga: ["audio", "audio/ogg"], opus: ["audio", "audio/ogg"], flac: ["audio", "audio/flac"],
  m4a: ["audio", "audio/mp4"], aac: ["audio", "audio/aac"],
  mp4: ["video", "video/mp4"], m4v: ["video", "video/mp4"], mov: ["video", "video/quicktime"],
  webm: ["video", "video/webm"], ogv: ["video", "video/ogg"],
};
function generationFor(relative: string, stats: Stats): string {
  return createHash("sha256").update(JSON.stringify([relative, stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs, stats.birthtimeMs])).digest("hex");
}

/** Metadata checks also retire a stream if its pathname is deleted/replaced while the descriptor is open. */
export async function isProjectMediaCurrent(store: FileStore, media: ProjectMediaFile): Promise<boolean> {
  try {
    const [descriptor, pathname] = await Promise.all([media.handle.stat(), store.fs.lstat(path.join(store.root, media.path))]);
    return descriptor.isFile() && pathname.isFile() && !pathname.isSymbolicLink()
      && generationFor(media.path, descriptor) === media.generation && generationFor(media.path, pathname) === media.generation;
  } catch { return false; }
}
function validSignature(extension: string, bytes: Buffer): boolean {
  const ascii = (start: number, end: number) => bytes.toString("ascii", start, end);
  const isoMedia = bytes.length >= 16 && ascii(4, 8) === "ftyp";
  switch (extension) {
    case "png": return bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && ascii(12, 16) === "IHDR";
    case "jpg": case "jpeg": return bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    case "gif": return bytes.length >= 13 && /^GIF8[79]a$/.test(ascii(0, 6));
    case "webp": return bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
    case "bmp": return bytes.length >= 26 && ascii(0, 2) === "BM";
    case "ico": return bytes.length >= 6 && bytes.readUInt32LE(0) === 0x00010000 && bytes.readUInt16LE(4) > 0;
    case "avif": return isoMedia && /(?:avif|avis)/.test(ascii(8, bytes.length));
    case "svg": return /^(?:\uFEFF)?\s*(?:<\?xml\s[^?]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(bytes.toString("utf8"));
    case "mp3": return bytes.length >= 3 && (ascii(0, 3) === "ID3" || (bytes[0] === 255 && (bytes[1]! & 0xe0) === 0xe0));
    case "wav": return bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE";
    case "ogg": case "oga": case "opus": case "ogv": return bytes.length >= 27 && ascii(0, 4) === "OggS";
    case "flac": return bytes.length >= 4 && ascii(0, 4) === "fLaC";
    case "aac": return bytes.length >= 2 && bytes[0] === 255 && (bytes[1]! & 0xf6) === 0xf0;
    case "m4a": case "mp4": case "m4v": case "mov": return isoMedia;
    case "webm": return bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]));
    default: return false;
  }
}

/** Opens only a safe project regular file and sniffs a small prefix; videos are never buffered or hashed. */
export async function openProjectMedia(store: FileStore, relative: string): Promise<ProjectMediaFile> {
  const normalized = store.normalizePath(relative);
  const target = await store.policy.resolve(normalized);
  const extension = path.extname(normalized).slice(1).toLowerCase();
  const type = types[extension];
  if (!type) throw new ProjectError("VALIDATION_FAILED", "Unsupported project media format", { path: normalized });
  let handle: FileHandle;
  try { handle = await store.fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) {
    if (hasCode(error, "ENOENT")) throw new ProjectError("FILE_NOT_FOUND", "The project media file does not exist", { path: normalized });
    if (hasCode(error, "ELOOP")) throw new ProjectError("PATH_ESCAPE", "Symbolic links are not allowed", { path: normalized });
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size <= 0 || !Number.isSafeInteger(stats.size)) throw new ProjectError("VALIDATION_FAILED", "Expected a nonempty regular media file", { path: normalized });
    if (type[0] === "image" && stats.size > projectImageByteLimit) throw new ProjectError("VALIDATION_FAILED", "Project images must not exceed 32 MiB", { path: normalized });
    const prefix = Buffer.alloc(Math.min(stats.size, 512));
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
    if (!validSignature(extension, prefix.subarray(0, bytesRead))) throw new ProjectError("VALIDATION_FAILED", "Project media signature does not match its file extension", { path: normalized });
    await store.policy.assertSafe(target);
    const current = await store.fs.lstat(target);
    if (!current.isFile() || generationFor(normalized, current) !== generationFor(normalized, stats)
      || generationFor(normalized, await handle.stat()) !== generationFor(normalized, stats)) throw new ProjectError("VERSION_CONFLICT", "Project media changed while opening", { path: normalized });
    return { path: normalized, handle, kind: type[0], mimeType: type[1], size: stats.size, generation: generationFor(normalized, stats) };
  } catch (error) { await handle.close(); throw error; }
}
