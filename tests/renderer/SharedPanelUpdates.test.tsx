// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { HooksView } from "../../src/renderer/ToolsViews";
import { McpView } from "../../src/renderer/SettingsViews";
import { SkillsView } from "../../src/renderer/SkillsView";
import type { DesktopApi, HooksApi, McpConfigApi, SkillsApi } from "../../src/shared/desktop-api";
import type { ManagedSkill } from "../../src/shared/skill-management";
import type { HookDefinition } from "../../src/shared/hooks";
import type { ManagedMcpServer } from "../../src/shared/mcp-config";
import type { ChatSessionsApi } from "../../src/shared/chat";
import { fixture } from "./fixtures";

afterEach(() => { cleanup(); localStorage.clear(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(release => { resolve = release; });
  return { promise, resolve };
}
function bridge(extra: Partial<DesktopApi>) {
  const listeners = new Set<() => void>();
  const api: DesktopApi = { ...fixture().api, ...extra, onStateChanged: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
  return { api, listeners, notify() { act(() => { for (const listener of listeners) listener(); }); } };
}
const hook = (name: string): HookDefinition => ({ id: name, name, event: "session.before", command: "echo ready", timeoutMs: 30000, enabled: true, updatedAt: "1" });
const server = (name: string): ManagedMcpServer => ({ name, scope: "global", config: { command: "node", enabled: true } });
const skill = (id: string): ManagedSkill => ({ id, name: id, purpose: "项目工作流", enabled: true, source: "directory", installedAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" });

test("peer Hook updates refresh the list without changing the Hook form draft", async () => {
  const hooks: HooksApi = { list: vi.fn(async () => [hook("原有 Hook")]), save: vi.fn(), remove: vi.fn(), setEnabled: vi.fn(), test: vi.fn() };
  const f = bridge({ hooks }); const onError = vi.fn();
  const view = render(<HooksView api={f.api} onError={onError} />);
  await screen.findByRole("heading", { name: "原有 Hook" });
  const command = screen.getByLabelText("命令"); fireEvent.change(command, { target: { value: "echo my unsaved command" } });
  fireEvent.change(screen.getByLabelText("名称"), { target: { value: "未保存 Hook" } });
  vi.mocked(hooks.list).mockResolvedValue([hook("同伴新增 Hook")]);
  act(() => { f.notify(); f.notify(); });
  await screen.findByRole("heading", { name: "同伴新增 Hook" });
  expect(hooks.list).toHaveBeenCalledTimes(2); expect(screen.queryByText("原有 Hook")).not.toBeInTheDocument();
  expect(screen.getByLabelText("命令")).toBe(command); expect(command).toHaveValue("echo my unsaved command");
  expect(screen.getByLabelText("名称")).toHaveValue("未保存 Hook"); expect(onError).not.toHaveBeenCalled();
  view.unmount(); expect(f.listeners.size).toBe(0);
});

test("an older Hook list response cannot replace a newer peer refresh", async () => {
  const initial = deferred<HookDefinition[]>();
  const hooks: HooksApi = { list: vi.fn(async () => [hook("最新 Hook")]), save: vi.fn(), remove: vi.fn(), setEnabled: vi.fn(), test: vi.fn() };
  vi.mocked(hooks.list).mockImplementationOnce(() => initial.promise);
  const f = bridge({ hooks }); render(<HooksView api={f.api} onError={vi.fn()} />);
  f.notify(); await screen.findByRole("heading", { name: "最新 Hook" });
  await act(async () => initial.resolve([hook("过期 Hook")]));
  expect(screen.getByRole("heading", { name: "最新 Hook" })).toBeVisible(); expect(screen.queryByText("过期 Hook")).not.toBeInTheDocument();
});

test("peer MCP updates refresh configuration while retaining the open unsaved server form", async () => {
  const config: McpConfigApi = { list: vi.fn(async () => [server("original")]), save: vi.fn(), remove: vi.fn(), setEnabled: vi.fn(), test: vi.fn() };
  const f = bridge({ mcpConfig: config });
  const view = render(<McpView connection={undefined} task={undefined} configApi={config} projectPath="P" onStateChanged={f.api.onStateChanged} onError={vi.fn()} />);
  await screen.findByRole("heading", { name: "original" }); fireEvent.click(screen.getByRole("button", { name: "添加 MCP" }));
  const command = screen.getByLabelText("启动命令");
  fireEvent.change(screen.getByLabelText("服务名称"), { target: { value: "unsaved-server" } });
  fireEvent.change(command, { target: { value: "node my-pending-server.js" } });
  fireEvent.change(screen.getByLabelText("参数（每行一个）"), { target: { value: "--my-pending-flag" } });
  vi.mocked(config.list).mockResolvedValue([server("peer-server")]); act(() => { f.notify(); f.notify(); });
  await screen.findByRole("heading", { name: "peer-server" }); expect(config.list).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("heading", { name: "original" })).not.toBeInTheDocument();
  expect(screen.getByLabelText("启动命令")).toBe(command); expect(command).toHaveValue("node my-pending-server.js");
  expect(screen.getByLabelText("服务名称")).toHaveValue("unsaved-server"); expect(screen.getByLabelText("参数（每行一个）")).toHaveValue("--my-pending-flag");
  view.unmount(); expect(f.listeners.size).toBe(0);
});

test("MCP ignores an older initial list after a newer peer configuration refresh", async () => {
  const initial = deferred<ManagedMcpServer[]>();
  const config: McpConfigApi = { list: vi.fn(async () => [server("latest")]), save: vi.fn(), remove: vi.fn(), setEnabled: vi.fn(), test: vi.fn() };
  vi.mocked(config.list).mockImplementationOnce(() => initial.promise);
  const f = bridge({ mcpConfig: config });
  render(<McpView connection={undefined} task={undefined} configApi={config} projectPath="P" onStateChanged={f.api.onStateChanged} onError={vi.fn()} />);
  f.notify(); await screen.findByRole("heading", { name: "latest" });
  await act(async () => initial.resolve([server("stale")]));
  expect(screen.getByRole("heading", { name: "latest" })).toBeVisible(); expect(screen.queryByText("stale")).not.toBeInTheDocument();
});

function managedSkills() {
  return { list: vi.fn(async () => [skill("global-old")]), listProject: vi.fn(async () => [skill("project-old")]), installDirectory: vi.fn(), selectDirectory: vi.fn(async () => "C:/skills/new"), installArchive: vi.fn(), installProjectDirectory: vi.fn(), setProjectEnabled: vi.fn(), removeProject: vi.fn(), refresh: vi.fn(), setEnabled: vi.fn(), remove: vi.fn() } satisfies SkillsApi;
}
const sessions = { list: vi.fn(async () => []), subscribe: vi.fn(() => () => undefined) } as unknown as ChatSessionsApi;

test("peer managed Skills changes refresh both inventories while a local installation is pending", async () => {
  const skills = managedSkills(); const installation = deferred<ManagedSkill>(); skills.installDirectory.mockImplementationOnce(() => installation.promise);
  const f = bridge({ skills, sessions });
  const view = render(<SkillsView api={f.api} task={undefined} projectPath="P" onNewTask={vi.fn()} onError={vi.fn()} />);
  await screen.findByRole("heading", { name: "project-old" }); await screen.findByText("global-old", { selector: "strong" });
  fireEvent.click(screen.getByRole("button", { name: "安装本地 Skill" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "安装本地 Skill" })).toBeDisabled());
  skills.list.mockResolvedValue([skill("global-peer")]); skills.listProject.mockResolvedValue([skill("project-peer")]);
  act(() => { f.notify(); f.notify(); });
  await screen.findByRole("heading", { name: "project-peer" }); await screen.findByText("global-peer", { selector: "strong" });
  expect(skills.list).toHaveBeenCalledTimes(2); expect(skills.listProject).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("button", { name: "安装本地 Skill" })).toBeDisabled();
  await act(async () => installation.resolve(skill("my-install")));
  expect(screen.getByRole("button", { name: "安装本地 Skill" })).toBeEnabled();
  view.unmount(); expect(f.listeners.size).toBe(0);
});

test("managed Skills ignore older global and project reads after a peer refresh", async () => {
  const global = deferred<ManagedSkill[]>(); const project = deferred<ManagedSkill[]>(); const skills = managedSkills();
  skills.list.mockImplementationOnce(() => global.promise).mockResolvedValue([skill("global-current")]);
  skills.listProject.mockImplementationOnce(() => project.promise).mockResolvedValue([skill("project-current")]);
  const f = bridge({ skills, sessions });
  render(<SkillsView api={f.api} task={undefined} projectPath="P" onNewTask={vi.fn()} onError={vi.fn()} />);
  f.notify(); await screen.findByRole("heading", { name: "project-current" }); await screen.findByText("global-current", { selector: "strong" });
  await act(async () => { global.resolve([skill("global-stale")]); project.resolve([skill("project-stale")]); });
  expect(screen.getByRole("heading", { name: "project-current" })).toBeVisible(); expect(screen.getByText("global-current", { selector: "strong" })).toBeVisible();
  expect(screen.queryByText("global-stale")).not.toBeInTheDocument(); expect(screen.queryByText("project-stale")).not.toBeInTheDocument();
});
