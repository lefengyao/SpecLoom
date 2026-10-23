// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ChatWorkbench } from "../../src/renderer/chat/ChatWorkbench";
import type { ChatSession, ChatSessionsApi, SessionEvent } from "../../src/shared/chat";
import type { ChangeReview, TaskView } from "../../src/shared/desktop-api";
import type { SessionModelPreference } from "../../src/shared/contracts";
import { task as legacyTask } from "./fixtures";
import { attachmentApi } from "./attachment-fixture";

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const session = (id: string, title: string): ChatSession => ({ id, title, createdAt: "1", updatedAt: "1", archived: false, draft: "", draftRevision: 0, revision: 1, seq: 0, status: "idle", items: [] });
function fixture(initial = [session("a", "会话A"), session("b", "会话B")], tasks: TaskView[] = [], review: ChangeReview | undefined = undefined, listImpl?: ChatSessionsApi["list"], documents?: () => Promise<{ path: string }[]>, sessionModel?: SessionModelPreference, vision = true) {
  const records = initial;
  const listeners = new Set<(event: SessionEvent) => void>();
  const changeListeners = new Set<(projectPath: string) => void>();
  const api: ChatSessionsApi = {
    list: listImpl ?? vi.fn(async () => structuredClone(records)), create: vi.fn(async () => session("new", "新会话")),
    patch: vi.fn(async (_root, id, patch) => { const next = records.find((s) => s.id === id)!; Object.assign(next, patch); if (patch.draft !== undefined) next.draftRevision++; next.revision++; return structuredClone(next); }),
    remove: vi.fn(async () => undefined), export: vi.fn(async () => "{}"), import: vi.fn(async () => session("i", "导入")),
    send: vi.fn(async (_root, id) => { const next = records.find((s) => s.id === id)!; return { ...next, status: "completed", revision: next.revision + 1 } as ChatSession; }),
    guide: vi.fn(async (_root, id) => structuredClone(records.find((s) => s.id === id)!)),
    cancel: vi.fn(async () => undefined), answer: vi.fn(async (_root, id) => records.find((s) => s.id === id)!), approve: vi.fn(async (_root, id) => records.find((s) => s.id === id)!),
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    subscribeChanges: listener => { changeListeners.add(listener); return () => { changeListeners.delete(listener); }; },
  };
  const report = vi.fn();
  const editScope = vi.fn();
  const attachments = attachmentApi();
  render(<ChatWorkbench api={api} attachments={attachments} projectPath="P" tasks={tasks} providers={[{ id: "p", name: "测试", protocol: "openai", baseUrl: "http://test", models: ["m", ...(sessionModel?.model && sessionModel.model !== "m" ? [sessionModel.model] : [])], modelSettings: { m: { vision } }, hasKey: false, keyStorage: "none" }]} defaultModel={{ providerId: "p", model: "m" }} {...(sessionModel ? { sessionModel } : {})} review={review} busy={false} onSelectTask={vi.fn()} onNewTask={vi.fn()} onEditTaskScope={editScope} onReview={vi.fn(async () => undefined)} onError={report} onFinished={vi.fn()} {...(documents ? { documents } : {})} />);
  return { api, records, attachments, report, editScope, invalidate() { act(() => { for (const listener of changeListeners) listener("P"); }); }, emit(next: ChatSession) { act(() => { for (const listener of listeners) listener({ projectPath: "P", sessionId: next.id, ...(next.runId ? { runId: next.runId } : {}), seq: next.seq, session: next }); }); } };
}

test("opens the scope editor for the active task session", async () => {
  const f = fixture([{ ...session("a", "任务会话"), taskId: "task-1" }], [legacyTask]);
  await screen.findByRole("button", { name: "任务会话" });
  fireEvent.click(screen.getByRole("button", { name: "编辑范围" }));
  expect(f.editScope).toHaveBeenCalledWith(expect.objectContaining({ id: "task-1" }));
});

test("replaces the send shortcut control with session approval permissions", async () => {
  const f = fixture(); await screen.findByRole("button", { name: "会话A" });
  const permissions = screen.getByRole("combobox", { name: "审批权限" });
  expect(permissions).toHaveValue("auto");
  expect(within(permissions).getAllByRole("option").map(option => option.textContent)).toEqual(["请求批准", "帮我批准", "完全访问"]);
  expect(screen.queryByRole("combobox", { name: "发送快捷键" })).not.toBeInTheDocument();
  fireEvent.change(permissions, { target: { value: "full" } });
  await waitFor(() => expect(f.api.patch).toHaveBeenCalledWith("P", "a", { approvalMode: "full" }));
  await waitFor(() => expect(permissions).toHaveValue("full"));
  fireEvent.click(screen.getByRole("button", { name: "会话B" }));
  expect(permissions).toHaveValue("auto");
  fireEvent.click(screen.getByRole("button", { name: "会话A" }));
  expect(permissions).toHaveValue("full");
});

test.each(["running", "waiting"] as const)("locks approval permissions during a %s run", async status => {
  fixture([{ ...session("a", "会话A"), approvalMode: "ask", status }]);
  await screen.findByRole("button", { name: "会话A" });
  expect(screen.getByRole("combobox", { name: "审批权限" })).toBeDisabled();
});

