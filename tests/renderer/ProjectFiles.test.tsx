// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DocumentsView } from "../../src/renderer/DocumentsView";
import type { ProjectTreeEntry } from "../../src/shared/desktop-api";
import { fixture, version } from "./fixtures";

const projectPath = "C:/Godot/lantern";
const lease = (id: string, kind: "image" | "audio" | "video" = "image") => ({ id, kind, url: `specloom-media://lease/${id}`, mimeType: `${kind}/test`, size: 32, generation: "generation-1" });
function setup(paths: ProjectTreeEntry[], initialProject = projectPath) {
  const f = fixture({ project: true });
  f.api.documents.mockResolvedValue([]);
  f.api.projectTree.mockResolvedValue(paths);
  const projectFiles = {
    readText: vi.fn(async (_project: string, path: string) => ({ path, version, size: 24, content: "extends Node\n# 你好" })),
    openMedia: vi.fn(async (_project: string, path: string) => lease(path, /\.(mp4|webm)$/i.test(path) ? "video" : /\.ogg$/i.test(path) ? "audio" : "image")),
    releaseMedia: vi.fn<(id: string) => Promise<void>>(async () => undefined),
  };
  const api = Object.assign(f.api, { projectFiles });
  const onError = vi.fn();
  const viewFor = (project = initialProject, active = true) => <DocumentsView api={api} onError={onError} projectPath={project} busy={false} revision={0} category="all" active={active} />;
  const view = render(viewFor());
  return { ...view, ...f, api, projectFiles, onError, viewFor };
}
async function select(path: string) {
  const tree = screen.getByRole("tree", { name: "项目树" });
  fireEvent.click(await within(tree).findByRole("button", { name: path }));
}
beforeEach(() => {
  window.localStorage.setItem("specloom.documents.tree", "open");
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
});
afterEach(() => { cleanup(); window.localStorage.clear(); vi.restoreAllMocks(); });

it("previews an ordinary tree image when the specs document catalog is empty", async () => {
  const f = setup([{ path: "cover.PNG", kind: "file" }]);
  await select("cover.PNG");
  const image = await screen.findByRole("img", { name: "cover.PNG" });
  expect(image).toHaveAttribute("src", lease("cover.PNG").url);
  expect(f.projectFiles.openMedia).toHaveBeenCalledWith(projectPath, "cover.PNG");
  expect(f.api.readDocument).not.toHaveBeenCalled();
  expect(f.api.readMaterialImage).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "保存资料" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "100%" }));
  expect(screen.getByLabelText("图片缩放比例")).toHaveValue("100");
  fireEvent.click(screen.getByRole("button", { name: "放大图片" }));
  expect(screen.getByLabelText("图片缩放比例")).toHaveValue("125");
  fireEvent.wheel(screen.getByLabelText("图片预览"), { deltaY: -100 });
  expect(screen.getByLabelText("图片缩放比例")).toHaveValue("135");
  fireEvent.wheel(screen.getByLabelText("图片预览"), { deltaY: 100 });
  expect(screen.getByLabelText("图片缩放比例")).toHaveValue("125");
});

it("reads ordinary UTF-8 project files through a read-only API", async () => {
  const f = setup([{ path: "keeper.gd", kind: "file" }]);
  await select("keeper.gd");
  expect(await screen.findByRole("textbox", { name: "项目文件内容" })).toHaveValue("extends Node\n# 你好");
  expect(screen.getByRole("textbox", { name: "项目文件内容" })).toHaveAttribute("readonly");
  expect(f.projectFiles.readText).toHaveBeenCalledWith(projectPath, "keeper.gd");
  expect(f.api.readDocument).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "保存资料" })).not.toBeInTheDocument();
});

