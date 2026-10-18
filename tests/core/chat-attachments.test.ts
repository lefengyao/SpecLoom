import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ChatAttachmentService } from "../../src/main/core/chat-attachments";
import { extractDocxAttachment } from "../../src/main/core/docx-text";
import { limitAttachmentText } from "../../src/main/core/attachment-text";
import { docxFixture, pdfFixture, wordXml, zipFixture } from "../helpers/chat-attachment-fixtures";
import { serializeError } from "../../src/main/core/errors";

const root = fileURLToPath(new URL("../..", import.meta.url));
let directory: string; let workerPath: string;
const services: ChatAttachmentService[] = [];
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "specloom-attachment-test-")); workerPath = path.join(directory, "chat-attachment-worker.cjs");
  await symlink(path.join(root, "node_modules"), path.join(directory, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  await build({ absWorkingDir: root, entryPoints: ["src/main/chat-attachment-worker.ts"], outfile: workerPath, bundle: true, platform: "node", format: "cjs", target: "node24", external: ["pdfjs-dist/*"], logLevel: "silent" });
});
afterAll(async () => { for (const service of services) service.close(); await rm(directory, { recursive: true, force: true }); });
function service(options: ConstructorParameters<typeof ChatAttachmentService>[0] = { workerPath }): ChatAttachmentService { const instance = new ChatAttachmentService(options); services.push(instance); return instance; }
function prepare(instance: ChatAttachmentService, name: string, bytes: Uint8Array, owner: symbol = Symbol.for("test")) { return instance.prepare(owner, "project/session", randomUUID(), { name, bytes }); }

describe("chat attachment preparation", () => {
  it("uses actual UTF-8 contents and sanitized names without a worker", async () => {
    await expect(prepare(service({}), "C:\\private\\notes.md", Buffer.from("# Context\n真实内容"))).resolves.toMatchObject({ kind: "document", name: "notes.md", text: "# Context\n真实内容", truncated: false });
    await expect(prepare(service({}), "bad.txt", Buffer.from([0xc3, 0x28]))).rejects.toThrow(/UTF-8/);
    await expect(prepare(service({}), "binary.txt", Buffer.from("a\0b"))).rejects.toThrow(/二进制/);
    await expect(prepare(service({}), "large.txt", Buffer.alloc(65537, 65))).rejects.toThrow(/64 KiB/);
    await expect(prepare(service({}), "unknown.exe", Buffer.from("MZ harmless"))).rejects.toThrow(/格式/);
  });
  it("derives image MIME from bytes and rejects fake signatures and image budgets", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lN8AAAAASUVORK5CYII=", "base64");
    await expect(prepare(service({}), "wrong.jpg", png)).resolves.toMatchObject({ kind: "image", image: { mimeType: "image/png", base64: png.toString("base64") } });
    await expect(prepare(service({}), "fake.png", Buffer.from("not an image"))).rejects.toThrow(/不匹配/);
    const large = Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]);
    await expect(prepare(service({}), "large.png", large)).rejects.toThrow(/2 MiB/);
    await expect(prepare(service({}), "large.pdf", Buffer.alloc(6 * 1024 * 1024 + 1))).rejects.toThrow(/6 MiB/);
  });
  it("keeps output byte budgets on Unicode boundaries", () => {
    const bounded = limitAttachmentText("😀中文".repeat(20000));
    expect(Buffer.byteLength(bounded.text)).toBeLessThanOrEqual(65536); expect(bounded.text).not.toContain("�"); expect(bounded.truncated).toBe(true);
  });
  it("extracts real PDF and DOCX text in isolated bounded workers", async () => {
    const instance = service();
    await expect(prepare(instance, "document.pdf", pdfFixture())).resolves.toMatchObject({ kind: "document", text: "[第 1 页]\nActual PDF text", truncated: false });
    await expect(prepare(instance, "document.docx", docxFixture("Real DOCX &amp; 中文"))).resolves.toMatchObject({ kind: "document", text: "Real DOCX & 中文", truncated: false });
    const pages = await prepare(instance, "long.pdf", pdfFixture("Page text", 21));
    expect(pages.kind).toBe("document"); if (pages.kind === "document") { expect(pages.truncated).toBe(true); expect(pages.text).toContain("第 20 页"); expect(pages.text).not.toContain("第 21 页"); expect(pages.notices.join()).toContain("21"); }
    await expect(prepare(instance, "broken.pdf", Buffer.from("%PDF-invalid"))).rejects.toThrow(/损坏/);
    await expect(prepare(instance, "locked.pdf", pdfFixture("locked", 1, true))).rejects.toThrow(/密码/);
    await expect(prepare(instance, "scan.pdf", pdfFixture(""))).rejects.toThrow(/OCR/);
    await expect(prepare(service({}), "doc.pdf", pdfFixture())).rejects.toThrow(/工作进程不可用/);
    await expect(prepare(service({}), "doc.pdf", pdfFixture())).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
    const invalid = await prepare(service({}), "bad.txt", Buffer.from([0xff])).catch(error => error);
    expect(serializeError(invalid)).toMatchObject({ code: "VALIDATION_FAILED", message: expect.stringContaining("UTF-8") });
  });
  it("enforces the PDF context limit while preserving page markers", async () => {
    const result = await prepare(service(), "context.pdf", pdfFixture("A".repeat(10000), 8));
    expect(result.kind).toBe("document"); if (result.kind === "document") { expect(result.truncated).toBe(true); expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(65536); expect(result.text).toContain("[第 1 页]"); }
  });
});

