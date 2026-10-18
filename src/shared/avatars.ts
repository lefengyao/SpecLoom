export const avatarByteLimit = 262_144;
/** Larger upload allowance; renderer compresses accepted images to avatarByteLimit. */
export const avatarInputByteLimit = 8 * 1024 * 1024;
export const avatarMimeTypes = ["image/png", "image/jpeg", "image/webp"] as const;
export const defaultAssistantAvatar = "/brand/specloom.svg";

/** Accept only bounded embedded raster files, including their actual file signature. */
export function isAvatarDataUrl(value: string): boolean {
  if (value === "") return true;
  if (value.length > Math.ceil(avatarByteLimit / 3) * 4 + 32) return false;
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2]!.length % 4 !== 0) return false;
  let bytes: string;
  try { bytes = atob(match[2]!); if (btoa(bytes) !== match[2]) return false; } catch { return false; }
  if (!bytes.length || bytes.length > avatarByteLimit) return false;
  const signature = (...values: number[]) => values.every((byte, index) => bytes.charCodeAt(index) === byte);
  if (match[1] === "image/png") return bytes.length >= 45 && signature(137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13) && bytes.slice(12, 16) === "IHDR" && bytes.slice(-8, -4) === "IEND";
  if (match[1] === "image/jpeg") return bytes.length >= 4 && signature(255, 216, 255) && bytes.slice(-2) === "\xff\xd9";
  const size = (bytes.charCodeAt(4) | bytes.charCodeAt(5) << 8 | bytes.charCodeAt(6) << 16 | bytes.charCodeAt(7) << 24) >>> 0;
  return bytes.length >= 20 && bytes.slice(0, 4) === "RIFF" && bytes.slice(8, 12) === "WEBP" && ["VP8 ", "VP8L", "VP8X"].includes(bytes.slice(12, 16)) && size + 8 === bytes.length;
}