test("waits for a pending permission update before allowing a new run", async () => {
  const f = fixture(); await screen.findByRole("button", { name: "会话A" });
  const originalPatch = vi.mocked(f.api.patch).getMockImplementation()!;
  let finish!: (session: ChatSession) => void;
  vi.mocked(f.api.patch).mockImplementation((root, id, patch) => patch.approvalMode ? new Promise(resolve => { finish = resolve; }) : originalPatch(root, id, patch));
  fireEvent.change(screen.getByLabelText("任务消息"), { target: { value: "下一项任务" } });
  fireEvent.change(screen.getByRole("combobox", { name: "审批权限" }), { target: { value: "ask" } });
  expect(screen.getByRole("combobox", { name: "审批权限" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  fireEvent.keyDown(screen.getByLabelText("任务消息"), { key: "Enter" });
  expect(f.api.send).not.toHaveBeenCalled();
  await act(async () => finish({ ...f.records[0]!, approvalMode: "ask", revision: 10 }));
  expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
  expect(screen.getByRole("combobox", { name: "审批权限" })).toHaveValue("ask");
});

test("preserves the saved permission and draft when a permission change fails", async () => {
  const f = fixture(); await screen.findByRole("button", { name: "会话A" });
  vi.mocked(f.api.patch).mockRejectedValueOnce(new Error("权限设置保存失败"));
  fireEvent.change(screen.getByLabelText("任务消息"), { target: { value: "未发送草稿" } });
  fireEvent.change(screen.getByRole("combobox", { name: "审批权限" }), { target: { value: "full" } });
  await waitFor(() => expect(f.report).toHaveBeenCalledWith(expect.objectContaining({ message: "权限设置保存失败" })));
  expect(screen.getByRole("combobox", { name: "审批权限" })).toHaveValue("auto");
  expect(screen.getByRole("combobox", { name: "审批权限" })).toBeEnabled();
  expect(screen.getByLabelText("任务消息")).toHaveValue("未发送草稿");
});

test("keeps an existing modifier-Enter preference when the shortcut selector is removed", async () => {
  localStorage.setItem("specloom:send-shortcut", "mod-enter");
  const f = fixture(); await screen.findByRole("button", { name: "会话A" });
  const input = screen.getByLabelText("任务消息");
  fireEvent.change(input, { target: { value: "提交任务" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(f.api.send).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(f.api.send).toHaveBeenCalled());
  expect(localStorage.getItem("specloom:send-shortcut")).toBe("mod-enter");
});

test("routes an approval response to its original session and request", async () => {
  const approval: Extract<ChatSession["items"][number], { kind: "approval" }> = { id: "approval-item", kind: "approval", status: "waiting", request: { id: "approval-1", sessionId: "a", runId: "run-a", toolName: "Bash", arguments: '{"command":"curl https://example.com"}', reason: "请求访问网络", risk: "standard" } };
  const f = fixture([{ ...session("a", "会话A"), runId: "run-a", status: "waiting", items: [approval] }]);
  fireEvent.click(await screen.findByRole("button", { name: "批准" }));
  await waitFor(() => expect(f.api.approve).toHaveBeenCalledWith("P", "a", "run-a", "approval-1", true));
});
test("uses the session model preference before the default model for a new chat session", async () => {
  const preference = { providerId: "p", model: "session", reasoning: "high" } as const;
  const f = fixture(undefined, [], undefined, undefined, undefined, preference);
  await screen.findByRole("button", { name: "会话A" });
  expect(screen.getByLabelText("选择模型")).toHaveValue("p:session");
  expect(screen.getByLabelText("思考偏好")).toHaveValue("high");
  fireEvent.change(screen.getByLabelText("任务消息"), { target: { value: "开始" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(f.api.send).toHaveBeenCalled());
  expect(f.api.patch).toHaveBeenCalledWith("P", "a", { model: preference });
});
test("preserves an existing chat session's model and reasoning over global preferences", async () => {
  const existing = { ...session("a", "会话A"), model: { providerId: "p", model: "m", reasoning: "off" } as const };
  fixture([existing], [], undefined, undefined, undefined, { providerId: "p", model: "session", reasoning: "high" });
  await screen.findByRole("button", { name: "会话A" });
  expect(screen.getByLabelText("选择模型")).toHaveValue("p:m");
  expect(screen.getByLabelText("思考偏好")).toHaveValue("off");
});
async function confirmSessionRemoval() {
  const dialog = await screen.findByRole("dialog", { name: "删除会话" });
  fireEvent.click(within(dialog).getByRole("button", { name: "确认删除" }));
}

test("deleted sessions stay removed when an earlier draft save or stream event arrives late", async () => {
  const f = fixture(); await screen.findByRole("button", { name: "会话A" });
  let finish!: (value: ChatSession) => void;
  vi.mocked(f.api.patch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.change(screen.getByLabelText("任务消息"), { target: { value: "旧会话草稿" } });
  await waitFor(() => expect(f.api.patch).toHaveBeenCalledWith("P", "a", { draft: "旧会话草稿" }));
  const late = { ...structuredClone(f.records[0]!), draft: "旧会话草稿", revision: 5 };
  vi.mocked(f.api.remove).mockImplementation(async (_root, id) => { f.records.splice(f.records.findIndex(record => record.id === id), 1); });
  fireEvent.click(screen.getByRole("button", { name: "会话设置 会话A" }));
  fireEvent.click(screen.getByRole("button", { name: "删除会话" }));
  await confirmSessionRemoval();
  await waitFor(() => expect(screen.queryByRole("button", { name: "会话A" })).not.toBeInTheDocument());
  await act(async () => finish(late));
  f.emit({ ...late, revision: 6 });
  expect(screen.queryByRole("button", { name: "会话A" })).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "会话B" })).toBeVisible();
});

test("deletion cancels a pending debounced draft save", async () => {
  const f = fixture(); await screen.findByRole("button", { name: "会话A" });
  vi.mocked(f.api.remove).mockImplementation(async (_root, id) => { f.records.splice(f.records.findIndex(record => record.id === id), 1); });
  vi.useFakeTimers();
  try {
    fireEvent.change(screen.getByLabelText("任务消息"), { target: { value: "待保存草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "会话设置 会话A" }));
    fireEvent.click(screen.getByRole("button", { name: "删除会话" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "删除会话" })).getByRole("button", { name: "确认删除" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(f.api.patch).not.toHaveBeenCalled();
    expect(f.report).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

test("a failed deletion retains the session and resumes saving its local draft", async () => {
  const f = fixture(); await screen.findByRole("button", { name: "会话A" });
  vi.mocked(f.api.remove).mockRejectedValueOnce(new Error("删除失败"));
  vi.useFakeTimers();
  try {
    fireEvent.change(screen.getByLabelText("任务消息"), { target: { value: "仍需保存的草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "会话设置 会话A" }));
    fireEvent.click(screen.getByRole("button", { name: "删除会话" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "删除会话" })).getByRole("button", { name: "确认删除" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(f.report).toHaveBeenCalledWith(expect.objectContaining({ message: "删除失败" }));
    expect(f.api.patch).toHaveBeenCalledWith("P", "a", { draft: "仍需保存的草稿" });
    expect(screen.getByRole("button", { name: "会话A" })).toBeVisible();
    expect(screen.getByLabelText("任务消息")).toHaveValue("仍需保存的草稿");
  } finally { vi.useRealTimers(); }
});
test.each([null, "", "本地草稿"])("hydrates a restored session's draft after delayed history loading while preserving local edits (%j)", async localDraft => {
  localStorage.setItem("specloom:active-session:P", "a");
  if (localDraft !== null) localStorage.setItem("specloom:draft:P:a", localDraft);
  const stored = { ...session("a", "会话A"), draft: "磁盘上的草稿" };
  let finish!: (sessions: ChatSession[]) => void;
  fixture([stored], [], undefined, () => new Promise(resolve => { finish = resolve; }));
  expect(screen.getByLabelText("任务消息")).toBeDisabled();
  await act(async () => finish([stored]));
  expect(screen.getByLabelText("任务消息")).toHaveValue(localDraft ?? stored.draft);
});
test("isolates drafts across sessions and restores them after a send failure", async () => {
  const f = fixture(); await screen.findByRole("button", { name: "会话A" });
  fireEvent.change(screen.getByLabelText("任务消息"), { target: { value: "A草稿" } });
  fireEvent.click(screen.getByRole("button", { name: "会话B" }));
  expect(screen.getByLabelText("任务消息")).toHaveValue("");
  fireEvent.change(screen.getByLabelText("任务消息"), { target: { value: "B草稿" } });
  fireEvent.click(screen.getByRole("button", { name: "会话A" })); expect(screen.getByLabelText("任务消息")).toHaveValue("A草稿");
  vi.mocked(f.api.send).mockRejectedValueOnce(new Error("offline"));
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(f.report).toHaveBeenCalled());
  expect(screen.getByLabelText("任务消息")).toHaveValue("A草稿");
});

test("keeps an accepted message out of the composer when its model stream fails", async () => {
  const f = fixture(); await screen.findByRole("button", { name: "会话A" });
  const input = screen.getByLabelText("任务消息");
  let reject!: (error: Error) => void;
  vi.mocked(f.api.send).mockImplementationOnce(() => new Promise((_ok, fail) => { reject = fail; }));
  fireEvent.change(input, { target: { value: "已发送的消息" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(f.api.send).toHaveBeenCalled());
  const accepted: ChatSession = { ...f.records[0]!, draft: "", draftRevision: f.records[0]!.draftRevision + 1, revision: 10, runId: "new-run", status: "running", items: [{ id: "new-run:user", kind: "message", role: "user", content: "已发送的消息" }] };
  f.emit(accepted);
  expect(input).toHaveValue("");
  f.emit({ ...accepted, revision: 11, seq: 1, status: "error", error: "The model stream failed while receiving data." });
  await act(async () => reject(new Error("The model stream failed while receiving data.")));
  expect(f.report).toHaveBeenCalled();
  expect(input).toHaveValue("");
  expect(localStorage.getItem("specloom:draft:P:a")).toBe("");
});

test("shows a copyable diagnostic reference beside a failed session", async () => {
  const diagnosticId = "9c1c7c73-ec83-41bb-8e1f-6d4770039f56";
  fixture([{ ...session("a", "会话A"), status: "error", error: "The model stream failed while receiving data.", diagnosticId }]);
  await screen.findByRole("button", { name: "会话A" });
  expect(screen.getByText(diagnosticId)).toBeVisible();
  expect(screen.getByRole("button", { name: "复制诊断编号" })).toBeVisible();
});

test("checks durable acceptance when send fails before its session event arrives", async () => {
  const f = fixture(); await screen.findByRole("button", { name: "会话A" });
  vi.mocked(f.api.send).mockImplementationOnce(async () => {
    Object.assign(f.records[0]!, { draft: "", draftRevision: f.records[0]!.draftRevision + 1, revision: 10, runId: "new-run", status: "error", error: "The model stream failed while receiving data.", items: [{ id: "new-run:user", kind: "message", role: "user", content: "已受理但事件延迟" }] });
    throw new Error("The model stream failed while receiving data.");
  });
  fireEvent.change(screen.getByLabelText("任务消息"), { target: { value: "已受理但事件延迟" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(f.report).toHaveBeenCalled());
  expect(screen.getByLabelText("任务消息")).toHaveValue("");
  expect(screen.getByText("已受理但事件延迟")).toBeVisible();
});

test("does not restore an accepted failed run into its background session or overwrite a new draft", async () => {
  const f = fixture(); await screen.findByRole("button", { name: "会话A" });
  let reject!: (error: Error) => void;
  vi.mocked(f.api.send).mockImplementationOnce(() => new Promise((_ok, fail) => { reject = fail; }));
  fireEvent.change(screen.getByLabelText("任务消息"), { target: { value: "后台发送" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(f.api.send).toHaveBeenCalled());
  f.emit({ ...f.records[0]!, draft: "", revision: 10, runId: "new-run", status: "running", items: [{ id: "new-run:user", kind: "message", role: "user", content: "后台发送" }] });
  fireEvent.click(screen.getByRole("button", { name: "会话B" }));
  fireEvent.change(screen.getByLabelText("任务消息"), { target: { value: "另一个会话的新草稿" } });
  await act(async () => reject(new Error("The model stream failed while receiving data.")));
  expect(screen.getByLabelText("任务消息")).toHaveValue("另一个会话的新草稿");
  fireEvent.click(screen.getByRole("button", { name: "会话A" }));
  expect(screen.getByLabelText("任务消息")).toHaveValue("");
});

test("restores the exact unaccepted draft even when an older run contains the same message", async () => {
  const old: ChatSession = { ...session("a", "会话A"), status: "error", runId: "old-run", items: [{ id: "old-run:user", kind: "message", role: "user", content: "再次发送" }] };
  const f = fixture([old]); await screen.findByRole("button", { name: "会话A" });
  vi.mocked(f.api.send).mockRejectedValueOnce(new Error("send rejected"));
  fireEvent.change(screen.getByLabelText("任务消息"), { target: { value: "  再次发送\n" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(f.report).toHaveBeenCalled());
  expect(screen.getByLabelText("任务消息")).toHaveValue("  再次发送\n");
});

test("does not confuse an earlier cancelled run with rejection of the next message", async () => {
  const old: ChatSession = { ...session("a", "会话A"), status: "cancelled", runId: "old-run", items: [{ id: "old-run:user", kind: "message", role: "user", content: "上次消息" }] };
  const f = fixture([old]); await screen.findByRole("button", { name: "会话A" });
  vi.mocked(f.api.send).mockRejectedValueOnce(new Error("send rejected"));
  fireEvent.change(screen.getByLabelText("任务消息"), { target: { value: "本次未受理消息" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(f.api.send).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeVisible());
  expect(screen.getByLabelText("任务消息")).toHaveValue("本次未受理消息");
  expect(f.report).toHaveBeenCalled();
});

test("captures the submitted draft before a delayed initial model update and preserves newer input", async () => {
  const f = fixture(); await screen.findByRole("button", { name: "会话A" });
  const originalPatch = vi.mocked(f.api.patch).getMockImplementation()!;
  let finishModelUpdate!: (next: ChatSession) => void;
  vi.mocked(f.api.patch).mockImplementation((_root, id, patch) => {
    if (patch.model) return new Promise(resolve => { finishModelUpdate = resolve; });
    return originalPatch("P", id, patch);
  });
  const input = screen.getByLabelText("任务消息");
  fireEvent.change(input, { target: { value: "本次提交" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(finishModelUpdate).toBeDefined());
  expect(input).toHaveValue("");
  fireEvent.change(input, { target: { value: "下一条草稿" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(vi.mocked(f.api.patch).mock.calls.filter(([, , patch]) => patch.model)).toHaveLength(1);
  await act(async () => finishModelUpdate({ ...f.records[0]!, revision: 10, model: { providerId: "p", model: "m", reasoning: "inherit" } }));
  await waitFor(() => expect(f.api.send).toHaveBeenCalledWith("P", "a", "本次提交", expect.any(Number)));
  expect(input).toHaveValue("下一条草稿");
});

test.each([undefined, ""])("restores a failed initial model update only if the cleared draft was untouched (%j)", async newerDraft => {
  const f = fixture(); await screen.findByRole("button", { name: "会话A" });
  const originalPatch = vi.mocked(f.api.patch).getMockImplementation()!;
  let rejectModelUpdate!: (error: Error) => void;
  vi.mocked(f.api.patch).mockImplementation((_root, id, patch) => {
    if (patch.model) return new Promise((_ok, reject) => { rejectModelUpdate = reject; });
    return originalPatch("P", id, patch);
  });
  const input = screen.getByLabelText("任务消息");
  fireEvent.change(input, { target: { value: "  原始草稿\n" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(rejectModelUpdate).toBeDefined());
  expect(input).toHaveValue("");
  if (newerDraft !== undefined) {
    fireEvent.change(input, { target: { value: "编辑后主动清空" } });
    fireEvent.change(input, { target: { value: newerDraft } });
  }
  await act(async () => rejectModelUpdate(new Error("model preference failed")));
  expect(input).toHaveValue(newerDraft ?? "  原始草稿\n");
  expect(f.api.send).not.toHaveBeenCalled();
  expect(f.report).toHaveBeenCalled();
});

test("manages another session inside its sidebar row without switching the conversation or draft", async () => {
  const f = fixture(); await screen.findByRole("button", { name: /^会话A$/ });
  fireEvent.change(screen.getByLabelText("任务消息"), { target: { value: "A 的未发送草稿" } });
  const settings = screen.getByRole("button", { name: "会话设置 会话B" });
  expect(settings.closest(".session-sidebar")).toBeInTheDocument();
  fireEvent.click(settings);
  const panel = screen.getByRole("region", { name: "会话B 的设置" });
  expect(settings.closest(".session-row")).toContainElement(panel);
  expect(screen.getByRole("heading", { name: /^会话A$/ })).toBeVisible();
  fireEvent.change(within(panel).getByLabelText("会话名称"), { target: { value: "后台会话" } });
  fireEvent.click(within(panel).getByRole("button", { name: "保存名称" }));
  await waitFor(() => expect(f.api.patch).toHaveBeenCalledWith("P", "b", { title: "后台会话" }));
  expect(screen.getByRole("heading", { name: /^会话A$/ })).toBeVisible();
  expect(screen.getByLabelText("任务消息")).toHaveValue("A 的未发送草稿");
  expect(screen.queryByRole("button", { name: /^会话设置$/ })).not.toBeInTheDocument();
});

test("protects a background running session while allowing other session settings", async () => {
  const background = { ...session("b", "会话B"), status: "running" as const };
  fixture([session("a", "会话A"), background]);
  fireEvent.click(await screen.findByRole("button", { name: "会话设置 会话B" }));
  expect(screen.getByRole("button", { name: "归档会话" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "删除会话" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "会话设置 会话A" }));
  expect(screen.getByRole("button", { name: "归档会话" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "删除会话" })).toBeEnabled();
});
test("archives, exports and removes the selected background session without changing the active draft", async () => {
  const f = fixture(); await screen.findByRole("button", { name: /^会话A$/ });
  fireEvent.change(screen.getByLabelText("任务消息"), { target: { value: "A 的未发送草稿" } });

  fireEvent.click(screen.getByRole("button", { name: "会话设置 会话B" }));
  fireEvent.click(screen.getByRole("button", { name: "归档会话" }));
  await waitFor(() => expect(f.api.patch).toHaveBeenCalledWith("P", "b", { archived: true }));
  expect(screen.getByRole("heading", { name: /^会话A$/ })).toBeVisible();
  expect(screen.getByLabelText("任务消息")).toHaveValue("A 的未发送草稿");
  fireEvent.click(screen.getByRole("button", { name: "显示归档" }));
  expect(screen.getByRole("button", { name: "会话设置 会话B" })).toHaveAttribute("aria-expanded", "false");

  fireEvent.click(screen.getByRole("button", { name: "会话设置 会话B" }));
  const createObjectURL = vi.fn(() => "blob:session");
  const revokeObjectURL = vi.fn();
  const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
  fireEvent.click(screen.getByRole("button", { name: "导出会话" }));
  await waitFor(() => expect(f.api.export).toHaveBeenCalledWith("P", "b"));
  expect(createObjectURL).toHaveBeenCalled();
  expect(anchorClick).toHaveBeenCalled();

  vi.mocked(f.api.remove).mockImplementation(async (_projectPath, id) => {
    const index = f.records.findIndex((s) => s.id === id);
    if (index >= 0) f.records.splice(index, 1);
  });
  fireEvent.click(screen.getByRole("button", { name: "删除会话" }));
  await confirmSessionRemoval();
  await waitFor(() => expect(f.api.remove).toHaveBeenCalledWith("P", "b"));
  await waitFor(() => expect(screen.queryByRole("button", { name: /^会话B$/ })).not.toBeInTheDocument());
  expect(screen.getByRole("heading", { name: /^会话A$/ })).toBeVisible();
  expect(screen.getByLabelText("任务消息")).toHaveValue("A 的未发送草稿");
  expect(f.report).not.toHaveBeenCalled();
});
test("cancels session removal without deleting its conversation", async () => {
  const f = fixture([session("only", "唯一会话")]);
  await screen.findByRole("button", { name: "会话设置 唯一会话" });
  fireEvent.click(screen.getByRole("button", { name: "会话设置 唯一会话" }));
  fireEvent.click(screen.getByRole("button", { name: "删除会话" }));
  const dialog = await screen.findByRole("dialog", { name: "删除会话" });
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "删除会话" })).not.toBeInTheDocument());
  expect(f.api.remove).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "唯一会话" })).toBeInTheDocument();
});

test("restores focus to the active composer after deleting a background session", async () => {
  const f = fixture(); await screen.findByRole("button", { name: /^会话A$/ });
  const input = screen.getByLabelText("任务消息");
  fireEvent.change(input, { target: { value: "继续编辑" } });
  vi.mocked(f.api.remove).mockImplementation(async (_projectPath, id) => {
    const index = f.records.findIndex((s) => s.id === id);
    if (index >= 0) f.records.splice(index, 1);
  });
  fireEvent.click(screen.getByRole("button", { name: "会话设置 会话B" }));
  fireEvent.click(screen.getByRole("button", { name: "删除会话" }));
  await confirmSessionRemoval();
  await waitFor(() => expect(screen.queryByRole("button", { name: /^会话B$/ })).not.toBeInTheDocument());
  expect(screen.getByRole("heading", { name: /^会话A$/ })).toBeVisible();
  expect(input).toHaveValue("继续编辑");
  await waitFor(() => expect(input).toHaveFocus());
});
test("protects IME composition and newer draft while an older request fails", async () => {
  const f = fixture(); await screen.findByRole("button", { name: "会话A" });
  const input = screen.getByLabelText("任务消息"); fireEvent.change(input, { target: { value: "原始" } });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true }); fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  expect(f.api.send).not.toHaveBeenCalled();
  let reject!: (error: Error) => void;
  vi.mocked(f.api.send).mockImplementationOnce(() => new Promise((_ok, fail) => { reject = fail; }));
  fireEvent.keyDown(input, { key: "Enter" }); await waitFor(() => expect(f.api.send).toHaveBeenCalled());
  expect(input).toBeEnabled(); fireEvent.change(input, { target: { value: "新草稿" } });
  await act(async () => reject(new Error("offline")));
  expect(input).toHaveValue("原始\n\n新草稿");
});

test("stopping a run preserves its explicit status without reporting a global error", async () => {
  const f = fixture(); await screen.findByRole("button", { name: "会话A" });
  let reject!: (error: Error) => void;
  vi.mocked(f.api.send).mockImplementationOnce(() => new Promise((_ok, fail) => { reject = fail; }));
  fireEvent.change(screen.getByLabelText("任务消息"), { target: { value: "执行" } }); fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(f.api.send).toHaveBeenCalled());
  f.emit({ ...f.records[0]!, revision: 99, status: "cancelled", runId: "new-run", items: [{ id: "new-run:user", kind: "message", role: "user", content: "执行" }], error: "已停止，保留部分回复" });
  await act(async () => reject(new Error("The agent run was cancelled.")));
  expect(f.report).not.toHaveBeenCalled(); expect(screen.getByLabelText("任务消息")).toHaveValue("");
  expect(screen.getByText("已停止，保留部分回复")).toBeVisible();
});
test("routes background text and ignores older run snapshots", async () => {
  const f = fixture(); await screen.findByRole("button", { name: "会话A" });
  const a = { ...f.records[0]!, runId: "run-1", seq: 1, revision: 5, status: "running" as const, items: [{ id: "m1", kind: "message" as const, role: "assistant" as const, content: "首段" }] };
  f.emit(a); expect(screen.getByText("首段")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "会话B" })); expect(screen.queryByText("首段")).not.toBeInTheDocument();
  f.emit({ ...a, revision: 6, seq: 2, items: [{ ...a.items[0]!, content: "后台完成" }], status: "completed" });
  f.emit({ ...a, revision: 4, runId: "old", items: [{ ...a.items[0]!, content: "过期" }] });
  fireEvent.click(screen.getByRole("button", { name: "会话A" })); expect(screen.getByText("后台完成")).toBeVisible(); expect(screen.queryByText("过期")).not.toBeInTheDocument();
});
test("renders safe Markdown and lets users copy a code block", async () => {
  const copy = vi.fn(async () => undefined); Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
  const s = session("a", "会话A"); s.items = [{ id: "code", kind: "message", role: "assistant", content: '**粗体**\n\n```gdscript\nextends Node\n```\n<script>alert(1)</script>' }];
  fixture([s]); await screen.findByText("粗体"); expect(document.querySelector("strong")).toBeTruthy(); expect(document.querySelector("script")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "复制代码" })); await waitFor(() => expect(copy).toHaveBeenCalledWith("extends Node\n"));
});
test("validates and defers a question, keeps it actionable after submission failure", async () => {
  const s = session("a", "会话A"); s.status = "waiting"; s.runId = "r";
  s.items = [{ id: "q", kind: "question", status: "waiting", question: { id: "q", runId: "r", sessionId: "a", title: "选择方案", fields: [{ id: "text", label: "需求说明", type: "text", required: true }, { id: "single", label: "方向", type: "single", required: true, options: [{ id: "left", label: "左侧" }] }, { id: "multi", label: "能力", type: "multi", required: true, options: [{ id: "run", label: "移动" }] }] } }];
  const f = fixture([s]); await screen.findByText("选择方案");
  fireEvent.click(screen.getByRole("button", { name: "提交回答" })); expect(await screen.findByRole("alert")).toHaveTextContent("请填写"); expect(f.api.answer).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "稍后处理" })); fireEvent.click(screen.getByRole("button", { name: "继续回答" }));
  fireEvent.change(screen.getByLabelText("需求说明（必填）"), { target: { value: "人物移动" } });
  fireEvent.click(screen.getByLabelText("左侧")); fireEvent.click(screen.getByLabelText("移动"));
  vi.mocked(f.api.answer).mockRejectedValueOnce({ code: "VERSION_CONFLICT", message: "回答提交失败" }); fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("回答提交失败"); expect(screen.getByRole("button", { name: "提交回答" })).toBeEnabled();
});

test("keeps a draft editable while creating a session and does not override a later selection", async () => {
  const f = fixture(); await screen.findByRole("button", { name: "会话A" });
  let resolve!: (s: ChatSession) => void;
  vi.mocked(f.api.create).mockImplementationOnce(() => new Promise((ok) => { resolve = ok; }));
  fireEvent.click(screen.getAllByRole("button", { name: "新建会话" })[0]!);
  const input = screen.getByLabelText("任务消息");
  expect(input).toBeEnabled();
  fireEvent.change(input, { target: { value: "创建中的草稿" } });
  expect(input).toHaveValue("创建中的草稿");
  fireEvent.change(screen.getByLabelText("添加附件文件"), { target: { files: [new File(["创建附件正文"], "creating.txt")] } });
  await screen.findByRole("button", { name: "移除附件 creating.txt" });
  expect(f.attachments.prepare).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "会话B" }));
  await act(async () => resolve(session("c", "会话C")));
  expect(screen.getByRole("heading", { name: "会话B" })).toBeVisible();
  expect(screen.getByLabelText("任务消息")).toBeEnabled();
  expect(screen.queryByRole("button", { name: "移除附件 creating.txt" })).not.toBeInTheDocument();
  await waitFor(() => expect(f.attachments.prepare).toHaveBeenCalledWith("P", "c", expect.any(String), expect.any(Object)));
  fireEvent.click(screen.getByRole("button", { name: "会话C" }));
  expect(screen.getByLabelText("任务消息")).toHaveValue("创建中的草稿");
  await screen.findByText("创建附件正文");
});

test("keeps a newly created session selected when the initial list is stale", async () => {
  let releaseList!: (sessions: ChatSession[]) => void;
  const list = vi.fn(() => new Promise<ChatSession[]>(resolve => { releaseList = resolve; }));
  fixture([], [], undefined, list);
  await waitFor(() => expect(list).toHaveBeenCalled());
  fireEvent.click(screen.getAllByRole("button", { name: "新建会话" })[0]!);
  await screen.findByRole("heading", { name: "新会话" });
  const input = screen.getByLabelText("任务消息");
  expect(input).toBeEnabled();
  fireEvent.change(input, { target: { value: "创建期间草稿" } });
  await act(async () => releaseList([]));
  expect(screen.getByRole("heading", { name: "新会话" })).toBeVisible();
  expect(input).toBeEnabled();
  expect(input).toHaveValue("创建期间草稿");
});
test("focuses the new-session composer and accepts text while capabilities are loading", async () => {
  const f = fixture([]);
  await waitFor(() => expect(f.api.list).toHaveBeenCalled());
  fireEvent.click(screen.getAllByRole("button", { name: "新建会话" })[0]!);
  await screen.findByRole("heading", { name: "新会话" });
  const input = screen.getByLabelText("任务消息");
  expect(input).toBeEnabled();
  await waitFor(() => expect(input).toHaveFocus());
  fireEvent.change(input, { target: { value: "现在可以输入" } });
  expect(input).toHaveValue("现在可以输入");
  f.emit({ ...session("new", "新会话"), revision: 2, capabilities: { tools: [{ name: "Read", description: "读文件" }], skills: [], mcp: [], plugins: [] } });
  expect(input).toHaveValue("现在可以输入");
  expect(input).toHaveFocus();
});

test("creates an editable session after deleting the last session", async () => {
  const f = fixture([session("only", "唯一会话")]);
  await screen.findByRole("button", { name: "唯一会话" });
  vi.mocked(f.api.remove).mockImplementation(async (_projectPath, id) => {
    const index = f.records.findIndex((item) => item.id === id);
    if (index >= 0) f.records.splice(index, 1);
  });
  vi.mocked(f.api.create).mockImplementation(async () => {
    const created = session("new-after-delete", "新会话");
    f.records.push(created);
    return structuredClone(created);
  });
  fireEvent.click(screen.getByRole("button", { name: "会话设置 唯一会话" }));
  fireEvent.click(screen.getByRole("button", { name: "删除会话" }));
  await confirmSessionRemoval();
  await waitFor(() => expect(f.api.remove).toHaveBeenCalledWith("P", "only"));
  await waitFor(() => expect(screen.queryByRole("button", { name: "唯一会话" })).not.toBeInTheDocument());
  fireEvent.click(screen.getAllByRole("button", { name: "新建会话" })[0]!);
  await screen.findByRole("heading", { name: "新会话" });
  const input = screen.getByLabelText("任务消息");
  expect(input).toBeEnabled();
  await waitFor(() => expect(input).toHaveFocus());
  fireEvent.change(input, { target: { value: "删除后仍可输入" } });
  expect(input).toHaveValue("删除后仍可输入");
});

test("keeps a newly created session editable when deletion finishes after creation", async () => {
  const f = fixture([session("only", "唯一会话")]);
  await screen.findByRole("button", { name: "唯一会话" });
  let finishRemove!: () => void;
  vi.mocked(f.api.remove).mockImplementation(async (_projectPath, id) => {
    await new Promise<void>((resolve) => { finishRemove = () => { const index = f.records.findIndex((item) => item.id === id); if (index >= 0) f.records.splice(index, 1); resolve(); }; });
  });
  vi.mocked(f.api.create).mockImplementation(async () => {
    const created = session("new-after-delete", "新会话");
    f.records.push(created);
    return structuredClone(created);
  });

  fireEvent.click(screen.getByRole("button", { name: "会话设置 唯一会话" }));
  fireEvent.click(screen.getByRole("button", { name: "删除会话" }));
  await confirmSessionRemoval();
  await waitFor(() => expect(f.api.remove).toHaveBeenCalledWith("P", "only"));
  fireEvent.click(screen.getAllByRole("button", { name: "新建会话" })[0]!);
  await screen.findByRole("heading", { name: "新会话" });
  const input = screen.getByLabelText("任务消息");
  fireEvent.change(input, { target: { value: "创建期间仍可编辑" } });
  expect(input).toHaveValue("创建期间仍可编辑");
  await act(async () => finishRemove());
  await waitFor(() => expect(screen.getByRole("heading", { name: "新会话" })).toBeVisible());
  expect(input).toBeEnabled();
  await waitFor(() => expect(input).toHaveFocus());
  expect(input).toHaveValue("创建期间仍可编辑");
});

test("restores composer focus when the window regains focus after a deletion", async () => {
  const f = fixture([session("only", "唯一会话")]);
  await screen.findByRole("button", { name: "唯一会话" });
  vi.mocked(f.api.remove).mockImplementation(async (_projectPath, id) => {
    const index = f.records.findIndex((item) => item.id === id);
    if (index >= 0) f.records.splice(index, 1);
  });
  vi.mocked(f.api.create).mockImplementation(async () => {
    const created = session("new-after-window-focus", "新会话");
    f.records.push(created);
    return structuredClone(created);
  });

  fireEvent.click(screen.getByRole("button", { name: "会话设置 唯一会话" }));
  fireEvent.click(screen.getByRole("button", { name: "删除会话" }));
  await confirmSessionRemoval();
  await waitFor(() => expect(screen.queryByRole("button", { name: "唯一会话" })).not.toBeInTheDocument());
  fireEvent.click(screen.getAllByRole("button", { name: "新建会话" })[0]!);
  await screen.findByRole("heading", { name: "新会话" });

  const input = screen.getByLabelText("任务消息");
  await waitFor(() => expect(input).toHaveFocus());
  input.blur();
  act(() => { window.dispatchEvent(new Event("focus")); });
  expect(input).toHaveFocus();
});

test("appends delayed attachments to the original session without replacing newer text", async () => {
  fixture(); await screen.findByRole("button", { name: "会话A" });
  fireEvent.change(screen.getByLabelText("任务消息"), { target: { value: "原文" } });
  let resolve!: (bytes: ArrayBuffer) => void;
  const file = { name: "notes.md", size: 10, arrayBuffer: () => new Promise<ArrayBuffer>((ok) => { resolve = ok; }) };
  fireEvent.change(screen.getByLabelText("添加附件文件"), { target: { files: [file] } });
  fireEvent.change(screen.getByLabelText("任务消息"), { target: { value: "最新草稿" } });
  fireEvent.click(screen.getByRole("button", { name: "会话B" }));
  fireEvent.change(screen.getByLabelText("任务消息"), { target: { value: "B内容" } });
  await act(async () => resolve(new TextEncoder().encode("附加内容").buffer));
  expect(screen.getByLabelText("任务消息")).toHaveValue("B内容");
  fireEvent.click(screen.getByRole("button", { name: "会话A" }));
  expect((screen.getByLabelText("任务消息") as HTMLTextAreaElement).value).toContain("最新草稿");
  expect(screen.getByText("附加内容")).toBeInTheDocument();
});

test("expands attachment actions from the plus menu and supports multiple file types", async () => {
  const f = fixture(undefined, [], undefined, undefined, async () => [{ path: "specs/outline.md" }]);
  await screen.findByRole("button", { name: "会话A" });

  fireEvent.click(screen.getByRole("button", { name: "添加附件或资料" }));
  expect(screen.getByRole("menuitem", { name: "添加文件" })).toBeVisible();
  fireEvent.click(screen.getByRole("menuitem", { name: "引用资料" }));
  expect(await screen.findByRole("combobox", { name: "选择引用资料" })).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "添加附件或资料" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "添加文件" }));
  const input = screen.getByLabelText("添加附件文件") as HTMLInputElement;
  expect(input).toHaveAttribute("accept", "*/*");
  expect(input.multiple).toBe(true);
  const files = [
    new File(["正文"], "notes.md", { type: "text/markdown" }),
    new File(["PDF的实际提取正文"], "reference.pdf", { type: "application/pdf" }),
  ] as unknown as File[];
  fireEvent.change(input, { target: { files } });
  await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(f.api.send).toHaveBeenCalledWith("P", "a", expect.stringContaining("PDF的实际提取正文"), expect.any(Number)));
});

test("passes image attachments to the model as vision payloads", async () => {
  const f = fixture();
  await screen.findByRole("button", { name: "会话A" });
  const image = { name: "screen.png", type: "image/png", size: 3, arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer } as unknown as File;
  fireEvent.change(screen.getByLabelText("添加附件文件"), { target: { files: [image] } });
  await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(f.api.send).toHaveBeenCalledWith("P", "a", expect.any(String), expect.any(Number), [{ name: "screen.png", mimeType: "image/png", base64: "AQID" }]));
});

test("retains the image and draft when the selected model has no vision capability", async () => {
  const f = fixture(undefined, [], undefined, undefined, undefined, undefined, false);
  await screen.findByRole("button", { name: "会话A" });
  fireEvent.change(screen.getByLabelText("任务消息"), { target: { value: "查看图片" } });
  fireEvent.change(screen.getByLabelText("添加附件文件"), { target: { files: [new File(["image"], "screen.png", { type: "image/png" })] } });
  await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(f.report).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/图片/) })));
  expect(f.api.send).not.toHaveBeenCalled();
  expect(screen.getByLabelText("任务消息")).toHaveValue("查看图片");
  expect(screen.getByRole("button", { name: "移除附件 screen.png" })).toBeVisible();
});

test("holds sending while native paste is pending and keeps its original session", async () => {
  const f = fixture(); await screen.findByRole("button", { name: "会话A" });
  let finish!: (value: { files: []; text: string; notices: [] }) => void;
  vi.mocked(f.attachments.readClipboard).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const input = screen.getByLabelText("任务消息");
  fireEvent.change(input, { target: { value: "A原文" } });
  fireEvent.paste(input, { clipboardData: { files: [], getData: () => "" } });
  expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(f.api.send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "会话B" }));
  fireEvent.change(input, { target: { value: "B草稿" } });
  await act(async () => finish({ files: [], text: "粘贴文字", notices: [] }));
  expect(input).toHaveValue("B草稿");
  fireEvent.click(screen.getByRole("button", { name: "会话A" }));
  expect(input).toHaveValue("A原文粘贴文字");
});

test("uses clipboard items when browsers omit the files collection", async () => {
  const f = fixture(); await screen.findByRole("button", { name: "会话A" });
  const file = new File(["图片字节"], "clipboard.png", { type: "image/png" });
  fireEvent.paste(screen.getByLabelText("任务消息"), { clipboardData: { files: [], items: [{ kind: "file", getAsFile: () => file }], getData: () => "" } });
  await screen.findByRole("button", { name: "移除附件 clipboard.png" });
  await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
  expect(f.attachments.readClipboard).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(f.api.send).toHaveBeenCalledWith("P", "a", expect.any(String), expect.any(Number), [expect.objectContaining({ name: "clipboard.png" })]));
});

test("keeps file picker selection attached to the session that opened it", async () => {
  fixture(); await screen.findByRole("button", { name: "会话A" });
  fireEvent.click(screen.getByRole("button", { name: "添加附件或资料" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "添加文件" }));
  fireEvent.click(screen.getByRole("button", { name: "会话B" }));
  fireEvent.change(screen.getByLabelText("添加附件文件"), { target: { files: [new File(["A的正文"], "original.md")] } });
  await act(async () => {});
  expect(screen.queryByRole("button", { name: "移除附件 original.md" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "会话A" }));
  await screen.findByText("A的正文");
});

test("reports invalid native copied files without pasting their path representation", async () => {
  const f = fixture(); await screen.findByRole("button", { name: "会话A" });
  vi.mocked(f.attachments.readClipboard).mockRejectedValueOnce({ code: "VALIDATION_FAILED", message: "剪贴板文件超过6MiB" });
  const input = screen.getByLabelText("任务消息") as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "替换这里" } });
  input.setSelectionRange(2, 4);
  fireEvent.paste(input, { clipboardData: { files: [], getData: () => "C:/large.pdf" } });
  await waitFor(() => expect(f.report).toHaveBeenCalledWith(expect.objectContaining({ message: "剪贴板文件超过6MiB" })));
  expect(input).toHaveValue("替换这里");
});

