// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../src/renderer/App";
import { useWorkspace } from "../../src/renderer/useWorkspace";
import { useChatSessions } from "../../src/renderer/chat/useChatSessions";
import { ArchivedSessionsView } from "../../src/renderer/ToolsViews";
import type { ChatSession, ChatSessionsApi, SessionEvent } from "../../src/shared/chat";
import type { DesktopApi, WorkspaceState } from "../../src/shared/desktop-api";
import { fixture, task } from "./fixtures";

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(release => { resolve = release; });
  return { promise, resolve };
}

function stateBridge() {
  const f = fixture({ project: true, tasks: true });
  const changes = new Set<() => void>();
  const api = { ...f.api, onStateChanged: (listener: () => void) => { changes.add(listener); return () => changes.delete(listener); } } satisfies DesktopApi;
  return { ...f, api, changes, notify() { act(() => { for (const listener of changes) listener(); }); } };
}

function session(id: string, patch: Partial<ChatSession> = {}): ChatSession {
  return { id, title: id, createdAt: "1", updatedAt: "1", archived: false, draft: "", draftRevision: 0, revision: 1, seq: 0, status: "running", runId: `run-${id}`, items: [], ...patch };
}

function sessionBridge(initial = [session("a"), session("b")]) {
  let records = initial;
  const changes = new Set<(projectPath: string) => void>();
  const events = new Set<(event: SessionEvent) => void>();
  const api = {
    list: vi.fn(async () => structuredClone(records)),
    patch: vi.fn(async (_path: string, id: string, patch: Partial<ChatSession>) => {
      const current = records.find(s => s.id === id)!;
      Object.assign(current, patch, { revision: current.revision + 1 });
      return structuredClone(current);
    }),
    create: vi.fn(), remove: vi.fn(), export: vi.fn(), import: vi.fn(), send: vi.fn(), guide: vi.fn(), cancel: vi.fn(), answer: vi.fn(), approve: vi.fn(),
    subscribe(listener: (event: SessionEvent) => void) { events.add(listener); return () => events.delete(listener); },
    subscribeChanges(listener: (path: string) => void) { changes.add(listener); return () => changes.delete(listener); },
  } satisfies ChatSessionsApi;
  return { api, changes, events, replace(next: ChatSession[]) { records = next; }, notify(path = "P") { act(() => { for (const listener of changes) listener(path); }); } };
}

describe("workspace broadcasts", () => {
  it("refreshes shared settings on broadcasts and unsubscribes on unmount", async () => {
    const f = stateBridge(); const hook = renderHook(() => useWorkspace(f.api));
    await waitFor(() => expect(hook.result.current.state.project).toBeDefined());
    f.state().preferences.completionSound = false;
    f.notify();
    await waitFor(() => expect(hook.result.current.state.preferences.completionSound).toBe(false));
    expect(f.api.state).toHaveBeenCalledTimes(2);
    hook.unmount(); expect(f.changes.size).toBe(0);
  });

  it("does not restore a previous project when an old state read resolves after project selection", async () => {
    const f = stateBridge(); const hook = renderHook(() => useWorkspace(f.api));
    await waitFor(() => expect(hook.result.current.state.project).toBeDefined());
    const old = structuredClone(f.state()); const pending = deferred<WorkspaceState>();
    f.api.state.mockImplementationOnce(() => pending.promise); f.notify();
    await waitFor(() => expect(f.api.state).toHaveBeenCalledTimes(2));
    const next = { ...old, project: { ...old.project!, path: "Q", name: "新项目" }, tasks: [] };
    f.api.openProject.mockResolvedValueOnce(next);
    await act(async () => hook.result.current.openRecent("Q"));
    await act(async () => pending.resolve(old));
    expect(hook.result.current.state.project?.path).toBe("Q");
  });

  it("defers broadcasts during project selection and reads the selected project afterward", async () => {
    const f = stateBridge(); const hook = renderHook(() => useWorkspace(f.api));
    await waitFor(() => expect(hook.result.current.state.project).toBeDefined());
    const pending = deferred<WorkspaceState>(); f.api.openProject.mockImplementationOnce(() => pending.promise);
    let opening!: Promise<void>; act(() => { opening = hook.result.current.openRecent("Q"); });
    f.notify(); await act(async () => { await Promise.resolve(); });
    expect(f.api.state).toHaveBeenCalledOnce();
    const next = { ...f.state(), project: { ...f.state().project!, path: "Q" }, tasks: [] };
    f.setState(next);
    await act(async () => { pending.resolve(next); await opening; });
    expect(f.api.state).toHaveBeenCalledTimes(2); expect(hook.result.current.state.project?.path).toBe("Q");
  });

  it("keeps the user's task selection when an older refresh lacks that task", async () => {
    const f = stateBridge(); const hook = renderHook(() => useWorkspace(f.api));
    await waitFor(() => expect(hook.result.current.selectedId).toBe(task.id));
    const pending = deferred<WorkspaceState>(); f.api.state.mockImplementationOnce(() => pending.promise);
    let refresh!: Promise<void>; act(() => { refresh = hook.result.current.refresh(); });
    act(() => hook.result.current.setSelectedId("new-task"));
    await act(async () => { pending.resolve(structuredClone(f.state())); await refresh; });
    expect(hook.result.current.selectedId).toBe("new-task");
  });

  it("ignores a slower refresh after a newer refresh has applied", async () => {
    const f = stateBridge(); const hook = renderHook(() => useWorkspace(f.api));
    await waitFor(() => expect(hook.result.current.state.project).toBeDefined());
    const old = structuredClone(f.state()); const pending = deferred<WorkspaceState>();
    f.api.state.mockImplementationOnce(() => pending.promise);
    let refresh!: Promise<void>; act(() => { refresh = hook.result.current.refresh(); });
    f.state().preferences.completionSound = false;
    await act(async () => hook.result.current.refresh());
    await act(async () => { pending.resolve(old); await refresh; });
    expect(hook.result.current.state.preferences.completionSound).toBe(false);
  });
});

