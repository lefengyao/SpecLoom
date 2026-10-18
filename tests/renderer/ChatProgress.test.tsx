// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ChatTimeline } from "../../src/renderer/chat/ChatTimeline";
import type { ChatItem } from "../../src/shared/chat";

afterEach(cleanup);
const preferences = { hideAgentDetails: true, showOutputRate: false, showFirstTokenLatency: false, showThinkingDuration: false };
const user: ChatItem = { id: "r:user", kind: "message", role: "user", content: "修改玩家移动" };
function edit(id: string, path: string, status: "running" | "ok" | "error" = "ok"): ChatItem {
  return { id, kind: "tool", callId: id, name: "Edit", arguments: JSON.stringify({ ok: true, result: { path, old_string: "speed = 1", new_string: "speed = 2" } }), output: status === "ok" ? '{"ok":true,"result":{"replacements":1}}' : "", status };
}

test("shows public progress beside recent file operations and leaves reasoning optional", () => {
  const items: ChatItem[] = [user, { id: "r:progress", kind: "message", role: "assistant", content: "先核对碰撞逻辑，再调整玩家速度。", partial: true }, edit("r:old", "old.gd"), { id: "r:thinking", kind: "thinking", content: "供应商的推理详情", partial: true }, edit("r:a", "player.gd"), edit("r:b", "scene.gd"), edit("r:c", "world.gd", "running")];
  render(<ChatTimeline sessionId="s" runId="r" running items={items} preferences={preferences} onAnswer={vi.fn()} />);
  const recent = screen.getByLabelText("最近执行步骤");
  expect(within(recent).getByText("world.gd")).toBeVisible();
  expect(within(recent).queryByText("old.gd")).not.toBeInTheDocument();
  const progress = screen.getByText("先核对碰撞逻辑，再调整玩家速度。");
  expect(progress).toBeVisible();
  expect(progress.closest(".tool-chain-box")).toBeNull();
  expect(screen.queryByText("供应商的推理详情")).not.toBeInTheDocument();
  expect(within(recent).getAllByText("speed = 2").length).toBeGreaterThan(0);
  expect(within(recent).getByText("调用中")).toBeVisible();
  expect(screen.queryByText(/思考中/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "展开工具链" }));
  expect(screen.getByText("old.gd")).toBeVisible();
  const thinking = screen.getByLabelText("模型返回的思考") as HTMLDetailsElement;
  thinking.open = true; fireEvent(thinking, new Event("toggle"));
  expect(screen.getByText("供应商的推理详情")).toBeVisible();
});

