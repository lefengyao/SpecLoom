import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { RunFileChangeTracker } from "../../src/main/core/run-file-changes";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temporary() { const root = await mkdtemp(path.join(os.tmpdir(), "specloom-file-observer-")); roots.push(root); return root; }

test("marks count, byte and time limited scans incomplete without inventing additions or deletions", async () => {
  const root = await temporary(); await writeFile(path.join(root, "a"), "before"); await writeFile(path.join(root, "b"), "unchanged");
  for (const limits of [{ maxFiles: 0 }, { maxEntries: 0 }, { maxBytes: 0 }, { maxFileBytes: 0 }, { scanMs: 0 }]) {
    const tracker = new RunFileChangeTracker(root, "bounded", limits); await tracker.start();
    const report = await tracker.finish(); expect(report.complete).toBe(false); expect(report.files).toEqual([]); expect(report.notes.length).toBeGreaterThan(1);
  }
});

test("does not follow directory links or file links even when targets change", async () => {
  const root = await temporary(), outside = await temporary(); await writeFile(path.join(outside, "external"), "before");
  await symlink(outside, path.join(root, "linked-directory"), process.platform === "win32" ? "junction" : "dir");
  if (process.platform !== "win32") await symlink(path.join(outside, "external"), path.join(root, "linked-file"));
  const tracker = new RunFileChangeTracker(root, "linked"); await tracker.start(); await writeFile(path.join(outside, "external"), "after");
  expect((await tracker.finish()).files).toEqual([]);
});

test("retains directly verified writes outside scan coverage and bounds the persisted list", async () => {
  const root = await temporary(); const tracker = new RunFileChangeTracker(root, "tool-fallback", { maxFiles: 0 }); await tracker.start();
  await tracker.observe({ type: "tool-start", round: 1, toolCallId: "write", name: "Write", arguments: JSON.stringify({ path: "new" }) });
  await writeFile(path.join(root, "new"), "saved");
  await tracker.observe({ type: "tool-result", round: 1, toolCallId: "write", name: "Write", output: "{}", ok: true });
  const report = await tracker.finish(); expect(report.complete).toBe(false); expect(report.files).toEqual([{ path: "new", operation: "create", source: "tool" }]);
});

test("labels a subsequent command overwrite as workspace observation", async () => {
  const root = await temporary(); await writeFile(path.join(root, "file"), "baseline"); const tracker = new RunFileChangeTracker(root, "authorship"); await tracker.start();
  await tracker.observe({ type: "tool-start", round: 1, toolCallId: "edit", name: "Edit", arguments: JSON.stringify({ path: "file" }) });
  await writeFile(path.join(root, "file"), "tool"); await tracker.observe({ type: "tool-result", round: 1, toolCallId: "edit", output: "{}", ok: true });
  await writeFile(path.join(root, "file"), "someone else");
  expect((await tracker.finish()).files).toEqual([{ path: "file", operation: "modify", source: "workspace" }]);
});

test("bounds large reports and explains omitted paths", async () => {
  const root = await temporary(); const tracker = new RunFileChangeTracker(root, "many", { scanMs: 5000 }); await tracker.start();
  await mkdir(path.join(root, "created"));
  await Promise.all(Array.from({ length: 270 }, (_, index) => writeFile(path.join(root, "created", `${index}.txt`), "new")));
  const report = await tracker.finish(); expect(report.files).toHaveLength(256); expect(report.complete).toBe(false); expect(report.notes.join(" ")).toContain("持久化");
});

test("does not inspect an unapproved external target", async () => {
  const root = await temporary(), external = await temporary(); const target = path.join(external, "private"); await writeFile(target, "unapproved");
  const tracker = new RunFileChangeTracker(root, "denied", { maxBytes: 0 }); await tracker.start();
  await tracker.observe({ type: "tool-start", round: 1, toolCallId: "outside", name: "Edit", arguments: JSON.stringify({ path: target }) });
  await tracker.observe({ type: "tool-result", round: 1, toolCallId: "outside", name: "Edit", output: "denied", ok: false });
  const report = await tracker.finish(); expect(report.complete).toBe(true); expect(report.files).toEqual([]);
});

test("a successful no-op after a command reverts an earlier edit clears stale fallback evidence", async () => {
  const root = await temporary(); await writeFile(path.join(root, "file"), "baseline");
  const tracker = new RunFileChangeTracker(root, "reverted-partial", { maxFiles: 0 }); await tracker.start();
  for (const [id, content] of [["first", "changed"], ["noop", "baseline"]]) {
    if (id === "noop") await writeFile(path.join(root, "file"), "baseline");
    await tracker.observe({ type: "tool-start", round: 1, toolCallId: id!, name: "Write", arguments: JSON.stringify({ path: "file" }) });
    await writeFile(path.join(root, "file"), content!);
    await tracker.observe({ type: "tool-result", round: 1, toolCallId: id!, name: "Write", output: "{}", ok: true });
  }
  expect((await tracker.finish()).files).toEqual([]);
});

