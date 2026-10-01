import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileStore } from "../../src/main/core/file-store";

const roots: string[] = [];
async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-files-"));
  roots.push(root);
  return root;
}
const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("versioned file store", () => {
  it("lists normalized paths with hashes and absent versions", async () => {
    const root = await fixture();
    await mkdir(path.join(root, "specs"));
    await writeFile(path.join(root, "specs/a.md"), "hello");
    const store = new FileStore(root);
    expect(await store.listVersion("specs\\a.md")).toEqual({ path: "specs/a.md", exists: true, size: 5, version: hash("hello") });
    expect(await store.listVersion("specs/missing.md")).toEqual({ path: "specs/missing.md", exists: false, size: 0, version: "absent" });
    expect(await store.listVersions(["specs/a.md", "missing"])).toHaveLength(2);
    expect(await store.listFiles("specs")).toEqual([await store.listVersion("specs/a.md")]);
  });

  it("hashes exactly the bytes returned and rejects stale reads and updates", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "a.md"), "old");
    const store = new FileStore(root);
    const old = await store.listVersion("a.md");
    expect(await store.read("a.md", old.version)).toEqual({ path: "a.md", content: "old", version: hash("old") });
    await writeFile(path.join(root, "a.md"), "external");
    await expect(store.read("a.md", old.version)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    await expect(store.write("a.md", "replacement", old.version)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(await readFile(path.join(root, "a.md"), "utf8")).toBe("external");
    await expect(store.read("absent", "absent")).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
  });

  it("patches only one exact unique occurrence", async () => {
    const root = await fixture();
    const store = new FileStore(root);
    const first = await store.write("a.md", "aba", "absent");
    await expect(store.patch("a.md", { search: "a", replace: "x" }, first.version)).rejects.toMatchObject({ code: "INVALID_PATCH" });
    await expect(store.patch("a.md", { search: "", replace: "x" }, first.version)).rejects.toMatchObject({ code: "INVALID_PATCH" });
    await expect(store.patch("a.md", { search: "z", replace: "x" }, first.version)).rejects.toMatchObject({ code: "INVALID_PATCH" });
    const next = await store.patch("a.md", { search: "b", replace: "x" }, first.version);
    expect((await store.read("a.md", next.version)).content).toBe("axa");
    await store.remove("a.md", next.version);
    expect((await store.listVersion("a.md")).version).toBe("absent");
  });

  it("uses exclusive creation when an external file appears after the absence check", async () => {
    const root = await fixture();
    const store = new FileStore(root, { fs: { open: async (target, flags, mode) => {
      if (target === path.join(root, "race.md") && flags === "wx") await writeFile(target, "external");
      return fs.open(target, flags, mode);
    } } });
    await expect(store.write("race.md", "ours", "absent")).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(await readFile(path.join(root, "race.md"), "utf8")).toBe("external");
  });

  it("rechecks the target after preparing an update", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "a.md"), "old");
    const store = new FileStore(root, { fs: { open: async (target, flags, mode) => {
      const handle = await fs.open(target, flags, mode);
      if (String(target).includes(".specloom-tmp-")) await writeFile(path.join(root, "a.md"), "external");
      return handle;
    } } });
    await expect(store.write("a.md", "ours", hash("old"))).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(await readFile(path.join(root, "a.md"), "utf8")).toBe("external");
    expect((await fs.readdir(root)).some((name) => name.includes(".specloom-tmp-"))).toBe(false);
  });

  it.each(["../outside", "a/../outside", "/absolute", "C:\\outside", "C:relative", "file:stream", "\\\\server\\share", "a\u0000b", "a. ", "CON.md"])("rejects unsafe path %s", async (relative) => {
    const store = new FileStore(await fixture());
    await expect(store.listVersion(relative)).rejects.toMatchObject({ code: "PATH_ESCAPE" });
  });

  it.each([
    "COM\u00b9", "COM\u00b2", "COM\u00b3", "LPT\u00b9", "LPT\u00b2", "LPT\u00b3",
    "specs/com\u00b9.md", "specs/com\u00b2.md", "specs/com\u00b3.md",
    "specs/lpt\u00b9.md", "specs/lpt\u00b2.md", "specs/lpt\u00b3.md",
  ])("rejects Windows superscript device path %j before filesystem access", async (relative) => {
    const root = await fixture();
    const store = new FileStore(root);
    await expect(store.listVersion(relative)).rejects.toMatchObject({ code: "PATH_ESCAPE" });
    await expect(store.write(relative, "unsafe", "absent")).rejects.toMatchObject({ code: "PATH_ESCAPE" });
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("rejects root junctions, ancestor junctions and links to files", async () => {
    const root = await fixture();
    const outside = await fixture();
    await writeFile(path.join(outside, "a.md"), "outside");
    await symlink(outside, path.join(root, "linked"), "junction");
    const store = new FileStore(root);
    await expect(store.read("linked/a.md", hash("outside"))).rejects.toMatchObject({ code: "PATH_ESCAPE" });
    await expect(store.write("linked/new.md", "ours", "absent")).rejects.toMatchObject({ code: "PATH_ESCAPE" });
    await expect(new FileStore(path.join(root, "linked")).listFiles()).rejects.toMatchObject({ code: "PATH_ESCAPE" });
    await expect(new FileStore(path.join(root, "linked/subdir")).listFiles()).rejects.toMatchObject({ code: "PATH_ESCAPE" });
  });

  it("excludes runtime trees, allows skills, and refuses reserved metadata", async () => {
    const root = await fixture();
    for (const directory of [".git", ".godot", ".specloom/history", ".specloom/skills/test"]) await mkdir(path.join(root, directory), { recursive: true });
    for (const relative of [".git/config", ".godot/cache", ".specloom/history/a.json", ".specloom/project.yaml", ".specloom/skills/test/SKILL.md", "a.md"]) await writeFile(path.join(root, relative), "text");
    const store = new FileStore(root);
    expect((await store.listFiles()).map((entry) => entry.path)).toEqual([".specloom/skills/test/SKILL.md", "a.md"]);
    await expect(store.write(".specloom/project.yaml", "ours", hash("text"))).rejects.toMatchObject({ code: "TASK_SCOPE_DENIED" });
    await expect(store.listVersion(".GIT/config")).rejects.toMatchObject({ code: "TASK_SCOPE_DENIED" });
  });

  it("lists binary metadata but bounds text and validates UTF8", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "binary"), Buffer.from([0xff, 0xfe]));
    const store = new FileStore(root, { maxTextBytes: 4 });
    const version = await store.listVersion("binary");
    expect(version.size).toBe(2);
    await expect(store.read("binary", version.version)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(store.write("binary", "text", version.version)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(store.write("large", "12345", "absent")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(store.write("invalid", "\ud800", "absent")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("preserves UTF-8 BOM bytes in versioned reads and updates", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "bom.md"), "\ufeffhello");
    const store = new FileStore(root);
    const version = await store.listVersion("bom.md");
    const read = await store.read("bom.md", version.version);
    expect(read.content).toBe("\ufeffhello");
    expect(hash(read.content)).toBe(read.version);
  });

  it("serializes stores sharing the same root", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "a.md"), "old");
    const results = await Promise.allSettled([new FileStore(root).write("a.md", "first", hash("old")), new FileStore(root).write("a.md", "second", hash("old"))]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });
});
