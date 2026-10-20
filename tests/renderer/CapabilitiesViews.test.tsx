// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { SkillsView } from "../../src/renderer/SkillsView";
import { McpView } from "../../src/renderer/SettingsViews";
import type { ChatSession, ChatSessionsApi } from "../../src/shared/chat";
import type { PluginManagementApi, SkillsApi } from "../../src/shared/desktop-api";
import type { ManagedSkill } from "../../src/shared/skill-management";
import type { PluginInventory } from "../../src/shared/godot-plugins";
import { fixture } from "./fixtures";
import App from "../../src/renderer/App";

afterEach(() => { cleanup(); window.localStorage.clear(); });
function sessionApi() {
  const record: ChatSession = { id: "session", title: "项目会话", createdAt: "1", updatedAt: "1", archived: false, draft: "", draftRevision: 0, revision: 1, seq: 0, status: "idle", items: [], capabilities: { tools: [], skills: [{ id: "scene-review", name: "场景审查", purpose: "检查场景依赖" }], mcp: [{ name: "资料库", status: "connected", tools: ["mcp_docs_read"] }, { name: "外部服务", status: "error", tools: [], error: "服务器离线" }], plugins: [] } };
  const api: ChatSessionsApi = { list: vi.fn(async () => [record]), create: vi.fn(async () => record), patch: vi.fn(async () => record), remove: vi.fn(async () => undefined), export: vi.fn(async () => "{}"), import: vi.fn(async () => record), send: vi.fn(async () => record), guide: vi.fn(async () => record), cancel: vi.fn(async () => undefined), answer: vi.fn(async () => record), approve: vi.fn(async () => record), subscribe: vi.fn(() => () => undefined) };
  return { api, record };
}

function projectSkill(id: string, name: string): ManagedSkill {
  return { id, name, purpose: "项目工作流", enabled: true, source: "directory", installedAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" };
}

function skillsApi(): SkillsApi {
  return { list: vi.fn(async () => []), listProject: vi.fn(async () => [projectSkill("project-context", "项目上下文")]), installDirectory: vi.fn(), installArchive: vi.fn(), installProjectDirectory: vi.fn(), setProjectEnabled: vi.fn(), removeProject: vi.fn(), refresh: vi.fn(), setEnabled: vi.fn(), remove: vi.fn() };
}

test("lists project Skills before any chat exists and refreshes from project files", async () => {
  const sessions = sessionApi(); vi.mocked(sessions.api.list).mockResolvedValue([]);
  const skills = skillsApi(); const api = Object.assign(fixture({ project: true }).api, { sessions: sessions.api, skills });
  render(<SkillsView api={api} projectPath="P" task={undefined} onError={vi.fn()} onNewTask={vi.fn()} />);
  expect(await screen.findByRole("heading", { name: "项目上下文" })).toBeVisible();
  expect(skills.listProject).toHaveBeenCalledWith("P");
  expect(screen.queryByText("新建会话后可查看项目 Skills 清单。")).not.toBeInTheDocument();
  vi.mocked(skills.listProject).mockResolvedValue([projectSkill("new-workflow", "新增工作流")]);
  fireEvent.click(screen.getByRole("button", { name: "刷新 Skills" }));
  expect(await screen.findByRole("heading", { name: "新增工作流" })).toBeVisible();
  expect(screen.queryByRole("heading", { name: "项目上下文" })).not.toBeInTheDocument();
});

test("ignores project Skills returned after switching projects", async () => {
  const sessions = sessionApi(); vi.mocked(sessions.api.list).mockResolvedValue([]);
  const skills = skillsApi(); const api = Object.assign(fixture({ project: true }).api, { sessions: sessions.api, skills });
  let resolve!: (records: ManagedSkill[]) => void;
  vi.mocked(skills.listProject).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const view = render(<SkillsView api={api} projectPath="old" task={undefined} onError={vi.fn()} onNewTask={vi.fn()} />);
  view.rerender(<SkillsView api={api} projectPath="new" task={undefined} onError={vi.fn()} onNewTask={vi.fn()} />);
  await screen.findByRole("heading", { name: "项目上下文" });
  await act(async () => resolve([projectSkill("stale", "过期项目 Skill")]));
  expect(screen.getByRole("heading", { name: "项目上下文" })).toBeVisible();
  expect(screen.queryByText("过期项目 Skill")).not.toBeInTheDocument();
});

test("lists real session Skills without a legacy task and provides an executable chat request", async () => {
  const sessions = sessionApi(); const api = Object.assign(fixture({ project: true }).api, { sessions: sessions.api });
  const copy = vi.fn(async () => undefined); Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
  render(<SkillsView api={api} projectPath="P" task={undefined} onError={vi.fn()} onNewTask={vi.fn()} />);
  expect(await screen.findByRole("heading", { name: "场景审查" })).toBeVisible();
  expect(sessions.api.list).toHaveBeenCalledWith("P");
  expect(api.tool).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "新建任务" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "复制 Skill 调用 scene-review" }));
  await waitFor(() => expect(copy).toHaveBeenCalledWith("调用 Skill scene-review，并按它的步骤执行。"));
});

