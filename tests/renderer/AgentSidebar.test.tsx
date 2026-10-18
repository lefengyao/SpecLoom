// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { ChatItem, ChatSession } from "../../src/shared/chat";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const tool = (id: string, output = `output:${id}`): ChatItem => ({ id, kind: "tool", callId: `call:${id}`, name: `Read.${id}`, arguments: '{"path":"project.md"}', output, status: "ok" });
const session: ChatSession = {
  id: "s", title: "项目检查", createdAt: "1", updatedAt: "1", archived: false, draft: "", draftRevision: 0, revision: 1, seq: 0, status: "running", runId: "run",
  items: [{ id: "u1", kind: "message", role: "user", content: "检查" }, tool("t1"), { id: "u2", kind: "message", role: "user", content: "再检查" }, tool("t2")],
};

test("shows the chosen tool payload and keeps that selection during streamed updates", async () => {
  const { AgentSidebar } = await import("../../src/renderer/chat/AgentSidebar");
  const selection = { turnId: "u1", itemId: "t1" };
  const view = render(<AgentSidebar session={session} selection={selection} onClose={vi.fn()} />);
  const sidebar = screen.getByRole("complementary", { name: "智能体侧栏" });
  expect(within(sidebar).getByText("output:t1")).toBeVisible();
  expect(within(sidebar).queryByText("output:t2")).not.toBeInTheDocument();
  view.rerender(<AgentSidebar session={{ ...session, items: [session.items[0]!, tool("t1", "streamed output"), ...session.items.slice(2)] }} selection={selection} onClose={vi.fn()} />);
  expect(within(sidebar).getByText("streamed output")).toBeVisible();
  fireEvent.change(within(sidebar).getByRole("combobox", { name: "查看轮次" }), { target: { value: "u2" } });
  expect(within(sidebar).getByText("output:t2")).toBeVisible();
});

test("provides keyboard tabs and accepts future sidebar sections", async () => {
  const { AgentSidebar } = await import("../../src/renderer/chat/AgentSidebar");
  render(<AgentSidebar session={session} onClose={vi.fn()} sections={[{ id: "files", label: "文件", content: <p>项目文件索引</p> }]} />);
  fireEvent.click(screen.getByRole("tab", { name: "会话概览" }));
  expect(screen.getByRole("tabpanel")).toHaveTextContent("运行中");
  fireEvent.keyDown(screen.getByRole("tab", { name: "会话概览" }), { key: "ArrowRight" });
  expect(screen.getByRole("tab", { name: "文件" })).toHaveFocus();
  expect(screen.getByRole("tabpanel")).toHaveTextContent("项目文件索引");
});

test("closes on Escape and restores focus to the control that opened it", async () => {
  const { AgentSidebar } = await import("../../src/renderer/chat/AgentSidebar");
  const onClose = vi.fn();
  const opener = document.createElement("button");
  document.body.append(opener); opener.focus();
  const view = render(<AgentSidebar session={session} onClose={onClose} />);
  expect(screen.getByRole("button", { name: "关闭智能体侧栏" })).toHaveFocus();
  fireEvent.keyDown(screen.getByRole("complementary", { name: "智能体侧栏" }), { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(opener).toHaveFocus();
  opener.remove();
});

test("shows a useful empty tool state and a reminder for pending user action", async () => {
  const { AgentSidebar } = await import("../../src/renderer/chat/AgentSidebar");
  render(<AgentSidebar session={{ ...session, items: [{ id: "q", kind: "question", status: "waiting", question: { id: "q", runId: "run", sessionId: "s", title: "范围", fields: [{ id: "scope", label: "范围", type: "text", required: false }] } }] }} onClose={vi.fn()} />);
  expect(screen.getByText("本轮还没有工具调用")).toBeVisible();
  expect(screen.getByText(/有 1 项等待你处理/)).toBeVisible();
});

test("opens the newest turn with tools when guidance arrives during the active run", async () => {
  const { AgentSidebar } = await import("../../src/renderer/chat/AgentSidebar");
  const guided: ChatSession = { ...session, items: [...session.items, { id: "guidance", kind: "message", role: "user", content: "再检查引用" }] };
  const view = render(<AgentSidebar session={guided} onClose={vi.fn()} />);
  expect(screen.getByText("output:t2")).toBeVisible();
  expect(screen.getByRole("combobox", { name: "查看轮次" })).toHaveValue("u2");
  view.rerender(<AgentSidebar session={guided} selection={{ turnId: "guidance" }} onClose={vi.fn()} />);
  expect(screen.getByRole("combobox", { name: "查看轮次" })).toHaveValue("guidance");
  expect(screen.getByText("本轮还没有工具调用")).toBeVisible();
});

test("keeps keyboard focus inside the sidebar drawer on narrow windows", async () => {
  const { AgentSidebar } = await import("../../src/renderer/chat/AgentSidebar");
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
  render(<AgentSidebar session={session} onClose={vi.fn()} />);
  const first = screen.getByRole("button", { name: "关闭智能体侧栏" });
  const last = screen.getByRole("button", { name: "复制结果（已脱敏）" });
  fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
  expect(last).toHaveFocus();
  fireEvent.keyDown(last, { key: "Tab" });
  expect(first).toHaveFocus();
});
