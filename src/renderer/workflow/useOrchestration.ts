import { useCallback, useEffect, useRef, useState } from "react";
import { stringify } from "yaml";
import type { VersionToken } from "../../shared/contracts";
import type { DesktopApi, OrchestrationsApi } from "../../shared/desktop-api";
import { errorMessage } from "../../shared/error-message";
import {
  OFFICIAL_WORKFLOW_ID,
  type OrchestrationApproval,
  type OrchestrationDefinition,
  type OrchestrationRun,
  type OrchestrationStep,
} from "../../shared/orchestration";
import type { OrchestrationSource, OrchestrationSummary } from "../../shared/orchestration-api";
import type {
  WorkflowRetryAction,
  WorkflowRun,
  WorkflowRunInputs,
  WorkflowSummary,
} from "../../shared/workflow-api";
import { useI18n, type Translate } from "../i18n";

/** A draft orchestration: either a stored definition or a temporary, unsaved queue. */
export interface OrchestrationDraft {
  id: string;
  title: string;
  description: string;
  steps: OrchestrationStep[];
  /** The content version the draft was read from; undefined for a temporary queue. */
  fileVersion: VersionToken | undefined;
  dirty: boolean;
}

export const orchestrationRunStatusLabels: Record<OrchestrationRun["status"], string> = {
  queued: "排队中",
  running: "运行中",
  waiting_approval: "等待审批",
  failed: "失败",
  completed: "已完成",
  cancelled: "已取消",
  interrupted: "已中断",
};

export const orchestrationStepStatusLabels: Record<OrchestrationRun["steps"][number]["status"], string> = {
  pending: "待执行",
  running: "运行中",
  waiting_approval: "等待审批",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  skipped: "已跳过",
};

export const orchestrationApprovalLabels: Record<OrchestrationApproval, string> = {
  inherit: "继承",
  always: "人工",
  auto: "自动",
};

/** True when a step's approval will let the orchestrator approve without a person. */
export function isAutoApproval(approval: OrchestrationApproval): boolean {
  return approval === "auto";
}

/** The default title of a temporary queue or freshly created orchestration. */
export const ORCHESTRATION_DEFAULT_TITLE = "新建编排";

/** Unique id for a new temporary queue, e.g. orch_m1abcdef. */
export function orchestrationBlankId(now: number = Date.now()): string {
  return "orch_" + now.toString(36);
}

/** A unique step id; the store only requires uniqueness inside one definition. */
export function orchestrationStepId(): string {
  return "step_" + crypto.randomUUID().replace(/-/g, "").slice(0, 10);
}

export function draftFromSource(source: OrchestrationSource): OrchestrationDraft {
  return {
    id: source.definition.id,
    title: source.definition.title,
    description: source.definition.description,
    steps: source.definition.steps.map((step) => ({ ...step })),
    fileVersion: source.fileVersion,
    dirty: false,
  };
}

export function blankOrchestrationDraft(now: number = Date.now()): OrchestrationDraft {
  return {
    id: orchestrationBlankId(now),
    title: ORCHESTRATION_DEFAULT_TITLE,
    description: "",
    steps: [],
    fileVersion: undefined,
    dirty: true,
  };
}

export function knownWorkflowIds(workflows: WorkflowSummary[]): ReadonlySet<string> {
  return new Set([OFFICIAL_WORKFLOW_ID, ...workflows.map((workflow) => workflow.id)]);
}

/**
 * Return a readable reason the draft cannot be saved or run, or undefined.
 *
 * References are checked against the loaded project list plus the official
 * virtual id; a missing workflow is a run-time error on the main process, so the
 * renderer blocks the action and names the step instead of starting a doomed run.
 */
export function orchestrationDraftError(
  draft: OrchestrationDraft,
  workflows: WorkflowSummary[],
  tr: Translate = (text: string) => text,
): string | undefined {
  if (draft.title.trim().length === 0) return tr("请填写编排名称。");
  if (draft.steps.length === 0) return tr("编排至少需要一个步骤。");
  const known = knownWorkflowIds(workflows);
  for (const [index, step] of draft.steps.entries()) {
    if (!known.has(step.workflowId)) {
      return tr("步骤 {index} 引用的工作流 {id} 不存在，请重新选择。", { index: index + 1, id: step.workflowId });
    }
  }
  return undefined;
}

