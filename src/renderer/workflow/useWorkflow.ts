import { useCallback, useEffect, useRef, useState } from "react";
import { stringify } from "yaml";
import type { VersionToken } from "../../shared/contracts";
import type { DesktopApi, WorkflowApi } from "../../shared/desktop-api";
import { errorMessage } from "../../shared/error-message";
import { OFFICIAL_WORKFLOW_ID, type WorkflowSettings } from "../../shared/orchestration";
import type { WorkflowDefinition, WorkflowNode } from "../../shared/workflow";
import { addReadAgent as addReadAgentToDefinition, canRemoveNode, connectSuccess, deleteEdges as deleteEdgesFromDefinition, removeReadAgent } from "./workflow-editing";
import type {
  WorkflowNodeStatus,
  WorkflowRetryAction,
  WorkflowRun,
  WorkflowRunInputs,
  WorkflowSource,
  WorkflowSummary,
  WorkflowUpdate,
} from "../../shared/workflow-api";

/** The page has three modes: authoring a definition, composing orchestrations, and running. */
export type WorkflowMode = "workflow" | "orchestration" | "run";

export const workflowRunStatusLabels: Record<WorkflowRun["status"], string> = {
  queued: "排队中",
  running: "运行中",
  waiting_approval: "等待审批",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};

export const workflowNodeStatusLabels: Record<WorkflowNodeStatus, string> = {
  pending: "待执行",
  running: "运行中",
  waiting_approval: "等待审批",
  completed: "已完成",
  failed: "失败",
  skipped: "已跳过",
};

export const workflowNodeTypeLabels: Record<WorkflowNode["type"], string> = {
  context: "上下文",
  agent: "智能体",
  validation: "校验",
  approval: "审批",
  decision: "决策",
};

/** The short badge shown on a canvas card; agents read as 规划 or 实现. */
export function workflowNodeBadge(node: WorkflowNode): string {
  if (node.type === "agent") return node.config.access === "write" ? "实现" : "规划";
  return workflowNodeTypeLabels[node.type];
}

/** Unique id for a copied official workflow, e.g. wf_review_m1abcdef. */
export function workflowCopyId(now: number = Date.now()): string {
  return "wf_review_" + now.toString(36);
}

/** Unique id for a freshly created blank workflow, e.g. wf_custom_m1abcdef. */
export function workflowBlankId(now: number = Date.now()): string {
  return "wf_custom_" + now.toString(36);
}

/**
 * A valid B definition: one read/plan agent, one write agent, one validation,
 * one approval, one decision, and the single approval -> write reject edge.
 */
export function createBlankWorkflowDefinition(id: string, title = "新建工作流"): WorkflowDefinition {
  return {
    schemaVersion: 1,
    id,
    title,
    description: "自定义开发审查流程。",
    version: 1,
    inputs: [
      { key: "goal", label: "目标", type: "string", required: true },
      { key: "readPaths", label: "读取范围", type: "paths", required: true },
      { key: "writePaths", label: "修改范围", type: "paths", required: true },
      { key: "model", label: "模型", type: "model", required: false },
    ],
    nodes: [
      { id: "context", type: "context", label: "读取规范", position: { x: 80, y: 120 }, config: {} },
      {
        id: "plan",
        type: "agent",
        label: "规划",
        position: { x: 260, y: 120 },
        config: { access: "read", prompt: "阅读运行范围内的项目资料，输出可执行的实现计划；不得修改文件。" },
      },
      {
        id: "implement",
        type: "agent",
        label: "Agent 实现",
        position: { x: 440, y: 120 },
        config: { access: "write", prompt: "根据目标和计划实现改动；只写 writePaths 允许的路径；完成后总结改动与验证建议。" },
      },
      { id: "validate", type: "validation", label: "自动校验", position: { x: 620, y: 120 }, config: {} },
      { id: "review", type: "approval", label: "人工审查", position: { x: 800, y: 120 }, config: { allowReject: true } },
      { id: "decide", type: "decision", label: "记录决策", position: { x: 980, y: 120 }, config: { directory: "specs/decisions" } },
    ],
    edges: [
      { id: "e1", from: "context", to: "plan", on: "success" },
      { id: "e2", from: "plan", to: "implement", on: "success" },
      { id: "e3", from: "implement", to: "validate", on: "success" },
      { id: "e4", from: "validate", to: "review", on: "success" },
      { id: "e5", from: "review", to: "decide", on: "success" },
      { id: "e6", from: "review", to: "implement", on: "reject" },
    ],
    settings: { maxImplementAttempts: 3, approvalPolicy: "manual" },
  };
}