describe("session metadata broadcasts", () => {
  it("coalesces current-project invalidations and shows peer create, patch, import and delete", async () => {
    const f = sessionBridge(); const onError = vi.fn(); const onFinished = vi.fn();
    const hook = renderHook(() => useChatSessions(f.api, "P", onError, onFinished));
    await waitFor(() => expect(hook.result.current.sessions).toHaveLength(2));
    f.notify("Q"); await act(async () => { await Promise.resolve(); });
    expect(f.api.list).toHaveBeenCalledOnce();
    f.replace([session("a", { title: "改名", revision: 2 }), session("created"), session("imported")]);
    act(() => { f.notify(); f.notify(); });
    await waitFor(() => expect(hook.result.current.sessions.map(s => s.title)).toEqual(["改名", "created", "imported"]));
    expect(f.api.list).toHaveBeenCalledTimes(2);
    expect(hook.result.current.activeId).toBe("a");
    f.replace([session("created"), session("imported")]); f.notify();
    await waitFor(() => expect(hook.result.current.activeId).toBe("created"));
    hook.unmount(); expect(f.changes.size).toBe(0); expect(f.events.size).toBe(0);
  });

  it("retains a newer streamed reply while metadata invalidation is in flight", async () => {
    const f = sessionBridge(); const onError = vi.fn(); const onFinished = vi.fn();
    const hook = renderHook(() => useChatSessions(f.api, "P", onError, onFinished));
    await waitFor(() => expect(hook.result.current.sessions).toHaveLength(2));
    const pending = deferred<ChatSession[]>(); f.api.list.mockImplementationOnce(() => pending.promise); f.notify();
    await waitFor(() => expect(f.api.list).toHaveBeenCalledTimes(2));
    const streamed = session("a", { revision: 3, seq: 2, items: [{ id: "reply", kind: "message", role: "assistant", content: "新回复" }] });
    act(() => { for (const listener of f.events) listener({ projectPath: "P", sessionId: "a", runId: streamed.runId!, seq: streamed.seq, session: streamed }); });
    await act(async () => pending.resolve([session("a"), session("b")]));
    expect(hook.result.current.sessions[0]?.items[0]).toMatchObject({ content: "新回复" });
  });

  it("removes a peer-deleted active session even while a different session streams", async () => {
    const f = sessionBridge(); const onError = vi.fn(); const onFinished = vi.fn();
    const hook = renderHook(() => useChatSessions(f.api, "P", onError, onFinished));
    await waitFor(() => expect(hook.result.current.sessions).toHaveLength(2));
    act(() => hook.result.current.setActiveId("b"));
    const pending = deferred<ChatSession[]>(); f.api.list.mockImplementationOnce(() => pending.promise); f.notify();
    await waitFor(() => expect(f.api.list).toHaveBeenCalledTimes(2));
    const streamed = session("a", { revision: 3, seq: 2, items: [{ id: "reply", kind: "message", role: "assistant", content: "新回复" }] });
    act(() => { for (const listener of f.events) listener({ projectPath: "P", sessionId: "a", runId: streamed.runId!, seq: streamed.seq, session: streamed }); });
    await act(async () => pending.resolve([session("a")]));
    expect(hook.result.current.sessions.map(s => s.id)).toEqual(["a"]);
    expect(hook.result.current.activeId).toBe("a");
    expect(hook.result.current.sessions[0]?.items[0]).toMatchObject({ content: "新回复" });
  });
});

