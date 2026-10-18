// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ArchivedSessionsView, HooksView, ToolDocsView } from "../../src/renderer/ToolsViews";
import type { ChatSession, ChatSessionsApi, SessionEvent } from "../../src/shared/chat";
import { fixture } from "./fixtures";
import type { HooksApi } from "../../src/shared/desktop-api";

afterEach(cleanup);
test("retained archived sessions update from project events without another list request", async () => {
  let listener: ((event: SessionEvent) => void) | undefined;
  const archived: ChatSession = { id: "a", title: "后台归档", createdAt: "1", updatedAt: "1", archived: true, draft: "", draftRevision: 0, revision: 2, seq: 1, status: "idle", items: [] };
  const sessions = { list: vi.fn(async () => []), subscribe: vi.fn((next: (event: SessionEvent) => void) => { listener = next; return () => { listener = undefined; }; }) } as unknown as ChatSessionsApi;
  render(<ArchivedSessionsView api={{ ...fixture().api, sessions }} projectPath="P" onError={vi.fn()} onSelect={vi.fn()} />);
  await waitFor(() => expect(sessions.list).toHaveBeenCalledOnce());
  act(() => listener?.({ projectPath: "Other", sessionId: "a", seq: 1, session: archived }));
  expect(screen.queryByRole("heading", { name: "后台归档" })).not.toBeInTheDocument();
  act(() => listener?.({ projectPath: "P", sessionId: "a", seq: 1, session: archived }));
  expect(await screen.findByRole("heading", { name: "后台归档" })).toBeVisible();
  act(() => listener?.({ projectPath: "P", sessionId: "a", seq: 2, session: { ...archived, archived: false, seq: 2, revision: 3 } }));
  expect(screen.queryByRole("heading", { name: "后台归档" })).not.toBeInTheDocument();
  expect(sessions.list).toHaveBeenCalledOnce();
});

test("retained tool docs update capability names on session events without rereading history", async () => {
  let listener: ((event: SessionEvent) => void) | undefined;
  const record: ChatSession = { id: "a", title: "会话", createdAt: "1", updatedAt: "1", archived: false, draft: "", draftRevision: 0, revision: 2, seq: 1, status: "running", items: [], capabilities: { tools: [{ name: "DiscoveredTool", description: "" }], skills: [], mcp: [], plugins: [] } };
  const sessions = { list: vi.fn(async () => []), subscribe: vi.fn((next: (event: SessionEvent) => void) => { listener = next; return () => undefined; }) } as unknown as ChatSessionsApi;
  render(<ToolDocsView api={{ ...fixture().api, sessions }} projectPath="P" />);
  await waitFor(() => expect(sessions.list).toHaveBeenCalledOnce());
  act(() => listener?.({ projectPath: "P", sessionId: "a", seq: 1, session: record }));
  expect(await screen.findByRole("heading", { name: "DiscoveredTool" })).toBeVisible();
  expect(sessions.list).toHaveBeenCalledOnce();
});

test("Hooks refresh results on return while retaining the command being edited", async () => {
  const hooks = { list: vi.fn(async () => []) } as unknown as HooksApi;
  const props = { api: { ...fixture().api, hooks }, onError: vi.fn() };
  const view = render(<HooksView {...props} active />);
  await waitFor(() => expect(hooks.list).toHaveBeenCalledOnce());
  fireEvent.change(screen.getByLabelText("命令"), { target: { value: "my draft command" } });
  view.rerender(<HooksView {...props} active={false} />);
  expect(hooks.list).toHaveBeenCalledOnce();
  view.rerender(<HooksView {...props} active />);
  await waitFor(() => expect(hooks.list).toHaveBeenCalledTimes(2));
  expect(screen.getByLabelText("命令")).toHaveValue("my draft command");
});
