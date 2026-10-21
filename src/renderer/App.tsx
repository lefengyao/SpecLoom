import {
  AlertCircle,
  BookOpen,
  Cable,
  FileText,
  FolderOpen,
  FolderTree,
  Gamepad2,
  Globe2,
  History,
  Home,
  Layers3,
  Map,
  PanelLeftClose,
  PanelLeftOpen,
  PanelsTopLeft,
  Puzzle,
  Plus,
  SlidersHorizontal,
  Store,
  Sparkles,
  Workflow,
  X,
  Code2,
  Archive,
  Info,
  Waypoints,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TaskScopeSpec } from "../shared/contracts";
import { mergeSession } from "./chat/useChatSessions";
import type { ChatSession } from "../shared/chat";
import { applyAppearance, watchSystemTheme } from "./appearance";
import { DocumentsView, type DocumentCategory, type MaterialDraft } from "./DocumentsView";
import { EntityWorkspace } from "./EntityWorkspace";
import { ProvidersView } from "./ProvidersView";
import { ScopeForm } from "./ScopeForm";
import { HistoryView, McpView, SettingsView } from "./SettingsViews";
import { SkillsView } from "./SkillsView";
import { PluginManagementView } from "./PluginManagementView";
import { configureCompletionSound } from "./sound";
import { WorkflowView } from "./WorkflowView";
import { WorkspaceView } from "./WorkspaceView";
import { ChatWorkbench } from "./chat/ChatWorkbench";
import { AboutView, ArchivedSessionsView, HooksView, OfflineDocsView, ToolDocsView } from "./ToolsViews";
import { ContextMenu, ErrorNotice, IconButton, Modal, formatRelativeTime } from "./ui";
import { Mascot, type OrbitPreset } from "./Mascot";
import { MascotSpeech } from "./MascotSpeech";
import { useWorkspace } from "./useWorkspace";
import { APP_VERSION } from "../shared/version";
import { NavigationPage } from "./NavigationPage";
import { ProjectSidebarInfo } from "./ProjectSidebarInfo";
import { LocaleProvider, createTranslator } from "./i18n";
import "./navigation-materials.css";

const ORBIT_SEQUENCE: OrbitPreset[] = ["thread", "wide", "tall"];

function WelcomeOrbitMascot() {
  const [preset, setPreset] = useState<OrbitPreset>("thread");

  useEffect(() => {
    const timer = window.setInterval(() => {
      setPreset((current) => {
        const index = ORBIT_SEQUENCE.indexOf(current);
        return ORBIT_SEQUENCE[(index + 1) % ORBIT_SEQUENCE.length] ?? "thread";
      });
    }, 20_000);
    return () => window.clearInterval(timer);
  }, []);

  return <Mascot className="entry-mark" size={200} orbit={preset} trackPointer />;
}

