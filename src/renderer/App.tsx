import {
  AlertCircle,
  BookOpen,
  Boxes,
  Cable,
  FolderOpen,
  History,
  Layers3,
  Plus,
  Settings2,
  Sparkles,
  Workflow,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { TaskScopeSpec } from "../shared/contracts";
import { DocumentsView } from "./DocumentsView";
import { ModelsView } from "./ModelsView";
import { ScopeForm } from "./ScopeForm";
import { HistoryView, McpView } from "./SettingsViews";
import { SkillsView } from "./SkillsView";
import { WorkspaceView } from "./WorkspaceView";
import { ErrorNotice } from "./ui";
import { useWorkspace } from "./useWorkspace";

const tabs = [
  { id: "workspace", label: "工作区", icon: Workflow },
  { id: "documents", label: "规范与实体", icon: Boxes },
  { id: "skills", label: "Skills", icon: BookOpen },
  { id: "models", label: "模型", icon: Settings2 },
  { id: "mcp", label: "MCP", icon: Cable },
  { id: "history", label: "历史", icon: History },
] as const;
type Tab = (typeof tabs)[number]["id"];
export default function App() {
  const api = window.specloom;
  const workspace = useWorkspace(api);
  const { state, selected, busy, running, review, error } = workspace;
  const [tab, setTab] = useState<Tab>("workspace");
  const [scope, setScope] = useState<Omit<TaskScopeSpec, "id"> | true>();
  const [revision, setRevision] = useState(0);
  const projectPath = state.project?.path;
  useEffect(() => {
    if (projectPath) void workspace.refresh().catch(workspace.reportError);
  }, [tab, projectPath, workspace.refresh, workspace.reportError]);
  const anyRunning =
    state.tasks.some((task) => task.running) ||
    workspace.pendingTasks.length > 0;
  function restart() {
    if (selected)
      setScope({
        title: selected.scope.title,
        readPaths: selected.scope.readPaths,
        writePaths: selected.scope.writePaths,
        mode: selected.scope.mode,
        allowDelete: selected.scope.allowDelete,
      });
  }
  async function stage(path: string, content: string, version?: string) {
    const task = await workspace.stageDocument(path, content, version);
    if (task) {
      setTab("workspace");
      setRevision((value) => value + 1);
    }
    return !!task;
  }
  return (
    <div className="application">
      <header className="application-header">
        <div className="brand">
          <Layers3 aria-hidden="true" size={23} />
          <span>SpecLoom</span>
          <span className="brand-tag">Godot</span>
        </div>
        <div className="header-actions">
          <button
            disabled={!api || busy || anyRunning}
            onClick={() => {
              void workspace.openProject();
            }}
          >
            <FolderOpen size={16} />
            打开 Godot 项目
          </button>
          {state.project && (
            <button
              className="primary"
              disabled={busy}
              onClick={() => setScope(true)}
            >
              <Plus size={16} />
              新建任务
            </button>
          )}
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
            workspace.setError(undefined);
            setRevision((value) => value + 1);
            return;
          }
          void workspace.reread().then(() => setRevision((value) => value + 1));
        }}
        onRestart={selected ? restart : undefined}
      />
      {!state.project ? (
        <main className="project-entry">
          <div className="entry-mark">
            <Layers3 size={42} />
          </div>
          <h1>SpecLoom</h1>
          <span className="subtle">Godot 项目工作区</span>
          <div className="entry-actions">
            <button
              className="primary"
              disabled={!api || busy}
              onClick={() => {
                void workspace.openProject();
              }}
            >
              <FolderOpen size={17} />
              打开 Godot 项目
            </button>
            <button
              disabled={!api || busy}
              onClick={() => {
                void workspace.openProject(true);
              }}
            >
              <Sparkles size={17} />
              创建示例项目
            </button>
          </div>
          {!api && (
            <span className="connection-unavailable">桌面连接不可用</span>
          )}
        </main>
      ) : (
        <>
          <section className="project-bar">
            <div className="project-identity">
              <h2>{state.project.name}</h2>
              <code title={state.project.path}>{state.project.path}</code>
            </div>
            <div className="godot-metadata">
              <span>
                Godot{" "}
                {state.project.godot.features[0] ??
                  state.project.godot.configVersion ??
                  "—"}
              </span>
              <span>{state.project.godot.features.slice(1).join(" · ")}</span>
              <code>{state.project.godot.mainScene ?? "未配置主场景"}</code>
            </div>
          </section>
          <nav className="workspace-tabs" aria-label="项目视图">
            {tabs.map((item) => (
              <button
                aria-current={tab === item.id ? "page" : undefined}
                className={tab === item.id ? "active" : ""}
                key={item.id}
                onClick={() => setTab(item.id)}
              >
                <item.icon size={17} />
                {item.label}
              </button>
            ))}
          </nav>
          <main className="main-content">
            {tab === "workspace" && (
              <WorkspaceView
                tasks={state.tasks}
                selected={selected}
                onSelect={workspace.setSelectedId}
                onNew={() => setScope(true)}
                onRestart={restart}
                models={state.models}
                review={review}
                busy={busy}
                running={running}
                messages={selected ? (workspace.chats[selected.id] ?? selected.conversation ?? []) : []}
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
                onModels={() => setTab("models")}
              />
            )}
            {tab === "documents" && api && (
              <DocumentsView
                api={api}
                onError={workspace.reportError}
                onStage={stage}
                busy={busy}
                revision={revision}
              />
            )}
            {tab === "skills" && api && (
              <SkillsView
                api={api}
                task={selected}
                onError={workspace.reportError}
                onNewTask={() => setScope(true)}
              />
            )}
            {tab === "models" && api && (
              <ModelsView
                models={state.models}
                busy={busy}
                onSave={async (profile, secret) => {
                  const result = await workspace.perform(async () => {
                    const saved = await api.saveModel(profile, secret);
                    await workspace.refresh();
                    return saved;
                  });
                  return !!result;
                }}
                onRemove={(id) => {
                  void workspace.perform(async () => {
                    await api.removeModel(id);
                    await workspace.refresh();
                  });
                }}
              />
            )}
            {tab === "mcp" && (
              <McpView
                connection={state.mcp}
                task={selected}
                onError={workspace.reportError}
              />
            )}
            {tab === "history" && (
              <HistoryView
                tasks={state.tasks}
                onSelect={(id) => {
                  workspace.setSelectedId(id);
                  setTab("workspace");
                }}
              />
            )}
          </main>
        </>
      )}
      {scope && (
        <ScopeForm
          initial={scope === true ? undefined : scope}
          busy={busy}
          onClose={() => setScope(undefined)}
          onCreate={async (spec) => {
            const task = await workspace.createTask(spec);
            if (task) {
              setScope(undefined);
              setTab("workspace");
            }
          }}
        />
      )}
    </div>
  );
}
