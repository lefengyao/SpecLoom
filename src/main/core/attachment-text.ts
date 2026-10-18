import { TextDecoder } from "node:util";
import { CHAT_ATTACHMENT_LIMITS } from "../../shared/chat-attachments";

export interface AttachmentText { text: string; notices: string[]; truncated: boolean }

/** Preserve valid Unicode while limiting the encoded context, not UTF-16 code units. */
export function limitAttachmentText(text: string, maximum = CHAT_ATTACHMENT_LIMITS.extractedBytes): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maximum) return { text, truncated: false };
  let end = maximum;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

export function extractPlainAttachment(bytes: Uint8Array): AttachmentText {
  if (bytes.byteLength > CHAT_ATTACHMENT_LIMITS.textBytes) throw new Error("文本附件超过 64 KiB，请拆分文件");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("文本附件必须使用有效的 UTF-8 编码"); }
  if (Array.from(text).some(character => { const code = character.charCodeAt(0); return code === 127 || (code < 32 && code !== 9 && code !== 10 && code !== 13); })) throw new Error("附件包含二进制内容，无法作为文本读取");
  if (!text.trim()) throw new Error("文本附件为空");
  return { text, notices: [], truncated: false };
}

export async function extractPdfAttachment(bytes: Uint8Array): Promise<AttachmentText> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = getDocument({ data: new Uint8Array(bytes), verbosity: 0, useSystemFonts: false, disableFontFace: true, useWorkerFetch: false });
  try {
    const document = await loading.promise;
    let text = "";
    let foundText = false;
    let truncated = document.numPages > CHAT_ATTACHMENT_LIMITS.pdfPages;
    const notices: string[] = [];
    if (truncated) notices.push(`PDF 共 ${document.numPages} 页，仅提取前 ${CHAT_ATTACHMENT_LIMITS.pdfPages} 页`);
    for (let pageNumber = 1; pageNumber <= Math.min(document.numPages, CHAT_ATTACHMENT_LIMITS.pdfPages); pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = content.items.map(item => "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "").join("").trim();
      foundText ||= !!pageText;
      const bounded = limitAttachmentText(`${text}${text ? "\n\n" : ""}[第 ${pageNumber} 页]\n${pageText}`);
      text = bounded.text;
      page.cleanup();
      if (bounded.truncated) { truncated = true; notices.push("提取内容已截断至 64 KiB"); break; }
    }
    if (!foundText) throw new Error("PDF 没有可提取的文本，可能是扫描件；当前不支持 OCR");
    return { text, truncated, notices };
  } catch (error) {
    if (error instanceof Error && /password/i.test(`${error.name} ${error.message}`)) throw new Error("PDF 受密码保护，请先解密后重试");
    if (error instanceof Error && /OCR/.test(error.message)) throw error;
    throw new Error("PDF 损坏或无法提取文本，请检查文件");
  } finally { await loading.destroy(); }
}
