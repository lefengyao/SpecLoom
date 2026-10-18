// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi, PluginManagementApi } from "../../src/shared/desktop-api";
import type { ProjectMetadata } from "../../src/shared/contracts";
import { PluginManagementView } from "../../src/renderer/PluginManagementView";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const project: ProjectMetadata = {
  schemaVersion: 1,
  name: "灯塔守望",
  description: "探索海岛",
  path: "C:/Godot/lantern",
  godot: { configVersion: 5, features: ["4.7.1"], mainScene: "res://main.tscn" },
  engine: "godot",
};
const inventory = {
  godotMcp: { status: "missing" as const, enabled: false, connected: false },
  scanLimitReached: false,
  plugins: [
    { id: "addons/dialogue/plugin.cfg", name: "Dialogue Manager", description: "Dialogue graph editor", author: "Trailblazer", version: "3.1.0", enabled: true, metadataValid: true },
    { id: "addons/texture/plugin.cfg", name: "Texture Atlas", description: "Preview texture atlases", version: "1.2.0", enabled: false, metadataValid: true },
    { id: "addons/missing/plugin.cfg", name: "missing", enabled: true, metadataValid: false, issue: "missing_config" as const },
  ],
};
function apiFixture(): { api: DesktopApi; manager: PluginManagementApi } {
  const manager: PluginManagementApi = {
    list: vi.fn(async () => structuredClone(inventory)),
    setGodotPluginEnabled: vi.fn(async () => ({ restartRequired: true })),
    setGodotMcpEnabled: vi.fn(async () => ({ restartRequired: true })),
    installGodotMcp: vi.fn(async () => ({ restartRequired: true, installedVersion: "1.1.0", changedPaths: [] })),
    revealDirectory: vi.fn(async () => undefined),
  };
  return { api: { pluginManagement: manager } as unknown as DesktopApi, manager };
}

describe("PluginManagementView", () => {
  it("shows the official Godot MCP separately and filters project plugins by metadata and status", async () => {
    const { api } = apiFixture();
    render(<PluginManagementView api={api} project={project} onError={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "SpecLoom Godot MCP" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Godot 项目插件" })).toBeVisible();
    expect(screen.getByText("Dialogue Manager")).toBeVisible();
    expect(screen.getByText("missing")).toBeVisible();

    fireEvent.change(screen.getByPlaceholderText("搜索名称、说明、作者或目录"), { target: { value: "Trailblazer" } });
    expect(screen.getByText("Dialogue Manager")).toBeVisible();
    expect(screen.queryByText("Texture Atlas")).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("搜索名称、说明、作者或目录"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "已禁用" }));
    expect(screen.getByText("Texture Atlas")).toBeVisible();
    expect(screen.queryByText("Dialogue Manager")).not.toBeInTheDocument();
  });

  it("confirms before installing, reveals only plugin identifiers, and explains reload requirements", async () => {
    const { api, manager } = apiFixture();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<PluginManagementView api={api} project={project} onError={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "安装并启用" }));
    await waitFor(() => expect(manager.installGodotMcp).toHaveBeenCalledOnce());
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("把插件代码写入当前 Godot 项目的 addons/ 目录并启用它"));
    expect(await screen.findByRole("status")).toHaveTextContent("重新载入 Godot");
    fireEvent.click(screen.getByRole("button", { name: "定位 Dialogue Manager 目录" }));
    await waitFor(() => expect(manager.revealDirectory).toHaveBeenCalledWith("addons/dialogue/plugin.cfg"));
  });

  it("does not call installation when the user cancels confirmation", async () => {
    const { api, manager } = apiFixture();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<PluginManagementView api={api} project={project} onError={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "安装并启用" }));
    expect(manager.installGodotMcp).not.toHaveBeenCalled();
  });

  it("toggles an installed project plugin and disables malformed entries only in the off direction", async () => {
    const { api, manager } = apiFixture();
    render(<PluginManagementView api={api} project={project} onError={vi.fn()} />);
    fireEvent.click(await screen.findByRole("switch", { name: "禁用 Dialogue Manager" }));
    await waitFor(() => expect(manager.setGodotPluginEnabled).toHaveBeenCalledWith("addons/dialogue/plugin.cfg", false));
    expect(await screen.findByRole("status")).toHaveTextContent("重新载入 Godot");
    fireEvent.click(screen.getByRole("switch", { name: "禁用 missing" }));
    await waitFor(() => expect(manager.setGodotPluginEnabled).toHaveBeenCalledWith("addons/missing/plugin.cfg", false));
  });

  it("shows a clear non-Godot state without querying the project plugin inventory", async () => {
    const { api, manager } = apiFixture();
    render(<PluginManagementView api={api} project={{ ...project, engine: "generic" }} onError={vi.fn()} />);
    expect(await screen.findByText(/仅适用于 Godot 项目/)).toBeVisible();
    expect(manager.list).not.toHaveBeenCalled();
  });
});
