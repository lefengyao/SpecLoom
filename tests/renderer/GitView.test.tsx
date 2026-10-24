// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { GitView } from "../../src/renderer/GitView";

afterEach(cleanup);

type MockFile = { path: string; index: string; worktree: string; staged: boolean; unstaged: boolean };

const repo = (files: MockFile[]) => ({ state: "repository", branch: "main", files, ahead: 0, behind: 0 });

/** Plugin mock with a mutable working tree so staging can change the file list mid-test. */
function plugin(files: MockFile[], diff = "+hello") {
  const invoke = vi.fn(async (_id: string, command: string) => {
    if (command === "state") return repo(files);
    if (command === "branches") return { current: "main", branches: ["main"] };
    if (command === "history") return { commits: [] };
    if (command === "diff") return { diff };
    if (command === "stage" || command === "unstage") return repo(files);
    return {};
  });
  return { invoke, api: { plugins: { invoke } } as never };
}

const file = (path: string, index: string, worktree: string): MockFile => ({ path, index, worktree, staged: index !== " ", unstaged: worktree !== " " });

test("loads repository state and stages a file through plugin.invoke", async () => {
  const { invoke, api } = plugin([file("a.txt", " ", "M")]);
  render(<GitView api={api} pluginId="specloom-git" projectPath="E:\\project" onError={() => undefined} />);
  await screen.findByText("a.txt");
  fireEvent.click(screen.getByRole("button", { name: "暂存" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("specloom-git", "stage", { paths: ["a.txt"] }));
});

test("stages every selected file at once and only unstages the ones that have staged content", async () => {
  const files = [file("a.txt", " ", "M"), file("b.txt", "M", " "), file("c.txt", "M", "M")];
  const { invoke, api } = plugin(files);
  render(<GitView api={api} pluginId="specloom-git" projectPath="E:\\project" onError={() => undefined} />);
  await screen.findByText("a.txt");
  fireEvent.click(screen.getByLabelText("全选变更文件"));
  expect(screen.getByText("已选 3")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "暂存所选" }));
  // b.txt is fully staged already, so bulk staging must not include it.
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("specloom-git", "stage", { paths: ["a.txt", "c.txt"] }));
  await waitFor(() => expect(screen.getByRole("button", { name: "取消暂存所选" })).not.toBeDisabled());
  fireEvent.click(screen.getByRole("button", { name: "取消暂存所选" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("specloom-git", "unstage", { paths: ["b.txt", "c.txt"] }));
});

test("clears the select-all box when no file is chosen", async () => {
  const { api } = plugin([file("a.txt", " ", "M")]);
  render(<GitView api={api} pluginId="specloom-git" projectPath="E:\\project" onError={() => undefined} />);
  await screen.findByText("a.txt");
  const all = screen.getByLabelText("全选变更文件") as HTMLInputElement;
  fireEvent.click(all);
  expect(all.checked).toBe(true);
  fireEvent.click(all);
  expect(all.checked).toBe(false);
  expect(screen.getByRole("button", { name: "暂存所选" })).toBeDisabled();
});

test("drops selections for files that disappear after a refresh", async () => {
  const files = [file("a.txt", " ", "M"), file("b.txt", " ", "M")];
  const invoke = vi.fn(async (_id: string, command: string) => {
    if (command === "state") return repo(files);
    if (command === "branches") return { current: "main", branches: ["main"] };
    if (command === "history") return { commits: [] };
    if (command === "diff") return { diff: "+hello" };
    if (command === "stage") { files.splice(1, 1); return repo(files); }
    return {};
  });
  render(<GitView api={{ plugins: { invoke } } as never} pluginId="specloom-git" projectPath="E:\\project" onError={() => undefined} />);
  await screen.findByText("b.txt");
  fireEvent.click(screen.getByLabelText("全选变更文件"));
  expect(screen.getByText("已选 2")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "暂存所选" }));
  await waitFor(() => expect(screen.queryByText("b.txt")).not.toBeInTheDocument());
  expect(screen.getByText("已选 1")).toBeVisible();
});

test("colours added, removed, hunk and header lines of the diff", async () => {
  const diff = ["diff --git a/a.txt b/a.txt", "--- a/a.txt", "+++ b/a.txt", "@@ -1 +1 @@", "-old", "+new", " keep"].join("\n");
  const { api } = plugin([file("a.txt", " ", "M")], diff);
  const { container } = render(<GitView api={api} pluginId="specloom-git" projectPath="E:\\project" onError={() => undefined} />);
  await screen.findByText("a.txt");
  fireEvent.click(screen.getByRole("button", { name: /a\.txt/ }));
  await waitFor(() => expect(container.querySelector(".git-diff-line.added")).toHaveTextContent("+new"));
  expect(container.querySelector(".git-diff-line.removed")).toHaveTextContent("-old");
  expect(container.querySelector(".git-diff-line.hunk")).toHaveTextContent("@@ -1 +1 @@");
  expect(container.querySelectorAll(".git-diff-line.meta")).toHaveLength(3);
  // Context rows keep their leading space; toHaveTextContent would normalise it away.
  expect(container.querySelector(".git-diff-line.context")?.textContent).toBe(" keep");
});
