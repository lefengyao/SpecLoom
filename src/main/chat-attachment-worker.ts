import { parentPort, workerData } from "node:worker_threads";
import { extractPdfAttachment } from "./core/attachment-text";
import { extractDocxAttachment } from "./core/docx-text";

if (!parentPort) throw new Error("Attachment parser requires a worker thread");
const port = parentPort;
const input = workerData as { kind: "pdf" | "docx"; bytes: Uint8Array };
void (async () => {
  try {
    if (!(input.bytes instanceof Uint8Array)) throw new Error("附件内容无效");
    const result = input.kind === "pdf" ? await extractPdfAttachment(input.bytes) : input.kind === "docx" ? await extractDocxAttachment(input.bytes) : (() => { throw new Error("文档格式无效"); })();
    port.postMessage({ ok: true, result });
  } catch (error) {
    port.postMessage({ ok: false, error: error instanceof Error ? error.message : "文档解析失败" });
  } finally { port.close(); }
})();
