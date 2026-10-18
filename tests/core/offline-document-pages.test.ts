import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OfflineDocumentStore } from "../../src/main/core/offline-documents";
import { redactSecret, toolOutput } from "../../src/main/core/agent-output";
import type { OfflineDocumentRead } from "../../src/shared/offline-documents";

let root: string;
let store: OfflineDocumentStore;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "specloom-doc-pages-")); store = new OfflineDocumentStore(path.join(root, "user")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function document(content: string, name = "Guide") {
  const source = path.join(root, "guide.md");
  await writeFile(source, content, "utf8");
  return store.importFiles([source], name, "1", true);
}

test.each(["章节🙂".repeat(5000), "\\\"\t\u0001\r\n".repeat(4000)])("continuation reconstructs the whole document within the actual tool result budget", async (text) => {
  const bundle = await document(text);
  let offset = 0;
  let received = "";
  let pages = 0;
  do {
    const page = await store.read(bundle.id, bundle.activeVersionId, "guide.md", { offset, limit: 8000 });
    const serialized = toolOutput(true, page);
    const output = JSON.parse(serialized) as { truncated: boolean; result: OfflineDocumentRead };
    expect(output.truncated).toBe(false);
    expect(serialized.length).toBeLessThanOrEqual(16_384);
    expect(output.result.page).toMatchObject({ offset, totalChars: text.length });
    const content = output.result.content!;
    expect(content).toBe(text.slice(offset, offset + content.length));
    expect(content).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(content).not.toMatch(/^[\uDC00-\uDFFF]/);
    received += content; pages++;
    if (!output.result.page!.hasMore) { expect(output.result.page!.nextOffset).toBeNull(); break; }
    expect(output.result.page!.nextOffset).toBe(offset + content.length);
    offset = output.result.page!.nextOffset!;
  } while (pages < 100);
  expect(pages).toBeGreaterThan(1);
  expect(received).toBe(text);
});

test("pins continuation to the returned version when the active version changes", async () => {
  const oldText = "old".repeat(4000);
  const bundle = await document(oldText);
  const first = await store.read(bundle.id, undefined, "guide.md", { limit: 6000 });
  expect(first.page!.nextOffset).toBe(6000);
  await writeFile(path.join(root, "guide.md"), "new version", "utf8");
  const newer = await store.importFiles([path.join(root, "guide.md")], "Guide", "2", true, { setCurrent: true });
  expect(newer.activeVersionId).not.toBe(first.versionId);
  const second = await store.read(bundle.id, first.versionId, "guide.md", { offset: first.page!.nextOffset! });
  expect(first.content! + second.content!).toBe(oldText);
  expect(second.page!.hasMore).toBe(false);
});

test("validates ranges and handles empty files and exact end offsets", async () => {
  const bundle = await document("A🙂B");
  for (const options of [{ offset: -1 }, { offset: 99 }, { offset: 2 }, { limit: 0 }, { limit: 8001 }, { offset: 1, limit: 1 }]) {
    await expect(store.read(bundle.id, undefined, "guide.md", options)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  }
  const end = await store.read(bundle.id, undefined, "guide.md", { offset: 4 });
  expect(end).toMatchObject({ content: "", page: { offset: 4, nextOffset: null, hasMore: false, totalChars: 4 } });
  expect(await store.read(bundle.id, undefined, "guide.md", { offset: 1, limit: 2 }))
    .toMatchObject({ content: "🙂", page: { nextOffset: 3, hasMore: true } });
  const empty = await document("", "Empty");
  expect(await store.read(empty.id, undefined, "guide.md", {})).toMatchObject({ content: "", page: { offset: 0, nextOffset: null, hasMore: false, totalChars: 0 } });
});

test("a page boundary inside a redaction marker still reconstructs sanitized text", async () => {
  const text = "Bearer OTHER-CREDENTIAL and final content";
  const bundle = await document(text);
  let offset = 0;
  let combined = "";
  for (let pages = 0; pages < 100; pages++) {
    const read = await store.read(bundle.id, undefined, "guide.md", { offset, limit: 12 });
    const output = JSON.parse(toolOutput(true, read));
    expect(output.truncated).toBe(false);
    expect(output.result.content).toBe(read.content);
    combined += output.result.content;
    if (!read.page!.hasMore) break;
    expect(read.page!.nextOffset).toBeGreaterThan(offset);
    offset = read.page!.nextOffset!;
  }
  expect(combined).toBe(redactSecret(text));
});

test("repeated redaction preserves the existing Bearer marker", () => {
  const redacted = redactSecret("Bearer OTHER-CREDENTIAL");
  expect(redactSecret(redacted)).toBe(redacted);
});

test("direct document previews retain the full text and disabled libraries still reject pages", async () => {
  const text = "full preview".repeat(2000);
  const bundle = await document(text);
  expect(await store.read(bundle.id, undefined, "guide.md")).toMatchObject({ content: text });
  await store.setEnabled(bundle.id, false);
  await expect(store.read(bundle.id, undefined, "guide.md", {})).rejects.toMatchObject({ code: "TASK_SCOPE_DENIED" });
});

test("redacts the full document before paging so a boundary cannot split credentials", async () => {
  const credential = "PAGE-SECRET-CREDENTIAL";
  const text = "x".repeat(5995) + credential + "\nBearer OTHER-CREDENTIAL\n" + "later".repeat(2000);
  const bundle = await document(text);
  let offset = 0;
  let combined = "";
  for (let pages = 0; pages < 20; pages++) {
    const read = await store.read(bundle.id, bundle.activeVersionId, "guide.md", { offset }, value => redactSecret(value, credential));
    const output = JSON.parse(toolOutput(true, read, credential));
    expect(output.truncated).toBe(false);
    combined += output.result.content;
    if (!read.page!.hasMore) break;
    offset = read.page!.nextOffset!;
  }
  expect(combined).toBe(redactSecret(text, credential));
  expect(combined).not.toContain(credential);
});