describe("bounded DOCX ZIP and XML", () => {
  it.each([
    ["missing target", [{ name: "other.xml", text: "x" }], /缺少/],
    ["duplicate target", [{ name: "word/document.xml", text: wordXml("x") }, { name: "word/document.xml", text: wordXml("y") }], /重复/],
    ["path traversal", [{ name: "../escape", text: "x" }], /path|路径/i],
    ["encrypted", [{ name: "word/document.xml", text: wordXml("x"), flags: 1 }], /加密/],
    ["announced total", [{ name: "other", text: "x", announcedSize: 32 * 1024 * 1024 + 1 }], /32 MiB/],
    ["target XML size", [{ name: "word/document.xml", text: "x", announcedSize: 8 * 1024 * 1024 + 1 }], /8 MiB/],
    ["decompression size mismatch", [{ name: "word/document.xml", text: wordXml("<w:p><w:r><w:t>Actual bytes</w:t></w:r></w:p>"), announcedSize: 1 }], /byte|size/i],
    ["DTD entity", [{ name: "word/document.xml", text: '<!DOCTYPE w:document [<!ENTITY x "secret">]>' + wordXml("<w:p><w:r><w:t>&x;</w:t></w:r></w:p>") }], /DTD|实体/],
    ["depth", [{ name: "word/document.xml", text: wordXml("<w:p>".repeat(130) + "x" + "</w:p>".repeat(130)) }], /128/],
    ["malformed XML", [{ name: "word/document.xml", text: wordXml("<w:p>") }], /close|tag/i],
  ] as const)("rejects %s", async (_label, entries, message) => { await expect(extractDocxAttachment(zipFixture([...entries]))).rejects.toThrow(message); });
  it("rejects many entries and malformed ZIP data", async () => {
    await expect(extractDocxAttachment(zipFixture(Array.from({ length: 2049 }, (_, index) => ({ name: `f${index}`, text: "" }))))).rejects.toThrow(/2048/);
    await expect(extractDocxAttachment(Buffer.from("PK\x03\x04bad archive"))).rejects.toThrow();
  });
  it("preserves paragraphs/tabs and truncates actual document text", async () => {
    const result = await extractDocxAttachment(zipFixture([{ name: "word/document.xml", text: wordXml("<w:p><w:r><w:t>First</w:t><w:tab/><w:t>second</w:t><w:br/><w:t>third</w:t></w:r></w:p><w:p><w:r><w:t>" + "中".repeat(30000) + "</w:t></w:r></w:p>") }]));
    expect(result.text).toMatch(/^First\tsecond\nthird\n/); expect(result.truncated).toBe(true); expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(65536);
  });
});

