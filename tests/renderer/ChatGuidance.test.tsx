// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ChatWorkbench } from "../../src/renderer/chat/ChatWorkbench";
import type { ChatSession, ChatSessionsApi, SessionEvent } from "../../src/shared/chat";

import { attachmentApi } from "./attachment-fixture";

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
function fixture(status: ChatSession["status"] = "running") {
  const records: ChatSession[] = ["a", "b"].map(id => ({ id, title: `会话${id}`, createdAt: "1", updatedAt: "1", archived: false, draft: "", draftRevision: 0, revision: 1, seq: 0, status, runId: `run-${id}`, items: [] }));
  const listeners = new Set<(event: SessionEvent) => void>();
  const api = {
    list: vi.fn(async () => structuredClone(records)),
    patch: vi.fn(async (_root: string, id: string, patch: Record<string, unknown>) => { const s = records.find(s => s.id === id)!; Object.assign(s, patch); s.revision++; return structuredClone(s); }),
    send: vi.fn<ChatSessionsApi["send"]>(), cancel: vi.fn(async () => undefined), create: vi.fn(), remove: vi.fn(), export: vi.fn(), import: vi.fn(), answer: vi.fn(), approve: vi.fn(),
    guide: vi.fn(async (_root: string, id: string, runId: string, guidanceId: string, prompt: string) => { const s = records.find(s => s.id === id)!; s.items.push({ id: `${runId}:guidance:${guidanceId}`, kind: "message", role: "user", content: prompt }); s.revision++; return structuredClone(s); }),
    subscribe: (listener: (event: SessionEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const report = vi.fn();
  const props = { attachments: attachmentApi(), api: api as ChatSessionsApi, projectPath: "P", tasks: [], providers: [{ id: "p", name: "测试", protocol: "openai" as const, baseUrl: "http://test", models: ["m"], modelSettings: { m: { vision: true } }, hasKey: false, keyStorage: "none" as const }], defaultModel: { providerId: "p", model: "m" }, review: undefined, busy: false, onSelectTask: vi.fn(), onNewTask: vi.fn(), onReview: vi.fn(async () => undefined), onError: report, onFinished: vi.fn() };
  const rendered = render(<ChatWorkbench {...props} />);
  return { api, report, rendered, props, records, emit(id: string, patch: Partial<ChatSession>) { const s = records.find(s => s.id === id)!; Object.assign(s, patch); s.revision++; act(() => { for (const listener of listeners) listener({ projectPath: "P", sessionId: id, ...(s.runId ? { runId: s.runId } : {}), seq: s.seq, session: structuredClone(s) }); }); } };
}
async function stage(text: string) {
  await screen.findByRole("button", { name: "会话a" });
  fireEvent.change(screen.getByLabelText("任务消息"), { target: { value: text } });
  fireEvent.keyDown(screen.getByLabelText("任务消息"), { key: "Enter" });
  return (await screen.findAllByRole("region", { name: "待引导消息" })).at(-1)!;
}

test("document guidance sends actual text once and editing does not restore a duplicate card", async () => {
  const f = fixture(); await screen.findByRole("button", { name: "会话a" });
  fireEvent.change(screen.getByLabelText("任务消息"), { target: { value: "补充要求" } });
  fireEvent.change(screen.getByLabelText("添加附件文件"), { target: { files: [new File(["引导文档真实正文"], "guidance.txt")] } });
  await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  const card = await screen.findByRole("region", { name: "待引导消息" });
  expect(card).toHaveTextContent("引导文档真实正文");
  fireEvent.click(within(card).getByRole("button", { name: "修改" }));
  expect((screen.getByLabelText("任务消息") as HTMLTextAreaElement).value.split("引导文档真实正文")).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "移除附件 guidance.txt" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  fireEvent.click(within(await screen.findByRole("region", { name: "待引导消息" })).getByRole("button", { name: "引导" }));
  await waitFor(() => expect(f.api.guide).toHaveBeenCalled());
  expect(f.api.guide.mock.calls[0]![4].split("引导文档真实正文")).toHaveLength(2);
});

test("stages messages above the composer, guides the active run immediately without cancelling it", async () => {
  const f = fixture(); const card = await stage("也请检查文档");
  expect(within(card).getByText("也请检查文档")).toBeVisible();
  expect(screen.getByLabelText("任务消息")).toHaveValue("");
  expect(f.api.send).not.toHaveBeenCalled();
  fireEvent.click(within(card).getByRole("button", { name: "引导" }));
  await waitFor(() => expect(f.api.guide).toHaveBeenCalledWith("P", "a", "run-a", expect.any(String), "也请检查文档"));
  await waitFor(() => expect(screen.queryByRole("region", { name: "待引导消息" })).not.toBeInTheDocument());
  expect(f.api.cancel).not.toHaveBeenCalled();
});

test("returns unguided text to its own composer when that agent finishes, preserving newer text", async () => {
  const f = fixture(); await stage("增加校验");
  fireEvent.change(screen.getByLabelText("任务消息"), { target: { value: "已有草稿" } });
  fireEvent.click(screen.getByRole("button", { name: "会话b" }));
  f.emit("a", { status: "completed" });
  expect(screen.getByLabelText("任务消息")).toHaveValue("");
  fireEvent.click(screen.getByRole("button", { name: "会话a" }));
  await waitFor(() => expect(screen.getByLabelText("任务消息")).toHaveValue("增加校验\n\n已有草稿"));
  expect(f.api.guide).not.toHaveBeenCalled();
});

test("edits and deletes staged messages without sending them", async () => {
  const f = fixture(); let card = await stage("待修改");
  fireEvent.click(within(card).getByRole("button", { name: "修改" }));
  expect(screen.getByLabelText("任务消息")).toHaveValue("待修改");
  fireEvent.change(screen.getByLabelText("任务消息"), { target: { value: "待删除" } });
  fireEvent.keyDown(screen.getByLabelText("任务消息"), { key: "Enter" });
  card = await screen.findByRole("region", { name: "待引导消息" });
  fireEvent.click(within(card).getByRole("button", { name: "删除" }));
  expect(screen.queryByRole("region", { name: "待引导消息" })).not.toBeInTheDocument();
  expect(screen.getByLabelText("任务消息")).toHaveValue("");
  expect(f.api.guide).not.toHaveBeenCalled();
});

test("rejects late guidance safely and restores its text after completion", async () => {
  const f = fixture(); const card = await stage("别丢失");
  let reject!: (error: Error) => void;
  f.api.guide.mockImplementationOnce(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
  fireEvent.click(within(card).getByRole("button", { name: "引导" }));
  f.emit("a", { status: "completed" });
  await act(async () => reject(new Error("运行已结束")));
  await waitFor(() => expect(screen.getByLabelText("任务消息")).toHaveValue("别丢失"));
  expect(f.api.send).not.toHaveBeenCalled();
});

test("recovers pending guidance after remount and does not duplicate accepted messages on transport failure", async () => {
  const f = fixture(); await stage("恢复的消息");
  f.rendered.unmount(); render(<ChatWorkbench {...f.props} />);
  const card = await screen.findByRole("region", { name: "待引导消息" });
  f.api.guide.mockImplementationOnce(async (_root, id, runId, guidanceId, prompt) => {
    f.emit(id, { items: [{ id: `${runId}:guidance:${guidanceId}`, kind: "message", role: "user", content: prompt }] });
    throw new Error("连接已断开");
  });
  fireEvent.click(within(card).getByRole("button", { name: "引导" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "待引导消息" })).not.toBeInTheDocument());
  expect(screen.getByLabelText("任务消息")).toHaveValue("");
  expect(f.report).not.toHaveBeenCalled();
});

test("does not resend the initial run's image attachment with a later text guidance", async () => {
  const f = fixture("idle"); await screen.findByRole("button", { name: "会话a" });
  let finish!: (session: ChatSession) => void;
  f.api.send.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.change(screen.getByLabelText("添加附件文件"), { target: { files: [new File([new Uint8Array([137, 80, 78, 71])], "original.png", { type: "image/png" })] } });
  await screen.findByRole("button", { name: "移除附件 original.png" });
  fireEvent.change(screen.getByLabelText("任务消息"), { target: { value: "开始原任务" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(f.api.send).toHaveBeenCalled());
  f.emit("a", { status: "running", runId: "new-run" });
  const card = await stage("只增加文字要求");
  fireEvent.click(within(card).getByRole("button", { name: "引导" }));
  await waitFor(() => expect(f.api.guide).toHaveBeenCalled());
  expect(f.api.guide.mock.calls[0]).toHaveLength(5);
  await act(async () => finish({ ...f.records[0]!, status: "completed", revision: 20 }));
});

test("late acceptance from an unmounted page cannot overwrite newer staged messages", async () => {
  const f = fixture(); const card = await stage("旧引导");
  let finish!: (session: ChatSession) => void;
  f.api.guide.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.click(within(card).getByRole("button", { name: "引导" }));
  f.rendered.unmount(); const second = render(<ChatWorkbench {...f.props} />);
  await stage("新引导");
  const call = f.api.guide.mock.calls[0]!;
  const accepted: ChatSession = { ...f.records[0]!, items: [{ id: `${call[2]}:guidance:${call[3]}`, kind: "message", role: "user", content: call[4] }], revision: 20 };
  Object.assign(f.records[0]!, accepted);
  await act(async () => finish(accepted));
  second.unmount(); render(<ChatWorkbench {...f.props} />);
  await waitFor(() => expect(screen.getByRole("region", { name: "待引导消息" })).toHaveTextContent("新引导"));
});

test("a restored card with an accepted receipt disappears while the same run continues", async () => {
  const f = fixture(); await stage("已经引导过");
  const saved = JSON.parse(localStorage.getItem("specloom:guidance:P")!)[0] as { runId: string; id: string; text: string };
  f.records[0]!.items.push({ id: `${saved.runId}:guidance:${saved.id}`, kind: "message", role: "user", content: saved.text });
  f.records[0]!.revision++;
  f.rendered.unmount(); render(<ChatWorkbench {...f.props} />);
  await screen.findByRole("button", { name: "会话a" });
  await waitFor(() => expect(screen.queryByRole("region", { name: "待引导消息" })).not.toBeInTheDocument());
  expect(screen.getByLabelText("任务消息")).toHaveValue("");
});