test("keeps public bubbles and consecutive tool stages in execution order", () => {
  const onOpenTools = vi.fn();
  const items: ChatItem[] = [user,
    { id: "r:intro", kind: "message", role: "assistant", content: "先检查玩家脚本。", partial: true },
    edit("r:first", "player.gd"),
    { id: "r:update", kind: "message", role: "assistant", content: "已找到速度配置，现在调整场景。", partial: true },
    edit("r:second", "scene.gd", "running"),
  ];
  const view = render(<ChatTimeline sessionId="s" runId="r" running items={items} preferences={preferences} onAnswer={vi.fn()} onOpenTools={onOpenTools} />);
  const intro = screen.getByText("先检查玩家脚本。").closest("article")!;
  const update = screen.getByText("已找到速度配置，现在调整场景。").closest("article")!;
  const first = screen.getByText("player.gd").closest<HTMLElement>(".tool-chain-box")!;
  const second = screen.getByText("scene.gd").closest<HTMLElement>(".tool-chain-box")!;
  expect(intro.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(first.compareDocumentPosition(update) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(update.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(first).not.toBe(second);
  expect(intro).toHaveClass("chat-progress");
  expect(update).toHaveClass("chat-progress");
  expect(within(intro).getByText("智能体 · 进度说明")).toBeVisible();
  expect(screen.queryByText(/生成中/)).not.toBeInTheDocument();
  expect(within(first).getByText("已结束")).toBeVisible();
  fireEvent.click(within(second).getByRole("button", { name: /查看 Edit/ }));
  expect(onOpenTools).toHaveBeenLastCalledWith({ turnId: user.id, itemId: "r:second" });

  view.rerender(<ChatTimeline sessionId="s" runId="r" running items={[...items,
    { id: "r:final", kind: "message", role: "assistant", content: "已完成调整。", partial: true },
  ]} preferences={preferences} onAnswer={vi.fn()} onOpenTools={onOpenTools} />);
  const final = screen.getByText("已完成调整。").closest("article")!;
  expect(final).not.toHaveClass("chat-progress");
  expect(within(final).getByText(/生成中/)).toBeVisible();
  expect(screen.getAllByText(/生成中/)).toHaveLength(1);
  expect(second.compareDocumentPosition(final) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("keeps a streaming public reply live when guidance is appended during generation", () => {
  const reply: ChatItem = { id: "r:reply", kind: "message", role: "assistant", content: "正在核对", partial: true };
  const guidance: ChatItem = { id: "r:guidance:g", kind: "message", role: "user", content: "也检查场景", guidance: { fingerprint: "b".repeat(64) } };
  const view = render(<ChatTimeline sessionId="s" runId="r" running items={[user, reply]} onAnswer={vi.fn()} />);
  expect(screen.getByText(/生成中/)).toBeVisible();
  view.rerender(<ChatTimeline sessionId="s" runId="r" running items={[user, { ...reply, content: "正在核对玩家脚本" }, guidance]} onAnswer={vi.fn()} />);
  const bubble = screen.getByText("正在核对玩家脚本").closest("article")!;
  expect(within(bubble).getByText(/生成中/)).toBeVisible();
  expect(within(bubble).queryByText(/部分回复/)).not.toBeInTheDocument();
});

test("uses the validated path even when a large Write payload was truncated for history", () => {
  const write: ChatItem = { id: "r:write", kind: "tool", callId: "w", name: "Write", arguments: '{"path":"src/玩家.gd","content":"' + "x".repeat(16000), output: "", status: "running" };
  render(<ChatTimeline sessionId="s" runId="r" running items={[user, write]} preferences={preferences} onAnswer={vi.fn()} />);
  expect(screen.getByText("src/玩家.gd")).toBeVisible();
  expect(screen.getByText("写入文件")).toBeVisible();
  expect(screen.queryByText(/x{200}/)).not.toBeInTheDocument();
});

test("shows a pending Monitor line as a temporary result without claiming the job completed", () => {
  const monitor: ChatItem = { id: "r:monitor", kind: "tool", callId: "m", name: "Monitor", arguments: '{"operation":"poll","id":"job"}', output: JSON.stringify({ ok: true, result: { output: "", partialOutput: "服务器已就绪", status: "running" } }), status: "ok" };
  render(<ChatTimeline sessionId="s" runId="r" running items={[user, monitor]} preferences={preferences} onAnswer={vi.fn()} />);
  expect(screen.getByText("未换行：服务器已就绪")).toBeVisible();
});

test("renders the durable per-run file report outside folded tool details", () => {
  const reply: ChatItem = { id: "r:reply", kind: "message", role: "assistant", content: "已调整移动。", fileChanges: {
    runId: "r", complete: false, notes: ["部分目录未检查"], files: [
      { path: "player.gd", operation: "modify", source: "tool" },
      { path: "new.gd", operation: "create", source: "workspace" },
      { path: "old.gd", operation: "delete", source: "workspace" },
    ],
  } };
  render(<ChatTimeline sessionId="s" items={[user, edit("r:e", "player.gd"), reply]} preferences={preferences} onAnswer={vi.fn()} />);
  const report = screen.getByRole("region", { name: "本次文件变更" });
  expect(within(report).getByText("player.gd")).toBeVisible();
  expect(within(report).getByText("新增")).toBeVisible();
  expect(within(report).getByText("删除")).toBeVisible();
  expect(within(report).getByText("部分目录未检查")).toBeVisible();
  expect(within(report).getAllByText("运行期间检测")).toHaveLength(2);
  expect(report.closest(".tool-chain-box")).toBeNull();
});

test("keeps a stopped run's file report after tools when it is stored on a progress message", () => {
  const progress: ChatItem = { id: "r:progress", kind: "message", role: "assistant", content: "接下来修改玩家脚本。", partial: true, fileChanges: {
    runId: "r", complete: true, notes: [], files: [{ path: "player.gd", operation: "modify", source: "tool" }],
  } };
  render(<ChatTimeline sessionId="s" items={[user, progress, edit("r:edit", "player.gd")]} preferences={preferences} onAnswer={vi.fn()} />);
  const report = screen.getByRole("region", { name: "本次文件变更" });
  const chain = screen.getByRole("region", { name: "第 1 轮工具链" });
  expect(chain.compareDocumentPosition(report) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByText("接下来修改玩家脚本。").closest("article")).toHaveClass("chat-progress");
  expect(within(report).getByText("player.gd")).toBeVisible();
});

test("keeps empty and stopped-run reports distinct across later tasks", () => {
  const items: ChatItem[] = [user,
    { id: "r:file-changes", kind: "message", role: "assistant", content: "", fileChanges: { runId: "r", complete: true, notes: [], files: [{ path: "partial.gd", operation: "modify", source: "tool" }] } },
    { id: "next:user", kind: "message", role: "user", content: "只解释" },
    { id: "next:reply", kind: "message", role: "assistant", content: "解释完成", fileChanges: { runId: "next", complete: true, notes: [], files: [] } },
  ];
  render(<ChatTimeline sessionId="s" items={items} preferences={preferences} onAnswer={vi.fn()} />);
  const reports = screen.getAllByRole("region", { name: "本次文件变更" });
  expect(within(reports[0]!).getByText("partial.gd")).toBeVisible();
  expect(within(reports[1]!).queryByText("partial.gd")).not.toBeInTheDocument();
  expect(within(reports[1]!).getByText("本次未检测到文件修改")).toBeVisible();
});

test("a report stored on the user message at the history cap stays after the run's tools and guidance", () => {
  const items: ChatItem[] = [{ ...user, fileChanges: { runId: "r", complete: true, notes: [], files: [{ path: "final.gd", operation: "modify", source: "tool" }] } },
    edit("r:first", "first.gd"), { id: "r:guidance:g", kind: "message", role: "user", content: "也检查场景", guidance: { fingerprint: "a".repeat(64) } }, edit("r:last", "last.gd")];
  render(<ChatTimeline sessionId="s" items={items} preferences={preferences} onAnswer={vi.fn()} />);
  const chains = screen.getAllByRole("region", { name: /第 1 轮工具链/ });
  expect(chains).toHaveLength(2);
  expect(screen.queryByRole("region", { name: /第 2 轮/ })).not.toBeInTheDocument();
  const report = screen.getByRole("region", { name: "本次文件变更" });
  expect(within(report).getByText("final.gd")).toBeVisible();
  expect(screen.getByText("也检查场景").compareDocumentPosition(report) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("full tool history follows new records only while the user is near the bottom", () => {
  const view = render(<ChatTimeline sessionId="s" runId="r" running items={[user, edit("r:one", "one.gd")]} onAnswer={vi.fn()} />);
  const history = screen.getByLabelText("本轮工具和思考记录");
  Object.defineProperties(history, { scrollHeight: { value: 800, configurable: true }, clientHeight: { value: 200, configurable: true } });
  history.scrollTop = 20; fireEvent.scroll(history);
  view.rerender(<ChatTimeline sessionId="s" runId="r" running items={[user, edit("r:one", "one.gd"), edit("r:two", "two.gd")]} onAnswer={vi.fn()} />);
  expect(history.scrollTop).toBe(20);
  fireEvent.click(screen.getByRole("button", { name: "查看最新步骤" }));
  expect(history.scrollTop).toBe(800);
});
