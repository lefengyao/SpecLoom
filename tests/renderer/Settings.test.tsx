// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import App from "../../src/renderer/App";
import { SettingsView } from "../../src/renderer/SettingsViews";
import { defaultPreferences } from "../../src/shared/preferences";
import { fixture } from "./fixtures";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  const root = document.documentElement;
  root.removeAttribute("data-theme");
  root.removeAttribute("data-style");
  root.style.removeProperty("--accent-base");
  Object.defineProperty(window, "specloom", {
    configurable: true,
    value: undefined,
  });
});

async function openSettings(options: Parameters<typeof fixture>[0] = {}) {
  const harness = fixture(options);
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "设置" }));
  await screen.findByRole("heading", { name: "设置" });
  return harness;
}

async function openAgentSettings(options: Parameters<typeof fixture>[0] = {}) {
  const harness = await openSettings(options);
  fireEvent.click(screen.getByRole("button", { name: "智能体" }));
  return harness;
}

function selectSettingsSection(label: "外观" | "个性化" | "外部工具" | "智能体") {
  fireEvent.click(screen.getByRole("button", { name: label }));
}

describe("application settings", () => {
  it("disables the project prompt editor without a project and does not read project files", async () => {
    const { api } = await openAgentSettings();
    selectSettingsSection("智能体");
    expect(screen.getByRole("textbox", { name: "当前项目提示词" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存项目提示词" })).toBeDisabled();
    expect(api.readWorkspacePrompt).not.toHaveBeenCalled();
  });

  it("loads and saves the current project prompt separately from global preferences", async () => {
    const { api } = await openAgentSettings({ project: true, workspacePrompt: "项目原有要求" });
    selectSettingsSection("智能体");
    const editor = screen.getByRole("textbox", { name: "当前项目提示词" });
    await waitFor(() => expect(editor).toHaveValue("项目原有要求"));
    expect(editor).toHaveAttribute("maxlength", "16000");
    fireEvent.change(editor, { target: { value: "新的项目要求" } });
    fireEvent.click(screen.getByRole("button", { name: "保存项目提示词" }));
    await waitFor(() => expect(api.saveWorkspacePrompt).toHaveBeenCalledWith("C:/Godot/lantern", "新的项目要求", expect.stringMatching(/^sha256:/)));
    await screen.findByText("项目提示词已保存");
    expect(api.updatePreferences).not.toHaveBeenCalled();
    expect(api.createTask).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "保存项目提示词" })).toBeDisabled();
  });

  it("preserves the project draft and shows an actionable error after a failed save", async () => {
    const { api } = await openAgentSettings({ project: true });
    selectSettingsSection("智能体");
    const editor = screen.getByRole("textbox", { name: "当前项目提示词" });
    await waitFor(() => expect(editor).toBeEnabled());
    api.saveWorkspacePrompt.mockRejectedValueOnce(Object.assign(new Error("外部文件已修改，请重新加载后保存"), { code: "VERSION_CONFLICT" }));
    fireEvent.change(editor, { target: { value: "需要保留的草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "保存项目提示词" }));
    await screen.findByText(/外部文件已修改，请重新加载后保存/);
    expect(editor).toHaveValue("需要保留的草稿");
    expect(screen.getByRole("button", { name: "保存项目提示词" })).toBeEnabled();
  });

  it("keeps editing disabled after a read failure and allows a reload", async () => {
    const harness = fixture({ project: true });
    harness.api.readWorkspacePrompt.mockRejectedValueOnce(new Error("读取失败"));
    render(<App />);
    await screen.findByRole("heading", { name: "灯塔守望" });
    fireEvent.click(screen.getAllByRole("button", { name: "设置" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "智能体" }));
    selectSettingsSection("智能体");
    await screen.findByText(/读取失败/);
    expect(screen.getByRole("textbox", { name: "当前项目提示词" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "重新加载项目提示词" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "当前项目提示词" })).toBeEnabled());
  });

  it("ignores the previous project's delayed load after switching projects", async () => {
    const harness = fixture({ project: true });
    const firstProject = harness.state().project!;
    let resolve!: (result: Awaited<ReturnType<typeof harness.api.readWorkspacePrompt>>) => void;
    harness.api.readWorkspacePrompt.mockImplementationOnce(() => new Promise((fulfill) => { resolve = fulfill; }));
    harness.api.readWorkspacePrompt.mockResolvedValueOnce({ path: "specs/prompts/system-prompt.md", version: "absent", content: "项目 B 要求" });
    const view = render(<SettingsView preferences={defaultPreferences} busy={false} api={harness.api} project={firstProject} onUpdate={async () => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "智能体" }));
    selectSettingsSection("智能体");
    view.rerender(<SettingsView preferences={defaultPreferences} busy={false} api={harness.api} project={{ ...firstProject, path: "C:/Godot/project-b", name: "项目 B" }} onUpdate={async () => undefined} />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "当前项目提示词" })).toHaveValue("项目 B 要求"));
    resolve({ path: "specs/prompts/system-prompt.md", version: "absent", content: "过期项目 A 要求" });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "当前项目提示词" })).toHaveValue("项目 B 要求"));
    expect(harness.api.readWorkspacePrompt.mock.calls.map(([root]) => root)).toEqual([firstProject.path, "C:/Godot/project-b"]);
  });

  it("ignores a previous project's save completion after switching projects", async () => {
    const harness = fixture({ project: true });
    const firstProject = harness.state().project!;
    let resolve!: (result: Awaited<ReturnType<typeof harness.api.saveWorkspacePrompt>>) => void;
    harness.api.saveWorkspacePrompt.mockImplementationOnce(() => new Promise((fulfill) => { resolve = fulfill; }));
    const view = render(<SettingsView preferences={defaultPreferences} busy={false} api={harness.api} project={firstProject} onUpdate={async () => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "智能体" }));
    selectSettingsSection("智能体");
    await waitFor(() => expect(screen.getByRole("textbox", { name: "当前项目提示词" })).toBeEnabled());
    fireEvent.change(screen.getByRole("textbox", { name: "当前项目提示词" }), { target: { value: "项目 A 草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "保存项目提示词" }));
    harness.api.readWorkspacePrompt.mockResolvedValueOnce({ path: "specs/prompts/system-prompt.md", version: "absent", content: "项目 B 要求" });
    view.rerender(<SettingsView preferences={defaultPreferences} busy={false} api={harness.api} project={{ ...firstProject, path: "C:/Godot/project-b" }} onUpdate={async () => undefined} />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "当前项目提示词" })).toHaveValue("项目 B 要求"));
    resolve({ path: "specs/prompts/system-prompt.md", version: "absent", content: "项目 A 草稿" });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "当前项目提示词" })).toHaveValue("项目 B 要求"));
    expect(screen.queryByText("项目提示词已保存")).not.toBeInTheDocument();
  });

  it("opens before any project is loaded so the theme can be chosen up front", async () => {
    await openSettings();
    expect(screen.getByRole("radiogroup", { name: "外观模式" })).toBeVisible();
    expect(screen.getByRole("radiogroup", { name: "主题色" })).toBeVisible();
    expect(screen.getByRole("radiogroup", { name: "界面风格" })).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "项目视图" })).not.toBeInTheDocument();
  });

  it("switches setting sections from the top navigation", async () => {
    await openSettings();
    const navigation = screen.getByRole("navigation", { name: "设置分区" });
    expect(navigation).toBeVisible();
    expect(screen.getByRole("region", { name: "外观" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "个性化" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "个性化" }));
    expect(screen.getByRole("region", { name: "个性化" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "外观" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "个性化" })).toHaveAttribute("aria-current", "page");
  });

  it("exposes configured external tools from their settings section", async () => {
    const { api } = await openAgentSettings();
    fireEvent.click(screen.getByRole("button", { name: "外部工具" }));
    expect(screen.getByRole("heading", { name: "外部工具" })).toBeVisible();
    const godot = screen.getByRole("textbox", { name: "Godot 可执行文件" });
    fireEvent.change(godot, { target: { value: "C:/Godot/Godot.exe" } });
    fireEvent.click(screen.getByRole("button", { name: "保存外部工具路径" }));
    await waitFor(() => expect(api.updatePreferences).toHaveBeenCalledWith({ godotPath: "C:/Godot/Godot.exe", externalEditorPath: "" }));
  });

  it("returns to the workspace from project settings and opens configured tools", async () => {
    const { api } = await openSettings({ project: true });
    fireEvent.click(screen.getByRole("button", { name: "返回工作区" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "灯塔守望" })).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: "打开 Godot" }));
    fireEvent.click(screen.getByRole("button", { name: "打开外部编辑器" }));
    expect(api.openGodot).toHaveBeenCalledOnce();
    expect(api.openExternalEditor).toHaveBeenCalledOnce();
  });

  it("applies and persists the appearance mode, accent color and interface style", async () => {
    const { api } = await openSettings();
    fireEvent.click(screen.getByRole("radio", { name: "深色" }));
    await waitFor(() =>
      expect(api.updatePreferences).toHaveBeenCalledWith({ theme: "dark" }),
    );
    await waitFor(() =>
      expect(document.documentElement.dataset.theme).toBe("dark"),
    );

    fireEvent.click(screen.getByRole("radio", { name: "靛蓝" }));
    await waitFor(() =>
      expect(api.updatePreferences).toHaveBeenCalledWith({ accent: "indigo" }),
    );
    await waitFor(() =>
      expect(
        document.documentElement.style.getPropertyValue("--accent-base"),
      ).toBe("#3a5fc8"),
    );

    fireEvent.click(screen.getByRole("radio", { name: "紧凑" }));
    await waitFor(() =>
      expect(api.updatePreferences).toHaveBeenCalledWith({ style: "compact" }),
    );
    await waitFor(() =>
      expect(document.documentElement.dataset.style).toBe("compact"),
    );

    fireEvent.click(screen.getByRole("radio", { name: "纸墨" }));
    await waitFor(() =>
      expect(api.updatePreferences).toHaveBeenCalledWith({ theme: "paper" }),
    );
    await waitFor(() =>
      expect(document.documentElement.dataset.theme).toBe("paper"),
    );
  });

  it("reflects a stored appearance mode on first paint", async () => {
    await openSettings({ preferences: { theme: "dark", accent: "amber" } });
    await waitFor(() =>
      expect(document.documentElement.dataset.theme).toBe("dark"),
    );
    expect(
      document.documentElement.style.getPropertyValue("--accent-base"),
    ).toBe("#b0761b");
    expect(screen.getByRole("radio", { name: "深色" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("stores the agent reply chime and the custom instructions", async () => {
    const { api } = await openSettings();
    selectSettingsSection("智能体");
    const chime = screen.getByRole("switch", { name: "回复完成提示音" });
    expect(chime).toHaveAttribute("aria-checked", "true");
    fireEvent.click(chime);
    await waitFor(() =>
      expect(api.updatePreferences).toHaveBeenCalledWith({
        completionSound: false,
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "回复完成提示音" }),
      ).toHaveAttribute("aria-checked", "false"),
    );

    const prompt = screen.getByRole("textbox", { name: "智能体自定义提示词" });
    const save = screen.getByRole("button", { name: "保存提示词" });
    expect(save).toBeDisabled();
    fireEvent.change(prompt, { target: { value: "回答先给结论；注释用中文。" } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() =>
      expect(api.updatePreferences).toHaveBeenCalledWith({
        customInstructions: "回答先给结论；注释用中文。",
      }),
    );
  });

  it("stores the agent stability preference slider value", async () => {
    const { api } = await openSettings();
    selectSettingsSection("智能体");
    const slider = screen.getByLabelText("智能体稳定性偏好") as HTMLInputElement;
    expect(slider.value).toBe("50");
    fireEvent.change(slider, { target: { value: "80" } });
    await waitFor(() => expect(api.updatePreferences).toHaveBeenCalledWith({ agentTemperature: 80 }));
  });

  it("restores every preference to its default in one action", async () => {
    const { api } = await openAgentSettings({
      preferences: {
        theme: "dark",
        accent: "rose",
        style: "compact",
        completionSound: false,
        customInstructions: "旧提示词",
      },
    });
    selectSettingsSection("智能体");
    fireEvent.click(screen.getByRole("button", { name: "恢复默认设置" }));
    await waitFor(() =>
      expect(api.updatePreferences).toHaveBeenCalledWith({ ...defaultPreferences, userAvatar: "", assistantAvatar: "" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "智能体自定义提示词" })).toHaveValue(
        "",
      ),
    );
  });

  it("keeps the settings tab inside the project shell too", async () => {
    await openSettings({ project: true });
    expect(screen.getByRole("navigation", { name: "项目视图" })).toBeVisible();
    fireEvent.click(screen.getByRole("radio", { name: "浅色" }));
    fireEvent.click(screen.getByRole("radio", { name: "石墨" }));
    expect(screen.getByRole("navigation", { name: "项目视图" })).toBeVisible();
    expect(
      screen
        .getAllByRole("button", { name: "设置" })
        .some((button) => button.getAttribute("aria-current") === "page"),
    ).toBe(true);
  });

  it("offers deleting finished history entries", async () => {
    const { api } = await openSettings({ project: true, tasks: true, finishedTask: true });
    fireEvent.click(screen.getByRole("button", { name: "历史" }));
    await screen.findByRole("heading", { name: "历史" });
    fireEvent.click(screen.getByRole("button", { name: "删除任务 守灯人移动" }));
    await waitFor(() => expect(api.removeTask).toHaveBeenCalledWith("task-1"));
  });
});

