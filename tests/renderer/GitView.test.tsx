// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { GitView } from "../../src/renderer/GitView";

test("loads repository state and stages a file through plugin.invoke", async () => {
  const invoke = vi.fn(async (_id: string, command: string, _input?: unknown) => {
    if (command === "state") return { state: "repository", branch: "main", files: [{ path: "a.txt", index: " ", worktree: "M", staged: false, unstaged: true }], ahead: 0, behind: 0 };
    if (command === "stage") return { state: "repository", branch: "main", files: [{ path: "a.txt", index: "M", worktree: " ", staged: true, unstaged: false }], ahead: 0, behind: 0 };
    if (command === "branches") return { current: "main", branches: ["main"] };
    if (command === "history") return { commits: [] };
    if (command === "diff") return { diff: "+hello" };
    return {};
  });
  const api = { plugins: { invoke } } as never;
  render(<GitView api={api} pluginId="specloom-git" projectPath="E:\\project" onError={() => undefined} />);
  await screen.findByText("a.txt");
  fireEvent.click(screen.getByRole("button", { name: "暂存" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("specloom-git", "stage", { paths: ["a.txt"] }));
});
