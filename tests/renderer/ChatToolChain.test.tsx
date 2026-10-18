// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ChatTimeline } from "../../src/renderer/chat/ChatTimeline";
import type { ChatItem } from "../../src/shared/chat";

afterEach(cleanup);
const tool = (id: string, status: Extract<ChatItem, { kind: "tool" }>["status"] = "ok"): ChatItem => ({
  id, kind: "tool", callId: id, name: `files.read.${id}`, arguments: "PRIVATE_ARGUMENTS", output: "LARGE_OUTPUT", status,
});
const user: ChatItem = { id: "turn-1", kind: "message", role: "user", content: "检查项目" };
const preferences = { hideAgentDetails: false, showOutputRate: true, showFirstTokenLatency: true, showThinkingDuration: true };

test("keeps many tool calls in one compact chain without mounting arguments or output", () => {
  const items: ChatItem[] = [user, ...Array.from({ length: 80 }, (_, i) => tool(String(i))),
    { id: "reply-1", kind: "message", role: "assistant", content: "正在核对" },
    { id: "reply-2", kind: "message", role: "assistant", content: "检查完成" }];
  render(<ChatTimeline sessionId="s" items={items} preferences={preferences} onAnswer={vi.fn()} onOpenTools={vi.fn()} />);
  expect(screen.getAllByRole("region", { name: "第 1 轮工具链" })).toHaveLength(1);
  expect(screen.queryByText("PRIVATE_ARGUMENTS")).not.toBeInTheDocument();
  expect(screen.queryByText("LARGE_OUTPUT")).not.toBeInTheDocument();
  expect(screen.getByText("检查完成")).toBeVisible();
});

test("opens the selected turn and tool in the sidebar and reflects streamed status updates", () => {
  const onOpenTools = vi.fn();
  const view = render(<ChatTimeline sessionId="s" runId="run" running items={[user, tool("run:read", "receiving")]} onAnswer={vi.fn()} onOpenTools={onOpenTools} />);
  const box = screen.getByRole("region", { name: "第 1 轮工具链" });
  expect(within(box).getByText("接收参数")).toBeVisible();
  fireEvent.click(within(box).getByRole("button", { name: /查看 files.read.run:read/ }));
  expect(onOpenTools).toHaveBeenLastCalledWith({ turnId: "turn-1", itemId: "run:read" });
  fireEvent.click(within(box).getByRole("button", { name: "在侧栏展开工具链" }));
  expect(onOpenTools).toHaveBeenLastCalledWith({ turnId: "turn-1" });
  view.rerender(<ChatTimeline sessionId="s" runId="run" running items={[user, tool("run:read", "ok")]} onAnswer={vi.fn()} onOpenTools={onOpenTools} />);
  expect(within(box).getByText("完成")).toBeVisible();
  expect(within(box).queryByText("接收参数")).not.toBeInTheDocument();
});

test("keeps waiting approvals and questions actionable outside a collapsed chain", () => {
  const onAnswer = vi.fn(async () => undefined);
  const onApprove = vi.fn(async () => undefined);
  const approval: ChatItem = { id: "approve", kind: "approval", status: "waiting", request: {
    id: "request", sessionId: "s", runId: "run", toolName: "Bash", arguments: "{}", reason: "运行检查", risk: "standard",
  } };
  const question: ChatItem = { id: "question", kind: "question", status: "waiting", question: {
    id: "q", sessionId: "s", runId: "run", title: "选择范围", fields: [{ id: "scope", label: "范围", type: "text", required: false }],
  } };
  render(<ChatTimeline sessionId="s" runId="run" running items={[user, tool("read"), approval, question]} preferences={{ ...preferences, hideAgentDetails: true }} onAnswer={onAnswer} onApprove={onApprove} onOpenTools={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "展开工具链" }));
  fireEvent.click(screen.getByRole("button", { name: "收起工具链" }));
  expect(screen.getByRole("button", { name: "批准" })).toBeVisible();
  expect(screen.getByRole("button", { name: "提交回答" })).toBeVisible();
  expect(screen.getByLabelText("审批请求").closest(".tool-chain-box")).toBeNull();
  expect(screen.getByLabelText("需求问答").closest(".tool-chain-box")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "批准" }));
  expect(onApprove).toHaveBeenCalledWith(approval, true);
});

test("shows enabled response metrics even when the chain is collapsed", () => {
  render(<ChatTimeline sessionId="s" items={[user, tool("read"), { id: "reply", kind: "message", role: "assistant", content: "完成", metrics: {
    firstTokenMs: 120, thinkingMs: 2000, outputTokens: 30, outputRate: 15, durationMs: 3000,
  } }]} preferences={{ ...preferences, hideAgentDetails: true }} onAnswer={vi.fn()} />);
  expect(screen.getByText("输出 15.0 token/s")).toBeVisible();
  expect(screen.getByText("首字 120 ms")).toBeVisible();
  expect(screen.getByText("思考 2.0 s")).toBeVisible();
});
