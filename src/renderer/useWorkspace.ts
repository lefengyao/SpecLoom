import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChangeReview,
  DesktopApi,
  WorkspaceState,
} from "../shared/desktop-api";
import type { FileVersion, TaskScopeSpec } from "../shared/contracts";
import type { ChatMessage } from "./WorkspaceView";
import { describeError, isTerminal, type UiError } from "./ui";

export function useWorkspace(api?: DesktopApi) {
  const [state, setState] = useState<WorkspaceState>({ tasks: [], models: [] });
  const [selectedId, setSelectedId] = useState("");
  const currentTask = useRef(selectedId);
  currentTask.current = selectedId;
  const [review, setReview] = useState<ChangeReview>();
  const [error, setError] = useState<UiError>();
  const [busy, setBusy] = useState(false);
  const [pendingTasks, setPendingTasks] = useState<string[]>([]);
  const [chats, setChats] = useState<Record<string, ChatMessage[]>>({});
  const selected = state.tasks.find((task) => task.id === selectedId);
  const running =
    !!selected && (selected.running || pendingTasks.includes(selected.id));
  const reportError = useCallback((value: unknown) => {
    setError(describeError(value));
  }, []);
  const refresh = useCallback(async () => {
    if (!api) return;
    const next = await api.state();
    setState(next);
    setSelectedId((current) =>
      next.tasks.some((task) => task.id === current)
        ? current
        : (next.tasks.at(-1)?.id ?? ""),
    );
  }, [api]);
  useEffect(() => {
    void refresh().catch(reportError);
  }, [refresh, reportError]);
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
    await perform(async () => {
      setState(example ? await api.createExample() : await api.selectProject());
      setSelectedId("");
      setReview(undefined);
      setChats({});
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
  async function send(modelId: string, prompt: string) {
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
  async function stageDocument(
    path: string,
    content: string,
    loadedVersion?: string,
  ) {
    if (!api) return undefined;
    return perform(async () => {
      const task = await api.createTask({
        title: `编辑 ${path}`,
        readPaths: [path],
        writePaths: [path],
        allowDelete: false,
        mode: "manual",
      });
      await refresh();
      setSelectedId(task.id);
      const [version] = (await api.tool(task.id, "files.list_versions", {
        paths: [path],
      })) as FileVersion[];
      if (!version)
        throw Object.assign(new Error("未获取文件版本"), {
          code: "FILE_NOT_FOUND",
          details: { path },
        });
      if (loadedVersion && loadedVersion !== version.version)
        throw Object.assign(new Error("文档已变化，请重新读取后再暂存"), {
          code: "VERSION_CONFLICT",
          details: { path },
        });
      if (version.exists)
        await api.tool(task.id, "files.read", {
          path,
          expectedVersion: version.version,
        });
      await api.tool(task.id, "files.write", {
        path,
        content,
        expectedVersion: version.version,
      });
      await inspect(task.id);
      await refresh();
      return task;
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
    pendingTasks,
    refresh,
    perform,
    openProject,
    createTask,
    refreshReview,
    send,
    reviewAction,
    stageDocument,
    reread,
    cancel: () => {
      if (api && selected) void api.cancel(selected.id).catch(reportError);
    },
  };
}