test("serializes delayed text pastes while preserving later user edits", async () => {
  const f = fixture(); await screen.findByRole("button", { name: "会话A" });
  const resolvers: ((value: { files: []; notices: [] }) => void)[] = [];
  vi.mocked(f.attachments.readClipboard).mockImplementation(() => new Promise(resolve => resolvers.push(resolve)));
  const input = screen.getByLabelText("任务消息") as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "首尾" } }); input.setSelectionRange(1, 1);
  fireEvent.paste(input, { clipboardData: { files: [], getData: () => "一" } });
  fireEvent.paste(input, { clipboardData: { files: [], getData: () => "二" } });
  await act(async () => { resolvers[1]!({ files: [], notices: [] }); resolvers[0]!({ files: [], notices: [] }); });
  await waitFor(() => expect(input).toHaveValue("首一二尾"));
  input.setSelectionRange(1, 2);
  fireEvent.paste(input, { clipboardData: { files: [], getData: () => "追加" } });
  fireEvent.change(input, { target: { value: "用户的新文字" } });
  await act(async () => resolvers[2]!({ files: [], notices: [] }));
  expect(input).toHaveValue("用户的新文字追加");
  expect(screen.getByText("粘贴期间草稿已编辑，粘贴文字已追加到末尾。")).toBeVisible();
});