it("releases a late image lease after selection has moved to another file", async () => {
  const f = setup([{ path: "first.png", kind: "file" }, { path: "next.png", kind: "file" }]);
  let resolve!: (value: ReturnType<typeof lease>) => void;
  f.projectFiles.openMedia.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  await select("first.png");
  await select("next.png");
  expect(await screen.findByRole("img", { name: "next.png" })).toBeVisible();
  await act(async () => resolve(lease("stale")));
  await waitFor(() => expect(f.projectFiles.releaseMedia).toHaveBeenCalledWith("stale"));
  expect(screen.queryByRole("img", { name: "first.png" })).not.toBeInTheDocument();
  f.unmount();
  await waitFor(() => expect(f.projectFiles.releaseMedia).toHaveBeenCalledWith("next.png"));
});

it("offers video resources with native controls and stops the stream when inactive", async () => {
  const f = setup([{ path: "intro.MP4", kind: "file" }, { path: "music.ogg", kind: "file" }]);
  const filter = await screen.findByLabelText("筛选资源类型");
  fireEvent.change(filter, { target: { value: "video" } });
  const resources = screen.getByRole("list", { name: "项目资源列表" });
  fireEvent.click(await within(resources).findByRole("button", { name: /intro.MP4/ }));
  const video = await screen.findByLabelText("视频播放器");
  expect(video).toHaveAttribute("controls");
  expect(video).not.toHaveAttribute("autoplay");
  expect(screen.getByRole("button", { name: "展开视频" })).toBeVisible();
  expect(screen.getByRole("button", { name: "视频全屏" })).toBeVisible();
  f.rerender(f.viewFor(projectPath, false));
  expect(video).not.toHaveAttribute("src");
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  expect(HTMLMediaElement.prototype.load).toHaveBeenCalled();
  await waitFor(() => expect(f.projectFiles.releaseMedia).toHaveBeenCalledWith("intro.MP4"));
});

it("keeps import files visible by default and filters both tree inputs by a persisted project preference", async () => {
  const f = setup([{ path: "hero.PNG.IMPORT", kind: "file" }, { path: "archive.import", kind: "directory" }, { path: "other.gd.uid", kind: "file" }, { path: "project.godot", kind: "file" }]);
  f.api.documents.mockResolvedValue([{ path: "catalog.import", version, size: 1 }]);
  fireEvent.click(screen.getByRole("button", { name: "刷新项目树" }));
  const tree = screen.getByRole("tree", { name: "项目树" });
  expect(await within(tree).findByRole("button", { name: "catalog.import" })).toBeVisible();
  expect(within(tree).getByRole("button", { name: "hero.PNG.IMPORT" })).toBeVisible();
  const toggle = screen.getByRole("checkbox", { name: "隐藏 .import 文件" });
  expect(toggle).not.toBeChecked();
  fireEvent.click(toggle);
  expect(within(tree).queryByRole("button", { name: "catalog.import" })).not.toBeInTheDocument();
  expect(within(tree).queryByRole("button", { name: "hero.PNG.IMPORT" })).not.toBeInTheDocument();
  expect(within(tree).getByRole("button", { name: "archive.import" })).toBeVisible();
  expect(within(tree).queryByRole("button", { name: "other.gd.uid" })).not.toBeInTheDocument();
  f.unmount();
  const same = setup([{ path: "hero.PNG.IMPORT", kind: "file" }], "c:\\Godot\\lantern\\");
  expect(screen.getByRole("checkbox", { name: "隐藏 .import 文件" })).toBeChecked();
  same.rerender(same.viewFor("C:/Godot/different"));
  expect(screen.getByRole("checkbox", { name: "隐藏 .import 文件" })).not.toBeChecked();
});

it("keeps filtering usable when preference storage is unavailable", async () => {
  const f = setup([{ path: "hero.png.import", kind: "file" }]);
  await select("hero.png.import");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage blocked"); });
  fireEvent.click(screen.getByRole("checkbox", { name: "隐藏 .import 文件" }));
  expect(screen.getByRole("checkbox", { name: "隐藏 .import 文件" })).toBeChecked();
  expect(within(screen.getByRole("tree")).queryByRole("button", { name: "hero.png.import" })).not.toBeInTheDocument();
  expect(f.onError).not.toHaveBeenCalled();
});

