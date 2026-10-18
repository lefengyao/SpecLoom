// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ChatTimeline } from "../../src/renderer/chat/ChatTimeline";
import type { ChatItem } from "../../src/shared/chat";

afterEach(() => { cleanup(); vi.unstubAllEnvs(); });
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=";
const user = (id: string): ChatItem => ({ id, kind: "message", role: "user", content: id });
const tool = (id: string, status: "ok" | "error" | "cancelled" = "ok"): Extract<ChatItem, { kind: "tool" }> => ({ id, kind: "tool", callId: id, name: "files.read", arguments: "{}", output: "结果", status });
const approval = (status: Extract<ChatItem, { kind: "approval" }>["status"] = "waiting"): Extract<ChatItem, { kind: "approval" }> => ({
  id: "approval-item", kind: "approval", status,
  request: { id: "approval-request", sessionId: "s", runId: "r", toolName: "Bash", arguments: '{"command":"Remove-Item C:/external"}', reason: "删除外部文件需要审批", risk: "high" },
});

test.each([true, false])("submits an explicit approval decision and prevents duplicate responses (%s)", async approved => {
  let finish!: () => void;
  const onApprove = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const item = approval();
  render(<ChatTimeline sessionId="s" runId="r" running items={[item]} onAnswer={vi.fn()} onApprove={onApprove} />);
  const card = screen.getByLabelText("审批请求");
  expect(within(card).getByText("删除外部文件需要审批")).toBeVisible();
  expect(within(card).getByText("高风险")).toBeVisible();
  const button = within(card).getByRole("button", { name: approved ? "批准" : "拒绝" });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(onApprove).toHaveBeenCalledExactlyOnceWith(item, approved);
  expect(within(card).getByRole("button", { name: "批准" })).toBeDisabled();
  expect(within(card).getByRole("button", { name: "拒绝" })).toBeDisabled();
  await act(async () => finish());
});

