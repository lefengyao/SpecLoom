import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChangeReview,
  DesktopApi,
  WorkspaceState,
} from "../shared/desktop-api";
import type { FileVersion, ModelReference, TaskScopeSpec } from "../shared/contracts";
import { defaultPreferences, type Preferences } from "../shared/preferences";
import { playCompletionChime } from "./sound";
import type { ChatMessage } from "./WorkspaceView";
import { describeError, isTerminal, type UiError } from "./ui";

/** Refresh retained panel lists once per burst without touching their local form state. */
export function useStateChangeRefresh(subscribe: DesktopApi["onStateChanged"], refresh: () => Promise<unknown>) {
  useEffect(() => {
    let alive = true; let queued = false;
    const unsubscribe = subscribe?.(() => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (alive) void refresh();
      });
    });
    return () => { alive = false; unsubscribe?.(); };
  }, [subscribe, refresh]);
}

export function useWorkspace(api?: DesktopApi) {
  const [state, setState] = useState<WorkspaceState>({
    tasks: [],
    models: [],
    recent: [],
    preferences: defaultPreferences,
  });
  const [selectedId, updateSelectedId] = useState("");
  const taskSelectionSeq = useRef(0);
  const setSelectedId = useCallback((id: string) => { taskSelectionSeq.current++; updateSelectedId(id); }, []);
  const projectSelectionSeq = useRef(0);
  const refreshSeq = useRef(0);
  const selectingProject = useRef(false);
  const deferredRefresh = useRef(false);
  const currentTask = useRef(selectedId);
  currentTask.current = selectedId;
  /** Monotonic id for preference patches, so stale responses can be discarded. */
  const preferencesSeq = useRef(0);
  const [review, setReview] = useState<ChangeReview>();
  const [error, setError] = useState<UiError>();
  const [busy, setBusy] = useState(false);
  const [pendingTasks, setPendingTasks] = useState<string[]>([]);
  const [chats, setChats] = useState<Record<string, ChatMessage[]>>({});
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatRunning, setChatRunning] = useState(false);
  const selected = state.tasks.find((task) => task.id === selectedId);
  const running =
    chatRunning || (!!selected && (selected.running || pendingTasks.includes(selected.id)));
  const reportError = useCallback((value: unknown) => {
    setError(describeError(value));
  }, []);
  const refresh = useCallback(async () => {
    if (!api) return;
    if (selectingProject.current) { deferredRefresh.current = true; return; }
    const request = ++refreshSeq.current;
    const projectSelection = projectSelectionSeq.current;
    const taskSelection = taskSelectionSeq.current;
    const next = await api.state();
    if (request !== refreshSeq.current || projectSelection !== projectSelectionSeq.current || selectingProject.current) return;
    setState(next);
    if (taskSelection !== taskSelectionSeq.current) return;
    updateSelectedId((current) =>
      api.sessions && !current ? "" :
      next.tasks.some((task) => task.id === current)
        ? current
        : (next.tasks.at(-1)?.id ?? ""),
    );
  }, [api]);
  useEffect(() => {
    let alive = true; let queued = false;
    const unsubscribe = api?.onStateChanged?.(() => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (alive) void refresh().catch(reportError);
      });
    });
    void refresh().catch(reportError);
    return () => { alive = false; refreshSeq.current++; unsubscribe?.(); };
  }, [api, refresh, reportError]);
  useEffect(() => {
    if (!api || !selectedId) {
      setReview(undefined);
      return;
    }
    let current = true;
    setReview(undefined);
    void api.preview(selectedId).then(
      (next) => {
        if (current) setReview(next);
      },
      (value) => {
        if (current) reportError(value);
      },
    );
    return () => {
      current = false;
    };
  }, [api, selectedId, reportError]);
  const polling =
    pendingTasks.length > 0 || state.tasks.some((task) => task.running);
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => {
      void refresh().catch(reportError);
    }, 1000);
    return () => clearInterval(timer);
  }, [polling, refresh, reportError]);
  async function inspect(taskId: string) {
    if (!api || !taskId) return;
    const next = await api.preview(taskId);
    if (taskId === currentTask.current) setReview(next);
  }
  async function perform<T>(action: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(undefined);
    try {
      return await action();
    } catch (value) {
      reportError(value);
      try {
        await refresh();
        await inspect(currentTask.current);
      } catch {
        /* Preserve the operation's original error. */
      }
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  async function openProject(example = false) {
    if (!api) return;
    await selectProject(() => example ? api.createExample() : api.selectProject());
  }
  async function selectProject(action: () => Promise<WorkspaceState>) {
    const selection = ++projectSelectionSeq.current;
    refreshSeq.current++;
    selectingProject.current = true;
    try { await perform(async () => {
      const next = await action();
      if (selection !== projectSelectionSeq.current) return;
      refreshSeq.current++;
      setState(next);
      setSelectedId("");
      setReview(undefined);
      setChats({});
      setChatMessages([]);
    }); } finally {
      if (selection === projectSelectionSeq.current) {
        selectingProject.current = false;
        if (deferredRefresh.current) { deferredRefresh.current = false; await refresh().catch(reportError); }
      }
    }
  }
  /** Reopens a project from the home list without a directory picker. */
  async function openRecent(path: string) {
    if (!api) return;
    await selectProject(() => api.openProject(path));
  }
  async function forgetRecent(path: string) {
    if (!api) return;
    const selection = projectSelectionSeq.current;
    await perform(async () => {
      const next = await api.forgetProject(path);
      if (selection === projectSelectionSeq.current && !selectingProject.current) { refreshSeq.current++; setState(next); }
    });
  }
  async function updatePreferences(patch: Partial<Preferences>) {
    if (!api) return;
    const seq = ++preferencesSeq.current;
    const selection = projectSelectionSeq.current;
    await perform(async () => {
      const next = await api.updatePreferences(patch);
      // Two edits made in quick succession can resolve out of order. Applying an
      // older response would visibly revert a setting the user just changed, so
      // only the newest one is allowed to touch the UI.
      if (seq === preferencesSeq.current && selection === projectSelectionSeq.current && !selectingProject.current) { refreshSeq.current++; setState(next); }
    });
  }
  async function createTask(scope: Omit<TaskScopeSpec, "id">) {
    if (!api) return undefined;
    return perform(async () => {
      const task = await api.createTask(scope);
      await refresh();
      setSelectedId(task.id);
      return task;
    });
  }
  async function refreshReview(taskId = selectedId) {
    if (!api || !taskId) return;
    await perform(async () => {
      await inspect(taskId);
      await refresh();
    });
  }
  async function send(modelId: string | ModelReference, prompt: string) {
    if (!api || !selected || running || isTerminal(selected.status)) return;
    const id = selected.id;
    setError(undefined);
    setPendingTasks((current) => [...current, id]);
    setChats((current) => ({
      ...current,
      [id]: [...(current[id] ?? selected.conversation ?? []), { role: "user", content: prompt }],
    }));
    try {
      const result = await api.agent(id, modelId, prompt);
      setChats((current) => ({
        ...current,
        [id]: [
          ...(current[id] ?? []),
          { role: "assistant", content: result.summary },
        ],
      }));
      playCompletionChime();
    } catch (value) {
      reportError(value);
    } finally {
      setPendingTasks((current) => current.filter((task) => task !== id));
      try {
        await refresh();
        await inspect(id);
      } catch (value) {
        reportError(value);
      }
    }
  }
  async function sendConversation(modelId: string | ModelReference, prompt: string) {
    if (!api?.chat || chatRunning) return;
    const previousMessages = chatMessages;
    setError(undefined);
    setChatRunning(true);
    setChatMessages((current) => [...current, { role: "user", content: prompt }]);
    try {
      const result = await api.chat(modelId, prompt, previousMessages);
      setChatMessages((current) => [...current, { role: "assistant", content: result.summary }]);
      playCompletionChime();
    } catch (value) {
      reportError(value);
    } finally {
      setChatRunning(false);
    }
  }
  async function reviewAction(action: "approve" | "reject" | "validate") {
    if (
      !api ||
      !selectedId ||
      running ||
      (action !== "validate" && review?.changeSet.taskId !== selectedId)
    )
      return;
    await perform(async () => {
      if (action === "approve" && review)
        await api.approve(selectedId, review.changeSet.digest);
      if (action === "reject") await api.reject(selectedId);
      if (action === "validate") await api.validate(selectedId);
      await inspect(selectedId);
      await refresh();
    });
  }
  async function reread() {
    if (!api) return;
    await perform(async () => {
      if (selected && error?.path) {
        const inspection = isTerminal(selected.status)
          ? await api.createTask({
              title: `读取 ${error.path}`,
              readPaths: [error.path],
              writePaths: [],
              mode: "manual",
              allowDelete: false,
            })
          : selected;
        const [file] = (await api.tool(inspection.id, "files.list_versions", {
          paths: [error.path],
        })) as FileVersion[];
        if (file?.exists)
          await api.tool(inspection.id, "files.read", {
            path: file.path,
            expectedVersion: file.version,
          });
      }
      await refresh();
      await inspect(selectedId);
    });
  }
  return {
    state,
    selected,
    selectedId,
    setSelectedId,
    review: review?.changeSet.taskId === selectedId ? review : undefined,
    error,
    setError,
    reportError,
    busy,
    running,
    chats,
    chatMessages,
    chatRunning,
    pendingTasks,
    refresh,
    perform,
    openProject,
    openRecent,
    forgetRecent,
    updatePreferences,
    createTask,
    refreshReview,
    send,
    sendConversation,
    reviewAction,
    reread,
    cancel: () => {
      if (!api) return;
      if (selected) void api.cancel(selected.id).catch(reportError);
      else if (api.cancelChat) void api.cancelChat().catch(reportError);
    },
  };
}