describe("parser lifetime and admission", () => {
  async function loopingWorker() {
    const looping = path.join(directory, `loop-${randomUUID()}.cjs`);
    await writeFile(looping, "const {workerData}=require('node:worker_threads');const fs=require('node:fs');const target=Buffer.from(workerData.bytes).subarray(5).toString();setInterval(()=>fs.appendFileSync(target,'x'),10);");
    return looping;
  }
  it("terminates timed out workers instead of only rejecting their promise", async () => {
    const marker = path.join(directory, "timeout-marker");
    const instance = service({ workerPath: await loopingWorker(), timeoutMs: 200 });
    const pending = prepare(instance, "loop.pdf", Buffer.from(`%PDF-${marker}`)); const rejected = expect(pending).rejects.toThrow(/终止/);
    await vi.waitFor(async () => expect((await readFile(marker, "utf8")).length).toBeGreaterThan(0));
    await rejected; await new Promise(resolve => setTimeout(resolve, 40)); const stopped = await readFile(marker, "utf8");
    await new Promise(resolve => setTimeout(resolve, 70)); expect(await readFile(marker, "utf8")).toBe(stopped);
  });
  it("cancels only the matching owner/session/request and revokes queued requests", async () => {
    const instance = service({ workerPath: await loopingWorker(), maxWorkers: 1 }); const owner = Symbol("owner"); const request = randomUUID();
    const marker = path.join(directory, "cancel-marker"); const input = { name: "loop.pdf", bytes: Buffer.from(`%PDF-${marker}`) };
    const pending = instance.prepare(owner, "project/session", request, input); const rejected = expect(pending).rejects.toThrow(/取消/);
    await vi.waitFor(async () => expect((await readFile(marker, "utf8")).length).toBeGreaterThan(0));
    instance.cancel(Symbol("owner"), "project/session", request); instance.cancel(owner, "other/session", request);
    await expect(instance.prepare(owner, "project/session", request, input)).rejects.toThrow(/正在处理/);
    const queuedOwner = Symbol("queued"); const queued = prepare(instance, "queued.pdf", pdfFixture(), queuedOwner); const queuedRejected = expect(queued).rejects.toThrow(/取消/);
    instance.revokeOwner(queuedOwner); await queuedRejected;
    instance.cancel(owner, "project/session", request); await rejected;
    await new Promise(resolve => setTimeout(resolve, 40)); const stopped = await readFile(marker, "utf8"); await new Promise(resolve => setTimeout(resolve, 70)); expect(await readFile(marker, "utf8")).toBe(stopped);
  });
  it("bounds queued job count and pending raw bytes", async () => {
    const instance = service({ workerPath: await loopingWorker(), maxWorkers: 1 });
    const pending = Array.from({ length: 17 }, () => prepare(instance, "queued.pdf", pdfFixture()).catch(error => error));
    await expect(prepare(instance, "over.pdf", pdfFixture())).rejects.toThrow(/待处理/); instance.close(); await Promise.all(pending);
    const bounded = service({ workerPath: await loopingWorker() }); const large = Buffer.alloc(6 * 1024 * 1024); large.write("%PDF-");
    const first = prepare(bounded, "first.pdf", large).catch(error => error); const second = prepare(bounded, "second.pdf", large).catch(error => error);
    await expect(prepare(bounded, "third.pdf", large)).rejects.toThrow(/16 MiB/); bounded.close(); await Promise.all([first, second]);
    await expect(prepare(bounded, "closed.txt", Buffer.from("hello"))).rejects.toThrow(/关闭/);
  });
});