export interface UseWorkflowResult {
  /** False when the desktop bridge has no workflow API. */
  available: boolean;
  summaries: WorkflowSummary[];
  selectedId: string | undefined;
  definition: WorkflowDefinition | undefined;
  source: WorkflowSource | undefined;
  fileVersion: VersionToken | undefined;
  dirty: boolean;
  loading: boolean;
  error: string | undefined;
  mode: WorkflowMode;
  /** True when the host exposes the workflow defaults namespace. */
  defaultsAvailable: boolean;
  /** The project workflow settings; empty when no override exists. */
  settings: WorkflowSettings;
  /** The project override id, or undefined when the official global default applies. */
  projectDefaultId: string | undefined;
  /** True when the stored project default no longer resolves to a listed workflow. */
  defaultMissing: boolean;
  run: WorkflowRun | undefined;
  runs: WorkflowRun[];
  runLoading: boolean;
  setMode: (mode: WorkflowMode) => void;
  setDefault: (id: string) => Promise<void>;
  restoreDefault: () => Promise<void>;
  select: (id: string) => Promise<void>;
  openRun: (run: WorkflowRun) => Promise<void>;
  refresh: () => Promise<void>;
  save: () => Promise<void>;
  newBlank: () => Promise<void>;
  copyOfficial: () => Promise<void>;
  removeSelected: () => Promise<void>;
  addReadAgent: () => string | undefined;
  removeNode: (id: string) => void;
  connectNodes: (source: string, target: string) => void;
  deleteEdges: (ids: string[]) => void;
  canRemoveNode: (id: string) => boolean;
  updateNode: (id: string, update: (node: WorkflowNode) => WorkflowNode) => void;
  moveNode: (id: string, position: { x: number; y: number }) => void;
  start: (inputs: WorkflowRunInputs) => Promise<void>;
  approve: (digest: string) => Promise<void>;
  reject: () => Promise<void>;
  cancel: () => Promise<void>;
  retry: (action: WorkflowRetryAction) => Promise<void>;
  clearError: () => void;
}

/**
 * Renderer-side workflow state: the project definition list, the selected
 * definition draft, and the current run. It owns every workflow API call so the
 * page components stay presentational, and it is a no-op when the desktop
 * bridge does not expose a workflow API.
 */