describe("window composer recovery", () => {
  it("keeps each window's guidance and draft through simultaneous edits, reloads and slot reuse", async () => {
    const f = sessionBridge(); const onError = vi.fn(); const onFinished = vi.fn();
    const first = renderHook(() => useChatSessions(f.api, "P", onError, onFinished, undefined, "hub-window-1"));
    const second = renderHook(() => useChatSessions(f.api, "P", onError, onFinished, undefined, "hub-window-2"));
    await waitFor(() => expect(first.result.current.activeId).toBe("a"));
    await waitFor(() => expect(second.result.current.activeId).toBe("a"));
    act(() => first.result.current.setDraft("窗口一引导")); act(() => first.result.current.stageDraft("a"));
    act(() => second.result.current.setDraft("窗口二引导")); act(() => second.result.current.stageDraft("a"));
    act(() => first.result.current.setDraft("窗口一草稿")); act(() => second.result.current.setDraft("窗口二草稿"));
    act(() => second.result.current.setActiveId("b"));
    first.unmount(); second.unmount();
    const restoredFirst = renderHook(() => useChatSessions(f.api, "P", onError, onFinished, undefined, "hub-window-1"));
    const restoredSecond = renderHook(() => useChatSessions(f.api, "P", onError, onFinished, undefined, "hub-window-2"));
    await waitFor(() => expect(restoredFirst.result.current.sessions).toHaveLength(2));
    await waitFor(() => expect(restoredSecond.result.current.sessions).toHaveLength(2));
    expect(restoredFirst.result.current.activeId).toBe("a"); expect(restoredSecond.result.current.activeId).toBe("b");
    expect(restoredFirst.result.current.draft).toBe("窗口一草稿");
    expect(restoredFirst.result.current.pendingGuidance.map(entry => entry.text)).toEqual(["窗口一引导"]);
    act(() => restoredSecond.result.current.setActiveId("a"));
    expect(restoredSecond.result.current.draft).toBe("窗口二草稿");
    expect(restoredSecond.result.current.pendingGuidance.map(entry => entry.text)).toEqual(["窗口二引导"]);
  });

  it("migrates legacy recovery only into the first Hub window", async () => {
    localStorage.setItem("specloom:active-session:P", "b"); localStorage.setItem("specloom:draft:P:b", "旧草稿");
    localStorage.setItem("specloom:guidance:P", JSON.stringify([{ id: "old", sessionId: "b", runId: "run-b", text: "旧引导" }]));
    const f = sessionBridge(); const onError = vi.fn(); const onFinished = vi.fn();
    const other = renderHook(() => useChatSessions(f.api, "P", onError, onFinished, undefined, "hub-window-2"));
    await waitFor(() => expect(other.result.current.sessions).toHaveLength(2));
    expect(other.result.current.activeId).toBe("a"); expect(other.result.current.pendingGuidance).toEqual([]); expect(other.result.current.draft).toBe("");
    const first = renderHook(() => useChatSessions(f.api, "P", onError, onFinished, undefined, "hub-window-1"));
    await waitFor(() => expect(first.result.current.sessions).toHaveLength(2));
    expect(first.result.current.activeId).toBe("b"); expect(first.result.current.draft).toBe("旧草稿");
    expect(first.result.current.pendingGuidance.map(entry => entry.text)).toEqual(["旧引导"]);
    expect(localStorage.getItem("specloom:guidance:P:window:hub-window-1")).toContain("旧引导");
  });

  it("remounts the Workbench when the initial window identity arrives", async () => {
    const f = stateBridge(); const sessions = sessionBridge();
    f.setState({ ...f.state(), project: { ...f.state().project!, path: "P" }, tasks: [] });
    const api: DesktopApi = { ...f.api, sessions: sessions.api }; Object.defineProperty(window, "specloom", { configurable: true, value: api });
    render(<App />); await screen.findByLabelText("任务消息");
    const queued = [{ id: "scoped", sessionId: "a", runId: "run-a", text: "窗口专属引导" }];
    localStorage.setItem("specloom:guidance:P:window:hub-window-2", JSON.stringify(queued));
    f.setState({ ...f.state(), windowId: "hub-window-2" });
    f.notify();
    expect(await screen.findByRole("region", { name: "待引导消息" })).toHaveTextContent("窗口专属引导");
  });

  it("inherits the latest global navigation preference when a different Hub slot opens", async () => {
    const f = stateBridge(); Object.defineProperty(window, "specloom", { configurable: true, value: f.api });
    localStorage.setItem("specloom.navigation", "expanded");
    f.setState({ ...f.state(), windowId: "hub-window-2" });
    const mounted = render(<App />); await screen.findByRole("navigation", { name: "项目视图" });
    expect(screen.getByRole("button", { name: "收起导航" })).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "收起导航" }));
    expect(localStorage.getItem("specloom.navigation")).toBe("collapsed");
    mounted.unmount(); f.setState({ ...f.state(), windowId: "hub-window-1" }); render(<App />);
    await screen.findByRole("navigation", { name: "项目视图" });
    expect(screen.getByRole("button", { name: "展开导航" })).toHaveAttribute("aria-expanded", "false");
  });
});

