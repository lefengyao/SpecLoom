import type { ChatImageAttachment } from "./chat";

export const CHAT_ATTACHMENT_LIMITS = {
  files: 16,
  imageBytes: 2 * 1024 * 1024,
  documentBytes: 6 * 1024 * 1024,
  textBytes: 64 * 1024,
  pendingBytes: 16 * 1024 * 1024,
  extractedBytes: 64 * 1024,
  pdfPages: 20,
  workerTimeoutMs: 10_000,
  workers: 2,
} as const;

export interface ChatAttachmentInput {
  name: string;
  declaredMime?: string;
  bytes: Uint8Array;
}
export type PreparedChatAttachment =
  | { kind: "image"; name: string; size: number; image: ChatImageAttachment }
  | { kind: "document"; name: string; size: number; text: string; notices: string[]; truncated: boolean };
