// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import App from "../../src/renderer/App";
import type { ValidationResult } from "../../src/shared/contracts";
import { fixture, task, version } from "./fixtures";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(window, "specloom", {
    configurable: true,
    value: undefined,
  });
});

describe("desktop workspace workflows", () => {
  it("shows an actionable project picker and disables it only without a desktop bridge", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "SpecLoom" })).toBeVisible();
    expect(screen.getByRole("button", { name: "创建示例项目" })).toBeDisabled();
    expect(screen.getByText("桌面连接不可用")).toBeVisible();
  });
  it("creates a sample project and exposes its Godot metadata", async () => {
    const { api } = fixture();
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "创建示例项目" }));
    expect(
      await screen.findByRole("heading", { name: "灯塔守望" }),
    ).toBeVisible();
    expect(api.createExample).toHaveBeenCalledOnce();
    expect(screen.getByText("C:/Godot/lantern")).toBeVisible();
    expect(screen.getByText("Godot 4.4")).toBeVisible();
    expect(screen.getByRole("navigation", { name: "项目视图" })).toBeVisible();
  });
  it("creates a task only after explicit immutable read/write scope confirmation", async () => {
    const { api } = fixture({ project: true });
    render(<App />);
    await screen.findByRole("heading", { name: "灯塔守望" });
    fireEvent.click(screen.getAllByRole("button", { name: "新建任务" })[0]!);
    const dialog = screen.getByRole("dialog", { name: "确认任务范围" });
    expect(within(dialog).getByLabelText("可读路径")).toHaveValue("*");
    expect(within(dialog).getByLabelText("可写路径")).toHaveValue(
      "specs/entities/characters/**\nscenes/**\nscripts/**",
    );
    expect(api.createTask).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText("任务名称"), {
      target: { value: "授权角色移动" },
    });
    fireEvent.change(within(dialog).getByLabelText("可写路径"), {
      target: { value: "scripts/keeper.gd" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "确认范围并创建" }),
    );
    await waitFor(() =>
      expect(api.createTask).toHaveBeenCalledWith({
        title: "授权角色移动",
        readPaths: ["*"],
        writePaths: ["scripts/keeper.gd"],
        mode: "manual",
        allowDelete: false,
      }),
    );
    expect(
      await screen.findByRole("heading", { name: "授权角色移动" }),
    ).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("polls tool activity during a pending agent, blocks approval, then shows the final review", async () => {
    const f = fixture({ project: true, tasks: true, changes: true });
    let finish!: (value: { summary: string; toolCalls: number }) => void;
    f.api.agent.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<App />);
    await screen.findByRole("button", { name: "批准并提交" });
    fireEvent.change(screen.getByLabelText("任务消息"), {
      target: { value: "生成角色移动" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(screen.getByRole("button", { name: "批准并提交" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "停止" })).toBeEnabled();
    f.state().tasks[0]!.events.push({
      time: new Date().toISOString(),
      tool: "files.read",
      ok: true,
      message: "读取角色",
    });
    expect(
      await screen.findByText("读取角色", {}, { timeout: 2200 }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(f.api.cancel).toHaveBeenCalledWith("task-1");
    await act(async () => {
      finish({ summary: "已生成移动脚本", toolCalls: 1 });
    });
    expect(await screen.findByText("已生成移动脚本")).toBeVisible();
    expect(screen.getByText("提交前")).toBeVisible();
    expect(screen.getByText("提交后")).toBeVisible();
    expect(screen.getByText("const SPEED = 120")).toBeVisible();
    expect(screen.getByText("const SPEED = 180")).toBeVisible();
    expect(screen.getByRole("button", { name: "批准并提交" })).toBeEnabled();
  });
  it("approves the exact displayed digest and keeps post-commit validation available", async () => {
    const { api } = fixture({ project: true, tasks: true, changes: true });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "批准并提交" }));
    await waitFor(() =>
      expect(api.approve).toHaveBeenCalledWith("task-1", "digest-exact-123"),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "批准并提交" })).toBeDisabled(),
    );
    expect(screen.getByRole("button", { name: "验证" })).toBeEnabled();
    expect(screen.getByLabelText("任务消息")).toBeDisabled();
  });
  it("shows failed and skipped checks without claiming validation succeeded", async () => {
    const f = fixture({ project: true, tasks: true, changes: true });
    const result: ValidationResult = {
      status: "fail",
      checks: [
        {
          id: "syntax",
          name: "GDScript",
          status: "fail",
          stdout: "",
          stderr: "Unexpected token",
          exitCode: 1,
        },
        {
          id: "godot",
          name: "Godot",
          status: "skipped",
          stdout: "",
          stderr: "未配置",
        },
      ],
      diagnostics: [
        {
          severity: "error",
          code: "SCRIPT_INVALID",
          path: "scripts/keeper.gd",
          message: "脚本语法错误",
          line: 2,
        },
      ],
    };
    f.api.validate.mockImplementation(async () => {
      f.review().validation = result;
      return result;
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "验证" }));
    expect(await screen.findByText("验证失败")).toBeVisible();
    expect(screen.queryByText("验证通过")).not.toBeInTheDocument();
    expect(screen.getByText("SCRIPT_INVALID")).toBeVisible();
    expect(screen.getByText("跳过")).toBeVisible();
    expect(screen.getByText("scripts/keeper.gd:2")).toBeVisible();
  });
  it("reports the stale conflict path and supports a fresh version read and task restart", async () => {
    const f = fixture({ project: true, tasks: true, changes: true });
    f.api.approve.mockRejectedValue(
      Object.assign(new Error("源文件已更新"), {
        code: "VERSION_CONFLICT",
        details: { path: "scripts/keeper.gd" },
      }),
    );
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "批准并提交" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("VERSION_CONFLICT")).toBeVisible();
    expect(within(alert).getByText("scripts/keeper.gd")).toBeVisible();
    fireEvent.click(within(alert).getByRole("button", { name: "重新读取" }));
    await waitFor(() =>
      expect(f.api.tool).toHaveBeenCalledWith("task-1", "files.read", {
        path: "scripts/keeper.gd",
        expectedVersion: version,
      }),
    );
    f.api.approve.mockRejectedValue(
      Object.assign(new Error("源文件已更新"), {
        code: "VERSION_CONFLICT",
        details: { path: "scripts/keeper.gd" },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "批准并提交" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "重新创建任务" }),
    );
    expect(screen.getByRole("dialog", { name: "确认任务范围" })).toBeVisible();
    expect(screen.getByLabelText("任务名称")).toHaveValue(task.scope.title);
  });
  it("stages full document edits using an exact path scope and an actual task read", async () => {
    const f = fixture({ project: true });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "规范与实体" }));
    fireEvent.click(await screen.findByRole("button", { name: "outline.md" }));
    const editor = await screen.findByLabelText("文档内容");
    fireEvent.change(editor, { target: { value: "# 大纲\n新增内容" } });
    fireEvent.click(screen.getByRole("button", { name: "暂存编辑" }));
    await waitFor(() =>
      expect(f.api.tool).toHaveBeenCalledWith("new-task", "files.write", {
        path: "specs/outline.md",
        content: "# 大纲\n新增内容",
        expectedVersion: version,
      }),
    );
    expect(f.api.createTask).toHaveBeenCalledWith({
      title: "编辑 specs/outline.md",
      readPaths: ["specs/outline.md"],
      writePaths: ["specs/outline.md"],
      allowDelete: false,
      mode: "manual",
    });
    expect(f.api.tool.mock.calls.map((call) => call[1])).toEqual([
      "files.list_versions",
      "files.read",
      "files.write",
    ]);
  });
  it("saves an explicit empty credential for a keyless model and records endpoint approval", async () => {
    const f = fixture({ project: true });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "模型" }));
    fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
    fireEvent.change(screen.getByLabelText("配置名称"), {
      target: { value: "本地模型" },
    });
    fireEvent.change(screen.getByLabelText("模型 ID"), {
      target: { value: "local-model" },
    });
    fireEvent.change(screen.getByLabelText("端点 URL"), {
      target: { value: "http://127.0.0.1:1234/v1" },
    });
    fireEvent.click(screen.getByLabelText("授权此端点接收任务上下文"));
    fireEvent.click(screen.getByRole("button", { name: "保存模型" }));
    await waitFor(() =>
      expect(f.api.saveModel).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "本地模型",
          model: "local-model",
          approved: true,
          baseUrl: "http://127.0.0.1:1234/v1",
        }),
        "",
      ),
    );
    expect(await screen.findByText("本地模型")).toBeVisible();
  });
  it("creates entity YAML through a new exact-path task and never reads an absent file", async () => {
    const f = fixture({ project: true });
    f.api.tool.mockImplementation(async (_id, name, input) =>
      name === "files.list_versions"
        ? [
            {
              path: (input.paths as string[])[0],
              version: "absent",
              exists: false,
              size: 0,
            },
          ]
        : {},
    );
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "规范与实体" }));
    fireEvent.click(screen.getByRole("button", { name: "新建实体" }));
    fireEvent.change(screen.getByLabelText("实体 ID"), {
      target: { value: "keeper" },
    });
    fireEvent.change(screen.getByLabelText("名称"), {
      target: { value: "守灯人" },
    });
    fireEvent.click(screen.getByRole("button", { name: "暂存实体" }));
    await waitFor(() =>
      expect(f.api.tool).toHaveBeenCalledWith(
        "new-task",
        "files.write",
        expect.objectContaining({
          path: "specs/entities/characters/keeper.md",
          expectedVersion: "absent",
        }),
      ),
    );
    const content = f.api.tool.mock.calls.find(
      (call) => call[1] === "files.write",
    )![2].content as string;
    expect(parse(content.split("---")[1]!)).toEqual({
      id: "keeper",
      type: "character",
      status: "draft",
      version: 1,
      relations: [],
      source: "developer",
    });
    expect(f.api.tool.mock.calls.some((call) => call[1] === "files.read")).toBe(
      false,
    );
    expect(f.api.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        readPaths: ["specs/entities/characters/keeper.md"],
        writePaths: ["specs/entities/characters/keeper.md"],
        mode: "manual",
      }),
    );
  });
  it("loads Skills for the active task at the discovered version with explicit source paths", async () => {
    const f = fixture({ project: true, tasks: true });
    const skill = {
      id: "character",
      name: "角色开发",
      purpose: "生成角色",
      allowedSources: ["specs/**"],
      path: ".specloom/skills/character/SKILL.md",
      version,
    };
    f.api.tool.mockImplementation(async (_id, name) =>
      name === "skills.list"
        ? [skill]
        : {
            ...skill,
            instructions: "读取角色，生成脚本，验证。",
            sources: [{ path: "specs/entities/characters/keeper.md", version }],
            referencedContent: [],
          },
    );
    render(<App />);
    await screen.findByRole("heading", { name: "守灯人移动" });
    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    fireEvent.change(screen.getByLabelText("来源路径（可选）"), {
      target: { value: "specs/entities/characters/**" },
    });
    fireEvent.click(await screen.findByRole("button", { name: /角色开发/ }));
    expect(await screen.findByText("读取角色，生成脚本，验证。")).toBeVisible();
    expect(f.api.tool).toHaveBeenCalledWith("task-1", "skills.load", {
      id: "character",
      expectedVersion: version,
      sourcePaths: ["specs/entities/characters/**"],
    });
    expect(
      screen.getByText("specs/entities/characters/keeper.md"),
    ).toBeVisible();
  });
  it("prevents new runs on a conflicted task and preserves its scope in the restart dialog", async () => {
    const f = fixture({ project: true, tasks: true, changes: true });
    f.state().tasks[0]!.status = "conflicted";
    f.review().changeSet.status = "conflicted";
    render(<App />);
    await screen.findByRole("button", { name: "批准并提交" });
    expect(screen.getByLabelText("任务消息")).toBeDisabled();
    expect(screen.getByRole("button", { name: "批准并提交" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "重新创建任务" }));
    expect(screen.getByLabelText("可写路径")).toHaveValue(
      "scenes/**\nscripts/**",
    );
    expect(f.api.agent).not.toHaveBeenCalled();
  });
});
