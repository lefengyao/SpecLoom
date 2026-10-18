import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { SessionRuns, type SessionRunOptions } from "../../src/main/core/session-runs";
import { SessionStore } from "../../src/main/core/session-store";
import type { ChatSession } from "../../src/shared/chat";
import type { AgentRunResult } from "../../src/main/core/agent-runtime";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(taskId?: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-run-files-")); roots.push(root);
  const store = await SessionStore.open(root); const session = await store.create("文件成果", taskId);
  return { root, store, session, runs: new SessionRuns(store, root) };
}
const result = (): AgentRunResult => ({ summary: "完成", toolCalls: 0, rounds: 1, messages: [{ role: "assistant", content: "完成" }] });
function reports(session: ChatSession) { return session.items.flatMap(item => item.kind === "message" && item.fileChanges ? [item.fileChanges] : []); }
async function tool(options: SessionRunOptions, id: string, name: string, target: string, operation: () => Promise<void>, ok = true) {
  await options.onEvent?.({ type: "tool-start", round: 1, toolCallId: id, name, arguments: JSON.stringify({ ok: true, result: { path: target }, truncated: false }) });
  await operation();
  await options.onEvent?.({ type: "tool-result", round: 1, toolCallId: id, name, output: "{}", ok });
}

test("reports content changes in a non-Git Chinese project against the pre-run dirty baseline", async () => {
  const { root, store, session, runs } = await fixture("task-files");
  await writeFile(path.join(root, "已有脏文件.txt"), "用户已编辑");
  await writeFile(path.join(root, "修改.txt"), "旧值"); await writeFile(path.join(root, "删除.txt"), "删除前");
  const completed = await runs.send(session.id, "修改项目", async options => {
    await tool(options, "edit", "Edit", "修改.txt", () => writeFile(path.join(root, "修改.txt"), "新值"));
    await tool(options, "edit-again", "Edit", "修改.txt", () => writeFile(path.join(root, "修改.txt"), "最终值"));
    await writeFile(path.join(root, "命令新增.txt"), "命令生成"); await rm(path.join(root, "删除.txt"));
    await options.onEvent?.({ type: "text", round: 1, messageId: "final", content: "完成" });
    return result();
  });
  expect(reports(completed)).toEqual([{ runId: completed.runId, complete: true, notes: expect.any(Array), files: [
    { path: "修改.txt", operation: "modify", source: "tool" },
    { path: "删除.txt", operation: "delete", source: "workspace" },
    { path: "命令新增.txt", operation: "create", source: "workspace" },
  ] }]);
  expect(await readFile(path.join(root, "已有脏文件.txt"), "utf8")).toBe("用户已编辑");
  const reopened = await SessionStore.open(root); expect(reports(reopened.get(session.id))).toEqual(reports(completed));
  expect(reports(await reopened.import(store.export(session.id)))).toEqual(reports(completed));
});

test("omits reads, failed edits, unchanged writes, reverted changes and excluded runtime files", async () => {
  const { root, session, runs } = await fixture(); await writeFile(path.join(root, "same.txt"), "same");
  const completed = await runs.send(session.id, "检查", async options => {
    await tool(options, "read", "Read", "same.txt", async () => { await readFile(path.join(root, "same.txt")); });
    await tool(options, "failed", "Edit", "same.txt", async () => undefined, false);
    await tool(options, "noop", "Write", "same.txt", () => writeFile(path.join(root, "same.txt"), "same"));
    await tool(options, "temporary", "Write", "same.txt", () => writeFile(path.join(root, "same.txt"), "temporary"));
    await tool(options, "revert", "Write", "same.txt", () => writeFile(path.join(root, "same.txt"), "same"));
    for (const directory of [".git", ".godot", ".specloom", "node_modules", "dist", "build"]) { await mkdir(path.join(root, directory), { recursive: true }); await writeFile(path.join(root, directory, "generated"), "ignored"); }
    return result();
  });
  expect(reports(completed)).toHaveLength(1); expect(reports(completed)[0]?.files).toEqual([]);
});

test("keeps runs separate and captures successful approved external paths", async () => {
  const { root, session, runs } = await fixture(); const external = await mkdtemp(path.join(os.tmpdir(), "specloom-external-")); roots.push(external);
  const target = path.join(external, "外部.txt"); await writeFile(target, "before");
  const unsubscribe = runs.subscribe(event => { const approval = event.session.items.find(item => item.kind === "approval" && item.status === "waiting"); if (approval?.kind === "approval") void runs.approve(session.id, approval.request.runId, approval.id, true); });
  const first = await runs.send(session.id, "外部修改", async options => {
    await options.onEvent?.({ type: "tool-start", round: 1, toolCallId: "external", name: "Edit", arguments: JSON.stringify({ path: target }) });
    expect(await options.onApproval({ toolName: "Edit", arguments: JSON.stringify({ path: target }), reason: "修改外部文件", risk: "high" })).toBe(true);
    await writeFile(target, "after"); await options.onEvent?.({ type: "tool-result", round: 1, toolCallId: "external", name: "Edit", output: "{}", ok: true });
    return result();
  }); unsubscribe();
  expect(reports(first)[0]?.files).toEqual([{ path: target.replaceAll("\\", "/"), operation: "modify", source: "tool" }]);
  const second = await runs.send(session.id, "下一轮", async () => { await writeFile(path.join(root, "new.txt"), "next"); return result(); });
  expect(reports(second)).toHaveLength(2); expect(reports(second)[1]?.files).toEqual([{ path: "new.txt", operation: "create", source: "workspace" }]);
  expect(reports(second)[1]?.runId).not.toBe(reports(first)[0]?.runId);
});

test.each(["cancel", "error"])("retains confirmed writes when a run ends with %s and has no reply", async ending => {
  const { root, store, session, runs } = await fixture();
  const pending = runs.send(session.id, "保留修改", async options => {
    await tool(options, "write", "Write", "已保存.txt", () => writeFile(path.join(root, "已保存.txt"), "saved"));
    if (ending === "cancel") { runs.cancel(session.id); return new Promise<AgentRunResult>(() => undefined); }
    throw new Error("provider failed");
  });
  await expect(pending).rejects.toThrow();
  const ended = store.get(session.id); expect(ended.status).toBe(ending === "cancel" ? "cancelled" : "error");
  expect(reports(ended)[0]?.files).toEqual([{ path: "已保存.txt", operation: "create", source: "tool" }]);
});
