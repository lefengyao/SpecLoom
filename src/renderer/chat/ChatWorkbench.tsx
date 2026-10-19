import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { CornerUpRight, PanelRightOpen, Pencil, Plus, Settings2, Trash2 } from "lucide-react";
import type { ChangeReview, DesktopApi, TaskView, WorkflowApi } from "../../shared/desktop-api";
import type { ModelReference, ProviderPublic, ReasoningPreference, SessionModelPreference } from "../../shared/contracts";
import type { ChatSession, ChatSessionsApi } from "../../shared/chat";
import type { Preferences } from "../../shared/preferences";
import { OFFICIAL_WORKFLOW_ID, type WorkflowSettings } from "../../shared/orchestration";
import type { WorkflowRun, WorkflowSummary, WorkflowTriggerResult } from "../../shared/workflow-api";
import { DEFAULT_APPROVAL_MODE, type ApprovalMode } from "../../shared/approvals";
import { DEFAULT_WEB_SEARCH_MODE, WEB_SEARCH_MODE_LABELS, WebSearchModeSchema, type WebSearchMode } from "../../shared/web-search";
import { sessionFileLimit } from "../../shared/chat";
import { estimateTokens, resolveModelSettings } from "../../main/core/model-settings";
import { ReviewPane } from "../ReviewPane";
import { AuditEvents } from "../WorkspaceView";
import { CopyButton, Modal, Status, registerEditablePaste } from "../ui";
import { ChatTimeline } from "./ChatTimeline";
import { useChatSessions } from "./useChatSessions";
import { CapabilitySummary } from "./CapabilitySummary";
import { AgentProgress } from "./AgentProgress";
import { SessionSettings } from "./SessionSettings";
import { AgentSidebar } from "./AgentSidebar";
import type { ToolSidebarSelection } from "./ToolChainBox";
import { AttachmentIngest, composePrompt, type AttachmentTarget, type PreparedDraftSnapshot } from "./attachment-ingest";
import { AttachmentTray } from "./AttachmentTray";
import { ImplementationScopeCard, type ImplementationScopeInput } from "./ImplementationScopeCard";
import { WorkflowRunCard, type WorkflowRunCardState } from "./WorkflowRunCard";
import "./chat.css";
import "./guidance.css";

const approvalModeTitles: Record<ApprovalMode, string> = {
  ask: "请求批准：访问网络、外部文件或操作外部软件前需要批准。",
  auto: "帮我批准：常规操作自动执行，仅对风险操作或无法判断的操作请求批准。",
  full: "完全访问：允许访问项目外的电脑文件与软件，无需批准。",
};

function ContextUsageIndicator({ current, pending, contextTokens, lastRequestUsage, usage }: {
  current: number;
  pending: number;
  contextTokens: number;
  lastRequestUsage: ChatSession["lastRequestUsage"];
  usage: NonNullable<ChatSession["usage"]> | undefined;
}) {
  const estimated = current + pending;
  const ratio = contextTokens > 0 ? Math.min(1, Math.max(0, estimated / contextTokens)) : 0;
  const percent = Math.round(ratio * 100);
  const usageText = (label: string, value: ChatSession["usage"]) => !value || value.source === "missing"
    ? `${label}：用量未提供`
    : `${label}：${value.source === "actual" ? "实际" : "估算"}输入 ${value.promptTokens} · 输出 ${value.completionTokens} tokens`;
  const title = [
    `当前上下文估算 ${current} / ${contextTokens} tokens`,
    ...(pending > 0 ? [`待发送估算 ${pending} tokens；含待发送 ${estimated} / ${contextTokens} tokens`] : []),
    usageText("最近请求", lastRequestUsage),
    usageText("本轮累计", usage),
  ].join("；");
  const style = { "--context-progress": `${percent * 3.6}deg` } as CSSProperties;
  return <span className="context-usage" title={title}>
    <span className="context-usage-ring" role="img" aria-label={`上下文占用 ${estimated} / ${contextTokens} tokens`} title={title} style={style}>
      <span aria-hidden="true">{percent}%</span>
    </span>
  </span>;
}

type ComposerMode = "qa" | "implementation";