test("skips unapproved sensitive project files before inspecting their contents", async () => {
  const root = await temporary(); await writeFile(path.join(root, ".env"), "PRIVATE_VALUE=secret"); await writeFile(path.join(root, "private.pem"), "private material");
  const tracker = new RunFileChangeTracker(root, "sensitive", { maxBytes: 0 }); await tracker.start();
  const report = await tracker.finish();
  expect(report.complete).toBe(false); expect(report.files).toEqual([]);
  expect(report.notes.join(" ")).toContain("审批"); expect(report.notes.join(" ")).not.toContain("字节限制");
  const full = new RunFileChangeTracker(root, "full-sensitive", { maxBytes: 0 }, "full"); await full.start();
  expect((await full.finish()).notes.join(" ")).toContain("字节限制");
});

test("still confirms an approved sensitive Write against its approved before value", async () => {
  const root = await temporary(); await writeFile(path.join(root, ".env"), "before");
  const tracker = new RunFileChangeTracker(root, "approved-sensitive"); await tracker.start();
  await tracker.observe({ type: "tool-start", round: 1, toolCallId: "secret", name: "Write", arguments: JSON.stringify({ path: ".env" }) });
  await tracker.approved({ toolName: "Write", arguments: JSON.stringify({ path: ".env" }), reason: "修改敏感文件", risk: "high" });
  await writeFile(path.join(root, ".env"), "after");
  await tracker.observe({ type: "tool-result", round: 1, toolCallId: "secret", name: "Write", output: "{}", ok: true });
  expect((await tracker.finish()).files).toEqual([{ path: ".env", operation: "modify", source: "tool" }]);
});

test.each(["auto", "full"] as const)("rejects traversal targets before inspecting an external file in %s mode", async mode => {
  const root = await temporary(), outside = await temporary(); const target = path.join(outside, "outside.txt"); await writeFile(target, "unapproved");
  const relative = path.relative(root, target); const tracker = new RunFileChangeTracker(root, "invalid-traversal", { maxBytes: 0 }, mode); await tracker.start();
  await tracker.observe({ type: "tool-start", round: 1, toolCallId: "escape", name: "Edit", arguments: JSON.stringify({ path: relative }) });
  // Even a malformed/mismatched approval cannot convert a rejected relative path into file access.
  await tracker.approved({ toolName: "Edit", arguments: JSON.stringify({ path: relative }), reason: "fixture", risk: "high" });
  await tracker.observe({ type: "tool-result", round: 1, toolCallId: "escape", name: "Edit", output: "denied", ok: false });
  const report = await tracker.finish(); expect(report.complete).toBe(false); expect(report.files).toEqual([]);
  expect(report.notes.join(" ")).toContain("路径不符合"); expect(report.notes.join(" ")).not.toContain("字节限制");
});

test.each(["NUL", "sub/CON.txt", "COM¹.log", "file.", "file ", "file:stream", "C:drive-relative", ".", "sub/../file", "\\\\.\\NUL", "\\\\?\\C:\\private.txt"])("rejects invalid or device file tool target %s", async target => {
  const root = await temporary(); const tracker = new RunFileChangeTracker(root, "invalid-device", {}, "full"); await tracker.start();
  await tracker.observe({ type: "tool-start", round: 1, toolCallId: "invalid", name: "Write", arguments: JSON.stringify({ path: target }) });
  await tracker.observe({ type: "tool-result", round: 1, toolCallId: "invalid", name: "Write", output: "denied", ok: false });
  const report = await tracker.finish(); expect(report.complete).toBe(false); expect(report.files).toEqual([]); expect(report.notes.join(" ")).toContain("路径不符合");
});

test.each([
  { skipped: ".env", content: "PRIVATE_VALUE=secret", limits: {} },
  { skipped: "large.bin", content: "large".repeat(20), limits: { maxFileBytes: 16 } },
])("still observes command additions and deletions when $skipped content is uninspected", async ({ skipped, content, limits }) => {
  const root = await temporary(); await writeFile(path.join(root, skipped), content); await writeFile(path.join(root, "old.txt"), "old");
  const tracker = new RunFileChangeTracker(root, "partial-content", limits); await tracker.start();
  await tracker.observe({ type: "tool-start", round: 1, toolCallId: "command", name: "Bash", arguments: JSON.stringify({ command: "fixture file changes" }) });
  await writeFile(path.join(root, "new.txt"), "new"); await rm(path.join(root, "old.txt"));
  await tracker.observe({ type: "tool-result", round: 1, toolCallId: "command", name: "Bash", output: "done", ok: true });
  const report = await tracker.finish(); expect(report.complete).toBe(false);
  expect(report.files).toEqual([{ path: "new.txt", operation: "create", source: "workspace" }, { path: "old.txt", operation: "delete", source: "workspace" }]);
});
