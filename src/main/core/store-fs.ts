import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import type { VersionToken } from "../../shared/contracts";
import { ProjectError } from "./errors";

export type StoreFileSystem = Pick<typeof fs, "lstat" | "realpath" | "open" | "mkdir" | "readdir" | "rename" | "unlink">;
export const defaultFileSystem: StoreFileSystem = fs;
export const digestBytes = (bytes: Uint8Array | string): VersionToken => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
export const hasCode = (error: unknown, code: string): boolean => typeof error === "object" && error !== null && "code" in error && error.code === code;

export async function removeTemporary(fs: StoreFileSystem, target: string): Promise<void> {
  try { await fs.unlink(target); } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
}

export function decodeText(bytes: Uint8Array, limit: number): string {
  if (bytes.byteLength > limit) throw new ProjectError("VALIDATION_FAILED", "Text file exceeds the configured byte limit", { limit });
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.includes("\0")) throw new Error("Binary text");
    return text;
  } catch {
    throw new ProjectError("VALIDATION_FAILED", "Only valid UTF-8 text files are editable");
  }
}

export function encodeText(content: string, limit: number): Buffer {
  const bytes = Buffer.from(content, "utf8");
  if (decodeText(bytes, limit) !== content) throw new ProjectError("VALIDATION_FAILED", "Content must be valid UTF-8 text");
  return bytes;
}
