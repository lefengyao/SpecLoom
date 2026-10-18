import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FileStore } from "../../src/main/core/file-store";
import { readProjectText } from "../../src/main/core/project-files";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(path.join(os.tmpdir(), "specloom-preview-")); roots.push(root); return root; }

it("reads ordinary UTF-8 once and returns the size and version of those bytes without a version pre-read", async () => {
  const root = await fixture();
  const content = "extends Node\n# 项目脚本\n";
  await writeFile(path.join(root, "player.gd"), content);
  let opened = 0;
  const store = new FileStore(root, { fs: { open: async (...args) => { opened++; return fs.open(...args); } } });
  vi.spyOn(store, "listVersion").mockRejectedValue(new Error("must not hash before the bounded reader"));
  expect(await readProjectText(store, "player.gd")).toEqual({ path: "player.gd", content, size: Buffer.byteLength(content), version: `sha256:${createHash("sha256").update(content).digest("hex")}` });
  expect(opened).toBe(1);
});

it("bounds ordinary previews before content reads and preserves versioned read result shape", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "large.txt"), Buffer.alloc(1024 * 1024 + 1));
  await writeFile(path.join(root, "invalid.txt"), Buffer.from([0xc3, 0x28]));
  await writeFile(path.join(root, "valid.txt"), "hello");
  const store = new FileStore(root);
  await expect(readProjectText(store, "large.txt")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  await expect(readProjectText(new FileStore(root, { maxTextBytes: 2 * 1024 * 1024 }), "large.txt")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  await expect(readProjectText(store, "invalid.txt")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  await expect(readProjectText(store, "missing.txt")).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
  const current = await store.readCurrentText("valid.txt");
  expect(await store.read("valid.txt", current.version)).toEqual({ path: current.path, version: current.version, content: current.content });
  await expect(store.read("missing.txt", "sha256:old")).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
});