test("creation failure retries its original attachments without touching an old session", async () => {
  const f = fixture(); await screen.findByRole("button", { name: "会话A" });
  let fail!: (error: Error) => void;
  vi.mocked(f.api.create).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
  fireEvent.change(screen.getByLabelText("任务消息"), { target: { value: "新会话草稿" } });
  fireEvent.change(screen.getByLabelText("添加附件文件"), { target: { files: [new File(["新会话附件正文"], "new.txt")] } });
  await screen.findByRole("button", { name: "移除附件 new.txt" });
  expect(f.attachments.prepare).not.toHaveBeenCalled();
  await act(async () => fail(new Error("创建失败")));
  expect(screen.getByLabelText("任务消息")).toHaveValue("新会话草稿");
  vi.mocked(f.api.create).mockImplementationOnce(async () => { const created = session("retried", "重试会话"); f.records.push(created); return structuredClone(created); });
  fireEvent.click(screen.getByRole("button", { name: "重试创建" }));
  await screen.findByText("新会话附件正文");
  expect(f.attachments.prepare).toHaveBeenCalledWith("P", "retried", expect.any(String), expect.any(Object));
  expect(screen.getByLabelText("任务消息")).toHaveValue("新会话草稿");
  fireEvent.click(screen.getByRole("button", { name: "会话A" }));
  expect(screen.queryByRole("button", { name: "移除附件 new.txt" })).not.toBeInTheDocument();
  expect(screen.getByLabelText("任务消息")).toHaveValue("");
});

