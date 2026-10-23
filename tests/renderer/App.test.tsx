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
  window.localStorage.clear();
  Object.defineProperty(window, "specloom", {
    configurable: true,
    value: undefined,
  });
});

describe("desktop workspace workflows", () => {
  it("shows an actionable project picker and disables it only without a desktop bridge", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "SpecLoom" })).toBeVisible();
    expect(screen.getByText("络络")).toBeVisible();
    expect(screen.getByText("THREAD SPRITE")).toBeVisible();
    expect(screen.getByRole("button", { name: /我是络络/ })).toBeVisible();
    expect(document.querySelector(".mascot-orbit-track")).not.toBeNull();
    expect(document.querySelector(".entry-mark")).toHaveAttribute("data-orbit-preset", "thread");
    expect(screen.getByRole("button", { name: "创建示例项目" })).toBeDisabled();
    expect(screen.getByText("桌面连接不可用")).toBeVisible();
  });
  it("renders the core navigation in English when the locale is en", async () => {
    fixture({ project: true, preferences: { locale: "en" } });
    render(<App />);

    expect(await screen.findByRole("button", { name: "Workspace" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Workflows" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Entities" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Game settings" })).toBeInTheDocument();
  });
  it("creates a sample project and exposes its Godot metadata in the sidebar", async () => {
    const { api } = fixture();
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "创建示例项目" }));
    expect(
      await screen.findByRole("heading", { name: "灯塔守望" }),
    ).toBeVisible();
    expect(api.createExample).toHaveBeenCalledOnce();
    const projectInfo = screen.getByRole("region", { name: "当前项目" });
    const projectToggle = within(projectInfo).getByRole("button", { name: "项目信息：灯塔守望" });
    expect(projectInfo.closest("aside")).toHaveClass("application-sidebar");
    expect(projectToggle).toHaveAttribute("aria-expanded", "false");
    expect(within(projectInfo).getByText("C:/Godot/lantern")).not.toBeVisible();
    fireEvent.click(projectToggle);
    expect(projectToggle).toHaveAttribute("aria-expanded", "true");
    expect(within(projectInfo).getByText("C:/Godot/lantern")).toBeVisible();
    expect(within(projectInfo).getByText("Godot 4.4")).toBeVisible();
    expect(within(projectInfo).getByText("GL Compatibility")).toBeVisible();
    expect(within(projectInfo).getByText("res://scenes/main.tscn")).toBeVisible();
    expect(document.querySelector(".application-body")?.firstElementChild).toHaveClass("main-content");
    expect(screen.getByRole("navigation", { name: "项目视图" })).toBeVisible();
    const navigation = screen.getByRole("navigation", { name: "项目视图" });
    expect(navigation.closest("aside")).toHaveClass("application-sidebar");
    for (const name of ["项目文件", "实体", "组件", "设定", "地图", "UI", "规范"]) {
      expect(within(navigation).getByRole("button", { name })).toBeVisible();
    }
    fireEvent.click(screen.getByRole("button", { name: "收起导航" }));
    expect(projectToggle).toHaveAttribute("aria-expanded", "false");
    expect(within(projectInfo).getByText("C:/Godot/lantern")).not.toBeVisible();
    fireEvent.click(projectToggle);
    expect(screen.getByRole("button", { name: "收起导航" })).toHaveAttribute("aria-expanded", "true");
    expect(projectToggle).toHaveAttribute("aria-expanded", "true");
  });
  it("uses distinct icons for providers and MCP navigation entries", async () => {
    const { api } = fixture();
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "创建示例项目" }));
    const navigation = await screen.findByRole("navigation", { name: "项目视图" });
    expect(within(navigation).getByRole("button", { name: "供应商" }).querySelector("svg")).toHaveClass("lucide-store");
    expect(within(navigation).getByRole("button", { name: "MCP" }).querySelector("svg")).toHaveClass("lucide-cable");
    expect(api.createExample).toHaveBeenCalledOnce();
  });
  it("opens the independent plugin management page from the tool navigation group", async () => {
    const { api } = fixture({ project: true });
    render(<App />);
    const navigation = await screen.findByRole("navigation", { name: "项目视图" });
    fireEvent.click(within(navigation).getByRole("button", { name: "插件" }));
    expect(await screen.findByRole("heading", { name: "插件管理" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "SpecLoom Godot MCP" })).toBeVisible();
    expect(api.pluginManagement?.list).toHaveBeenCalledOnce();
  });
  it("keeps workspace state stable while switching views", async () => {
    const { api } = fixture({ project: true });
    render(<App />);
    await screen.findByRole("navigation", { name: "项目视图" });
    const refreshes = api.state.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "供应商" }));
    await screen.findByRole("heading", { name: "供应商与模型" });
    fireEvent.click(screen.getByRole("button", { name: "工作区" }));
    await screen.findByLabelText("任务消息");
    expect(api.state).toHaveBeenCalledTimes(refreshes);
  });
  it("sends an empty-workspace chat without creating a task", async () => {
    const { api } = fixture({ project: true });
    render(<App />);
    const composer = await screen.findByLabelText("任务消息");
    expect(composer).toBeVisible();
    fireEvent.change(composer, { target: { value: "生成一个守灯人脚本" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(api.createTask).not.toHaveBeenCalled();
    expect(api.agent).not.toHaveBeenCalled();
    await waitFor(() => expect(api.chat).toHaveBeenCalledWith(
      { providerId: "provider-1", model: "gpt-test" },
      "生成一个守灯人脚本",
      [],
    ));
    expect(await screen.findByText("这是普通对话回复")).toBeVisible();
  });
  it("creates a task only after the user explicitly chooses new task", async () => {
    const { api } = fixture({ project: true });
    render(<App />);
    await screen.findByRole("heading", { name: "灯塔守望" });
    fireEvent.click(screen.getByRole("button", { name: "只创建任务" }));
    expect(screen.getByRole("dialog", { name: "确认任务范围" })).toBeVisible();
    expect(api.chat).not.toHaveBeenCalled();
  });
  it("keeps the project tree in a drawer so category views are not all split by it", async () => {
    const { api } = fixture({ project: true });
    api.projectTree.mockResolvedValue([
      { path: "project.godot", kind: "file" },
      { path: "scenes", kind: "directory" },
      { path: "scenes/main.tscn", kind: "file" },
      { path: "specs", kind: "directory" },
      { path: "specs/outline.md", kind: "file" },
    ]);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "项目文件" }));
    const toggle = screen.getByRole("button", { name: "项目树" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "project.godot" })).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(await screen.findByRole("button", { name: "project.godot" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "scenes" }));
    fireEvent.click(screen.getByRole("button", { name: "main.tscn" }));
    expect(screen.getByRole("heading", { name: "scenes/main.tscn" })).toBeVisible();
    expect(api.readDocument).not.toHaveBeenCalled();
  });
  it("remembers an opened project tree drawer across remounts", async () => {
    fixture({ project: true });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "项目文件" }));
    fireEvent.click(screen.getByRole("button", { name: "项目树" }));
    expect(screen.getByRole("button", { name: "项目树" })).toHaveAttribute("aria-expanded", "true");
    cleanup();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "项目文件" }));
    expect(screen.getByRole("button", { name: "项目树" })).toHaveAttribute("aria-expanded", "true");
  });
  it("lists recently opened projects on the home screen and reopens one without a picker", async () => {
    const { api } = fixture({
      recent: [
        {
          path: "C:/Godot/lantern",
          name: "灯塔守望",
          openedAt: new Date().toISOString(),
          exists: true,
        },
        {
          path: "D:/Godot/gone",
          name: "已删除项目",
          openedAt: "2020-01-01T00:00:00.000Z",
          exists: false,
        },
      ],
    });
    render(<App />);
    const list = await screen.findByRole("region", { name: "近期打开的项目" });
    expect(within(list).getByText("刚刚")).toBeVisible();
    expect(within(list).getByText("路径不可用")).toBeVisible();
    expect(within(list).getByTitle("路径不可用：D:/Godot/gone")).toBeDisabled();
    fireEvent.click(within(list).getByTitle("打开 C:/Godot/lantern"));
    expect(await screen.findByRole("heading", { name: "灯塔守望" })).toBeVisible();
    expect(api.openProject).toHaveBeenCalledWith("C:/Godot/lantern");
    expect(api.selectProject).not.toHaveBeenCalled();
  });
  it.each([true, false])("removes a recent project with exists=%s from the list", async exists => {
    const { api } = fixture({
      recent: [
        {
          path: "D:/Godot/gone",
          name: "已删除项目",
          openedAt: "2020-01-01T00:00:00.000Z",
          exists,
        },
      ],
    });
    render(<App />);
    const list = await screen.findByRole("region", { name: "近期打开的项目" });
    fireEvent.click(
      within(list).getByRole("button", { name: "从列表移除 已删除项目" }),
    );
    await waitFor(() =>
      expect(api.forgetProject).toHaveBeenCalledWith("D:/Godot/gone"),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "近期打开的项目" }),
      ).not.toBeInTheDocument(),
    );
  });
  it.each([
    ["设定", "specs/settings/world.md", "setting"],
    ["UI", "specs/ui/hud.md", "ui"],
  ])("creates a %s document in its own category", async (category, path, type) => {
    const { api } = fixture({ project: true });
    api.tool.mockImplementation(async (_id, name, input) =>
      name === "files.list_versions"
        ? [{ path: (input.paths as string[])[0], version: "absent", exists: false, size: 0 }]
        : {},
    );
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: category }));
    fireEvent.click(screen.getByRole("button", { name: `新建${category}` }));
    fireEvent.change(screen.getByLabelText("文件名称"), { target: { value: category === "设定" ? "world" : "hud" } });
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: category } });
    fireEvent.change(screen.getByLabelText("Markdown 正文"), { target: { value: "## 内容" } });
    fireEvent.click(screen.getByRole("button", { name: category === "UI" ? "创建 UI" : `创建${category}` }));
    await waitFor(() => expect(api.saveDocument).toHaveBeenCalledWith("C:/Godot/lantern", path, expect.any(String), "absent"));
    const call = api.saveDocument.mock.calls[0]!;
    expect(parse(String(call[2]).split("---\n")[1] ?? "")).toMatchObject({ type, title: category, schemaVersion: 1 });
  });
  it("creates maps outside the legacy entity directory", async () => {
    const { api } = fixture({ project: true });
    api.tool.mockImplementation(async (_id, name, input) =>
      name === "files.list_versions"
        ? [{ path: (input.paths as string[])[0], version: "absent", exists: false, size: 0 }]
        : {},
    );
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "地图" }));
    fireEvent.click(screen.getByRole("button", { name: "新建地图" }));
    fireEvent.change(screen.getByLabelText("地图 ID"), { target: { value: "harbor" } });
    fireEvent.click(screen.getByRole("button", { name: "创建地图" }));
    await waitFor(() => expect(api.saveDocument).toHaveBeenCalledWith("C:/Godot/lantern", "specs/maps/harbor.md", expect.any(String), "absent"));
  });
  it("creates a task only after explicit immutable read/write scope confirmation", async () => {
    const { api } = fixture({ project: true });
    render(<App />);
    await screen.findByRole("heading", { name: "灯塔守望" });
    fireEvent.click(screen.getAllByRole("button", { name: "新建任务" })[0]!);
    const dialog = screen.getByRole("dialog", { name: "确认任务范围" });
    expect(within(dialog).getByLabelText("可读路径")).toHaveValue("*");
    expect(within(dialog).getByLabelText("可写路径")).toHaveValue("*");
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
  it("saves document edits in place without tasks or agent tools", async () => {
    const f = fixture({ project: true });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "规范" }));
    // The browser item appears after catalog loading; the initial file tree is replaced during loading.
    await waitFor(() => expect(screen.getByRole("button", { name: "查看 outline.md" })).toBeVisible(), { timeout: 5000 });
    fireEvent.click(screen.getByRole("button", { name: "查看 outline.md" }));
    const editor = await screen.findByLabelText("文档内容");
    fireEvent.change(editor, { target: { value: "# 大纲\n新增内容" } });
    fireEvent.click(screen.getByRole("button", { name: "保存资料" }));
    await waitFor(() => expect(f.api.saveDocument).toHaveBeenCalledWith("C:/Godot/lantern", "specs/outline.md", "# 大纲\n新增内容", version));
    expect(f.api.createTask).not.toHaveBeenCalled();
    expect(f.api.tool).not.toHaveBeenCalled();
    expect(screen.getByLabelText("文档内容")).toBeVisible();
  });
  it("routes model configuration through providers and hides the legacy model page", async () => {
    const f = fixture({ project: true });
    render(<App />);
    expect(screen.queryByRole("button", { name: /^模型$/ })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /^供应商$/ }));
    expect(await screen.findByRole("heading", { name: "供应商与模型" })).toBeVisible();
    expect(f.api.saveModel).not.toHaveBeenCalled();
  });
  it("persists a named entity immediately and keeps its management page open", async () => {
    const f = fixture({ project: true });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "实体" }));
    fireEvent.click(screen.getByRole("tab", { name: "详情" }));
    fireEvent.click(screen.getByRole("button", { name: "新建实体" }));
    const dialog = screen.getByRole("dialog", { name: "新建实体" });
    expect(within(dialog).getAllByRole("textbox")).toHaveLength(1);
    fireEvent.change(within(dialog).getByLabelText("名称"), { target: { value: "守灯人" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建实体" }));
    await waitFor(() => expect(f.api.saveDocument).toHaveBeenCalledOnce());
    const [, path, content, expectedVersion] = f.api.saveDocument.mock.calls[0]!;
    expect(expectedVersion).toBe("absent");
    expect(parse(content.split("---")[1]!)).toMatchObject({ id: path.split("/").pop()!.slice(0, -3), title: "守灯人", type: "entity", components: [] });
    expect(await screen.findByLabelText("名称")).toHaveValue("守灯人");
    expect(await screen.findByRole("button", { name: "查看 守灯人" })).toBeVisible();
    expect(f.api.createTask).not.toHaveBeenCalled();
    expect(f.api.agent).not.toHaveBeenCalled();
    expect(f.api.tool).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "保存资料" })).toBeDisabled();
  });
  it("adds parent, inheritance, and components to an entity after creating it", async () => {
    const f = fixture({ project: true });
    const definitions: Record<string, string> = {
      "specs/entities/weapon.md": "---\nid: weapon\ntitle: 武器\ntype: entity\nstatus: draft\nversion: 1\nrelations: []\nsource: developer\ncomponents: []\n---\n\n# 武器\n",
      "specs/entities/item_base.md": "---\nid: item_base\ntitle: 基础物品\ntype: entity\nstatus: draft\nversion: 1\nrelations: []\nsource: developer\ncomponents: []\n---\n\n# 基础物品\n",
      "specs/components/damage.md": "---\nschemaVersion: 1\nid: damage\ntitle: 伤害\ntype: component\ndescription: \"\"\nfields:\n  - key: amount\n    label: 伤害值\n    type: number\n    default: 10\n---\n\n# 伤害\n",
    };
    f.api.documents.mockResolvedValue(Object.entries(definitions).map(([path, content]) => ({ path, version, size: content.length })));
    f.api.projectTree.mockResolvedValue(Object.keys(definitions).map((path) => ({ path, kind: "file" })));
    f.api.readDocument.mockImplementation(async (path) => ({ path, version, content: definitions[path]! }));
    f.api.tool.mockImplementation(async (_id, name, input) =>
      name === "files.list_versions"
        ? [{ path: (input.paths as string[])[0], version: "absent", exists: false, size: 0 }]
        : {},
    );
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "实体" }));
    fireEvent.click(screen.getByRole("tab", { name: "详情" }));
    fireEvent.click(screen.getByRole("button", { name: "新建实体" }));
    const dialog = screen.getByRole("dialog", { name: "新建实体" });
    fireEvent.change(within(dialog).getByLabelText("名称"), { target: { value: "脉冲步枪" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建实体" }));
    const parent = await screen.findByLabelText("父级资料");
    await within(parent).findByRole("option", { name: "武器" });
    fireEvent.change(parent, { target: { value: "weapon" } });
    fireEvent.change(screen.getByLabelText("继承自"), { target: { value: "item_base" } });
    fireEvent.change(screen.getByLabelText("实体类型"), { target: { value: "item" } });
    const components = screen.getByLabelText("选择组件");
    await within(components).findByRole("option", { name: "伤害" });
    fireEvent.change(components, { target: { value: "damage" } });
    fireEvent.click(screen.getByRole("button", { name: "添加组件" }));
    fireEvent.change(screen.getByLabelText("伤害 · 伤害值"), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: "保存资料" }));
    await waitFor(() => expect(f.api.saveDocument).toHaveBeenCalledTimes(2));
    const content = f.api.saveDocument.mock.calls[1]![2];
    expect(parse(content.split("---")[1]!)).toMatchObject({ title: "脉冲步枪", parent: "weapon", extends: "item_base", type: "item", components: [{ id: "damage", values: { amount: 25 } }] });
  });
  it("uses a newly persisted component immediately and retains unsaved entity edits", async () => {
    const f = fixture({ project: true });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "实体" }));
    fireEvent.click(screen.getByRole("tab", { name: "详情" }));
    fireEvent.click(screen.getByRole("button", { name: "新建实体" }));
    let dialog = screen.getByRole("dialog", { name: "新建实体" });
    fireEvent.change(within(dialog).getByLabelText("名称"), { target: { value: "待配置的小怪" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建实体" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("说明"), { target: { value: "保留本地编辑" } });
    fireEvent.click(screen.getByRole("button", { name: "组件" }));
    fireEvent.click(screen.getByRole("button", { name: "新建组件" }));
    dialog = screen.getByRole("dialog", { name: "新建组件" });
    fireEvent.change(within(dialog).getByLabelText("组件模板"), { target: { value: "health" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建组件" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const componentId = (parse(f.api.saveDocument.mock.calls[1]![2].split("---")[1]!) as { id: string }).id;
    fireEvent.click(screen.getByRole("button", { name: "实体" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看 待配置的小怪" }));
    await waitFor(() => expect(screen.getByLabelText("说明")).toHaveValue("保留本地编辑"));
    const picker = screen.getByLabelText("选择组件");
    await within(picker).findByRole("option", { name: "生命值" });
    fireEvent.change(picker, { target: { value: componentId } });
    fireEvent.click(screen.getByRole("button", { name: "添加组件" }));
    fireEvent.click(screen.getByRole("button", { name: "保存资料" }));
    await waitFor(() => expect(f.api.saveDocument).toHaveBeenCalledTimes(3));
    expect(parse(f.api.saveDocument.mock.calls[2]![2].split("---")[1]!)).toMatchObject({ title: "待配置的小怪", description: "保留本地编辑", components: [{ id: componentId, values: { current: 100, max: 100 } }] });
    expect(f.api.createTask).not.toHaveBeenCalled();
    expect(f.api.approve).not.toHaveBeenCalled();
  });
  it("retains edits to a saved entity when leaving materials for the workspace", async () => {
    const f = fixture({ project: true });
    const path = "specs/entities/hero.md";
    const content = "---\nid: hero\ntitle: 守灯人\ntype: entity\nstatus: draft\nversion: 1\nrelations: []\nsource: developer\ncomponents: []\n---\n\n# 守灯人\n";
    f.api.documents.mockResolvedValue([{ path, version, size: content.length }]);
    f.api.projectTree.mockResolvedValue([{ path, kind: "file" }]);
    f.api.readDocument.mockResolvedValue({ path, version, content });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "实体" }));
    fireEvent.click(screen.getByRole("tab", { name: "详情" }));
    fireEvent.click(screen.getByRole("button", { name: "项目树" }));
    fireEvent.click(await within(screen.getByRole("tree", { name: "实体关系树" })).findByRole("button", { name: "守灯人" }));
    const name = await screen.findByLabelText("名称");
    fireEvent.change(name, { target: { value: "受伤的守灯人" } });
    fireEvent.change(screen.getByLabelText("说明"), { target: { value: "在战斗后撤回灯塔" } });
    fireEvent.click(screen.getByRole("button", { name: "工作区" }));
    fireEvent.click(screen.getByRole("button", { name: "实体" }));
    fireEvent.click(await within(screen.getByRole("tree", { name: "实体关系树" })).findByRole("button", { name: "受伤的守灯人" }));
    await waitFor(() => expect(screen.getByLabelText("名称")).toHaveValue("受伤的守灯人"));
    expect(screen.getByLabelText("说明")).toHaveValue("在战斗后撤回灯塔");
    expect(f.api.createTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存资料" }));
    await waitFor(() => expect(f.api.saveDocument).toHaveBeenCalledWith("C:/Godot/lantern", path, expect.any(String), version));
    const write = f.api.saveDocument.mock.calls[0]!;
    expect(parse(String(write[2]).split("---")[1]!)).toMatchObject({ title: "受伤的守灯人", description: "在战斗后撤回灯塔" });
  });
  it("protects unstaged material edits when returning to the launcher", async () => {
    const f = fixture({ project: true });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "实体" }));
    fireEvent.click(screen.getByRole("tab", { name: "详情" }));
    fireEvent.click(screen.getByRole("button", { name: "新建实体" }));
    const creation = screen.getByRole("dialog", { name: "新建实体" });
    fireEvent.change(within(creation).getByLabelText("名称"), { target: { value: "未完成的哥布林" } });
    fireEvent.click(within(creation).getByRole("button", { name: "创建实体" }));
    await waitFor(() => expect(screen.getByLabelText("名称")).toHaveValue("未完成的哥布林"));
    fireEvent.change(screen.getByLabelText("说明"), { target: { value: "尚未保存的编辑" } });
    fireEvent.click(screen.getByRole("button", { name: "工作区" }));
    const unloading = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unloading);
    expect(unloading.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "返回初始界面" }));
    const warning = screen.getByRole("dialog", { name: "未保存的资料修改" });
    expect(f.api.closeProject).not.toHaveBeenCalled();
    fireEvent.click(within(warning).getByRole("button", { name: "继续编辑" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(f.api.closeProject).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "返回初始界面" }));
    fireEvent.click(screen.getByRole("button", { name: "返回初始界面并丢弃修改" }));
    await screen.findByRole("button", { name: "创建示例项目" });
    expect(f.api.closeProject).toHaveBeenCalledOnce();
    await waitFor(() => {
      const afterSwitch = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(afterSwitch);
      expect(afterSwitch.defaultPrevented).toBe(false);
    });
  });
  it("recovers an edited entity after a version conflict by confirming a fresh read", async () => {
    const f = fixture({ project: true });
    const path = "specs/entities/hero.md";
    const latestVersion = `sha256:${"b".repeat(64)}` as const;
    const original = "---\nid: hero\ntitle: 守灯人\ntype: entity\nstatus: draft\nversion: 1\nrelations: []\nsource: developer\ncomponents: []\n---\n\n# 守灯人\n";
    const latest = original.replace("title: 守灯人", "title: 外部更新的守灯人");
    let changed = false;
    f.api.documents.mockImplementation(async () => [{ path, version: changed ? latestVersion : version, size: original.length }]);
    f.api.projectTree.mockResolvedValue([{ path, kind: "file" }]);
    f.api.readDocument.mockImplementation(async () => ({ path, version: changed ? latestVersion : version, content: changed ? latest : original }));
    f.api.saveDocument.mockImplementation(async (_root, savedPath, content, expectedVersion) => {
      if (expectedVersion !== latestVersion) throw Object.assign(new Error("文档已变化，请重新读取后再保存"), { code: "VERSION_CONFLICT", details: { path } });
      return { path: savedPath, content, version: latestVersion };
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "实体" }));
    fireEvent.click(screen.getByRole("tab", { name: "详情" }));
    fireEvent.click(screen.getByRole("button", { name: "项目树" }));
    fireEvent.click(await within(screen.getByRole("tree", { name: "实体关系树" })).findByRole("button", { name: "守灯人" }));
    await screen.findByLabelText("名称");
    await waitFor(() => expect(screen.getByLabelText("说明")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("说明"), { target: { value: "未暂存的本地修改" } });
    changed = true;
    fireEvent.click(screen.getByRole("button", { name: "保存资料" }));
    await screen.findByText("文档已变化，请重新读取后再保存");
    fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
    let confirmation = screen.getByRole("dialog", { name: "重新读取资料" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "继续编辑" }));
    expect(screen.getByLabelText("说明")).toHaveValue("未暂存的本地修改");
    fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
    confirmation = screen.getByRole("dialog", { name: "重新读取资料" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "丢弃修改并重新读取" }));
    await waitFor(() => expect(screen.getByLabelText("名称")).toHaveValue("外部更新的守灯人"));
    expect(screen.getByLabelText("说明")).toHaveValue("");
    expect(f.api.readDocument).toHaveBeenCalledWith(path, latestVersion);
    // The new content can render before the catalog finishes refreshing.
    await waitFor(() => expect(screen.getByLabelText("说明")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("说明"), { target: { value: "基于最新版本继续编辑" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "保存资料" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "保存资料" }));
    await waitFor(() => expect(f.api.saveDocument).toHaveBeenLastCalledWith("C:/Godot/lantern", path, expect.any(String), latestVersion));
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
