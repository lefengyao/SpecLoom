// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ScopeForm } from "../../src/renderer/ScopeForm";
import { MAX_TASK_GOAL_LENGTH, type TaskScopeSpec } from "../../src/shared/contracts";

afterEach(cleanup);

type ScopeDraft = Omit<TaskScopeSpec, "id">;

function open(onCreate: (scope: ScopeDraft) => Promise<void> = vi.fn(async () => undefined)) {
  render(
    <ScopeForm
      initial={undefined}
      busy={false}
      onClose={vi.fn()}
      onCreate={onCreate}
    />,
  );
  return onCreate;
}

test("task form collects an optional implementation goal within the shared cap", async () => {
  const onCreate = open();
  const goal = screen.getByLabelText("任务目标");
  expect(goal).toBeVisible();
  expect(goal).toHaveAttribute("maxlength", String(MAX_TASK_GOAL_LENGTH));
  expect(screen.getByText(/首次实现消息会启动默认工作流/)).toBeVisible();

  fireEvent.change(screen.getByLabelText("任务名称"), { target: { value: "修复灯塔交互" } });
  fireEvent.change(goal, { target: { value: "  让守灯人靠近灯塔时触发修复  " } });
  fireEvent.click(screen.getByRole("button", { name: "确认范围并创建" }));

  expect(onCreate).toHaveBeenCalledOnce();
  expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
    title: "修复灯塔交互",
    goal: "让守灯人靠近灯塔时触发修复",
    readPaths: ["*"],
  }));
});

test("an empty goal is omitted instead of persisted as a blank string", async () => {
  const onCreate = open();
  fireEvent.change(screen.getByLabelText("任务名称"), { target: { value: "只创建任务" } });
  fireEvent.change(screen.getByLabelText("任务目标"), { target: { value: "   " } });
  fireEvent.click(screen.getByRole("button", { name: "确认范围并创建" }));
  const created = vi.mocked(onCreate).mock.calls[0]?.[0] as Record<string, unknown>;
  expect(created).not.toHaveProperty("goal");
});