test("restores one document and original draft before later typing when sending fails before acceptance", async () => {
  const f = fixture(); await screen.findByRole("button", { name: "会话A" });
  let rejectSend!: (error: Error) => void;
  vi.mocked(f.api.send).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSend = reject; }));
  fireEvent.change(screen.getByLabelText("任务消息"), { target: { value: "请阅读" } });
  fireEvent.change(screen.getByLabelText("添加附件文件"), { target: { files: [new File(["文档恢复正文"], "restore.txt")] } });
  await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(f.api.send).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText("任务消息"), { target: { value: "稍后输入" } });
  await act(async () => rejectSend(new Error("发送失败")));
  await waitFor(() => expect(f.report).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByRole("button", { name: "移除附件 restore.txt" })).toBeVisible());
  expect(screen.getByLabelText("任务消息")).toHaveValue("请阅读\n\n稍后输入");
  expect(screen.getAllByText("文档恢复正文")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(f.api.send).toHaveBeenCalledTimes(2));
  expect(vi.mocked(f.api.send).mock.calls[1]![2].split("文档恢复正文")).toHaveLength(2);
});

test("cancels pending attachments when another window deletes their session", async () => {
  const f = fixture(); await screen.findByRole("button", { name: "会话A" });
  let finish!: (value: Awaited<ReturnType<typeof f.attachments.prepare>>) => void;
  vi.mocked(f.attachments.prepare).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.change(screen.getByLabelText("添加附件文件"), { target: { files: [new File(["迟到正文"], "deleted.txt")] } });
  await waitFor(() => expect(f.attachments.prepare).toHaveBeenCalled());
  f.records.splice(0, 1); f.invalidate();
  await waitFor(() => expect(screen.queryByRole("button", { name: "会话A" })).not.toBeInTheDocument());
  await waitFor(() => expect(f.attachments.cancel).toHaveBeenCalledWith("P", "a", expect.any(String)));
  await act(async () => finish({ kind: "document", name: "deleted.txt", size: 12, text: "迟到正文", notices: [], truncated: false }));
  expect(screen.queryByRole("button", { name: "移除附件 deleted.txt" })).not.toBeInTheDocument();
  expect(screen.queryByText("迟到正文")).not.toBeInTheDocument();
  expect(screen.getByLabelText("任务消息")).toHaveValue("");
});