export function useWorkflow(
  api: DesktopApi | undefined,
  projectPath: string,
  onError?: (error: unknown) => void,
): UseWorkflowResult {
  const workflow = api?.workflow;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const mounted = useRef(true);
  const runIdRef = useRef<string | undefined>(undefined);
  const selectedIdRef = useRef<string | undefined>(undefined);

  const [summaries, setSummaries] = useState<WorkflowSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [definition, setDefinition] = useState<WorkflowDefinition | undefined>(undefined);
  const [source, setSource] = useState<WorkflowSource | undefined>(undefined);
  const [fileVersion, setFileVersion] = useState<VersionToken | undefined>(undefined);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [mode, setMode] = useState<WorkflowMode>("workflow");
  const [settings, setSettings] = useState<WorkflowSettings>({ schemaVersion: 1 });
  const [run, setRun] = useState<WorkflowRun | undefined>(undefined);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [runLoading, setRunLoading] = useState(false);
  const defaults = workflow?.defaults;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    runIdRef.current = run?.runId;
  }, [run]);

  const fail = useCallback((cause: unknown) => {
    if (mounted.current) setError(errorMessage(cause));
    onErrorRef.current?.(cause);
  }, []);

  /** Read the project default settings; an unavailable defaults API is a no-op. */
  const refreshDefaults = useCallback(async (): Promise<void> => {
    if (!defaults) return;
    try {
      const loaded = await defaults.read();
      if (mounted.current) setSettings(loaded);
    } catch (cause) {
      fail(cause);
    }
  }, [defaults, fail]);

  /** Load the definition into the draft and mark it clean. */
  const openWorkflow = useCallback(
    async (id: string): Promise<void> => {
      if (!workflow) return;
      const loaded = await workflow.read(id);
      if (!mounted.current) return;
      selectedIdRef.current = id;
      setSelectedId(id);
      setDefinition(loaded.definition);
      setSource(loaded);
      setFileVersion(loaded.fileVersion);
      setDirty(false);
    },
    [workflow],
  );

  const listWorkflows = useCallback(async (): Promise<WorkflowSummary[] | undefined> => {
    if (!workflow) return undefined;
    const list = await workflow.list();
    if (!mounted.current) return undefined;
    setSummaries(list);
    return list;
  }, [workflow]);

  const reloadRuns = useCallback(
    async (runId: string): Promise<void> => {
      if (!workflow) return;
      try {
        const latest = await workflow.getRun(runId);
        if (mounted.current && runIdRef.current === runId) setRun(latest);
      } catch {
        // A best-effort sync after an action must not surface a second error.
      }
    },
    [workflow],
  );

  const refreshRuns = useCallback(async (): Promise<void> => {
    if (!workflow) return;
    try {
      const list = await workflow.listRuns();
      if (mounted.current) setRuns(list);
    } catch (cause) {
      fail(cause);
    }
  }, [workflow, fail]);

  /** Open a historical run and load the workflow it belongs to. */
  const openRun = useCallback(
    async (candidate: WorkflowRun): Promise<void> => {
      setMode("run");
      runIdRef.current = candidate.runId;
      setRun(candidate);
      if (candidate.workflowId !== selectedIdRef.current) {
        try {
          await openWorkflow(candidate.workflowId);
        } catch (cause) {
          fail(cause);
        }
      }
    },
    [openWorkflow, fail],
  );

  const setDefault = useCallback(
    async (id: string): Promise<void> => {
      if (!defaults) {
        setError("当前桌面版本不支持设置默认工作流。");
        return;
      }
      setLoading(true);
      setError(undefined);
      try {
        const saved = await defaults.save({ schemaVersion: 1, defaultWorkflowId: id });
        if (mounted.current) setSettings(saved);
      } catch (cause) {
        fail(cause);
      } finally {
        if (mounted.current) setLoading(false);
      }
    },
    [defaults, fail],
  );

  const restoreDefault = useCallback(async (): Promise<void> => {
    if (!defaults) {
      setError("当前桌面版本不支持恢复全局默认。");
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      const cleared = await defaults.clear();
      if (mounted.current) setSettings(cleared);
    } catch (cause) {
      fail(cause);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [defaults, fail]);

  const select = useCallback(
    async (id: string): Promise<void> => {
      if (!workflow || id === selectedIdRef.current) return;
      if (dirty) {
        let proceed = true;
        try {
          proceed = typeof window.confirm === "function" ? window.confirm("当前工作流有未保存的修改，切换后将丢弃。继续？") : true;
        } catch {
          proceed = true;
        }
        if (!proceed) return;
      }
      setLoading(true);
      setError(undefined);
      try {
        await openWorkflow(id);
      } catch (cause) {
        fail(cause);
      } finally {
        if (mounted.current) setLoading(false);
      }
    },
    [workflow, dirty, openWorkflow, fail],
  );

  const refresh = useCallback(async (): Promise<void> => {
    if (!workflow) return;
    setLoading(true);
    setError(undefined);
    try {
      await listWorkflows();
      const id = selectedIdRef.current;
      // Never discard an unsaved draft just because the list was refreshed.
      if (id && !dirty) await openWorkflow(id);
    } catch (cause) {
      fail(cause);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [workflow, listWorkflows, openWorkflow, dirty, fail]);

  const save = useCallback(async (): Promise<void> => {
    if (!workflow || !definition || !fileVersion) return;
    setLoading(true);
    setError(undefined);
    try {
      const content = stringify(definition, { lineWidth: 0 });
      const result = await workflow.save(definition.id, content, fileVersion);
      if (!mounted.current) return;
      setFileVersion(result.fileVersion);
      setSource({ definition, fileVersion: result.fileVersion, source: content });
      setDirty(false);
      await listWorkflows();
    } catch (cause) {
      fail(cause);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [workflow, definition, fileVersion, listWorkflows, fail]);

  const newBlank = useCallback(async (): Promise<void> => {
    if (!workflow) return;
    setLoading(true);
    setError(undefined);
    try {
      const id = workflowBlankId();
      const draft = createBlankWorkflowDefinition(id);
      const content = stringify(draft, { lineWidth: 0 });
      const result = await workflow.save(id, content, "absent");
      if (!mounted.current) return;
      await listWorkflows();
      if (!mounted.current) return;
      selectedIdRef.current = id;
      setSelectedId(id);
      setDefinition(draft);
      setSource({ definition: draft, fileVersion: result.fileVersion, source: content });
      setFileVersion(result.fileVersion);
      setDirty(false);
      setRun(undefined);
    } catch (cause) {
      fail(cause);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [workflow, listWorkflows, fail]);

  const copyOfficial = useCallback(async (): Promise<void> => {
    if (!workflow) return;
    setLoading(true);
    setError(undefined);
    try {
      const id = workflowCopyId();
      const copied = await workflow.copyOfficial(id);
      if (!mounted.current) return;
      const loaded = await workflow.read(copied.id);
      if (!mounted.current) return;
      await listWorkflows();
      if (!mounted.current) return;
      selectedIdRef.current = copied.id;
      setSelectedId(copied.id);
      setDefinition(loaded.definition);
      setSource(loaded);
      setFileVersion(loaded.fileVersion);
      setDirty(false);
      setRun(undefined);
    } catch (cause) {
      fail(cause);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [workflow, listWorkflows, fail]);

  const removeSelected = useCallback(async (): Promise<void> => {
    if (!workflow || !definition || !fileVersion) return;
    const id = definition.id;
    setLoading(true);
    setError(undefined);
    try {
      await workflow.remove(id, fileVersion);
      if (!mounted.current) return;
      selectedIdRef.current = undefined;
      setSelectedId(undefined);
      setDefinition(undefined);
      setSource(undefined);
      setFileVersion(undefined);
      setDirty(false);
      setRun(undefined);
      setRuns((current) => current.filter((item) => item.workflowId !== id));
      const list = await workflow.list();
      if (!mounted.current) return;
      setSummaries(list);
      const first = list[0];
      if (first) await openWorkflow(first.id);
    } catch (cause) {
      fail(cause);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [workflow, definition, fileVersion, openWorkflow, fail]);

  const addReadAgent = useCallback((): string | undefined => {
    if (!definition) return undefined;
    const id = "read_" + crypto.randomUUID().replace(/-/g, "").slice(0, 10);
    setDefinition((current) => {
      if (!current) return current;
      const added = addReadAgentToDefinition(current, id);
      if (!added) return current;
      setDirty(true);
      return added.definition;
    });
    return id;
  }, [definition]);

  const removeNode = useCallback((id: string): void => {
    setDefinition((current) => {
      if (!current) return current;
      const next = removeReadAgent(current, id);
      if (!next) return current;
      setDirty(true);
      return next;
    });
  }, []);

  const connectNodes = useCallback((source: string, target: string): void => {
    const id = "e_" + crypto.randomUUID().replace(/-/g, "").slice(0, 10);
    setDefinition((current) => {
      if (!current) return current;
      const next = connectSuccess(current, source, target, id);
      if (!next) return current;
      setDirty(true);
      return next;
    });
  }, []);

  const deleteEdges = useCallback((ids: string[]): void => {
    if (!ids.length) return;
    setDefinition((current) => {
      if (!current) return current;
      setDirty(true);
      return deleteEdgesFromDefinition(current, ids);
    });
  }, []);

  const canDeleteNode = useCallback((id: string): boolean => Boolean(definition && canRemoveNode(definition, id)), [definition]);

  const updateNode = useCallback((id: string, update: (node: WorkflowNode) => WorkflowNode): void => {
    setDefinition((current) => {
      if (!current) return current;
      let changed = false;
      const nodes = current.nodes.map((node) => {
        if (node.id !== id) return node;
        const next = update(node);
        changed = changed || next !== node;
        return next;
      });
      return changed ? { ...current, nodes } : current;
    });
    setDirty(true);
  }, []);

  const moveNode = useCallback((id: string, position: { x: number; y: number }): void => {
    setDefinition((current) => {
      if (!current) return current;
      let changed = false;
      const nodes = current.nodes.map((node) => {
        if (node.id !== id) return node;
        if (node.position.x === position.x && node.position.y === position.y) return node;
        changed = true;
        return { ...node, position } as WorkflowNode;
      });
      return changed ? { ...current, nodes } : current;
    });
    setDirty(true);
  }, []);

  const start = useCallback(
    async (inputs: WorkflowRunInputs): Promise<void> => {
      if (!workflow || !definition) {
        setError("请先选择或新建一个工作流。");
        return;
      }
      setRunLoading(true);
      setError(undefined);
      try {
        const started = await workflow.start(definition, inputs);
        if (!mounted.current) return;
        runIdRef.current = started.runId;
        setRun(started);
        setRuns((current) => [started, ...current.filter((item) => item.runId !== started.runId)]);
      } catch (cause) {
        fail(cause);
      } finally {
        if (mounted.current) setRunLoading(false);
      }
    },
    [workflow, definition, fail],
  );

  const act = useCallback(
    async (action: (client: WorkflowApi, runId: string) => Promise<void>): Promise<void> => {
      const runId = runIdRef.current;
      if (!workflow || !runId) return;
      setRunLoading(true);
      setError(undefined);
      try {
        await action(workflow, runId);
        await reloadRuns(runId);
        await refreshRuns();
      } catch (cause) {
        fail(cause);
      } finally {
        if (mounted.current) setRunLoading(false);
      }
    },
    [workflow, reloadRuns, refreshRuns, fail],
  );

  const approve = useCallback(
    async (digest: string): Promise<void> => {
      await act((client, runId) => client.approve(runId, digest));
    },
    [act],
  );

  const reject = useCallback(async (): Promise<void> => {
    await act((client, runId) => client.reject(runId));
  }, [act]);

  const cancel = useCallback(async (): Promise<void> => {
    await act((client, runId) => client.cancel(runId));
  }, [act]);

  const retry = useCallback(
    async (action: WorkflowRetryAction): Promise<void> => {
      await act((client, runId) => client.retry(runId, action));
    },
    [act],
  );

  useEffect(() => {
    if (!workflow || typeof workflow.onUpdate !== "function") return;
    return workflow.onUpdate((event: WorkflowUpdate) => {
      if (!mounted.current) return;
      if (event.projectPath !== projectPath) return;
      if (event.run.runId !== runIdRef.current) return;
      setRun(event.run);
      setRuns((current) => current.map((item) => item.runId === event.run.runId ? event.run : item));
    });
  }, [workflow, projectPath]);

  useEffect(() => {
    if (!workflow) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const list = await workflow.list();
        if (cancelled || !mounted.current) return;
        setSummaries(list);
        const first = list[0];
        if (!first) return;
        const loaded = await workflow.read(first.id);
        if (cancelled || !mounted.current) return;
        selectedIdRef.current = first.id;
        setSelectedId(first.id);
        setDefinition(loaded.definition);
        setSource(loaded);
        setFileVersion(loaded.fileVersion);
        setDirty(false);
      } catch (cause) {
        if (!cancelled) fail(cause);
      } finally {
        if (!cancelled && mounted.current) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workflow, fail]);

  useEffect(() => {
    void refreshRuns();
  }, [refreshRuns]);

  useEffect(() => {
    void refreshDefaults();
  }, [refreshDefaults]);

  const projectDefaultId =
    settings.defaultWorkflowId !== undefined && settings.defaultWorkflowId !== OFFICIAL_WORKFLOW_ID
      ? settings.defaultWorkflowId
      : undefined;
  const defaultMissing =
    projectDefaultId !== undefined && !loading && !summaries.some((item) => item.id === projectDefaultId);

  return {
    available: Boolean(workflow),
    summaries,
    selectedId,
    definition,
    source,
    fileVersion,
    dirty,
    loading,
    error,
    mode,
    defaultsAvailable: Boolean(defaults),
    settings,
    projectDefaultId,
    defaultMissing,
    run,
    runs,
    runLoading,
    setMode,
    setDefault,
    restoreDefault,
    select,
    openRun,
    refresh,
    save,
    newBlank,
    copyOfficial,
    removeSelected,
    addReadAgent,
    removeNode,
    connectNodes,
    deleteEdges,
    canRemoveNode: canDeleteNode,
    updateNode,
    moveNode,
    start,
    approve,
    reject,
    cancel,
    retry,
    clearError: () => setError(undefined),
  };
}