const tabs = [
  { id: "workspace", label: "工作区", icon: Workflow },
  { id: "workflow", label: "工作流", icon: Waypoints },
  { id: "documents", category: "all", label: "项目文件", icon: FolderTree },
  { id: "documents", category: "entity", label: "实体", icon: Layers3 },
  { id: "documents", category: "component", label: "组件", icon: Puzzle },
  { id: "documents", category: "setting", label: "设定", icon: Globe2 },
  { id: "documents", category: "map", label: "地图", icon: Map },
  { id: "documents", category: "ui", label: "UI", icon: PanelsTopLeft },
  { id: "documents", category: "spec", label: "规范", icon: FileText },
  { id: "skills", label: "Skills", icon: BookOpen },
  { id: "plugins", label: "插件", icon: Puzzle },
  { id: "offlineDocs", label: "离线文档", icon: BookOpen },
  { id: "hooks", label: "Hooks", icon: Wrench },
  { id: "toolDocs", label: "工具说明", icon: FileText },
  { id: "archived", label: "归档会话", icon: Archive },
  { id: "providers", label: "供应商", icon: Store },
  { id: "mcp", label: "MCP", icon: Cable },
  { id: "history", label: "历史", icon: History },
  { id: "settings", label: "设置", icon: SlidersHorizontal },
  { id: "about", label: "关于项目", icon: Info },
] as const;
type Tab = (typeof tabs)[number]["id"];
const navigationPreferenceKey = "specloom.navigation";
function readNavigationPreference(): boolean {
  try {
    const saved = window.localStorage.getItem(navigationPreferenceKey);
    if (saved) return saved !== "collapsed";
  } catch { /* Retain the current choice when local storage is unavailable. */ }
  return true;
}
export default function App() {
  const api = window.specloom;
  const workspace = useWorkspace(api);
  const { state, selected, running, review, error } = workspace;
  const [materialSaving, setMaterialSaving] = useState(false);
  const busy = workspace.busy || materialSaving;
  const [tab, setTab] = useState<Tab>("workspace");
  const [documentCategory, setDocumentCategory] = useState<DocumentCategory>("all");
  const [projectFileSelection, setProjectFileSelection] = useState<{ path: string; sequence: number }>();
  const projectFileSequence = useRef(0);
  const [navigationOpen, setNavigationOpen] = useState(readNavigationPreference);
  const [compactNavigation, setCompactNavigation] = useState(() => window.matchMedia?.("(max-width: 600px)")?.matches ?? false);
  const [navigationDrawerOpen, setNavigationDrawerOpen] = useState(false);
  const navigationExpanded = compactNavigation ? navigationDrawerOpen : navigationOpen;
  useEffect(() => {
    const query = window.matchMedia?.("(max-width: 600px)");
    if (!query) return;
    const update = () => { setCompactNavigation(query.matches); setNavigationDrawerOpen(false); };
    update(); query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);
  useEffect(() => {
    try { window.localStorage.setItem(navigationPreferenceKey, navigationOpen ? "expanded" : "collapsed"); } catch { /* Best effort. */ }
  }, [navigationOpen]);
  const [scope, setScope] = useState<Omit<TaskScopeSpec, "id"> | true>();
  const [revision, setRevision] = useState(0);
  const [materialDrafts, setMaterialDrafts] = useState<MaterialDraft[]>([]);
  const [pendingProjectOpen, setPendingProjectOpen] = useState<boolean>();
  const [pendingProjectExit, setPendingProjectExit] = useState(false);
  const [pendingMaterialReload, setPendingMaterialReload] = useState<string>();
  const [materialReload, setMaterialReload] = useState<{ path: string; sequence: number }>();
  const reloadSequence = useRef(0);
  const onMaterialReloadHandled = useCallback((sequence: number) => {
    setMaterialReload((current) => current?.sequence === sequence ? undefined : current);
  }, []);
  const onOpenFileHandled = useCallback((sequence: number) => {
    setProjectFileSelection((current) => current?.sequence === sequence ? undefined : current);
  }, []);
  const onRunRequestHandled = useCallback((sequence: number) => {
    setWorkflowRunRequest((current) => current?.sequence === sequence ? undefined : current);
  }, []);
  const [sessionsRunning, setSessionsRunning] = useState(false);
  const [sessionSelection, setSessionSelection] = useState<{ id: string; sequence: number }>();
  const sessionSelectionSequence = useRef(0);
  const [workflowRunRequest, setWorkflowRunRequest] = useState<{ runId: string; sequence: number }>();
  const workflowRunSequence = useRef(0);
  const projectPath = state.project?.path;
  useEffect(() => {
    setMaterialDrafts([]);
    setMaterialReload(undefined);
    setPendingMaterialReload(undefined);
    setSessionSelection(undefined);
    setProjectFileSelection(undefined);
  }, [projectPath]);
  useEffect(() => {
    if (!materialDrafts.length) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [materialDrafts.length]);
  const { preferences } = state;
  const tr = useMemo(() => createTranslator(preferences.locale), [preferences.locale]);
  useEffect(() => {
    applyAppearance(preferences);
  }, [preferences]);
  useEffect(() => {
    document.documentElement.lang = preferences.locale;
  }, [preferences.locale]);
  useEffect(() => {
    configureCompletionSound(preferences.completionSound);
  }, [preferences.completionSound]);
  useEffect(() => watchSystemTheme(() => preferences), [preferences]);
  useEffect(() => {
    const sessions = api?.sessions; if (!sessions || !projectPath) return;
    let alive = true; let known: ChatSession[] = [];
    const update = (next: ChatSession) => { known = mergeSession(known, next); if (alive) setSessionsRunning(known.some((s) => s.status === "running" || s.status === "waiting")); };
    const root = projectPath ?? "";
    const unsubscribe = sessions.subscribe((event) => { if (event.projectPath === root && event.sessionId === event.session.id && event.runId === event.session.runId && event.seq === event.session.seq) update(event.session); });
    void sessions.list(root).then((list) => { if (alive) { for (const session of list) update(session); if (!known.length) setSessionsRunning(false); } }, (error) => { if (alive) workspace.reportError(error); });
    return () => { alive = false; unsubscribe(); };
  }, [api, projectPath, workspace.reportError]);
  const anyRunning =
    state.tasks.some((task) => task.running) ||
    workspace.pendingTasks.length > 0 ||
    workspace.chatRunning || sessionsRunning;
  function restart() {
    if (selected)
      setScope({
        title: selected.scope.title,
        ...(selected.scope.goal === undefined ? {} : { goal: selected.scope.goal }),
        readPaths: selected.scope.readPaths,
        writePaths: selected.scope.writePaths,
        mode: selected.scope.mode,
        allowDelete: selected.scope.allowDelete,
      });
  }
  function openProject(example = false) {
    if (materialDrafts.length) setPendingProjectOpen(example);
    else void workspace.openProject(example);
  }
  function exitProject() {
    if (materialDrafts.length) setPendingProjectExit(true);
    else void workspace.closeProject();
  }
  return (
    <LocaleProvider locale={preferences.locale}>
    <ContextMenu onError={workspace.reportError}>
      <div className="application">
      <header className="application-header">
        <div className="brand">
          <Mascot className="brand-logo" size={38} />
          <span>SpecLoom</span>
          <span className="brand-version">v{APP_VERSION}</span>
          <span className="brand-tag">{tr("项目开发")}</span>
        </div>
        <div className="header-actions">
          <button
            disabled={!api || busy || anyRunning}
            onClick={() => {
              if (state.project) exitProject();
              else openProject();
            }}
          >
            {state.project ? <Home size={16} /> : <FolderOpen size={16} />}
            {state.project ? tr("返回初始界面") : tr("打开项目")}
          </button>
          {state.project && (
            <>
              <button disabled={!api || busy} onClick={() => void api?.openGodot().catch(workspace.reportError)}>
                <Gamepad2 size={16} />
                {tr("打开 Godot")}
              </button>
              <button
                disabled={!api || busy}
                title={preferences.externalEditorPath.trim() ? tr("打开外部编辑器") : tr("未配置外部编辑器时打开项目文件夹")}
                onClick={() => void api?.openExternalEditor().catch(workspace.reportError)}
              >
                <Code2 size={16} />
                {tr("打开外部编辑器")}
              </button>
            </>
          )}
          {state.project && (
            <button
              className="primary"
              disabled={busy}
              onClick={() => setScope(true)}
            >
              <Plus size={16} />
              {tr("新建任务")}
            </button>
          )}
          <button
            className={`header-ghost ${tab === "settings" ? "active" : ""}`}
            aria-current={tab === "settings" ? "page" : undefined}
            title={tr("设置")}
            onClick={() => setTab("settings")}
          >
            <SlidersHorizontal size={16} />
            {tr("设置")}
          </button>
        </div>
      </header>
      {state.recoveryIssues?.map((issue, index) => (
        <div role="alert" className="error-notice" key={`${issue.code}-${index}`}>
          <AlertCircle size={18} />
          <div>
            <strong>上次运行的清理未完成</strong>
            <span>{issue.code}: {issue.message}</span>
            {issue.path && <code>{issue.path}</code>}
          </div>
        </div>
      ))}
      <ErrorNotice
        error={error}
        onDismiss={() => workspace.setError(undefined)}
        onReload={() => {
          if (tab === "documents") {
            if (error?.path && materialDrafts.some((draft) => draft.path === error.path)) {
              setPendingMaterialReload(error.path);
              return;
            }
            workspace.setError(undefined);
            setRevision((value) => value + 1);
            return;
          }
          void workspace.reread().then(() => setRevision((value) => value + 1));
        }}
        onRestart={selected ? restart : undefined}
      />
      {!state.project ? (
        tab === "settings" ? (
          <main className="main-content settings-standalone">
            <SettingsView
              api={api}
              project={state.project}
              preferences={preferences}
              busy={busy}
              standalone
              onUpdate={workspace.updatePreferences}
              onBack={() => setTab("workspace")}
            />
          </main>
        ) : (
        <main className="project-entry">
          <div className="entry-mascot">
            <div className="entry-mascot-row">
              <WelcomeOrbitMascot />
              <MascotSpeech />
            </div>
            <span className="mascot-name"><b>络络</b><span>THREAD SPRITE</span></span>
          </div>
          <h1>SpecLoom</h1>
          <span className="subtle">{tr("智能体项目工作区")}</span>
          <div className="entry-actions">
            <button
              className="primary"
              disabled={!api || busy}
              onClick={() => {
                openProject();
              }}
            >
              <FolderOpen size={17} />
              {tr("打开项目")}
            </button>
            <button
              disabled={!api || busy}
              onClick={() => {
                openProject(true);
              }}
            >
              <Sparkles size={17} />
              {tr("创建示例项目")}
            </button>
          </div>
          {!api && (
            <span className="connection-unavailable">桌面连接不可用</span>
          )}
          {state.recent.length > 0 && (
            <section className="recent-projects" aria-label="近期打开的项目">
              <header>
                <History size={14} />
                <h2>近期打开</h2>
              </header>
              <ul>
                {state.recent.map((item) => (
                  <li key={item.path} className={item.exists ? "" : "is-missing"}>
                    <button
                      className="recent-project"
                      disabled={!api || busy || !item.exists}
                      title={item.exists ? `打开 ${item.path}` : `路径不可用：${item.path}`}
                      onClick={() => {
                        void workspace.openRecent(item.path);
                      }}
                    >
                      <FolderOpen size={16} />
                      <span className="recent-detail">
                        <span className="recent-name">{item.name}</span>
                        <code className="recent-path">{item.path}</code>
                      </span>
                      <span className="recent-time">
                        {item.exists ? formatRelativeTime(item.openedAt) : "路径不可用"}
                      </span>
                    </button>
                      <IconButton
                        label={`从列表移除 ${item.name}`}
                        disabled={!api || busy}
                        onClick={() => {
                          void workspace.forgetRecent(item.path);
                        }}
                      >
                        <X size={15} />
                      </IconButton>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </main>
        )
      ) : (
        <div className={`application-shell${navigationExpanded ? "" : " is-nav-collapsed"}`}>
          <aside className={`application-sidebar ${navigationExpanded ? "is-open" : "is-collapsed"}${compactNavigation && navigationDrawerOpen ? " is-drawer-open" : ""}`}>
            <div className="sidebar-heading">
              <span className="sidebar-heading-text">导航</span>
              <button className="sidebar-toggle" aria-label={navigationExpanded ? "收起导航" : "展开导航"} title={navigationExpanded ? "收起导航" : "展开导航"} aria-expanded={navigationExpanded} aria-controls="project-navigation" onClick={() => compactNavigation ? setNavigationDrawerOpen(value => !value) : setNavigationOpen(value => !value)}>{navigationExpanded ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}</button>
            </div>
            <ProjectSidebarInfo
              key={state.project.path}
              project={state.project}
              expanded={navigationExpanded}
              onExpandNavigation={() => compactNavigation ? setNavigationDrawerOpen(true) : setNavigationOpen(true)}
            />
            <nav id="project-navigation" className="workspace-tabs" aria-label={tr("项目视图")}>
              {tabs.map((item) => {
                const category = "category" in item ? item.category as DocumentCategory : undefined;
                const active = tab === item.id && (category === undefined || documentCategory === category);
                return <div key={item.label} className="nav-entry">
                  {item.label === "实体" && <span className="nav-group-label">{tr("项目资料")}</span>}
                  {item.id === "skills" && <span className="nav-group-label">{tr("工具")}</span>}
                  {item.id === "settings" && <span className="nav-group-label">{tr("偏好")}</span>}
                  <button aria-label={tr(item.label)} aria-current={active ? "page" : undefined} className={active ? "active" : ""} title={tr(item.label)} onClick={() => {
                    setTab(item.id);
                    if (category) setDocumentCategory(category);
                    setNavigationDrawerOpen(false);
                  }}><item.icon size={17} /><span className="nav-label">{tr(item.label)}</span></button>
                </div>;
              })}
            </nav>
          </aside>
          <div className="application-body">
          <main className="main-content" key={state.project.path} data-view={tab}>
            <NavigationPage active={tab === "workspace"}>
            {api?.sessions && (
              <ChatWorkbench key={`${state.windowId ?? "standalone"}:${state.project.path}`} api={api.sessions} attachments={api.chatAttachments} projectPath={state.project.path} windowId={state.windowId} tasks={state.tasks} providers={state.providers ?? []} preferences={preferences}
                {...(sessionSelection ? { sessionSelection } : {})}
                {...(state.defaultModel ? { defaultModel: state.defaultModel } : {})}
                {...(state.sessionModel ? { sessionModel: state.sessionModel } : {})}
                selectedTaskId={workspace.selectedId} onSelectTask={workspace.setSelectedId} onNewTask={() => setScope(true)}
                review={review} busy={busy} onError={workspace.reportError} onRunningChange={setSessionsRunning}
                {...(api.workflow ? { workflow: api.workflow } : {})}
                onOpenWorkflowRun={(runId) => {
                  setWorkflowRunRequest({ runId, sequence: ++workflowRunSequence.current });
                  setTab("workflow");
                }}
                onFinished={() => { void workspace.refresh().then(() => workspace.refreshReview()).catch(workspace.reportError); }}
                documents={() => api.documents()}
                onReview={async (action) => { if (action === "refresh") await workspace.refreshReview(); else await workspace.reviewAction(action); setRevision((value) => value + 1); }}
              />
            )}
            {!api?.sessions && (
              <WorkspaceView
                tasks={state.tasks}
                selected={selected}
                onSelect={workspace.setSelectedId}
                onNew={() => setScope(true)}
                onRestart={restart}
                models={state.models}
                {...(state.providers ? { providers: state.providers } : {})}
                {...(state.defaultModel ? { defaultModel: state.defaultModel } : {})}
                {...(state.sessionModel ? { sessionModel: state.sessionModel } : {})}
                review={review}
                busy={busy}
                running={running}
                messages={selected ? (workspace.chats[selected.id] ?? selected.conversation ?? []) : workspace.chatMessages}
                onSend={workspace.send}
                onCancel={workspace.cancel}
                onRefresh={() => {
                  void workspace.refreshReview();
                }}
                onValidate={() => {
                  void workspace.reviewAction("validate");
                }}
                onApprove={() => {
                  void workspace
                    .reviewAction("approve")
                    .then(() => setRevision((value) => value + 1));
                }}
                onReject={() => {
                  void workspace.reviewAction("reject");
                }}
                onProviders={() => setTab("providers")}
                onStartConversation={workspace.sendConversation}
                onSessionModel={async (preference) => {
                  if (!api?.setSessionModel) return;
                  setRevision((value) => value + 1);
                  await api.setSessionModel(preference);
                  await workspace.refresh();
                }}
              />
            )}
            </NavigationPage>
            <NavigationPage active={tab === "workflow"}>
              {api && (
                <WorkflowView
                  key={state.project.path}
                  api={api}
                  models={state.models}
                  projectPath={state.project.path}
                  onError={workspace.reportError}
                  {...(workflowRunRequest ? { runRequest: workflowRunRequest } : {})}
                  onRunRequestHandled={onRunRequestHandled}
                />
              )}
            </NavigationPage>
            <NavigationPage active={tab === "documents"}>
            {api && (documentCategory === "entity" ? (
              <EntityWorkspace
                key={state.project.path}
                api={api}
                projectPath={state.project.path}
                onError={workspace.reportError}
                busy={workspace.busy}
                revision={revision}
                drafts={materialDrafts}
                onDraftsChange={setMaterialDrafts}
                onSavingChange={setMaterialSaving}
                {...(materialReload ? { reloadRequest: materialReload } : {})}
                {...(projectFileSelection ? { openFileRequest: projectFileSelection } : {})}
                onOpenFileHandled={onOpenFileHandled}
                onReloadHandled={onMaterialReloadHandled}
              />
            ) : (
              <DocumentsView
                active={tab === "documents"}
                key={state.project.path}
                api={api}
                projectPath={state.project.path}
                onError={workspace.reportError}
                busy={workspace.busy}
                onSavingChange={setMaterialSaving}
                revision={revision}
                category={documentCategory}
                drafts={materialDrafts}
                onDraftsChange={setMaterialDrafts}
                {...(materialReload ? { reloadRequest: materialReload } : {})}
                {...(projectFileSelection ? { openFileRequest: projectFileSelection } : {})}
                onOpenFileHandled={onOpenFileHandled}
                onReloadHandled={onMaterialReloadHandled}
              />
            ))}
            </NavigationPage>
            <NavigationPage active={tab === "skills"}>
            {api && (
              <SkillsView
                api={api}
                skillsApi={api.skills}
                task={selected}
                projectPath={state.project.path}
                onOpenChat={() => setTab("workspace")}
                onError={workspace.reportError}
                onNewTask={() => setScope(true)}
              />
            )}
            </NavigationPage>
            <NavigationPage active={tab === "plugins"}>
              {api && <PluginManagementView key={state.project.path} api={api} project={state.project} onError={workspace.reportError} />}
            </NavigationPage>
            <NavigationPage active={tab === "offlineDocs"}>{api && <OfflineDocsView api={api} onError={workspace.reportError} />}</NavigationPage>
            <NavigationPage active={tab === "hooks"}>{api && <HooksView api={api} active={tab === "hooks"} onError={workspace.reportError} />}</NavigationPage>
            <NavigationPage active={tab === "toolDocs"}><ToolDocsView api={api} projectPath={state.project.path} /></NavigationPage>
            <NavigationPage active={tab === "archived"}>{api && <ArchivedSessionsView key={`${state.windowId ?? "standalone"}:${state.project.path}`} api={api} projectPath={state.project.path} onError={workspace.reportError} onSelect={(session) => { workspace.setSelectedId(session.taskId ?? ""); setSessionSelection({ id: session.id, sequence: ++sessionSelectionSequence.current }); setTab("workspace"); }} />}</NavigationPage>
            <NavigationPage active={tab === "about"}>{api && <AboutView project={state.project} api={api} active={tab === "about"} onOpenFile={(path) => { setDocumentCategory("all"); setProjectFileSelection({ path, sequence: ++projectFileSequence.current }); setTab("documents"); }} />}</NavigationPage>
            <NavigationPage active={tab === "providers"}>
            {api && (
              <ProvidersView
                providers={state.providers ?? []}
                api={api}
                {...(state.defaultModel ? { defaultModel: state.defaultModel } : {})}
                busy={busy}
                onRefresh={workspace.refresh}
                onError={workspace.reportError}
              />
            )}
            </NavigationPage>
            <NavigationPage active={tab === "mcp"}>
              <McpView
                onStateChanged={api?.onStateChanged}
                connection={state.mcp}
                task={selected}
                sessionsApi={api?.sessions}
                godotPluginApi={state.project.engine === "godot" ? api?.pluginManagement : undefined}
                configApi={api?.mcpConfig}
                projectPath={state.project.path}
                onError={workspace.reportError}
              />
            </NavigationPage>
            <NavigationPage active={tab === "history"}>
              <HistoryView
                tasks={state.tasks}
                onRemove={async (id) => { await workspace.perform(async () => { await api?.removeTask(id); await workspace.refresh(); }); }}
                onSelect={(id) => {
                  const show = () => { workspace.setSelectedId(id); setTab("workspace"); };
                  if (api?.sessions && projectPath) void api.sessions.create(projectPath, undefined, id).then(show).catch(workspace.reportError);
                  else show();
                }}
              />
            </NavigationPage>
            <NavigationPage active={tab === "settings"}>
              <SettingsView
                api={api}
                project={state.project}
                preferences={preferences}
                busy={busy}
                onBack={() => setTab("workspace")}
                onUpdate={workspace.updatePreferences}
              />
            </NavigationPage>
          </main>
          </div>
        </div>
      )}
      {scope && (
        <ScopeForm
          initial={scope === true ? undefined : scope}
          busy={busy}
          onClose={() => setScope(undefined)}
          onCreate={async (spec) => {
            const task = await workspace.createTask(spec);
            if (task) {
              // A task owns one persistent conversation; open it so the first
              // implementation message starts the default workflow there.
              if (api?.sessions && projectPath) {
                const session = await api.sessions.create(projectPath, undefined, task.id);
                setSessionSelection({ id: session.id, sequence: ++sessionSelectionSequence.current });
              }
              setScope(undefined);
              setTab("workspace");
            }
          }}
        />
      )}
      {pendingProjectExit && (
        <Modal title="未保存的资料修改" onClose={() => setPendingProjectExit(false)}>
          <p>有 {materialDrafts.length} 份资料尚未保存。返回初始界面会丢弃这些修改。</p>
          <footer className="form-actions">
            <button onClick={() => setPendingProjectExit(false)}>继续编辑</button>
            <button onClick={() => {
              setPendingProjectExit(false);
              void workspace.closeProject();
            }}>返回初始界面并丢弃修改</button>
          </footer>
        </Modal>
      )}
      {pendingProjectOpen !== undefined && (
        <Modal title="未保存的资料修改" onClose={() => setPendingProjectOpen(undefined)}>
          <p>有 {materialDrafts.length} 份资料尚未保存。切换项目会丢弃这些修改。</p>
          <footer className="form-actions">
            <button onClick={() => setPendingProjectOpen(undefined)}>继续编辑</button>
            <button onClick={() => {
              const example = pendingProjectOpen;
              setPendingProjectOpen(undefined);
              void workspace.openProject(example);
            }}>切换项目并丢弃修改</button>
          </footer>
        </Modal>
      )}
      {pendingMaterialReload && (
        <Modal title="重新读取资料" onClose={() => setPendingMaterialReload(undefined)}>
          <p>重新读取会丢弃这份资料的未暂存修改，并加载项目中的最新内容。</p>
          <code>{pendingMaterialReload}</code>
          <footer className="form-actions">
            <button onClick={() => setPendingMaterialReload(undefined)}>继续编辑</button>
            <button onClick={() => {
              setMaterialReload({ path: pendingMaterialReload, sequence: ++reloadSequence.current });
              setPendingMaterialReload(undefined);
              workspace.setError(undefined);
            }}>丢弃修改并重新读取</button>
          </footer>
        </Modal>
      )}
      </div>
    </ContextMenu>
    </LocaleProvider>
  );
}
