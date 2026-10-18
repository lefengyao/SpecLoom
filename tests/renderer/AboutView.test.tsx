// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AboutView } from "../../src/renderer/AboutView";
import type { DesktopApi } from "../../src/shared/desktop-api";
import type { ProjectOverview } from "../../src/shared/project-overview";
import { APP_INFO } from "../../src/shared/app-info";
import { fixture, version } from "./fixtures";

afterEach(cleanup);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(next => { resolve = next; }); return { promise, resolve }; }
function setup() {
  const base = fixture({ project: true }); const project = base.state().project!;
  const overview: ProjectOverview = { projectPath: project.path, inspectedAt: "2026-10-17T00:00:00Z", git: { state: "not-repository" }, documents: { gitignore: { path: ".gitignore", state: "missing" }, readmes: [{ path: "README.md", state: "file", version, size: 12 }] } };
  const api: DesktopApi = {
    ...base.api,
    projectOverview: { read: vi.fn(async () => overview) },
    projectFiles: { readText: vi.fn(async (_root, path) => ({ path, version, content: "# Root README", size: 13 })), openMedia: vi.fn(), releaseMedia: vi.fn() },
  };
  return { project, overview, api };
}
describe("AboutView", () => {
  it("reads independently when active, refreshes on focus and shows package identity", async () => {
    const { project, api } = setup(); const onOpenFile = vi.fn();
    const view = render(<AboutView project={project} api={api} active={false} onOpenFile={onOpenFile} />);
    expect(api.projectOverview!.read).not.toHaveBeenCalled();
    view.rerender(<AboutView project={project} api={api} active onOpenFile={onOpenFile} />);
    expect(await screen.findByText("当前项目不属于 Git 仓库。")).toBeVisible();
    expect(screen.getByText(APP_INFO.description)).toBeVisible(); expect(screen.getByText(APP_INFO.author)).toBeVisible(); expect(screen.getByText(APP_INFO.version)).toBeVisible();
    fireEvent(window, new Event("focus")); await waitFor(() => expect(api.projectOverview!.read).toHaveBeenCalledTimes(2));
  });
  it("discards a stale project response after switching projects", async () => {
    const { project, api, overview } = setup(); const old = deferred<ProjectOverview>();
    const nextProject = { ...project, name: "Next project", path: "C:/Next" };
    api.projectOverview!.read = vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValue({ ...overview, projectPath: nextProject.path, git: { state: "unavailable", issue: { code: "unavailable", message: "New project Git unavailable" } } });
    const view = render(<AboutView project={project} api={api} active onOpenFile={vi.fn()} />);
    view.rerender(<AboutView project={nextProject} api={api} active onOpenFile={vi.fn()} />);
    expect(await screen.findByText("New project Git unavailable")).toBeVisible();
    await act(async () => { old.resolve(overview); await old.promise; });
    expect(screen.queryByText("当前项目不属于 Git 仓库。")).not.toBeInTheDocument();
    expect(screen.getByText("Next project")).toBeVisible();
  });
  it("previews root text read-only and delegates opening it to the existing workspace", async () => {
    const { project, api } = setup(); const onOpenFile = vi.fn();
    render(<AboutView project={project} api={api} active onOpenFile={onOpenFile} />);
    const summary = await screen.findByText("只读预览 README.md");
    const details = summary.closest("details")!;
    await act(async () => { details.open = true; fireEvent(details, new Event("toggle")); });
    expect(await screen.findByText("# Root README")).toBeVisible();
    expect(api.projectFiles!.readText).toHaveBeenCalledWith(project.path, "README.md");
    fireEvent.click(screen.getByRole("button", { name: "打开文件" })); expect(onOpenFile).toHaveBeenCalledWith("README.md");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
  it("reports failed reads and allows a manual refresh", async () => {
    const { project, api } = setup(); api.projectOverview!.read = vi.fn().mockRejectedValueOnce(new Error("secret transport detail")).mockResolvedValue({ projectPath: project.path, inspectedAt: "2026-10-17", git: { state: "not-repository" }, documents: { gitignore: { path: ".gitignore", state: "missing" }, readmes: [] } });
    render(<AboutView project={project} api={api} active onOpenFile={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("项目概览读取失败，请重试。");
    expect(screen.queryByText("secret transport detail")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "刷新项目概览" }));
    expect(await screen.findByText("当前项目不属于 Git 仓库。")).toBeVisible();
  });
  it("shows document errors without exposing transport details and drops a stale preview on project switch", async () => {
    const { project, api, overview } = setup();
    const read = deferred<{ path: string; version: typeof version; content: string; size: number }>();
    api.projectFiles!.readText = vi.fn().mockRejectedValueOnce(new Error("secret file path")).mockImplementationOnce(() => read.promise);
    const view = render(<AboutView project={project} api={api} active onOpenFile={vi.fn()} />);
    let summary = await screen.findByText("只读预览 README.md");
    await act(async () => { const details = summary.closest("details")!; details.open = true; fireEvent(details, new Event("toggle")); });
    expect(await screen.findByRole("alert")).toHaveTextContent("文档读取失败，请刷新概览后重试。");
    expect(screen.queryByText("secret file path")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "刷新项目概览" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    summary = screen.getByText("只读预览 README.md");
    await act(async () => { const details = summary.closest("details")!; details.open = false; fireEvent(details, new Event("toggle")); details.open = true; fireEvent(details, new Event("toggle")); });
    await waitFor(() => expect(api.projectFiles!.readText).toHaveBeenCalledTimes(2));
    const next = { ...project, path: "C:/Next" }; api.projectOverview!.read = vi.fn(async () => ({ ...overview, projectPath: next.path }));
    view.rerender(<AboutView project={next} api={api} active onOpenFile={vi.fn()} />);
    await act(async () => { read.resolve({ path: "README.md", version, content: "stale old project content", size: 25 }); await read.promise; });
    expect(screen.queryByText("stale old project content")).not.toBeInTheDocument();
  });
  it("shows branches, upstream, current HEAD and remote URLs", async () => {
    const { project, api, overview } = setup();
    api.projectOverview!.read = vi.fn(async (): Promise<ProjectOverview> => ({ ...overview, git: { state: "repository", location: "root", worktreeRoot: project.path, gitDir: `${project.path}/.git`, commonDir: `${project.path}/.git`, head: { kind: "branch", name: "main", commit: "a".repeat(40) }, branches: [{ ref: "refs/heads/main", name: "main", kind: "local", commit: "a".repeat(40), upstream: "origin/main" }], branchesState: "loaded", branchesTruncated: false, remotes: [{ name: "origin", fetchUrls: ["https://example.org/repo"], pushUrls: ["https://example.org/repo"] }], remotesState: "loaded", issues: [] } }));
    render(<AboutView project={project} api={api} active onOpenFile={vi.fn()} />);
    expect(await screen.findByText("origin/main")).toBeVisible(); expect(screen.getByText("当前")).toBeVisible();
    expect(screen.getAllByText("https://example.org/repo")).toHaveLength(2);
  });
});