test("keeps the next project's Skills when a previous project's inventory arrives late", async () => {
  const sessions = sessionApi(); const api = Object.assign(fixture({ project: true }).api, { sessions: sessions.api });
  let resolve!: (records: ChatSession[]) => void;
  vi.mocked(sessions.api.list).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const view = render(<SkillsView api={api} projectPath="old" task={undefined} onError={vi.fn()} onNewTask={vi.fn()} />);
  view.rerender(<SkillsView api={api} projectPath="new" task={undefined} onError={vi.fn()} onNewTask={vi.fn()} />);
  await screen.findByRole("heading", { name: "场景审查" });
  resolve([{ ...sessions.record, capabilities: { ...sessions.record.capabilities!, skills: [{ id: "stale", name: "过期项目 Skill", purpose: "旧内容" }] } }]);
  await waitFor(() => expect(screen.queryByText("过期项目 Skill")).not.toBeInTheDocument());
});

test("preserves a live capability update that arrives while an older list request is pending", async () => {
  const sessions = sessionApi(); const api = Object.assign(fixture({ project: true }).api, { sessions: sessions.api });
  let resolve!: (records: ChatSession[]) => void;
  let receive!: Parameters<ChatSessionsApi["subscribe"]>[0];
  vi.mocked(sessions.api.list).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  vi.mocked(sessions.api.subscribe).mockImplementation((listener) => { receive = listener; return () => undefined; });
  render(<SkillsView api={api} projectPath="P" task={undefined} onError={vi.fn()} onNewTask={vi.fn()} />);
  act(() => receive({ projectPath: "P", sessionId: sessions.record.id, seq: sessions.record.seq, session: { ...sessions.record, revision: 2 } }));
  await act(async () => resolve([]));
  expect(screen.getByRole("heading", { name: "场景审查" })).toBeVisible();
});

test("separates outgoing MCP status from the SpecLoom connection details", async () => {
  const sessions = sessionApi();
  render(<McpView connection={{ url: "http://localhost/mcp", token: "secret" }} task={undefined} sessionsApi={sessions.api} projectPath="P" onError={vi.fn()} />);
  expect(await screen.findByText("资料库")).toBeVisible();
  expect(screen.getByText("已连接")).toBeVisible();
  expect(screen.getByText("服务器离线")).toBeVisible();
  expect(screen.getByText("mcp_docs_read")).toBeVisible();
  expect(screen.getByText(".specloom/mcp.json")).toBeVisible();
  expect(screen.getByText(".mcp.json")).toBeVisible();
  expect(screen.queryByText("连接配置")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "连接 SpecLoom" }));
  expect(screen.getByRole("button", { name: "复制 MCP 访问令牌" })).toBeVisible();
  expect(screen.getByText("连接配置")).toBeVisible();
  fireEvent.click(screen.getByRole("tab", { name: "外部 MCP" }));
  expect(screen.getByText("资料库")).toBeVisible();
  expect(sessions.api.list).toHaveBeenCalledWith("P");
  expect(sessions.api.list).toHaveBeenCalledOnce();
});