it("uses seekable native audio controls and releases the old audio when selecting text", async () => {
  const f = setup([{ path: "music.ogg", kind: "file" }, { path: "keeper.gd", kind: "file" }]);
  await select("music.ogg");
  const audio = await screen.findByLabelText("音频播放器") as HTMLAudioElement;
  expect(audio).toHaveAttribute("controls");
  expect(audio).toHaveAttribute("preload", "metadata");
  expect(audio).not.toHaveAttribute("autoplay");
  audio.currentTime = 12;
  fireEvent.seeked(audio);
  expect(audio.currentTime).toBe(12);
  await select("keeper.gd");
  expect(await screen.findByRole("textbox", { name: "项目文件内容" })).toBeVisible();
  expect(audio).not.toHaveAttribute("src");
  await waitFor(() => expect(f.projectFiles.releaseMedia).toHaveBeenCalledWith("music.ogg"));
});

it("shows decoder errors and provides an expanded video surface", async () => {
  setup([{ path: "intro.mp4", kind: "file" }]);
  await select("intro.mp4");
  const video = await screen.findByLabelText("视频播放器") as HTMLVideoElement;
  video.currentTime = 24;
  fireEvent.seeked(video);
  expect(video.currentTime).toBe(24);
  fireEvent.click(screen.getByRole("button", { name: "展开视频" }));
  expect(screen.getByRole("region", { name: "项目媒体预览" })).toHaveClass("is-expanded");
  fireEvent.click(screen.getByRole("button", { name: "收起视频" }));
  expect(screen.getByRole("region", { name: "项目媒体预览" })).not.toHaveClass("is-expanded");
  fireEvent.error(video);
  expect(await screen.findByRole("alert")).toHaveTextContent("编码不受支持");
});

it("releases an unfinished open after the retained page becomes inactive and reopens on return", async () => {
  const f = setup([{ path: "cover.png", kind: "file" }]);
  let resolve!: (value: ReturnType<typeof lease>) => void;
  f.projectFiles.openMedia.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  await select("cover.png");
  f.rerender(f.viewFor(projectPath, false));
  await act(async () => resolve(lease("hidden-lease")));
  await waitFor(() => expect(f.projectFiles.releaseMedia).toHaveBeenCalledWith("hidden-lease"));
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  f.rerender(f.viewFor());
  expect(await screen.findByRole("img", { name: "cover.png" })).toBeVisible();
  expect(f.projectFiles.openMedia).toHaveBeenCalledTimes(2);
});

it("retains an editable specs draft while previewing an ordinary image", async () => {
  const f = setup([{ path: "cover.png", kind: "file" }, { path: "specs/outline.md", kind: "file" }]);
  f.api.documents.mockResolvedValue([{ path: "specs/outline.md", version, size: 10 }]);
  f.api.readDocument.mockResolvedValue({ path: "specs/outline.md", version, content: "# 原稿" });
  fireEvent.click(screen.getByRole("button", { name: "刷新项目树" }));
  await select("outline.md");
  const editor = await screen.findByRole("textbox", { name: "文档内容" });
  fireEvent.change(editor, { target: { value: "# 未保存草稿" } });
  await select("cover.png");
  expect(await screen.findByRole("img", { name: "cover.png" })).toBeVisible();
  await select("outline.md");
  expect(await screen.findByRole("textbox", { name: "文档内容" })).toHaveValue("# 未保存草稿");
  expect(screen.getByRole("button", { name: "保存资料" })).toBeEnabled();
  expect(f.api.saveDocument).not.toHaveBeenCalled();
});