test("keeps successful attachments and draft when one file fails preparation", async () => {
  const f = fixture(); await screen.findByRole("button", { name: "会话A" });
  const prepare = vi.mocked(f.attachments.prepare).getMockImplementation()!;
  vi.mocked(f.attachments.prepare).mockImplementation((...args) => args[3].name === "broken.pdf" ? Promise.reject(new Error("PDF 已损坏")) : prepare(...args));
  fireEvent.change(screen.getByLabelText("任务消息"), { target: { value: "保留草稿" } });
  fireEvent.change(screen.getByLabelText("添加附件文件"), { target: { files: [new File(["完整正文"], "valid.txt"), new File(["invalid"], "broken.pdf")] } });
  await screen.findByText("PDF 已损坏");
  fireEvent.click(screen.getByText("查看提取正文"));
  expect(screen.getByText("完整正文")).toBeVisible();
  expect(screen.getByLabelText("任务消息")).toHaveValue("保留草稿");
  expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "移除附件 broken.pdf" }));
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(f.api.send).toHaveBeenCalledWith("P", "a", expect.stringContaining("完整正文"), expect.any(Number)));
  expect(vi.mocked(f.api.send).mock.calls[0]![2]).toContain("保留草稿");
});

test.each(["completed", "error"] as const)("keeps newly attached images after the accepted run is %s", async status => {
  const f = fixture(); await screen.findByRole("button", { name: "会话A" });
  const image = (name: string) => ({ name, type: "image/png", size: 3, arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer } as unknown as File);
  let finish!: (next: ChatSession) => void;
  let reject!: (error: Error) => void;
  vi.mocked(f.api.send).mockImplementationOnce(() => new Promise((resolve, fail) => { finish = resolve; reject = fail; }));
  fireEvent.change(screen.getByLabelText("添加附件文件"), { target: { files: [image("sent.png")] } });
  await screen.findByRole("button", { name: "移除附件 sent.png" });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(f.api.send).toHaveBeenCalled());
  const accepted: ChatSession = { ...f.records[0]!, draft: "", revision: 10, runId: "new-run", status: "running", items: [{ id: "new-run:user", kind: "message", role: "user", content: vi.mocked(f.api.send).mock.calls[0]![2] }] };
  f.emit(accepted);
  fireEvent.change(screen.getByLabelText("添加附件文件"), { target: { files: [image("next.png")] } });
  await screen.findByRole("button", { name: "移除附件 next.png" });
  expect(vi.mocked(f.api.send).mock.calls[0]![4]).toHaveLength(1);
  const ended = { ...accepted, revision: 11, seq: 1, status };
  f.emit(ended);
  await act(async () => { if (status === "completed") finish(ended); else reject(new Error("model stream failed")); });
  expect(screen.getByRole("button", { name: "移除附件 next.png" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "移除附件 sent.png" })).not.toBeInTheDocument();
  expect(screen.getByRole("img", { name: "next.png" })).toBeVisible();
});