test("shows the installed project Godot MCP separately from external MCP servers", async () => {
  const sessions = sessionApi();
  sessions.record.capabilities = { ...sessions.record.capabilities!, mcp: [] };
  const godotInventory: PluginInventory = {
    godotMcp: { status: "ready", installedVersion: "1.1.0", enabled: true, connected: true },
    plugins: [],
    scanLimitReached: false,
  };
  const pluginManagement: PluginManagementApi = {
    list: vi.fn(async () => godotInventory),
    setGodotPluginEnabled: vi.fn(),
    setGodotMcpEnabled: vi.fn(),
    installGodotMcp: vi.fn(),
    revealDirectory: vi.fn(),
  };

  render(<McpView connection={undefined} task={undefined} sessionsApi={sessions.api} godotPluginApi={pluginManagement} projectPath="P" onError={vi.fn()} />);

  expect(await screen.findByRole("heading", { name: "SpecLoom Godot MCP" })).toBeVisible();
  expect(screen.getByText("已启用 · Godot 已连接")).toBeVisible();
  expect(screen.getByLabelText("SpecLoom Godot MCP")).toHaveTextContent("GodotMCP-Standalone · v1.1.0");
  expect(screen.queryByText("当前会话没有配置外部 MCP 服务。")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "外部 MCP" }));
  expect(await screen.findByText("当前会话没有配置外部 MCP 服务。")).toBeVisible();
  expect(pluginManagement.list).toHaveBeenCalledOnce();
});

test("keeps Skills in a loading state until the background inventory arrives", async () => {
  const sessions = sessionApi(); const complete = structuredClone(sessions.record); delete sessions.record.capabilities;
  const api = Object.assign(fixture({ project: true }).api, { sessions: sessions.api });
  let receive!: Parameters<ChatSessionsApi["subscribe"]>[0];
  vi.mocked(sessions.api.subscribe).mockImplementation(listener => { receive = listener; return () => undefined; });
  render(<SkillsView api={api} projectPath="P" task={undefined} onError={vi.fn()} onNewTask={vi.fn()} />);
  await waitFor(() => expect(sessions.api.list).toHaveBeenCalled());
  await act(async () => undefined);
  expect(screen.getByText("正在加载 Skills…")).toBeVisible();
  act(() => receive({ projectPath: "P", sessionId: complete.id, seq: complete.seq, session: { ...complete, revision: 2 } }));
  expect(screen.getByRole("heading", { name: "场景审查" })).toBeVisible();
});

test("shows background capability failures in the MCP page instead of an empty inventory", async () => {
  const sessions = sessionApi(); delete sessions.record.capabilities; sessions.record.capabilityError = "能力发现失败";
  render(<McpView connection={undefined} task={undefined} sessionsApi={sessions.api} projectPath="P" onError={vi.fn()} />);
  expect(await screen.findByText("MCP 状态加载失败。下一次发送消息会重新加载。")).toBeVisible();
});

test("presents a generic project without empty Godot metadata and offers a general project picker", async () => {
  const harness = fixture({ project: true });
  harness.state().project = { ...harness.state().project!, name: "开发项目", engine: "generic", godot: { features: [] } };
  render(<App />);
  await screen.findByRole("heading", { name: "开发项目" });
  const projectDetails = screen.getByRole("button", { name: "项目信息：开发项目" });
  expect(projectDetails).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(projectDetails);
  expect(screen.getByText("通用项目")).toBeVisible();
  expect(screen.queryByText("未配置主场景")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "返回初始界面" })).toBeVisible();
});
