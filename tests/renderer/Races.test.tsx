// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import App from "../../src/renderer/App";
import type { ChangeReview } from "../../src/shared/desktop-api";
import type { FileReadResult } from "../../src/shared/contracts";
import { fixture, task, version } from "./fixtures";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});
describe("renderer async boundaries", () => {
  it("restores saved task conversation and keeps it when sending a continuation", async () => {
    const f = fixture({ project: true, tasks: true });
    f.state().tasks[0]!.conversation = [{ role: "user", content: "保留原来的角色目标" }, { role: "assistant", content: "角色已暂存" }];
    render(<App />);
    expect(await screen.findByText("保留原来的角色目标")).toBeVisible();
    fireEvent.change(screen.getByLabelText("任务消息"), { target: { value: "继续" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByText("已生成移动脚本")).toBeVisible();
    expect(screen.getByText("保留原来的角色目标")).toBeVisible();
    expect(screen.getByText("角色已暂存")).toBeVisible();
  });
  it("keeps startup cleanup failures visible while the project remains usable", async () => {
    const f = fixture({ project: true });
    f.state().recoveryIssues = [{ code: "COMMAND_FAILED", message: "Snapshot retained", path: "private-snapshot" }];
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("上次运行的清理未完成");
    expect(screen.getByRole("alert")).toHaveTextContent("private-snapshot");
    fireEvent.click(screen.getByRole("button", { name: "规范" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Snapshot retained");
  });
  it("opens a new-task action on Skills after completion without querying a finished task", async () => {
    const f = fixture({ project: true, tasks: true });
    f.state().tasks[0]!.status = "applied";
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /^Skills$/ }));
    expect(screen.getByLabelText("刷新 Skills")).toBeDisabled();
    expect(f.api.tool).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: /^新建任务$/ }).at(-1)!);
    expect(screen.getByRole("dialog", { name: "确认任务范围" })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("keeps a finished agent's review attached to its task after selection changes", async () => {
    const f = fixture({ project: true, tasks: true, changes: true });
    const second = {
      ...structuredClone(task),
      id: "task-2",
      scope: { ...task.scope, id: "task-2", title: "地图交互" },
    };
    f.state().tasks.unshift(second);
    const secondReview: ChangeReview = {
      changeSet: {
        ...f.review().changeSet,
        taskId: "task-2",
        digest: "map-digest",
        entries: [
          {
            ...f.review().changeSet.entries[0]!,
            path: "scripts/map.gd",
            sourceTaskId: "task-2",
            nextContent: "extends Node2D",
          },
        ],
      },
      before: {},
      approved: false,
    };
    let finishAgent!: (value: { summary: string; toolCalls: number }) => void;
    let finishPreview!: (value: ChangeReview) => void;
    f.api.agent.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishAgent = resolve;
        }),
    );
    f.api.preview.mockImplementation((id: string) =>
      id === "task-1"
        ? Promise.resolve(structuredClone(f.review()))
        : new Promise((resolve) => {
            finishPreview = resolve;
          }),
    );
    render(<App />);
    await screen.findByRole("button", { name: "批准并提交" });
    fireEvent.change(screen.getByLabelText("任务消息"), {
      target: { value: "生成角色" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    fireEvent.click(screen.getByRole("button", { name: /地图交互/ }));
    expect(
      screen.queryByRole("button", { name: "拒绝变更" }),
    ).not.toBeInTheDocument();
    await act(async () => {
      finishAgent({ summary: "角色已完成", toolCalls: 2 });
    });
    expect(screen.queryByText("const SPEED = 120")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "拒绝变更" }),
    ).not.toBeInTheDocument();
    await act(async () => {
      finishPreview(secondReview);
    });
    fireEvent.click(await screen.findByRole("button", { name: "拒绝变更" }));
    await waitFor(() => expect(f.api.reject).toHaveBeenCalledWith("task-2"));
    expect(screen.queryByText("角色已完成")).not.toBeInTheDocument();
  });
  it("ignores older document responses so the selected editor retains new text", async () => {
    const f = fixture({ project: true });
    f.api.documents.mockResolvedValue([
      { path: "specs/outline.md", version, size: 20 },
      { path: "specs/other.md", version, size: 20 },
    ]);
    f.api.readDocument.mockImplementation(async (path: string) => ({ path, version, content: path === "specs/outline.md" ? "# 旧文档" : "# 新文档" }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "规范" }));
    fireEvent.click(screen.getByRole("button", { name: "项目树" }));
    await waitFor(() => expect(f.api.readDocument).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("读取资料…")).not.toBeInTheDocument());
    f.api.readDocument.mockClear();
    let finishOld!: (value: FileReadResult) => void;
    f.api.readDocument.mockImplementation((path: string) =>
      path === "specs/outline.md"
        ? new Promise((resolve) => {
            finishOld = resolve;
          })
        : Promise.resolve({ path, version, content: "# 新文档" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "outline.md" }));
    await waitFor(() => expect(f.api.readDocument).toHaveBeenCalledWith("specs/outline.md", version));
    fireEvent.click(screen.getByRole("button", { name: "other.md" }));
    const editor = await screen.findByLabelText("文档内容");
    expect(editor).toHaveValue("# 新文档");
    fireEvent.change(editor, { target: { value: "# 新文档\n正在编辑" } });
    await act(async () => {
      finishOld({ path: "specs/outline.md", version, content: "# 旧文档" });
    });
    expect(screen.getByLabelText("文档内容")).toHaveValue("# 新文档\n正在编辑");
    expect(
      screen.getByRole("heading", { name: "specs/other.md" }),
    ).toBeVisible();
  });
  it("refreshes versions and retries a stale first document read without a task", async () => {
    const f = fixture({ project: true });
    const latest = `sha256:${"b".repeat(64)}` as const;
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "规范" }));
    fireEvent.click(screen.getByRole("button", { name: "项目树" }));
    await waitFor(() => expect(f.api.readDocument).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByText("读取资料…")).not.toBeInTheDocument());
    f.api.readDocument.mockClear();
    f.api.readDocument
      .mockRejectedValueOnce(
        Object.assign(new Error("文档版本已变化"), {
          code: "VERSION_CONFLICT",
          details: { path: "specs/outline.md" },
        }),
      )
      .mockResolvedValue({
        path: "specs/outline.md",
        version: latest,
        content: "# 当前大纲",
      });
    fireEvent.click(await screen.findByRole("button", { name: "outline.md" }));
    await screen.findByRole("alert");
    f.api.documents.mockResolvedValue([
      { path: "specs/outline.md", version: latest, size: 30 },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
    await waitFor(() => expect(screen.getByLabelText("文档内容")).toHaveValue("# 当前大纲"));
    await waitFor(() => expect(f.api.readDocument).toHaveBeenLastCalledWith("specs/outline.md", latest));
    expect(f.api.tool).not.toHaveBeenCalled();
    expect(f.api.createTask).not.toHaveBeenCalled();
  });
});