test("starts a session with its actual capability inventory and removes ordinary-chat restrictions", async () => {
  const s = session("a", "会话A");
  s.capabilities = { tools: [{ name: "files.read", description: "读取项目文件" }], skills: [{ id: "godot-review", name: "Godot 审查", purpose: "检查场景依赖" }], mcp: [{ name: "远程资料", status: "error", tools: [], error: "服务器离线" }], plugins: [{ name: "桌面工具", description: "项目工具集" }] };
  fixture([s]);
  const inventory = await screen.findByLabelText("会话能力清单");
  expect(inventory).toHaveTextContent("工具 · 1");
  expect(inventory).toHaveTextContent("Skills · 1");
  fireEvent.click(screen.getByText("工具 · 1"));
  expect(screen.getByText("files.read")).toBeVisible();
  fireEvent.click(screen.getByText("Skills · 1"));
  expect(screen.getByText("Godot 审查")).toBeVisible();
  fireEvent.click(screen.getByText("MCP · 1"));
  expect(screen.getByText("连接失败")).toBeVisible();
  expect(screen.getByText("服务器离线")).toBeVisible();
  expect(screen.queryByText(/普通对话|无项目读写权限/)).not.toBeInTheDocument();
});

test("renders context usage as a circular indicator with exact token values on hover", async () => {
  const s = session("a", "会话A");
  s.items = [{ id: "message", kind: "message", role: "user", content: "x".repeat(400) }];
  fixture([s]);
  await screen.findByRole("button", { name: "会话A" });

  const indicator = screen.getByRole("img", { name: /上下文占用/ });
  expect(indicator).toHaveClass("context-usage-ring");
  expect(indicator).toHaveAttribute("title", expect.stringContaining("/ 131072 tokens"));
  expect(indicator).toHaveAttribute("title", expect.stringContaining("估算"));
});

