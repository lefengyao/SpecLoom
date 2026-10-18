import { TextDecoder } from "node:util";
import { fromBuffer, type Entry, type ZipFile } from "yauzl";
import { SaxesParser } from "saxes";
import { CHAT_ATTACHMENT_LIMITS } from "../../shared/chat-attachments";
import { limitAttachmentText, type AttachmentText } from "./attachment-text";

const MAX_ENTRIES = 2048;
const MAX_UNCOMPRESSED = 32 * 1024 * 1024;
const MAX_XML = 8 * 1024 * 1024;
const WORD_NAMESPACES = new Set(["http://schemas.openxmlformats.org/wordprocessingml/2006/main", "http://purl.oclc.org/ooxml/wordprocessingml/main"]);

function openZip(bytes: Uint8Array): Promise<ZipFile> {
  return new Promise((resolve, reject) => fromBuffer(Buffer.from(bytes), { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true }, (error, zip) => error ? reject(error) : resolve(zip)));
}

/** Enumerate the entire directory first; never extract entries or resolve relationships. */
async function findDocument(zip: ZipFile): Promise<Entry> {
  if (zip.entryCount > MAX_ENTRIES) throw new Error("DOCX ZIP 条目超过 2048 个");
  return new Promise((resolve, reject) => {
    let target: Entry | undefined;
    let count = 0;
    let announced = 0;
    zip.on("error", reject);
    zip.on("entry", (entry: Entry) => {
      try {
        if (++count > MAX_ENTRIES) throw new Error("DOCX ZIP 条目超过 2048 个");
        const name = entry.fileName;
        if (!name || name.includes("\\") || name.startsWith("/") || name.split("/").some(part => part === ".." || part === ".") || /[:\0]/u.test(name)) throw new Error("DOCX ZIP 包含不安全的路径");
        if (entry.isEncrypted()) throw new Error("不支持加密的 DOCX ZIP");
        announced += entry.uncompressedSize;
        if (!Number.isSafeInteger(announced) || announced > MAX_UNCOMPRESSED) throw new Error("DOCX ZIP 解压总大小超过 32 MiB");
        if (name.toLowerCase() === "word/document.xml") {
          if (target) throw new Error("DOCX ZIP 包含重复的 document.xml");
          if (name !== "word/document.xml" || ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) throw new Error("DOCX 文档路径无效");
          if (entry.uncompressedSize > MAX_XML) throw new Error("DOCX document.xml 超过 8 MiB");
          target = entry;
        }
        zip.readEntry();
      } catch (error) { reject(error); }
    });
    zip.on("end", () => target ? resolve(target) : reject(new Error("DOCX 缺少 word/document.xml")));
    zip.readEntry();
  });
}

export async function extractDocxAttachment(bytes: Uint8Array): Promise<AttachmentText> {
  const zip = await openZip(bytes);
  try {
    const entry = await findDocument(zip);
    const stream = await new Promise<import("node:stream").Readable>((resolve, reject) => zip.openReadStream(entry, (error, readable) => error ? reject(error) : resolve(readable)));
    const parser = new SaxesParser({ xmlns: true });
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let depth = 0;
    let inText = 0;
    let rootSeen = false;
    let text = "";
    let truncated = false;
    let xmlBytes = 0;
    const append = (value: string) => {
      if (truncated) return;
      const limited = limitAttachmentText(text + value);
      text = limited.text; truncated = limited.truncated;
    };
    parser.on("doctype", () => { throw new Error("DOCX XML 不允许 DTD 或实体声明"); });
    parser.on("error", error => { throw error; });
    parser.on("opentag", tag => {
      if (++depth > 128) throw new Error("DOCX XML 嵌套深度超过 128");
      const word = WORD_NAMESPACES.has(tag.uri);
      if (depth === 1) { if (!word || tag.local !== "document") throw new Error("DOCX 文档 XML 根节点无效"); rootSeen = true; }
      if (!word) return;
      if (tag.local === "t") inText++;
      else if (tag.local === "tab") append("\t");
      else if (tag.local === "br" || tag.local === "cr") append("\n");
    });
    parser.on("text", value => { if (inText) append(value); });
    parser.on("cdata", value => { if (inText) append(value); });
    parser.on("closetag", tag => {
      if (WORD_NAMESPACES.has(tag.uri)) {
        if (tag.local === "t") inText--;
        else if (tag.local === "p") append("\n");
        else if (tag.local === "tc") append("\t");
      }
      depth--;
    });
    try {
      for await (const chunk of stream) {
        xmlBytes += (chunk as Buffer).byteLength;
        if (xmlBytes > MAX_XML) throw new Error("DOCX document.xml 解压后超过 8 MiB");
        parser.write(decoder.decode(chunk as Buffer, { stream: true }));
      }
      parser.write(decoder.decode()).close();
    } finally { stream.destroy(); }
    if (!rootSeen || !text.trim()) throw new Error("DOCX 没有可提取的文本");
    return { text: text.trim(), truncated, notices: truncated ? [`提取内容已截断至 ${CHAT_ATTACHMENT_LIMITS.extractedBytes / 1024} KiB`] : [] };
  } finally { zip.close(); }
}