export interface UseOrchestrationResult {
  /** False when the desktop bridge has no orchestration API. */
  available: boolean;
  summaries: OrchestrationSummary[];
  selectedId: string | undefined;
  draft: OrchestrationDraft | undefined;
  dirty: boolean;
  loading: boolean;
  error: string | undefined;
  runs: OrchestrationRun[];
  run: OrchestrationRun | undefined;
  /** The child WorkflowRun of the current step, when it exists. */
  childRun: WorkflowRun | undefined;
  runLoading: boolean;
  select: (id: string) => Promise<void>;
  newDraft: () => void;
  setTitle: (title: string) => void;
  setDescription: (description: string) => void;
  addStep: (workflowId: string) => void;
  updateStep: (id: string, patch: { workflowId?: string; approval?: OrchestrationApproval }) => void;
  removeStep: (id: string) => void;
  moveStep: (id: string, direction: "up" | "down") => void;
  save: () => Promise<void>;
  removeSelected: () => Promise<void>;
  start: (inputs: WorkflowRunInputs) => Promise<void>;
  approveStep: (digest: string) => Promise<void>;
  rejectStep: () => Promise<void>;
  retryStep: (action: WorkflowRetryAction) => Promise<void>;
  cancel: () => Promise<void>;
  openRun: (run: OrchestrationRun) => Promise<void>;
  refresh: () => Promise<void>;
  clearError: () => void;
}

/**
 * Renderer-side orchestration state.
 *
 * One draft is edited at a time; it is either a stored project orchestration or
 * a temporary, unsaved queue. Starting a temporary queue persists it first
 * because the main process starts orchestrations by id, then starts that id.
 */