describe("retained archive metadata", () => {
  it("refreshes peer mutations and does not revive an old event snapshot after peer deletion", async () => {
    const f = sessionBridge([session("a", { title: "已归档", archived: true, status: "idle" })]);
    const api: DesktopApi = { ...fixture().api, sessions: f.api };
    const view = render(<ArchivedSessionsView api={api} projectPath="P" onError={vi.fn()} onSelect={vi.fn()} />);
    await screen.findByRole("heading", { name: "已归档" });
    const streamed = session("a", { title: "事件归档", archived: true, status: "idle", revision: 2, seq: 1 });
    act(() => { for (const listener of f.events) listener({ projectPath: "P", sessionId: "a", runId: streamed.runId!, seq: 1, session: streamed }); });
    expect(screen.getByRole("heading", { name: "事件归档" })).toBeVisible();
    f.replace([session("a", { title: "同伴改名", archived: true, status: "idle", revision: 3 })]); f.notify("Other");
    await act(async () => { await Promise.resolve(); }); expect(f.api.list).toHaveBeenCalledOnce();
    act(() => { f.notify(); f.notify(); });
    await screen.findByRole("heading", { name: "同伴改名" }); expect(f.api.list).toHaveBeenCalledTimes(2);
    f.replace([]); f.notify();
    await waitFor(() => expect(screen.queryByRole("heading", { name: "同伴改名" })).not.toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "事件归档" })).not.toBeInTheDocument();
    f.notify(); await waitFor(() => expect(f.api.list).toHaveBeenCalledTimes(4));
    expect(screen.getByText("没有归档会话。")).toBeVisible();
    view.unmount(); expect(f.changes.size).toBe(0); expect(f.events.size).toBe(0);
  });

  it("preserves an archive event that is newer than an in-flight metadata read", async () => {
    const f = sessionBridge([session("a", { title: "已归档", archived: true, status: "idle" })]);
    const api: DesktopApi = { ...fixture().api, sessions: f.api };
    render(<ArchivedSessionsView api={api} projectPath="P" onError={vi.fn()} onSelect={vi.fn()} />);
    await screen.findByRole("heading", { name: "已归档" });
    const pending = deferred<ChatSession[]>(); f.api.list.mockImplementationOnce(() => pending.promise); f.notify();
    await waitFor(() => expect(f.api.list).toHaveBeenCalledTimes(2));
    const streamed = session("new", { title: "新事件归档", archived: true, status: "idle", revision: 3, seq: 2 });
    act(() => { for (const listener of f.events) listener({ projectPath: "P", sessionId: "new", runId: streamed.runId!, seq: 2, session: streamed }); });
    await act(async () => pending.resolve([]));
    expect(screen.getByRole("heading", { name: "新事件归档" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "已归档" })).not.toBeInTheDocument();
  });

  it("clears the prior project while the new project's archived sessions are loading", async () => {
    const f = sessionBridge([session("a", { title: "旧项目归档", archived: true, status: "idle" })]);
    const props = { api: { ...fixture().api, sessions: f.api }, onError: vi.fn(), onSelect: vi.fn() };
    const view = render(<ArchivedSessionsView {...props} projectPath="P" />);
    await screen.findByRole("heading", { name: "旧项目归档" });
    const pending = deferred<ChatSession[]>(); f.api.list.mockImplementationOnce(() => pending.promise);
    view.rerender(<ArchivedSessionsView {...props} projectPath="Q" />);
    expect(screen.queryByRole("heading", { name: "旧项目归档" })).not.toBeInTheDocument();
    await act(async () => pending.resolve([session("q", { title: "新项目归档", archived: true, status: "idle" })]));
    expect(screen.getByRole("heading", { name: "新项目归档" })).toBeVisible();
  });
});
