// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ChatWorkbench } from "../../src/renderer/chat/ChatWorkbench";
import type { ChatSession, ChatSessionsApi } from "../../src/shared/chat";

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
const session = (id: string): ChatSession => ({ id, title: `会话${id}`, createdAt: "1", updatedAt: "1", archived: false, draft: "", draftRevision: 0, revision: 1, seq: 0, status: "idle", items: [] });
function fixture(initial = [session("A"), session("B")]) {
  const records = initial;
  const api: ChatSessionsApi = {
    list: vi.fn(async () => structuredClone(records)), create: vi.fn(async () => session("new")),
    patch: vi.fn(async (_root, id, patch) => { const record = records.find(value => value.id === id)!; Object.assign(record, patch); record.revision++; return structuredClone(record); }),
    remove: vi.fn(async () => undefined), export: vi.fn(async () => "{}"), import: vi.fn(async () => session("imported")),
    send: vi.fn(async (_root, id) => ({ ...records.find(record => record.id === id)!, status: "completed" as const })),
    guide: vi.fn(async (_root, id) => records.find(record => record.id === id)!), cancel: vi.fn(async () => undefined),
    answer: vi.fn(async (_root, id) => records.find(record => record.id === id)!), approve: vi.fn(async (_root, id) => records.find(record => record.id === id)!),
    subscribe: () => () => undefined,
  };
  const onError = vi.fn();
  render(<ChatWorkbench api={api} projectPath="P" tasks={[]} providers={[{ id: "p", name: "测试", protocol: "openai", baseUrl: "http://test", models: ["m"], modelSettings: {}, hasKey: false, keyStorage: "none" }]} defaultModel={{ providerId: "p", model: "m" }} review={undefined} busy={false} onSelectTask={vi.fn()} onNewTask={vi.fn()} onReview={vi.fn(async () => undefined)} onError={onError} onFinished={vi.fn()} />);
  return { records, api, onError };
}

test("defaults web search to off and offers the five service modes", async () => {
  fixture(); await screen.findByRole("button", { name: "会话A" });
  const control = screen.getByRole("combobox", { name: "联网搜索" });
  expect(control).toHaveValue("off");
  expect(within(control).getAllByRole("option").map(option => (option as HTMLOptionElement).value)).toEqual(["off", "auto", "native", "free", "self-hosted"]);
});

test("saves the search mode per session and restores it when switching chats", async () => {
  const f = fixture(); await screen.findByRole("button", { name: "会话A" });
  const control = screen.getByRole("combobox", { name: "联网搜索" });
  fireEvent.change(control, { target: { value: "free" } });
  await waitFor(() => expect(f.api.patch).toHaveBeenCalledWith("P", "A", { webSearchMode: "free" }));
  await waitFor(() => expect(control).toHaveValue("free"));
  fireEvent.click(screen.getByRole("button", { name: "会话B" })); expect(control).toHaveValue("off");
  fireEvent.click(screen.getByRole("button", { name: "会话A" })); expect(control).toHaveValue("free");
});

test.each(["running", "waiting", "archived"] as const)("locks web search for a %s session", async state => {
  fixture([{ ...session("A"), ...(state === "archived" ? { archived: true } : { status: state }) }]);
  if (state === "archived") {
    fireEvent.click(screen.getByRole("button", { name: "显示归档" }));
    fireEvent.click(await screen.findByRole("button", { name: "会话A" }));
  }
  await screen.findByRole("heading", { name: "会话A" });
  expect(screen.getByRole("combobox", { name: "联网搜索" })).toBeDisabled();
});

test("waits for a search mode update before allowing a new run", async () => {
  const f = fixture(); await screen.findByRole("button", { name: "会话A" });
  let finish!: (value: ChatSession) => void;
  vi.mocked(f.api.patch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.change(screen.getByLabelText("任务消息"), { target: { value: "搜索最新资料" } });
  fireEvent.change(screen.getByRole("combobox", { name: "联网搜索" }), { target: { value: "auto" } });
  expect(screen.getByRole("combobox", { name: "联网搜索" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  fireEvent.keyDown(screen.getByLabelText("任务消息"), { key: "Enter" }); expect(f.api.send).not.toHaveBeenCalled();
  await act(async () => finish({ ...f.records[0]!, webSearchMode: "auto", revision: 10 }));
  expect(screen.getByRole("combobox", { name: "联网搜索" })).toHaveValue("auto");
  expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
});

test("keeps the saved mode and draft if a search mode update fails", async () => {
  const f = fixture(); await screen.findByRole("button", { name: "会话A" });
  vi.mocked(f.api.patch).mockRejectedValueOnce(new Error("联网设置保存失败"));
  fireEvent.change(screen.getByLabelText("任务消息"), { target: { value: "未发送草稿" } });
  fireEvent.change(screen.getByRole("combobox", { name: "联网搜索" }), { target: { value: "native" } });
  await waitFor(() => expect(f.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "联网设置保存失败" })));
  expect(screen.getByRole("combobox", { name: "联网搜索" })).toHaveValue("off");
  expect(screen.getByRole("combobox", { name: "联网搜索" })).toBeEnabled();
  expect(screen.getByLabelText("任务消息")).toHaveValue("未发送草稿");
});