export function useOrchestration(
  api: DesktopApi | undefined,
  projectPath: string,
  workflows: WorkflowSummary[],
  onError?: (error: unknown) => void,
): UseOrchestrationResult {
  const tr = useI18n();
  const workflow = api?.workflow;
  const orchestrations = workflow?.orchestrations;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const mounted = useRef(true);
  const runIdRef = useRef<string | undefined>(undefined);
  const childIdRef = useRef<string | undefined>(undefined);
  const selectedIdRef = useRef<string | undefined>(undefined);

  const [summaries, setSummaries] = useState<OrchestrationSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState<OrchestrationDraft | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [runs, setRuns] = useState<OrchestrationRun[]>([]);
  const [run, setRun] = useState<OrchestrationRun | undefined>(undefined);
  const [childRun, setChildRun] = useState<WorkflowRun | undefined>(undefined);
  const [runLoading, setRunLoading] = useState(false);

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
    runIdRef.current = run?.orchestrationRunId;
  }, [run]);

  const fail = useCallback((cause: unknown) => {
    if (mounted.current) setError(errorMessage(cause));
    onErrorRef.current?.(cause);
  }, []);

  const refreshList = useCallback(async (): Promise<OrchestrationSummary[] | undefined> => {
    if (!orchestrations) return undefined;
    const list = await orchestrations.list();
    if (mounted.current) setSummaries(list);
    return list;
  }, [orchestrations]);

  const refreshRuns = useCallback(async (): Promise<void> => {
    if (!orchestrations) return;
    try {
      const list = await orchestrations.listRuns();
      if (mounted.current) setRuns(list);
    } catch (cause) {
      fail(cause);
    }
  }, [orchestrations, fail]);

  const refresh = useCallback(async (): Promise<void> => {
    if (!orchestrations) return;
    setLoading(true);
    setError(undefined);
    try {
      await refreshList();
      const id = selectedIdRef.current;
      const current = draft;
      if (id && current && !current.dirty) {
        const loaded = await orchestrations.read(id);
        if (mounted.current) setDraft(draftFromSource(loaded));
      }
      await refreshRuns();
    } catch (cause) {
      fail(cause);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [orchestrations, refreshList, refreshRuns, draft, fail]);

  const select = useCallback(
    async (id: string): Promise<void> => {
      if (!orchestrations || id === selectedIdRef.current) return;
      if (draft?.dirty) {
        let proceed = true;
        try {
          proceed = typeof window.confirm === "function" ? window.confirm(tr("当前编排有未保存的修改，切换后将丢弃。继续？")) : true;
        } catch {
          proceed = true;
        }
        if (!proceed) return;
      }
      setLoading(true);
      setError(undefined);
      try {
        const loaded = await orchestrations.read(id);
        if (!mounted.current) return;
        selectedIdRef.current = id;
        setSelectedId(id);
        setDraft(draftFromSource(loaded));
      } catch (cause) {
        fail(cause);
      } finally {
        if (mounted.current) setLoading(false);
      }
    },
    [orchestrations, draft, fail, tr],
  );

  const newDraft = useCallback((): void => {
    const next = blankOrchestrationDraft();
    selectedIdRef.current = undefined;
    setSelectedId(undefined);
    setDraft(next);
    setRun(undefined);
    setChildRun(undefined);
    setError(undefined);
  }, []);

  const setTitle = useCallback((title: string): void => {
    setDraft((current) => (current ? { ...current, title, dirty: true } : current));
  }, []);

  const setDescription = useCallback((description: string): void => {
    setDraft((current) => (current ? { ...current, description, dirty: true } : current));
  }, []);

  const addStep = useCallback((workflowId: string): void => {
    setDraft((current) => {
      if (!current) return current;
      if (current.steps.length >= 20) {
        setError(tr("最多支持 20 个步骤。"));
        return current;
      }
      return {
        ...current,
        dirty: true,
        steps: [...current.steps, { id: orchestrationStepId(), workflowId, approval: "inherit" }],
      };
    });
  }, [tr]);

  const updateStep = useCallback(
    (id: string, patch: { workflowId?: string; approval?: OrchestrationApproval }): void => {
      setDraft((current) => {
        if (!current) return current;
        let changed = false;
        const steps = current.steps.map((step) => {
          if (step.id !== id) return step;
          changed = true;
          return {
            ...step,
            ...(patch.workflowId === undefined ? {} : { workflowId: patch.workflowId }),
            ...(patch.approval === undefined ? {} : { approval: patch.approval }),
          };
        });
        return changed ? { ...current, steps, dirty: true } : current;
      });
    },
    [],
  );

  const removeStep = useCallback((id: string): void => {
    setDraft((current) => {
      if (!current || !current.steps.some((step) => step.id === id)) return current;
      return { ...current, steps: current.steps.filter((step) => step.id !== id), dirty: true };
    });
  }, []);

  const moveStep = useCallback((id: string, direction: "up" | "down"): void => {
    setDraft((current) => {
      if (!current) return current;
      const index = current.steps.findIndex((step) => step.id === id);
      if (index < 0) return current;
      const target = direction === "up" ? index - 1 : index + 1;
      if (target < 0 || target >= current.steps.length) return current;
      const steps = [...current.steps];
      const [moved] = steps.splice(index, 1);
      if (!moved) return current;
      steps.splice(target, 0, moved);
      return { ...current, steps, dirty: true };
    });
  }, []);

  const validate = useCallback(
    (candidate: OrchestrationDraft): string | undefined => orchestrationDraftError(candidate, workflows, tr),
    [workflows, tr],
  );

  /**
   * Persist the current draft. Returns the saved id, or undefined when the draft
   * is invalid or the write failed. Callers that need to run afterwards use this
   * so a temporary queue becomes a project orchestration exactly once.
   */
  const persistDraft = useCallback(async (): Promise<string | undefined> => {
    if (!orchestrations || !draft) return undefined;
    const reason = validate(draft);
    if (reason !== undefined) {
      setError(reason);
      return undefined;
    }
    const definition: OrchestrationDefinition = {
      schemaVersion: 1,
      id: draft.id,
      title: draft.title.trim(),
      description: draft.description.trim(),
      steps: draft.steps.map((step) => ({ ...step })),
    };
    const content = stringify(definition, { lineWidth: 0 });
    const expectedVersion = draft.fileVersion ?? "absent";
    const result = await orchestrations.save(draft.id, content, expectedVersion);
    if (!mounted.current) return draft.id;
    setDraft((current) =>
      current && current.id === draft.id
        ? {
            id: definition.id,
            title: definition.title,
            description: definition.description,
            steps: definition.steps,
            fileVersion: result.fileVersion,
            dirty: false,
          }
        : current,
    );
    selectedIdRef.current = draft.id;
    setSelectedId(draft.id);
    await refreshList();
    return draft.id;
  }, [orchestrations, draft, validate, refreshList]);

  const save = useCallback(async (): Promise<void> => {
    if (!orchestrations) return;
    setLoading(true);
    setError(undefined);
    try {
      await persistDraft();
    } catch (cause) {
      fail(cause);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [orchestrations, persistDraft, fail]);

  const removeSelected = useCallback(async (): Promise<void> => {
    if (!orchestrations || !draft || draft.fileVersion === undefined) return;
    setLoading(true);
    setError(undefined);
    try {
      await orchestrations.remove(draft.id, draft.fileVersion);
      if (!mounted.current) return;
      selectedIdRef.current = undefined;
      setSelectedId(undefined);
      setDraft(undefined);
      setRun((current) => (current?.orchestrationId === draft.id ? undefined : current));
      const list = await refreshList();
      const first = list?.[0];
      if (first) {
        const loaded = await orchestrations.read(first.id);
        if (!mounted.current) return;
        selectedIdRef.current = first.id;
        setSelectedId(first.id);
        setDraft(draftFromSource(loaded));
      }
    } catch (cause) {
      fail(cause);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [orchestrations, draft, refreshList, fail]);

  const start = useCallback(
    async (inputs: WorkflowRunInputs): Promise<void> => {
      if (!orchestrations || !draft) {
        setError(tr("请先选择或新建一个编排。"));
        return;
      }
      setRunLoading(true);
      setError(undefined);
      try {
        const needsSave = draft.fileVersion === undefined || draft.dirty;
        const reason = validate(draft);
        if (reason !== undefined) {
          setError(reason);
          return;
        }
        const id = needsSave ? await persistDraft() : draft.id;
        if (id === undefined) return;
        const started = await orchestrations.start(id, inputs);
        if (!mounted.current) return;
        runIdRef.current = started.orchestrationRunId;
        setRun(started);
        setRuns((current) => [
          started,
          ...current.filter((item) => item.orchestrationRunId !== started.orchestrationRunId),
        ]);
      } catch (cause) {
        fail(cause);
      } finally {
        if (mounted.current) setRunLoading(false);
      }
    },
    [orchestrations, draft, validate, persistDraft, fail, tr],
  );

  const reloadRun = useCallback(
    async (orchestrationRunId: string): Promise<void> => {
      if (!orchestrations) return;
      const latest = await orchestrations.getRun(orchestrationRunId);
      if (mounted.current && runIdRef.current === orchestrationRunId) setRun(latest);
    },
    [orchestrations],
  );

  const act = useCallback(
    async (action: (client: OrchestrationsApi, runId: string) => Promise<void>): Promise<void> => {
      const runId = runIdRef.current;
      if (!orchestrations || !runId) return;
      setRunLoading(true);
      setError(undefined);
      try {
        await action(orchestrations, runId);
        await reloadRun(runId);
        await refreshRuns();
      } catch (cause) {
        fail(cause);
      } finally {
        if (mounted.current) setRunLoading(false);
      }
    },
    [orchestrations, reloadRun, refreshRuns, fail],
  );

  const approveStep = useCallback(
    async (digest: string): Promise<void> => {
      await act((client, id) => client.approveStep(id, digest));
    },
    [act],
  );

  const rejectStep = useCallback(async (): Promise<void> => {
    await act((client, id) => client.rejectStep(id));
  }, [act]);

  const retryStep = useCallback(
    async (action: WorkflowRetryAction): Promise<void> => {
      await act((client, id) => client.retryStep(id, action));
    },
    [act],
  );

  const cancel = useCallback(async (): Promise<void> => {
    await act((client, id) => client.cancel(id));
  }, [act]);

  const openRun = useCallback(async (candidate: OrchestrationRun): Promise<void> => {
    runIdRef.current = candidate.orchestrationRunId;
    setRun(candidate);
  }, []);

  // A different step is a different child; fetch it and follow its live updates.
  useEffect(() => {
    const step = run?.steps[run.currentStepIndex];
    const childId = step?.runId;
    childIdRef.current = childId;
    if (!workflow || childId === undefined) {
      setChildRun(undefined);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await workflow.getRun(childId);
        if (!cancelled && mounted.current) setChildRun(loaded);
      } catch {
        // The child record may be gone; the orchestration record still describes the step.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workflow, run]);

  useEffect(() => {
    if (!workflow || typeof workflow.onUpdate !== "function") return;
    return workflow.onUpdate((event) => {
      if (!mounted.current) return;
      if (event.projectPath !== projectPath) return;
      if (event.run.runId !== childIdRef.current) return;
      setChildRun(event.run);
    });
  }, [workflow, projectPath]);

  useEffect(() => {
    if (!workflow || typeof workflow.onOrchestrationUpdate !== "function") return;
    return workflow.onOrchestrationUpdate((event) => {
      if (!mounted.current) return;
      if (event.projectPath !== projectPath) return;
      if (event.run.orchestrationRunId !== runIdRef.current) return;
      setRun(event.run);
      setRuns((current) => current.map((item) => (item.orchestrationRunId === event.run.orchestrationRunId ? event.run : item)));
    });
  }, [workflow, projectPath]);

  useEffect(() => {
    if (!orchestrations) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const list = await orchestrations.list();
        if (cancelled || !mounted.current) return;
        setSummaries(list);
        const first = list[0];
        if (!first) return;
        const loaded = await orchestrations.read(first.id);
        if (cancelled || !mounted.current) return;
        selectedIdRef.current = first.id;
        setSelectedId(first.id);
        setDraft(draftFromSource(loaded));
      } catch (cause) {
        if (!cancelled) fail(cause);
      } finally {
        if (!cancelled && mounted.current) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orchestrations, fail]);

  useEffect(() => {
    void refreshRuns();
  }, [refreshRuns]);

  return {
    available: Boolean(orchestrations),
    summaries,
    selectedId,
    draft,
    dirty: draft?.dirty ?? false,
    loading,
    error,
    runs,
    run,
    childRun,
    runLoading,
    select,
    newDraft,
    setTitle,
    setDescription,
    addStep,
    updateStep,
    removeStep,
    moveStep,
    save,
    removeSelected,
    start,
    approveStep,
    rejectStep,
    retryStep,
    cancel,
    openRun,
    refresh,
    clearError: () => setError(undefined),
  };
}