it("opens an externally requested dotfile read-only once the retained files page is active", async () => {
  const f = setup([{ path: ".gitignore", kind: "file" }]);
  const onHandled = vi.fn();
  const request = { path: ".gitignore", sequence: 12 };
  const view = (active: boolean) => <DocumentsView api={f.api} onError={f.onError} projectPath={projectPath} busy={false} revision={0} category="all" active={active} openFileRequest={request} onOpenFileHandled={onHandled} />;
  f.rerender(view(false));
  await act(async () => undefined);
  expect(f.projectFiles.readText).not.toHaveBeenCalled();
  expect(onHandled).not.toHaveBeenCalled();
  f.rerender(view(true));
  expect(await screen.findByRole("textbox", { name: "项目文件内容" })).toHaveAttribute("readonly");
  expect(f.projectFiles.readText).toHaveBeenCalledWith(projectPath, ".gitignore");
  expect(onHandled).toHaveBeenCalledExactlyOnceWith(12);
  f.rerender(view(true));
  expect(f.projectFiles.readText).toHaveBeenCalledTimes(1);
});

it("shows the desktop bridge's structured file error message", async () => {
  const f = setup([{ path: "archive.bin", kind: "file" }]);
  f.projectFiles.readText.mockRejectedValue({ code: "VALIDATION_FAILED", message: "此文件不是 UTF-8 文本" });
  await select("archive.bin");
  expect(await screen.findByRole("alert")).toHaveTextContent("此文件不是 UTF-8 文本");
});

it("handles an external request for the same file while changing the document category", async () => {
  const f = setup([{ path: "README.md", kind: "file" }]);
  const onHandled = vi.fn();
  const base = { api: f.api, onError: f.onError, projectPath, busy: false, revision: 0 };
  f.rerender(<DocumentsView {...base} category="entity" />);
  const resources = screen.getByRole("list", { name: "项目资源列表" });
  fireEvent.click(await within(resources).findByRole("button", { name: /README.md/ }));
  expect(await screen.findByRole("textbox", { name: "项目文件内容" })).toBeVisible();
  f.rerender(<DocumentsView {...base} category="all" openFileRequest={{ path: "README.md", sequence: 15 }} onOpenFileHandled={onHandled} />);
  expect(await screen.findByRole("textbox", { name: "项目文件内容" })).toHaveValue("extends Node\n# 你好");
  expect(onHandled).toHaveBeenCalledExactlyOnceWith(15);
});

it("closes the selected import preview when it becomes hidden", async () => {
  const f = setup([{ path: "cover.png.import", kind: "file" }]);
  await select("cover.png.import");
  expect(await screen.findByRole("textbox", { name: "项目文件内容" })).toBeVisible();
  fireEvent.click(screen.getByRole("checkbox", { name: "隐藏 .import 文件" }));
  expect(screen.queryByRole("textbox", { name: "项目文件内容" })).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "cover.png.import" })).not.toBeInTheDocument();
  expect(f.api.saveDocument).not.toHaveBeenCalled();
});

it("preserves a dirty material draft when import files are hidden", async () => {
  const f = setup([{ path: "cover.png.import", kind: "file" }, { path: "specs/outline.md", kind: "file" }]);
  f.api.documents.mockResolvedValue([{ path: "specs/outline.md", version, size: 10 }]);
  f.api.readDocument.mockResolvedValue({ path: "specs/outline.md", version, content: "# 原稿" });
  fireEvent.click(screen.getByRole("button", { name: "刷新项目树" }));
  await select("outline.md");
  const editor = await screen.findByRole("textbox", { name: "文档内容" });
  fireEvent.change(editor, { target: { value: "# 保留草稿" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "隐藏 .import 文件" }));
  expect(editor).toHaveValue("# 保留草稿");
  expect(screen.getByRole("button", { name: "保存资料" })).toBeEnabled();
  expect(f.api.saveDocument).not.toHaveBeenCalled();
});