test("shows approval submission errors and permits a deliberate retry", async () => {
  const onApprove = vi.fn().mockRejectedValueOnce(new Error("审批已失效"));
  render(<ChatTimeline sessionId="s" runId="r" running items={[approval()]} onAnswer={vi.fn()} onApprove={onApprove} />);
  fireEvent.click(screen.getByRole("button", { name: "批准" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("审批已失效");
  await waitFor(() => expect(screen.getByRole("button", { name: "批准" })).toBeEnabled());
});

test("keeps a successful decision locked until the persisted approval status arrives", async () => {
  const onApprove = vi.fn(async () => undefined);
  render(<ChatTimeline sessionId="s" runId="r" running items={[approval()]} onAnswer={vi.fn()} onApprove={onApprove} />);
  fireEvent.click(screen.getByRole("button", { name: "批准" }));
  await waitFor(() => expect(screen.getByText("已批准")).toBeVisible());
  expect(screen.queryByRole("button", { name: "批准" })).not.toBeInTheDocument();
  expect(onApprove).toHaveBeenCalledTimes(1);
});

test.each([["other-session", "r", true], ["s", "new-run", true], ["s", "r", false]] as const)("blocks waiting approval actions when their session or run is stale (%s, %s, %s)", (sessionId, runId, running) => {
  const onApprove = vi.fn();
  render(<ChatTimeline sessionId={sessionId} runId={runId} running={running} items={[approval()]} onAnswer={vi.fn()} onApprove={onApprove} />);
  const button = screen.getByRole("button", { name: "批准" });
  expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(onApprove).not.toHaveBeenCalled();
});

test.each([["approved", "已批准"], ["denied", "已拒绝"], ["cancelled", "已取消"], ["interrupted", "运行已中断"]] as const)("keeps terminal approval %s visible without action buttons", (status, label) => {
  render(<ChatTimeline sessionId="s" items={[approval(status), { id: "reply", kind: "message", role: "assistant", content: "任务结果" }]} preferences={{ hideAgentDetails: true, showOutputRate: false, showFirstTokenLatency: false, showThinkingDuration: false }} onAnswer={vi.fn()} onApprove={vi.fn()} />);
  expect(within(screen.getByLabelText("审批请求")).getByText(label)).toBeVisible();
  expect(screen.queryByRole("button", { name: "批准" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "拒绝" })).not.toBeInTheDocument();
});

test("keeps invocation statistics next to every turn including turns without tools", () => {
  const view = render(<ChatTimeline sessionId="s" runId="old" items={[user("u1"), tool("old:t1"), tool("old:t2", "error"), { id: "a1", kind: "message", role: "assistant", content: "第一轮完成" }]} onAnswer={vi.fn()} />);
  expect(screen.getByText(/第 1 轮工具调用 · 2 次/)).toBeVisible();
  view.rerender(<ChatTimeline sessionId="s" runId="new" items={[user("u1"), tool("old:t1"), tool("old:t2", "error"), user("u2"), tool("new:t1", "cancelled"), user("u3"), { id: "a3", kind: "message", role: "assistant", content: "直接回答" }]} onAnswer={vi.fn()} />);
  expect(screen.getByText(/第 1 轮工具调用 · 2 次 · 1 次失败/)).toBeVisible();
  expect(screen.getByText(/第 2 轮工具调用 · 1 次 · 0 次失败 · 1 次停止/)).toBeVisible();
  expect(screen.getByText(/第 3 轮工具调用 · 0 次/)).toBeVisible();
  const first = screen.getByText(/第 1 轮工具调用/).closest("details")!;
  fireEvent.click(within(first).getByText(/第 1 轮工具调用/));
  expect(within(first).getByText("files.read × 2")).toBeVisible();
});

test("renders provider reasoning separately and treats activity as status text", () => {
  render(<ChatTimeline sessionId="s" runId="r" running items={[user("问题"), { id: "activity", kind: "activity", content: "正在调用 files.read" }, { id: "r:reason", kind: "thinking", content: "先核对**项目依赖**。", partial: true }]} onAnswer={vi.fn()} />);
  const reasoning = screen.getByLabelText("模型返回的思考") as HTMLDetailsElement;
  expect(screen.queryByText("项目依赖")).not.toBeInTheDocument();
  reasoning.open = true; fireEvent(reasoning, new Event("toggle"));
  expect(within(reasoning).getByText("项目依赖")).toBeVisible();
  expect(within(reasoning).getByText(/思考中/)).toBeVisible();
  expect(screen.getByText("正在调用 files.read")).toBeVisible();
  expect(screen.queryByLabelText("需求问答")).not.toBeInTheDocument();
});

test("does not label stopped reasoning as live thinking, including when a newer turn runs", () => {
  const items: ChatItem[] = [user("旧问题"), { id: "old:thinking", kind: "thinking", content: "已收到的部分思考", partial: true }];
  const view = render(<ChatTimeline sessionId="s" runId="old" items={items} onAnswer={vi.fn()} />);
  expect(screen.queryByText(/思考中/)).not.toBeInTheDocument();
  expect(screen.getByText("模型思考 · 部分内容")).toBeVisible();
  view.rerender(<ChatTimeline sessionId="s" runId="new" running items={[...items, user("新问题"), { id: "new:thinking", kind: "thinking", content: "当前思考", partial: true }]} onAnswer={vi.fn()} />);
  expect(screen.getAllByText(/思考中/)).toHaveLength(1);
  expect(screen.getByText("模型思考 · 部分内容")).toBeVisible();
});

test("only labels the current reasoning segment as thinking while the model is streaming it", () => {
  const items: ChatItem[] = [user("问题"), { id: "r:one", kind: "thinking", content: "第一阶段思考", partial: true }, tool("r:tool"), { id: "r:two", kind: "thinking", content: "第二阶段思考", partial: true }];
  const view = render(<ChatTimeline sessionId="s" runId="r" running items={items} onAnswer={vi.fn()} />);
  expect(screen.getAllByText(/思考中/)).toHaveLength(1);
  view.rerender(<ChatTimeline sessionId="s" runId="r" running items={[...items, { id: "r:tool2", kind: "tool", callId: "t2", name: "Read", arguments: "{}", output: "", status: "running" }]} onAnswer={vi.fn()} />);
  expect(screen.queryByText(/思考中/)).not.toBeInTheDocument();
});

test("uses configured avatars for both roles and the SpecLoom brand by default", () => {
  const items: ChatItem[] = [user("问题"), { id: "a", kind: "message", role: "assistant", content: "回答" }];
  const view = render(<ChatTimeline sessionId="s" items={items} onAnswer={vi.fn()} />);
  expect(screen.getByRole("img", { name: "智能体头像" })).toHaveAttribute("src", "/brand/specloom.svg");
  view.rerender(<ChatTimeline sessionId="s" items={items} avatars={{ userAvatar: png, assistantAvatar: png }} onAnswer={vi.fn()} />);
  expect(screen.getByRole("img", { name: "用户头像" })).toHaveAttribute("src", png);
  expect(screen.getByRole("img", { name: "智能体头像" })).toHaveAttribute("src", png);
});

test("loads the default avatar relative to the renderer directory in the desktop app", () => {
  vi.stubEnv("BASE_URL", "./");
  render(<ChatTimeline sessionId="s" items={[{ id: "a", kind: "message", role: "assistant", content: "回答" }]} onAnswer={vi.fn()} />);
  expect(screen.getByRole("img", { name: "智能体头像" })).toHaveAttribute("src", "./brand/specloom.svg");
});

test("mounts historical reasoning lazily while keeping tool payloads out of the conversation", () => {
  const preferences = { hideAgentDetails: true, showOutputRate: false, showFirstTokenLatency: false, showThinkingDuration: false };
  const items: ChatItem[] = [user("历史问题"), { id: "old:thinking", kind: "thinking", content: "历史**思考正文**" },
    { ...tool("old:tool"), output: "历史工具的大段输出" }, { id: "reply", kind: "message", role: "assistant", content: "历史回答" }];
  render(<ChatTimeline sessionId="s" items={items} preferences={preferences} onAnswer={vi.fn()} />);
  expect(screen.queryByText("思考正文")).not.toBeInTheDocument();
  expect(screen.queryByText("历史工具的大段输出")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "展开工具链" }));
  const thinking = screen.getByLabelText("模型返回的思考") as HTMLDetailsElement;
  expect(screen.queryByText("思考正文")).not.toBeInTheDocument();
  thinking.open = true; fireEvent(thinking, new Event("toggle"));
  expect(screen.getByText("思考正文")).toBeVisible();
  expect(screen.queryByText("历史工具的大段输出")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "收起工具链" }));
  expect(screen.queryByText("思考正文")).not.toBeInTheDocument();
  expect(screen.queryByText("历史工具的大段输出")).not.toBeInTheDocument();
});