export function ChatWorkbench({ api, attachments, projectPath, windowId, tasks, providers, defaultModel, sessionModel, preferences, selectedTaskId, sessionSelection, review, busy, workflow, onOpenWorkflowRun, onSelectTask, onNewTask, onReview, onError, onFinished, onRunningChange, documents }: {
  api: ChatSessionsApi; projectPath: string; tasks: TaskView[]; providers: ProviderPublic[]; defaultModel?: ModelReference; sessionModel?: SessionModelPreference; selectedTaskId?: string; review: ChangeReview | undefined; busy: boolean;
  attachments?: DesktopApi["chatAttachments"];
  onSelectTask: (id: string) => void; onNewTask: () => void; onReview: (action: "approve" | "reject" | "validate" | "refresh") => Promise<void>;
  onError: (error: unknown) => void; onFinished: () => void; onRunningChange?: (running: boolean) => void;
  sessionSelection?: { id: string; sequence: number };
  windowId?: string | undefined;
  documents?: () => Promise<{ path: string }[]>;
  /** Workflow entry API; when absent the composer stays in Q&A mode. */
  workflow?: WorkflowApi | undefined;
  /** Deep-link a started run into the workflow page's Run mode. */
  onOpenWorkflowRun?: (runId: string) => void;
  preferences?: Pick<Preferences, "userAvatar" | "assistantAvatar" | "hideAgentDetails" | "showOutputRate" | "showFirstTokenLatency" | "showThinkingDuration"> | undefined;
}) {
  const [, setAttachmentTick] = useState(0);
  const [ingest] = useState(() => new AttachmentIngest(projectPath, attachments, () => setAttachmentTick(value => value + 1)));
  useEffect(() => { ingest.activate(); return () => ingest.dispose(); }, [ingest]);
  const chat = useChatSessions(api, projectPath, onError, onFinished, (id, images) => {
    ingest.restore({ kind: "session", sessionId: id }, { draftText: "", draftRevision: 0, attachments: images.map(image => ({ id: crypto.randomUUID(), value: { kind: "image", name: image.name, size: Math.ceil(image.base64.length * 3 / 4), image } })) });
  }, windowId); const { active } = chat;
  const chatRef = useRef(chat); chatRef.current = chat;
  const [sidebar, setSidebar] = useState<{ sessionId: string; selection?: ToolSidebarSelection }>();
  const [showArchived, setShowArchived] = useState(false); const [references, setReferences] = useState<string[]>([]); const [showAttachmentMenu, setShowAttachmentMenu] = useState(false);
  const [sendShortcut] = useState<"enter" | "mod-enter">(() => { try { return localStorage.getItem("specloom:send-shortcut") === "mod-enter" ? "mod-enter" : "enter"; } catch { return "enter"; } });
  const [pendingPermissions, setPendingPermissions] = useState<string[]>([]);
  const permissionUpdates = useRef(new Set<string>());
  const [pendingWebSearchModes, setPendingWebSearchModes] = useState<string[]>([]);
  const webSearchModeUpdates = useRef(new Set<string>());
  const [settingsId, setSettingsId] = useState<string>();
  const [pendingDelete, setPendingDelete] = useState<ChatSession>();
  const [deleting, setDeleting] = useState(false);
  const [creatingDraft, setCreatingDraft] = useState("");
  const creatingDraftRef = useRef("");
  const creatingRevision = useRef(0);
  const creationToken = useRef<string | undefined>(undefined);
  const [failedCreation, setFailedCreation] = useState(false);
  const [composerMode, setComposerMode] = useState<ComposerMode>("qa");
  const [workflowSummaries, setWorkflowSummaries] = useState<WorkflowSummary[]>([]);
  const [workflowDefault, setWorkflowDefault] = useState<WorkflowSettings>({ schemaVersion: 1 });
  const [selectedWorkflowId, setSelectedWorkflowId] = useState("");
  const [runCards, setRunCards] = useState<WorkflowRunCardState[]>([]);
  const [scopeRequest, setScopeRequest] = useState<{ goal: string }>();
  const [implementationBusy, setImplementationBusy] = useState(false);
  const pendingImplementation = useRef<{ sessionId: string; target: AttachmentTarget; snapshot: PreparedDraftSnapshot } | undefined>(undefined);
  const temporaryDraft = chat.creating || failedCreation;
  const creatingSessionId = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (chat.creating || failedCreation) return;
    creatingSessionId.current = undefined;
    creatingDraftRef.current = "";
    setCreatingDraft("");
  }, [chat.creating, chat.activeId, failedCreation]);
  const input = useRef<HTMLTextAreaElement>(null); const importFile = useRef<HTMLInputElement>(null); const attachment = useRef<HTMLInputElement>(null);
  const pickerTarget = useRef<AttachmentTarget | undefined>(undefined);
  const task = tasks.find((t) => t.id === active?.taskId);
  const projectDefaultId = workflowDefault.defaultWorkflowId;
  const defaultWorkflowId = projectDefaultId !== undefined && projectDefaultId !== OFFICIAL_WORKFLOW_ID
    ? projectDefaultId
    : OFFICIAL_WORKFLOW_ID;
  const defaultWorkflowTitle = defaultWorkflowId === OFFICIAL_WORKFLOW_ID
    ? "官方开发审查"
    : (workflowSummaries.find((summary) => summary.id === defaultWorkflowId)?.title ?? defaultWorkflowId);
  const implementationAvailable = Boolean(workflow?.startForTask ?? workflow?.startForChat);
  const implementationMode = composerMode === "implementation";

  // A task session opens in implementation mode; a free chat opens in Q&A.
  useEffect(() => {
    setComposerMode(active?.taskId ? "implementation" : "qa");
    setSelectedWorkflowId("");
  }, [active?.id, active?.taskId]);

  useEffect(() => {
    if (!workflow) return;
    let cancelled = false;
    void (async () => {
      try {
        const [list, settings] = await Promise.all([
          workflow.list(),
          workflow.defaults?.read() ?? Promise.resolve({ schemaVersion: 1 } as WorkflowSettings),
        ]);
        if (!cancelled) {
          setWorkflowSummaries(list);
          setWorkflowDefault(settings);
        }
      } catch (error) {
        if (!cancelled) onError(error);
      }
    })();
    return () => { cancelled = true; };
  }, [workflow, projectPath, onError]);

  // Run cards follow the same durable updates the workflow page observes.
  useEffect(() => {
    if (!workflow || typeof workflow.onUpdate !== "function") return;
    return workflow.onUpdate((event) => {
      if (event.projectPath !== projectPath) return;
      setRunCards((current) => {
        let changed = false;
        const next = current.map((card) => {
          if (card.runId !== event.run.runId) return card;
          changed = true;
          return {
            ...card,
            title: event.run.title,
            status: event.run.status,
            ...(event.run.error === undefined ? {} : { error: event.run.error }),
          };
        });
        return changed ? next : current;
      });
    });
  }, [workflow, projectPath]);

  const running = !!active && (chat.sending.includes(active.id) || ["running", "waiting"].includes(active.status));
  const pendingPermission = !!active && pendingPermissions.includes(active.id);
  const pendingWebSearchMode = !!active && pendingWebSearchModes.includes(active.id);
  const approvalMode = active?.approvalMode ?? DEFAULT_APPROVAL_MODE;
  const pendingApproval = active?.items.some((item) => item.kind === "approval" && item.status === "waiting");
  const anyRunning = chat.sending.length > 0 || chat.sessions.some((s) => ["running", "waiting"].includes(s.status));
  const model = active?.model ?? sessionModel ?? (defaultModel ? { ...defaultModel, reasoning: "inherit" as const } : undefined);
  const available = useMemo(() => providers.flatMap((p) => p.models.map((m) => ({ key: `${p.id}:${m}`, providerId: p.id, model: m, label: `${p.name} / ${m}` }))), [providers]);
  const chosen = available.find((m) => m.providerId === model?.providerId && m.model === model.model) ?? (!model ? available[0] : undefined);
  const loadedTasks = useRef("");
  const currentTarget: AttachmentTarget | undefined = temporaryDraft && creationToken.current
    ? ingest.resolve({ kind: "creating", creationToken: creationToken.current })
    : active ? { kind: "session", sessionId: active.id } : undefined;
  const currentEntries = currentTarget ? ingest.entries(currentTarget) : [];
  const pendingDraft = temporaryDraft ? creatingDraft : chat.draft;
  const pendingImageCount = currentEntries.filter(entry => entry.value?.kind === "image").length;
  const pendingDocumentText = currentEntries.map(entry => entry.value?.kind === "document" ? entry.value.text : "").join("\n");
  const unfinishedAttachments = currentEntries.some(entry => entry.status !== "ready");
  const currentTargetRef = useRef(currentTarget); currentTargetRef.current = currentTarget;
  const mounted = useRef(true);
  const [pasteNotice, setPasteNotice] = useState("");
  const pasteChains = useRef(new Map<string, Promise<void>>());
  const creationOrigins = useRef(new Map<string, string>());
  type PasteOperation = { target: AttachmentTarget; text: string; revision: number; start: number; end: number };
  const pendingPastes = useRef(new Set<PasteOperation>());
  const knownSessions = useRef(new Set<string>());
  const pastePending = !!currentTarget && [...pendingPastes.current].some(operation => pasteKey(operation.target) === pasteKey(currentTarget));
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const present = new Set(chat.sessions.map(session => session.id));
    for (const id of knownSessions.current) if (!present.has(id)) ingest.clear({ kind: "session", sessionId: id });
    knownSessions.current = present;
    for (const session of chat.sessions) if (session.archived) ingest.clear({ kind: "session", sessionId: session.id });
  }, [chat.sessions, ingest]);
  // Runtime estimates describe the current request context; cumulative usage is billing data.
  const contextUsage = useMemo(() => {
    const provider = providers.find((p) => p.id === chosen?.providerId);
    if (!chosen || !provider) return undefined;
    const settings = provider.modelSettings[chosen.model];
    const contextTokens = resolveModelSettings(chosen.model, settings).contextTokens;
    const text = (active?.items ?? []).map((item) => {
      if (item.kind === "message" || item.kind === "thinking") return item.content;
      if (item.kind === "tool") return `${item.name}${item.arguments}${item.output}`;
      return "";
    }).join("\n");
    const current = active?.contextTokensEstimate ?? estimateTokens(text);
    // Match the runtime's fixed image allowance without counting base64 bytes as text.
    const pending = estimateTokens(pendingDraft + pendingDocumentText) + pendingImageCount * 1024 + chat.pendingGuidance.reduce((sum, entry) => {
      if (active?.items.some(item => item.id === `${entry.runId}:guidance:${entry.id}`)) return sum;
      return sum + estimateTokens(entry.text) + (entry.images?.length ?? 0) * 1024;
    }, 0);
    return { current, pending, contextTokens, lastRequestUsage: active?.lastRequestUsage, usage: active?.usage };
  }, [providers, chosen, active?.id, active?.items, active?.usage, active?.lastRequestUsage, active?.contextTokensEstimate, pendingDraft, pendingDocumentText, pendingImageCount, chat.pendingGuidance]);
  useEffect(() => { const identity = tasks.map((t) => t.id).join("|"); if (loadedTasks.current !== identity) { loadedTasks.current = identity; void chat.refresh().catch(onError); } }, [tasks, chat.refresh, onError]);
  useEffect(() => { if (selectedTaskId) { const session = chat.sessions.find((s) => s.taskId === selectedTaskId); if (session) chat.setActiveId(session.id); } }, [selectedTaskId, chat.sessions.find((s) => s.taskId === selectedTaskId)?.id]);
  useEffect(() => {
    if (!sessionSelection) return;
    chat.setActiveId(sessionSelection.id);
    void chat.refresh().catch(onError);
  }, [sessionSelection?.id, sessionSelection?.sequence, chat.setActiveId, chat.refresh, onError]);
  useEffect(() => { onRunningChange?.(anyRunning); }, [anyRunning, onRunningChange]);
  // Deleting any row moves focus to the row controls. Re-focus the active composer
  // when the session list changes, even if the active session itself is unchanged.
  useEffect(() => { if (chat.creating || (active && !active.archived)) input.current?.focus(); }, [active?.id, active?.archived, chat.creating, chat.sessions.length]);
  useEffect(() => {
    const restoreComposerFocus = () => {
      if (document.activeElement !== document.body) return;
      if (chat.creating || (active && !active.archived)) input.current?.focus();
    };
    window.addEventListener("focus", restoreComposerFocus);
    return () => window.removeEventListener("focus", restoreComposerFocus);
  }, [active?.id, active?.archived, chat.creating]);
  useLayoutEffect(() => {
    const textarea = input.current;
    if (!textarea) return;
    const measure = () => {
      const style = getComputedStyle(textarea);
      const minimum = Number.parseFloat(style.getPropertyValue("--composer-min-height")) || 44;
      const maximum = Number.parseFloat(style.getPropertyValue("--composer-max-height")) || 160;
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(maximum, Math.max(minimum, textarea.scrollHeight))}px`;
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    let width = textarea.clientWidth;
    const observer = new ResizeObserver(() => {
      if (textarea.clientWidth === width) return;
      width = textarea.clientWidth;
      measure();
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [pendingDraft, chat.activeId, chat.creating]);
  const safely = (action: () => Promise<unknown>) => { void action().catch(onError); };
  function pasteKey(target: AttachmentTarget): string {
    const resolved = ingest.resolve(target);
    return resolved.kind === "creating" ? `creating:${resolved.creationToken}` : `session:${creationOrigins.current.get(resolved.sessionId) ?? resolved.sessionId}`;
  }
  function targetDraft(target: AttachmentTarget): { text: string; revision: number } | undefined {
    if (!mounted.current) return;
    const resolved = ingest.resolve(target);
    if (resolved.kind === "creating") return resolved.creationToken === creationToken.current ? { text: creatingDraftRef.current, revision: creatingRevision.current } : undefined;
    if (!chatRef.current.sessions.some(session => session.id === resolved.sessionId && !session.archived)) return;
    return chatRef.current.snapshotDraft(resolved.sessionId);
  }
  function writeTargetDraft(target: AttachmentTarget, text: string) {
    if (text.length > 131072) throw new Error("粘贴后的消息超过长度上限，原草稿已保留");
    const resolved = ingest.resolve(target);
    if (resolved.kind === "session") chatRef.current.setDraftFor(resolved.sessionId, text);
    else { creatingDraftRef.current = text; creatingRevision.current++; setCreatingDraft(text); }
  }
  function capturePaste(): { target: AttachmentTarget; text: string; revision: number } | undefined {
    const target = currentTargetRef.current;
    const draft = target && targetDraft(target);
    return target && draft ? { target, ...draft } : undefined;
  }
  async function paste(captured: ReturnType<typeof capturePaste>, selection: { start: number; end: number }, files: File[], text?: string) {
    if (!captured) return;
    const operation: PasteOperation = { ...captured, ...selection };
    pendingPastes.current.add(operation);
    setAttachmentTick(value => value + 1);
    // Snapshot native bytes immediately; only commits wait for earlier pastes.
    const native = (files.length ? Promise.resolve(undefined) : attachments?.readClipboard(projectPath) ?? Promise.resolve(undefined))
      .then(value => ({ value }), error => ({ error }));
    const key = pasteKey(operation.target);
    const previous = pasteChains.current.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      const result = await native;
      const current = targetDraft(operation.target);
      if (!current) return;
      if ("error" in result) throw result.error;
      const nativeValue = "value" in result ? result.value : undefined;
      if (files.length) await ingest.addFiles(operation.target, files);
      else if (nativeValue?.files.length) await ingest.addInputs(operation.target, nativeValue.files);
      else {
        const insertion = text || nativeValue?.text || "";
        if (!insertion) return;
        const unchanged = current.revision === operation.revision && current.text === operation.text;
        const start = unchanged ? operation.start : current.text.length;
        const end = unchanged ? operation.end : current.text.length;
        const updated = current.text.slice(0, start) + insertion + current.text.slice(end);
        writeTargetDraft(operation.target, updated);
        const written = targetDraft(operation.target)!;
        // Rebase only our own known splices; user edits are never overwritten.
        for (const waiting of pendingPastes.current) {
          if (waiting === operation || pasteKey(waiting.target) !== key || waiting.revision !== current.revision || waiting.text !== current.text) continue;
          const rebase = (position: number) => position < start ? position : position >= end ? position + insertion.length - (end - start) : start + insertion.length;
          waiting.start = rebase(waiting.start); waiting.end = rebase(waiting.end);
          waiting.text = written.text; waiting.revision = written.revision;
        }
        if (!unchanged) setPasteNotice("粘贴期间草稿已编辑，粘贴文字已追加到末尾。");
        if (currentTargetRef.current && pasteKey(currentTargetRef.current) === key) queueMicrotask(() => {
          if (input.current?.value === updated) input.current.setSelectionRange(start + insertion.length, start + insertion.length);
        });
      }
      if (nativeValue?.notices.length) setPasteNotice(nativeValue.notices.join("；"));
    }).finally(() => { pendingPastes.current.delete(operation); if (pasteChains.current.get(key) === next) pasteChains.current.delete(key); if (mounted.current) setAttachmentTick(value => value + 1); });
    pasteChains.current.set(key, next);
    await next;
  }
  useEffect(() => {
    const textarea = input.current;
    if (!textarea) return;
    return registerEditablePaste(textarea, () => {
      const captured = capturePaste();
      return selection => paste(captured, selection, []);
    });
  });
  function refocusComposer() {
    window.setTimeout(() => {
      const composer = input.current;
      if (composer && !composer.disabled) composer.focus();
    }, 0);
  }
  function select(id: string) { chat.setActiveId(id); const session = chat.sessions.find((s) => s.id === id); onSelectTask(session?.taskId ?? ""); }
  async function createSession() {
    if (chat.creating) return;
    if (!failedCreation) {
      creationToken.current = crypto.randomUUID();
      creatingDraftRef.current = "";
      creatingRevision.current = 0;
      setCreatingDraft("");
    }
    setFailedCreation(false);
    creatingSessionId.current = undefined;
    try {
      const created = await chat.create(undefined, session => {
      if (!mounted.current) return;
      // The pending input handler can still receive a character until the selection commits.
      creatingSessionId.current = session.id;
      if (creationToken.current) { creationOrigins.current.set(session.id, creationToken.current); ingest.adopt(creationToken.current, session.id); }
      if (creatingDraftRef.current) chat.setDraftFor(session.id, creatingDraftRef.current);
    });
    if (created) {
      if (created.selected) { onSelectTask(""); refocusComposer(); }
    }
    } catch (error) { if (mounted.current) setFailedCreation(true); throw error; }
  }
  async function confirmRemove() {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    try {
      await chat.remove(pendingDelete.id);
      ingest.clear({ kind: "session", sessionId: pendingDelete.id });
      setSettingsId(undefined);
      setPendingDelete(undefined);
      refocusComposer();
    } finally { setDeleting(false); }
  }
  async function sendChat() {
    if (temporaryDraft || !active || unfinishedAttachments || [...pendingPastes.current].some(operation => pasteKey(operation.target) === pasteKey({ kind: "session", sessionId: active.id })) || permissionUpdates.current.has(active.id) || webSearchModeUpdates.current.has(active.id) || active.archived || !chosen || (!chat.draft.trim() && !currentEntries.length)) return;
    const target: AttachmentTarget = { kind: "session", sessionId: active.id };
    const snapshot = ingest.snapshot(target, chat.snapshotDraft(active.id));
    const images = snapshot.attachments.flatMap(({ value }) => value.kind === "image" ? [value.image] : []);
    const provider = providers.find(item => item.id === chosen.providerId);
    if (images.length && !resolveModelSettings(chosen.model, provider?.modelSettings[chosen.model]).vision) throw new Error("当前模型不能查看图片，请选择支持看图的模型；草稿和附件已保留");
    if (running) {
      if (chat.stageDraft(active.id, images, snapshot)) {
        ingest.detach(target, snapshot);
        refocusComposer();
      }
      return;
    }
    const pendingModel = !active.model ? { providerId: chosen.providerId, model: chosen.model, reasoning: model?.reasoning ?? "inherit" } : undefined;
    // send resolves at completion, so detach this run's images before accepting further guidance.
    ingest.detach(target, snapshot);
    const sent = await chat.send(active.id, images, pendingModel, snapshot);
    if (!sent && chatRef.current.sessions.some(session => session.id === active.id && !session.archived)) ingest.restore(target, snapshot);
  }
  function addRunCard(result: WorkflowTriggerResult): void {
    const base: WorkflowRunCardState = {
      runId: result.runId,
      workflowId: result.workflowId,
      source: result.source,
      ...(result.warning === undefined ? {} : { warning: result.warning }),
    };
    setRunCards((current) => {
      const existing = current.find((card) => card.runId === result.runId);
      if (!existing) return [base, ...current];
      return current.map((card) => card.runId === result.runId ? { ...existing, ...base } : card);
    });
    const loaded = workflow?.getRun?.(result.runId);
    if (loaded) void loaded.then((run: WorkflowRun) => {
      setRunCards((current) => current.map((card) => card.runId === result.runId
        ? { ...card, title: run.title, status: run.status, ...(run.error === undefined ? {} : { error: run.error }) }
        : card));
    }).catch(() => undefined);
  }

  /** Clear the consumed draft and attachments only after a run really started. */
  function commitImplementation(sessionId: string, target: AttachmentTarget, snapshot: PreparedDraftSnapshot): void {
    const current = chatRef.current.snapshotDraft(sessionId);
    if (current.revision === snapshot.draftRevision && current.text === snapshot.draftText) chatRef.current.setDraftFor(sessionId, "");
    ingest.detach(target, snapshot);
  }

  async function startChatImplementation(goal: string, readPaths: string[], writePaths: string[]): Promise<boolean> {
    if (!workflow?.startForChat) {
      onError(new Error("当前桌面版本不支持从聊天启动工作流。"));
      return false;
    }
    setImplementationBusy(true);
    try {
      const result = await workflow.startForChat({
        goal,
        readPaths,
        writePaths,
        ...(selectedWorkflowId ? { workflowId: selectedWorkflowId } : {}),
      });
      addRunCard(result);
      const pending = pendingImplementation.current;
      if (pending) commitImplementation(pending.sessionId, pending.target, pending.snapshot);
      pendingImplementation.current = undefined;
      return true;
    } catch (error) {
      onError(error);
      return false;
    } finally {
      setImplementationBusy(false);
    }
  }

  async function sendImplementation(): Promise<void> {
    if (!active || temporaryDraft || unfinishedAttachments || running || active.archived || implementationBusy) return;
    if ([...pendingPastes.current].some((operation) => pasteKey(operation.target) === pasteKey({ kind: "session", sessionId: active.id }))) return;
    const target: AttachmentTarget = { kind: "session", sessionId: active.id };
    const snapshot = ingest.snapshot(target, chat.snapshotDraft(active.id));
    const goal = composePrompt(snapshot).trim();
    if (!goal) return;

    if (active.taskId) {
      if (!workflow?.startForTask) {
        onError(new Error("当前桌面版本不支持启动任务工作流。"));
        return;
      }
      setImplementationBusy(true);
      try {
        const result = await workflow.startForTask(active.taskId, goal);
        addRunCard(result);
        commitImplementation(active.id, target, snapshot);
      } catch (error) {
        onError(error);
      } finally {
        setImplementationBusy(false);
      }
      return;
    }

    // Prefer the selected task scope; only ask for a scope when there is none.
    const scopeTask = tasks.find((candidate) => candidate.id === selectedTaskId);
    pendingImplementation.current = { sessionId: active.id, target, snapshot };
    if (scopeTask && scopeTask.scope.readPaths.length > 0 && scopeTask.scope.writePaths.length > 0) {
      await startChatImplementation(goal, scopeTask.scope.readPaths, scopeTask.scope.writePaths);
      return;
    }
    setScopeRequest({ goal });
  }

  async function startFromScope(input: ImplementationScopeInput): Promise<void> {
    const started = await startChatImplementation(input.goal, input.readPaths, input.writePaths);
    if (started) setScopeRequest(undefined);
  }

  async function send(): Promise<void> {
    if (implementationMode && implementationAvailable) {
      await sendImplementation();
      return;
    }
    await sendChat();
  }

  async function changeApprovalMode(id: string, mode: ApprovalMode) {
    if (permissionUpdates.current.has(id)) return;
    permissionUpdates.current.add(id); setPendingPermissions([...permissionUpdates.current]);
    try { await chat.patch(id, { approvalMode: mode }); }
    finally { permissionUpdates.current.delete(id); setPendingPermissions([...permissionUpdates.current]); }
  }
  async function changeWebSearchMode(id: string, mode: WebSearchMode) {
    if (webSearchModeUpdates.current.has(id)) return;
    webSearchModeUpdates.current.add(id); setPendingWebSearchModes([...webSearchModeUpdates.current]);
    try { await chat.patch(id, { webSearchMode: mode }); }
    finally { webSearchModeUpdates.current.delete(id); setPendingWebSearchModes([...webSearchModeUpdates.current]); }
  }
  async function exportSession(id: string) {
    const json = await api.export(projectPath, id); const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `specloom-session-${id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const activeReview = task && review?.changeSet.taskId === task.id ? review : undefined;
  return <div className={`chat-workbench${sidebar?.sessionId === active?.id && active ? " has-agent-sidebar" : ""}`}>
    <aside className="session-sidebar"><header><h2>会话</h2><button type="button" disabled={chat.creating} aria-label="新建会话" onClick={() => safely(createSession)}>＋</button></header>
      <div className="session-list">{chat.sessions.filter((s) => showArchived || !s.archived).map((s) => {
        const sessionRunning = chat.sending.includes(s.id) || ["running", "waiting"].includes(s.status);
        return <div key={s.id} className={`session-row${active?.id === s.id ? " active" : ""}`}>
          <div className="session-row-heading"><button type="button" className="session-select" aria-label={s.title} aria-current={active?.id === s.id ? "true" : undefined} onClick={() => select(s.id)}><span>{s.title}</span><small>{s.archived ? "已归档" : s.status === "waiting" ? s.items.some((item) => item.kind === "approval" && item.status === "waiting") ? "等待审批" : "等待回答" : sessionRunning ? "运行中" : s.taskId ? "任务会话" : "会话"}</small></button>
            <button type="button" className="session-settings-toggle" aria-label={`会话设置 ${s.title}`} title="会话设置" aria-expanded={settingsId === s.id} aria-controls={`session-settings-${s.id}`} onClick={() => setSettingsId((current) => current === s.id ? undefined : s.id)}><Settings2 size={15} /></button>
          </div>
          {settingsId === s.id && <SessionSettings session={s} running={sessionRunning} onError={onError} onRename={(title) => chat.patch(s.id, { title })} onArchive={async () => {
            await chat.patch(s.id, { archived: !s.archived }); setSettingsId(undefined);
          }} onExport={() => exportSession(s.id)} onRemove={async () => { setPendingDelete(s); }} />}
        </div>;
      })}</div>
      <footer><button type="button" onClick={() => setShowArchived((s) => !s)}>{showArchived ? "隐藏归档" : "显示归档"}</button><button type="button" onClick={() => importFile.current?.click()}>导入会话</button><button type="button" onClick={onNewTask}>新建任务</button></footer>
      <input type="file" accept="application/json,.json" hidden ref={importFile} aria-label="导入会话文件" onChange={(e) => { const file = e.target.files?.[0]; if (file) safely(async () => { if (file.size > sessionFileLimit) throw new Error("会话文件超过导入上限"); const imported = await api.import(projectPath, await file.text()); chat.apply(imported); select(imported.id); }); e.target.value = ""; }} />
    </aside>
    <section className="conversation-pane">
      <header className="conversation-heading"><div><h2 title={active?.title ?? "智能体对话"}>{active?.title ?? "智能体对话"}</h2><span className="subtle">{task ? <Status status={task.status} /> : "项目智能体会话"}{active?.status === "waiting" && (pendingApproval ? " · 等待你的审批" : " · 等待你的回答")}</span></div>{active && <button type="button" className="agent-sidebar-toggle" aria-label="打开智能体侧栏" aria-expanded={sidebar?.sessionId === active.id} onClick={() => setSidebar(current => current?.sessionId === active.id ? undefined : { sessionId: active.id })}><PanelRightOpen size={16} /><span>侧栏</span></button>}</header>
      {task && <details className="scope-summary"><summary>已授权范围</summary>{task.scope.goal && <p>目标：{task.scope.goal}</p>}<p>读取：{task.scope.readPaths.join("、")} · 写入：{task.scope.writePaths.join("、") || "无"} · {task.scope.mode === "manual" ? "手动审查" : "自动提交"}</p>{task.events.length > 0 && <details><summary>任务审计历史 · {task.events.length}</summary><AuditEvents task={task} /></details>}</details>}
      <ChatTimeline sessionId={active?.id ?? ""} runId={active?.runId} running={active?.status === "running" || active?.status === "waiting"} items={active?.items ?? []} avatars={preferences} preferences={preferences} introduction={active && <CapabilitySummary capabilities={active.capabilities} error={active.capabilityError} />} onOpenTools={(selection) => { if (active) setSidebar({ sessionId: active.id, selection }); }} onAnswer={async (item, answers) => { chat.apply(await api.answer(projectPath, item.question.sessionId, item.question.runId, item.question.id, answers)); }} onApprove={async (item, approved) => { chat.apply(await api.approve(projectPath, item.request.sessionId, item.request.runId, item.request.id, approved)); }}>
        {!active && <div className="conversation-empty"><h3>开始一段对话</h3><p>新建会话即可使用当前项目的工具与扩展。</p><button type="button" className="primary" disabled={chat.creating} onClick={() => safely(createSession)}>新建会话</button></div>}
        {active && !active.items.length && <p className="empty-state">输入消息开始对话。</p>}
        {active && running && <AgentProgress label={active.activity || (active.status === "waiting" ? pendingApproval ? "等待你的审批" : "等待你的回答" : "模型正在思考")} avatar={preferences?.assistantAvatar} />}
        {active?.error && <div className="run-error" role="status"><span>{active.error}</span>{active.diagnosticId && <span className="diagnostic-reference">诊断编号 <code>{active.diagnosticId}</code><CopyButton value={active.diagnosticId} label="复制诊断编号" onError={onError} /></span>}</div>}
        {activeReview && <article className="inline-review" aria-label="文件变更审查"><ReviewPane review={activeReview} running={running} busy={busy} onRefresh={() => safely(() => onReview("refresh"))} onValidate={() => safely(() => onReview("validate"))} onApprove={() => safely(() => onReview("approve"))} onReject={() => safely(() => onReview("reject"))} /></article>}
      </ChatTimeline>
      {runCards.length > 0 && (
        <section className="workflow-run-cards" aria-label="工作流运行卡片">
          {runCards.map((card) => (
            <WorkflowRunCard key={card.runId} card={card} onOpen={(runId) => onOpenWorkflowRun?.(runId)} />
          ))}
        </section>
      )}
      {chat.pendingGuidance.length > 0 && <div className="guidance-queue" aria-label="引导消息列表">{chat.pendingGuidance.map(message => <section className="guidance-card" role="region" aria-label="待引导消息" key={message.id}>
        <header><span><CornerUpRight size={14} />{message.sending ? "正在发送引导…" : "待引导"}</span><small>加入当前工作，继续当前回复</small></header>
        <p>{message.text}</p>{!!message.images?.length && <small>{message.images.map(image => image.name).join("、")}</small>}
        <footer><button type="button" className="primary" disabled={message.sending || !running} onClick={() => safely(() => chat.guide(message.id))}><CornerUpRight size={14} />引导</button><button type="button" disabled={message.sending} onClick={() => { chat.editGuidance(message.id); refocusComposer(); }}><Pencil size={13} />修改</button><button type="button" disabled={message.sending} onClick={() => chat.removeGuidance(message.id)}><Trash2 size={13} />删除</button></footer>
      </section>)}</div>}
      {pasteNotice && <div className="paste-notice" role="status">{pasteNotice}<button type="button" aria-label="关闭粘贴提示" onClick={() => setPasteNotice("")}>×</button></div>}
      {failedCreation && <div className="paste-notice" role="status">会话创建失败，草稿和附件已保留。<button type="button" onClick={() => safely(createSession)}>重试创建</button><button type="button" onClick={() => { if (creationToken.current) ingest.clear({ kind: "creating", creationToken: creationToken.current }); creationToken.current = undefined; setFailedCreation(false); }}>取消草稿</button></div>}
      <form className="composer session-composer" onSubmit={(e) => { e.preventDefault(); safely(send); }}>
        {workflow && active && !active.archived && (
          <div className="composer-workflow" aria-label="工作流入口">
            <div className="composer-workflow-mode" role="group" aria-label="消息模式">
              <button type="button" aria-pressed={composerMode === "qa"} onClick={() => setComposerMode("qa")}>
                问答
              </button>
              <button
                type="button"
                aria-pressed={implementationMode}
                disabled={!implementationAvailable}
                title={implementationAvailable ? undefined : "当前桌面版本不支持工作流"}
                onClick={() => setComposerMode("implementation")}
              >
                实现
              </button>
            </div>
            {implementationMode && (
              <span className="composer-workflow-default">
                默认工作流：{defaultWorkflowTitle}
                {!active.taskId && (
                  <select
                    aria-label="实现工作流"
                    value={selectedWorkflowId}
                    onChange={(event) => setSelectedWorkflowId(event.target.value)}
                  >
                    <option value="">使用默认（{defaultWorkflowTitle}）</option>
                    <option value={OFFICIAL_WORKFLOW_ID}>官方开发审查</option>
                    {workflowSummaries.filter((summary) => summary.id !== OFFICIAL_WORKFLOW_ID).map((summary) => (
                      <option key={summary.id} value={summary.id}>{summary.title}</option>
                    ))}
                  </select>
                )}
              </span>
            )}
          </div>
        )}
        <textarea ref={input} aria-label="任务消息" maxLength={131072} placeholder={chat.creating ? "正在创建会话，可先输入消息…" : active ? running ? "输入补充要求，发送后点击“引导”加入当前工作" : "输入消息，Shift+Enter 换行" : "先新建会话"} value={pendingDraft} disabled={!temporaryDraft && (!active || !!active.archived)} onChange={(e) => { if (temporaryDraft) { creatingRevision.current++; creatingDraftRef.current = e.target.value; setCreatingDraft(e.target.value); if (creatingSessionId.current) chat.setDraftFor(creatingSessionId.current, e.target.value); } else chat.setDraft(e.target.value); }} rows={1} onPaste={(event) => { event.preventDefault(); const captured = capturePaste(); const files = Array.from(event.clipboardData.files ?? []); if (!files.length) for (const item of Array.from(event.clipboardData.items ?? [])) { if (item.kind === "file") { const file = item.getAsFile(); if (file) files.push(file); } } const selection = { start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd }; const text = event.clipboardData.getData("text/plain"); safely(() => paste(captured, selection, files, text)); }} onKeyDown={(e) => { if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return; if (sendShortcut === "mod-enter" && !e.ctrlKey && !e.metaKey) return; e.preventDefault(); safely(send); }} />
        <footer><div className="composer-options"><select aria-label="选择模型" disabled={!active || running} value={chosen?.key ?? ""} onChange={(e) => { const next = available.find((m) => m.key === e.target.value); if (active && next) safely(() => chat.patch(active.id, { model: { providerId: next.providerId, model: next.model, reasoning: model?.reasoning ?? "inherit" } })); }}><option value="" disabled>选择模型</option>{available.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}</select>
          <select aria-label="思考偏好" value={model?.reasoning ?? "inherit"} disabled={!active || running || !chosen} onChange={(e) => { if (active && chosen) safely(() => chat.patch(active.id, { model: { providerId: chosen.providerId, model: chosen.model, reasoning: e.target.value as ReasoningPreference } })); }}>{["inherit", "off", "low", "medium", "high"].map((r) => <option key={r} value={r}>思考：{r === "inherit" ? "继承默认" : r}</option>)}</select>
          <select aria-label="联网搜索" value={active?.webSearchMode ?? DEFAULT_WEB_SEARCH_MODE} disabled={!active || running || pendingWebSearchMode || active.archived} onChange={(e) => { if (active && !running && !active.archived) safely(() => changeWebSearchMode(active.id, e.target.value as WebSearchMode)); }}>{WebSearchModeSchema.options.map(mode => <option key={mode} value={mode}>联网：{WEB_SEARCH_MODE_LABELS[mode]}</option>)}</select>
          <select aria-label="审批权限" title={approvalModeTitles[approvalMode]} value={approvalMode} disabled={!active || running || pendingPermission || active.archived} onChange={(e) => { if (active && !running) safely(() => changeApprovalMode(active.id, e.target.value as ApprovalMode)); }}><option value="ask">请求批准</option><option value="auto">帮我批准</option><option value="full">完全访问</option></select>
          {contextUsage && <ContextUsageIndicator {...contextUsage} />}
          <span className="composer-attachment-actions">
            <button type="button" className="composer-attachment-toggle" aria-label="添加附件或资料" aria-expanded={showAttachmentMenu} disabled={!active && !temporaryDraft} onClick={() => setShowAttachmentMenu((visible) => !visible)} title="添加附件或资料"><Plus size={16} /></button>
            {showAttachmentMenu && <span className="composer-attachment-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => { setShowAttachmentMenu(false); pickerTarget.current = currentTargetRef.current; attachment.current?.click(); }}>添加文件</button>
              {documents && <button type="button" role="menuitem" onClick={() => { setShowAttachmentMenu(false); safely(async () => setReferences((await documents()).map((d) => d.path))); }}>引用资料</button>}
            </span>}
          </span>
        </div><span className="composer-send-actions">{running && <button type="button" onClick={() => { if (active) safely(() => api.cancel(projectPath, active.id)); }}>停止</button>}<button className="primary" disabled={temporaryDraft || unfinishedAttachments || pastePending || !active || pendingPermission || pendingWebSearchMode || (!running && busy) || implementationBusy || active.archived || !chosen || (!chat.draft.trim() && !currentEntries.length)}>发送</button></span></footer>
        {references.length > 0 && <select aria-label="选择引用资料" defaultValue="" onChange={(e) => { chat.setDraft(chat.draft + `\n@${e.target.value}\n`); setReferences([]); }}><option value="" disabled>选择资料</option>{references.map((p) => <option key={p} value={p}>{p}</option>)}</select>}
        <AttachmentTray entries={currentEntries} onRemove={(id) => { if (currentTarget) ingest.remove(currentTarget, id); }} />
        <input type="file" accept="*/*" multiple hidden ref={attachment} aria-label="添加附件文件" onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ""; const target = pickerTarget.current ?? currentTargetRef.current; pickerTarget.current = undefined; if (target && targetDraft(target) && files.length) safely(() => ingest.addFiles(target, files)); }} />
      </form>
      {scopeRequest && (
        <ImplementationScopeCard
          initialGoal={scopeRequest.goal}
          busy={implementationBusy}
          onClose={() => {
            setScopeRequest(undefined);
            pendingImplementation.current = undefined;
          }}
          onStart={(input) => { safely(() => startFromScope(input)); }}
        />
      )}
      {pendingDelete && <Modal title="删除会话" onClose={() => { if (!deleting) setPendingDelete(undefined); }}>
        <p>{pendingDelete.taskId ? "删除此会话显示记录？任务审计、运行检查点和项目文件会保留，可从历史页重新进入任务。" : "删除此会话及聊天历史？项目文件会保留。"}</p>
        <footer className="form-actions">
          <button type="button" disabled={deleting} onClick={() => setPendingDelete(undefined)}>取消</button>
          <button type="button" className="session-delete-confirm" disabled={deleting} onClick={() => safely(confirmRemove)}>{deleting ? "正在删除…" : "确认删除"}</button>
        </footer>
      </Modal>}
    </section>
    {active && sidebar?.sessionId === active.id && <AgentSidebar session={active} {...(sidebar.selection ? { selection: sidebar.selection } : {})} onClose={() => setSidebar(undefined)} />}
  </div>;
}