test("shows live thinking animation without inventing reasoning and clears it when finished", async () => {
  const s = session("a", "会话A"); s.status = "running"; s.activity = "模型正在思考";
  const f = fixture([s]);
  expect(await screen.findByRole("status", { name: "智能体运行状态" })).toHaveTextContent("模型正在思考");
  expect(document.querySelector(".thinking-dots")).toBeInTheDocument();
  expect(screen.queryByLabelText("模型返回的思考")).not.toBeInTheDocument();
  f.emit({ ...s, revision: 2, status: "completed" });
  expect(screen.queryByRole("status", { name: "智能体运行状态" })).not.toBeInTheDocument();
});

test.each(["applied", "rejected"])("continues coding in a %s task session while its closed review remains locked", async (status) => {
  const task = { ...structuredClone(legacyTask), status };
  const s = session("a", "历史审查会话"); s.taskId = task.id;
  const review: ChangeReview = { changeSet: { id: "change", taskId: task.id, status: status as "applied" | "rejected", digest: "reviewed-digest", dependencies: {}, entries: [{ path: "scripts/next.gd", operation: "create", expectedVersion: "absent", nextContent: "extends Node", sourceTaskId: task.id, sourceTool: "files.write" }] }, before: {}, approved: status === "applied" };
  const f = fixture([s], [task], review);
  await screen.findByRole("button", { name: "历史审查会话" });
  const input = screen.getByLabelText("任务消息");
  expect(input).toBeEnabled();
  expect(screen.getByRole("button", { name: "批准并提交" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "拒绝变更" })).toBeDisabled();
  fireEvent.change(input, { target: { value: "继续读取项目并实现下一项功能" } });
  expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(f.api.send).toHaveBeenCalledWith("P", s.id, "继续读取项目并实现下一项功能", expect.any(Number)));
  expect(f.report).not.toHaveBeenCalled();
});
