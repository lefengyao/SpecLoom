import {
  ArrowLeft,
  FileText,
  Link2,
  Monitor,
  Moon,
  Plus,
  Puzzle,
  RotateCcw,
  Server,
  Sun,
  Volume2,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { DesktopApi, McpConnection, TaskView, McpConfigApi } from "../shared/desktop-api";
import type { McpConfigScope, McpServerConfig, ManagedMcpServer } from "../shared/mcp-config";
import type { ProjectMetadata } from "../shared/contracts";
import {
  accentIds,
  accents,
  customInstructionsLimit,
  defaultPreferences,
  localeLabels,
  locales,
  styleLabels,
  themeLabels,
  themeModes,
  uiStyles,
  type Preferences,
  type ThemeMode,
} from "../shared/preferences";
import { previewCompletionChime } from "./sound";
import { AuditEvents } from "./WorkspaceView";
import { CopyButton, Status } from "./ui";
import { WorkspacePromptEditor } from "./WorkspacePromptEditor";
import { AvatarSettings } from "./AvatarSettings";
import { GodotMcpStatus, ProjectMcpInventory } from "./ProjectMcpInventory";
import type { ChatSessionsApi } from "../shared/chat";
import { useStateChangeRefresh } from "./useWorkspace";
import { DiagnosticsView } from "./DiagnosticsView";
import { useI18n } from "./i18n";

const themeIcons = { paper: FileText, system: Monitor, light: Sun, dark: Moon } as const;
type SettingsSectionId = "appearance" | "personalization" | "tools" | "agent" | "diagnostics";

const settingsSections: Array<{ id: SettingsSectionId; label: string }> = [
  { id: "appearance", label: "外观" },
  { id: "personalization", label: "个性化" },
  { id: "tools", label: "外部工具" },
  { id: "agent", label: "智能体" },
  { id: "diagnostics", label: "诊断日志" },
];

/**
 * Application preferences. Everything here is local to this installation and is
 * persisted through the desktop bridge; the agent instructions are forwarded to
 * the main process, where they are appended to the built-in system prompt.
 */
export function SettingsView({
  preferences,
  busy,
  standalone = false,
  onUpdate,
  onBack,
  api,
  project,
}: {
  preferences: Preferences;
  busy: boolean;
  standalone?: boolean;
  onUpdate: (patch: Partial<Preferences>) => Promise<void>;
  onBack?: () => void;
  api?: DesktopApi | undefined;
  project?: ProjectMetadata | undefined;
}) {
  const tr = useI18n();
  const [draft, setDraft] = useState(preferences.customInstructions);
  const [godotPath, setGodotPath] = useState(preferences.godotPath);
  const [externalEditorPath, setExternalEditorPath] = useState(preferences.externalEditorPath);
  const [activeSection, setActiveSection] = useState<SettingsSectionId>("appearance");
  useEffect(() => {
    setDraft(preferences.customInstructions);
    setGodotPath(preferences.godotPath);
    setExternalEditorPath(preferences.externalEditorPath);
  }, [preferences.customInstructions, preferences.godotPath, preferences.externalEditorPath]);
  const promptDirty = draft !== preferences.customInstructions;
  return (
    <section className="standard-view settings-view">
      <header className="section-heading">
        <div>
          <h1>{tr("设置")}</h1>
          <span className="subtle">{tr("本机偏好与当前项目的智能体要求")}</span>
        </div>
        {onBack && (
          <button onClick={onBack} aria-label={standalone ? tr("返回主界面") : tr("返回工作区")}>
            <ArrowLeft size={15} />
            {standalone ? tr("返回主界面") : tr("返回工作区")}
          </button>
        )}
      </header>

      <nav className="settings-section-nav" aria-label={tr("设置分区")}>
        {settingsSections.filter((section) => section.id !== "diagnostics" || api?.diagnostics).map((section) => (
          <button
            key={section.id}
            type="button"
            aria-current={activeSection === section.id ? "page" : undefined}
            onClick={() => setActiveSection(section.id)}
          >
            {tr(section.label)}
          </button>
        ))}
      </nav>

      <div className="settings-sections">
      {activeSection === "appearance" && <section className="settings-group" aria-label={tr("外观")}>
        <h2>{tr("外观")}</h2>
        <p className="field-hint">{tr("决定界面怎么显示，与项目内容无关。")}</p>
        <div className="setting-row">
          <div className="setting-label">
            <span>{tr("外观模式")}</span>
            <span className="field-hint">{tr("纸墨为官方配色；也可选择浅色、深色，或跟随操作系统")}</span>
          </div>
          <div className="segmented" role="radiogroup" aria-label={tr("外观模式")}>
            {themeModes.map((mode: ThemeMode) => {
              const Icon = themeIcons[mode];
              return (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={preferences.theme === mode}
                  disabled={busy}
                  onClick={() => {
                    void onUpdate({ theme: mode });
                  }}
                >
                  <Icon size={15} />
                  {tr(themeLabels[mode])}
                </button>
              );
            })}
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-label">
            <span>{tr("主题色")}</span>
            <span className="field-hint">{tr("按钮、选中项与运行状态使用的主色")}</span>
          </div>
          <div className="accent-options" role="radiogroup" aria-label={tr("主题色")}>
            {accentIds.map((id) => (
              <button
                key={id}
                type="button"
                className="accent-swatch"
                role="radio"
                aria-checked={preferences.accent === id}
                aria-label={tr(accents[id].label)}
                title={tr(accents[id].label)}
                disabled={busy}
                style={{ "--swatch": accents[id].color } as CSSProperties}
                onClick={() => {
                  void onUpdate({ accent: id });
                }}
              />
            ))}
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-label">
            <span>{tr("界面风格")}</span>
            <span className="field-hint">{tr("紧凑风格缩小间距、控件高度与圆角")}</span>
          </div>
          <div className="segmented" role="radiogroup" aria-label={tr("界面风格")}>
            {uiStyles.map((style) => (
              <button
                key={style}
                type="button"
                role="radio"
                aria-checked={preferences.style === style}
                disabled={busy}
                onClick={() => {
                  void onUpdate({ style });
                }}
              >
                {tr(styleLabels[style])}
              </button>
            ))}
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-label">
            <span>{tr("语言 / Language")}</span>
            <span className="field-hint">{tr("界面语言；切换后立即生效。")}</span>
          </div>
          <div className="segmented" role="radiogroup" aria-label={tr("界面语言")}>
            {locales.map((locale) => (
              <button
                key={locale}
                type="button"
                role="radio"
                aria-checked={preferences.locale === locale}
                disabled={busy}
                onClick={() => void onUpdate({ locale })}
              >
                {tr(localeLabels[locale])}
              </button>
            ))}
          </div>
        </div>
      </section>}

      {activeSection === "personalization" && <AvatarSettings preferences={preferences} busy={busy} onUpdate={onUpdate} />}
      {activeSection === "tools" && <section className="settings-group" aria-label={tr("外部工具")}>
        <h2>{tr("外部工具")}</h2>
        <p className="field-hint">{tr("头像和外部工具属于本机偏好，应用于所有项目。")}</p>
        <div className="setting-block">
          <div className="setting-label">
            <span>{tr("可执行文件路径")}</span>
            <span className="field-hint">{tr("配置 Godot 与外部代码编辑器的可执行文件路径。")}</span>
          </div>
          <label className="setting-label">{tr("Godot 可执行文件")}<input aria-label={tr("Godot 可执行文件")} value={godotPath} disabled={busy} onChange={(event) => setGodotPath(event.target.value)} /></label>
          <label className="setting-label">{tr("外部编辑器可执行文件")}<input aria-label={tr("外部编辑器可执行文件")} value={externalEditorPath} disabled={busy} onChange={(event) => setExternalEditorPath(event.target.value)} /></label>
          <div className="setting-actions">
            <button type="button" className="primary" disabled={busy} onClick={() => void onUpdate({ godotPath, externalEditorPath })}>{tr("保存外部工具路径")}</button>
          </div>
        </div>
      </section>}

      {activeSection === "agent" && <section className="settings-group settings-group-wide" aria-label={tr("智能体")}>
        <h2>{tr("智能体")}</h2>
        <p className="field-hint">
          {tr("全局要求跨项目生效，项目要求仅用于当前项目；保存后下一轮会话立即生效。")}
        </p>
        <div className="setting-row">
          <div className="setting-label">
            <span>{tr("回复完成提示音")}</span>
            <span className="field-hint">{tr("智能体完成一次回复后播放提示音")}</span>
          </div>
          <div className="setting-actions">
            <button
              type="button"
              className="switch"
              role="switch"
              aria-checked={preferences.completionSound}
              aria-label={tr("回复完成提示音")}
              disabled={busy}
              onClick={() => {
                void onUpdate({ completionSound: !preferences.completionSound });
              }}
            >
              {preferences.completionSound ? tr("已开启") : tr("已关闭")}
            </button>
            <button type="button" disabled={busy} onClick={previewCompletionChime}>
              <Volume2 size={15} />
              {tr("试听")}
            </button>
          </div>
        </div>
        <div className="setting-block">
          <div className="setting-label">
            <span>{tr("智能体稳定性偏好")}</span>
            <span className="field-hint">
              {tr("0–100：越高越精准稳定，越低越发散创新；独立于逐模型配置，按 temperature = (120 − 偏好值) / 100 转换（当前 {value}）", { value: (120 - preferences.agentTemperature) / 100 })}
            </span>
          </div>
          <div className="setting-actions">
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              aria-label={tr("智能体稳定性偏好")}
              value={preferences.agentTemperature}
              disabled={busy}
              onChange={(event) => {
                void onUpdate({ agentTemperature: Number(event.target.value) });
              }}
            />
            <code>{preferences.agentTemperature}</code>
          </div>
        </div>
        <div className="setting-block">
          <div className="setting-label">
            <span>{tr("全局个性化提示词")}</span>
            <span className="field-hint">
              {tr("追加在内置系统提示词之后，跨项目保存于本机设置；最多 {limit} 字", { limit: customInstructionsLimit })}
            </span>
          </div>
          <textarea
            aria-label={tr("智能体自定义提示词")}
            placeholder={tr("例如：回答先给结论；GDScript 注释用中文；不要引入新的第三方插件。")}
            rows={6}
            maxLength={customInstructionsLimit}
            value={draft}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="setting-actions">
            <span className="field-hint">
              {draft.length} / {customInstructionsLimit} · {promptDirty ? tr("有未保存的修改") : tr("已是最新")}
            </span>
            <button
              type="button"
              className="primary"
              disabled={busy || !promptDirty}
              onClick={() => {
                void onUpdate({ customInstructions: draft });
              }}
            >
              {tr("保存提示词")}
            </button>
          </div>
        </div>
        <WorkspacePromptEditor key={project?.path ?? "no-project"} api={api} project={project} busy={busy} />
      </section>}
      {activeSection === "diagnostics" && api?.diagnostics && <DiagnosticsView api={api.diagnostics} />}
      </div>

      <footer className="settings-footer">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void onUpdate({ ...defaultPreferences, userAvatar: "", assistantAvatar: "" });
          }}
        >
          <RotateCcw size={15} />
          {tr("恢复默认设置")}
        </button>
      </footer>
    </section>
  );
}

export function McpView({
  connection,
  task,
  onError,
  sessionsApi,
  godotPluginApi,
  projectPath,
  configApi,
  onStateChanged,
}: {
  connection: McpConnection | undefined;
  task: TaskView | undefined;
  onError: (value: unknown) => void;
  sessionsApi?: ChatSessionsApi | undefined;
  godotPluginApi?: DesktopApi["pluginManagement"] | undefined;
  projectPath?: string | undefined;
  configApi?: McpConfigApi | undefined;
  onStateChanged?: DesktopApi["onStateChanged"];
}) {
  type McpSectionId = "godot" | "external" | "specloom";
  const initialSection: McpSectionId = godotPluginApi ? "godot" : "external";
  const tr = useI18n();
  const [activeSection, setActiveSection] = useState<McpSectionId>(initialSection);
  const [visitedSections, setVisitedSections] = useState<Set<McpSectionId>>(() => new Set([initialSection]));
  const showSection = (id: McpSectionId) => {
    setActiveSection(id);
    setVisitedSections((previous) => previous.has(id) ? previous : new Set([...previous, id]));
  };
  const sections = [
    ...(godotPluginApi ? [{ id: "godot" as const, label: "Godot MCP", icon: Puzzle }] : []),
    { id: "external" as const, label: "外部 MCP", icon: Server },
    { id: "specloom" as const, label: "连接 SpecLoom", icon: Link2 },
  ];
  useEffect(() => {
    if (!godotPluginApi && activeSection === "godot") {
      setActiveSection("external");
      setVisitedSections((previous) => previous.has("external") ? previous : new Set([...previous, "external"]));
    }
  }, [activeSection, godotPluginApi]);
  const handleSectionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const nextIndex = event.key === "ArrowRight" ? (index + 1) % sections.length : event.key === "ArrowLeft" ? (index - 1 + sections.length) % sections.length : event.key === "Home" ? 0 : event.key === "End" ? sections.length - 1 : undefined;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const next = sections[nextIndex]!;
    showSection(next.id);
    document.getElementById(`mcp-tab-${next.id}`)?.focus();
  };
  const config = connection
    ? {
        mcpServers: {
          specloom: {
            url: connection.url,
            headers: { Authorization: `Bearer ${connection.token}` },
          },
        },
      }
    : undefined;
  const visibleConfig = config
    ? {
        mcpServers: {
          specloom: {
            ...config.mcpServers.specloom,
            headers: {
              ...config.mcpServers.specloom.headers,
              Authorization: `Bearer <${tr("访问令牌")}>`,
            },
          },
        },
      }
    : undefined;
  return (
    <section className="standard-view mcp-view">
      <header className="section-heading">
        <h1>MCP</h1>
      </header>
      <nav className="mcp-category-tabs" role="tablist" aria-label={tr("MCP 分类")}>
        {sections.map((section, index) => {
          const Icon = section.icon;
          return <button key={section.id} id={`mcp-tab-${section.id}`} type="button" role="tab" aria-selected={activeSection === section.id} aria-controls={`mcp-panel-${section.id}`} tabIndex={activeSection === section.id ? 0 : -1} onClick={() => showSection(section.id)} onKeyDown={(event) => handleSectionKeyDown(event, index)}><Icon size={15} aria-hidden="true" />{tr(section.label)}</button>;
        })}
      </nav>
      {godotPluginApi && <div id="mcp-panel-godot" className="mcp-category-panel" role="tabpanel" aria-labelledby="mcp-tab-godot" tabIndex={0} hidden={activeSection !== "godot"}>
        {visitedSections.has("godot") && <GodotMcpStatus api={godotPluginApi} projectPath={projectPath} onError={onError} />}
      </div>}
      <div id="mcp-panel-external" className="mcp-category-panel" role="tabpanel" aria-labelledby="mcp-tab-external" tabIndex={0} hidden={activeSection !== "external"}>
        {visitedSections.has("external") && <>
          <ProjectMcpInventory api={sessionsApi} projectPath={projectPath} onError={onError} />
          {configApi && <McpConfigEditor api={configApi} projectPath={projectPath} onStateChanged={onStateChanged} onError={onError} />}
        </>}
      </div>
      <div id="mcp-panel-specloom" className="mcp-category-panel" role="tabpanel" aria-labelledby="mcp-tab-specloom" tabIndex={0} hidden={activeSection !== "specloom"}>
        {visitedSections.has("specloom") && <section className="mcp-connection-panel" aria-label={tr("连接 SpecLoom 的 MCP 服务")}>
          <header className="section-heading"><div><h2>{tr("连接 SpecLoom 的 MCP 服务")}</h2><p className="field-hint">{tr("让外部客户端调用当前 SpecLoom 工作区提供的工具。")}</p></div><span className={`status ${connection ? "status-applied" : "status-staged"}`}>{connection ? tr("已启动") : tr("未连接")}</span></header>
          {connection ? <>
            <dl className="connection-fields">
              <dt>{tr("地址")}</dt>
              <dd><code>{connection.url}</code><CopyButton value={connection.url} label={tr("复制 MCP 地址")} onError={onError} /></dd>
              <dt>{tr("访问令牌")}</dt>
              <dd><input type="password" readOnly value={connection.token} aria-label={tr("MCP 访问令牌")} /><CopyButton value={connection.token} label={tr("复制 MCP 访问令牌")} onError={onError} /></dd>
              <dt>{tr("当前任务 ID")}</dt>
              <dd><code>{task?.id ?? tr("未选择任务")}</code>{task && <CopyButton value={task.id} label={tr("复制任务 ID")} onError={onError} />}</dd>
            </dl>
            <header className="section-heading"><h2>{tr("连接配置")}</h2><CopyButton value={JSON.stringify(config, null, 2)} label={tr("复制连接配置")} onError={onError} /></header>
            <pre className="config-code">{JSON.stringify(visibleConfig, null, 2)}</pre>
            {task && <>
              <header className="section-heading mcp-tool-heading"><h2>files.list_versions · {tr("参数")}</h2><CopyButton value={JSON.stringify({ taskId: task.id, paths: ["specs/project.md"] }, null, 2)} label={tr("复制工具参数")} onError={onError} /></header>
              <pre className="config-code">{JSON.stringify({ taskId: task.id, paths: ["specs/project.md"] }, null, 2)}</pre>
            </>}
          </> : <p className="empty-state">{tr("MCP 服务未就绪")}</p>}
        </section>}
      </div>
    </section>
  );
}

function McpConfigEditor({ api, projectPath, onStateChanged, onError }: { api: McpConfigApi; projectPath?: string | undefined; onStateChanged?: DesktopApi["onStateChanged"]; onError: (error: unknown) => void }) {
  const tr = useI18n();
  const [items, setItems] = useState<ManagedMcpServer[]>([]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState(""); const [scope, setScope] = useState<McpConfigScope>("project"); const [kind, setKind] = useState<"stdio" | "http">("stdio"); const [command, setCommand] = useState(""); const [url, setUrl] = useState(""); const [args, setArgs] = useState(""); const [headers, setHeaders] = useState(""); const [env, setEnv] = useState(""); const [busy, setBusy] = useState(false);
  const requestSeq = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++requestSeq.current;
    try {
      const next = await api.list(projectPath);
      if (request === requestSeq.current) setItems(next);
    } catch (error) { if (request === requestSeq.current) onError(error); }
  }, [api, projectPath, onError]);
  useStateChangeRefresh(onStateChanged, refresh);
  useEffect(() => { void refresh(); return () => { requestSeq.current++; }; }, [refresh]);
  const acceptItems = (next: ManagedMcpServer[]) => { requestSeq.current++; setItems(next); };
  function config(): McpServerConfig { const parse = (value: string): Record<string, string> | undefined => { if (!value.trim()) return undefined; const parsed: unknown = JSON.parse(value); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(tr("环境变量和请求头必须是 JSON 对象")); return Object.fromEntries(Object.entries(parsed).map(([key, item]) => [key, String(item)])); }; return kind === "stdio" ? { command: command.trim(), ...(args.trim() ? { args: args.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean) } : {}), ...(parse(env) ? { env: parse(env) } : {}) } : { url: url.trim(), ...(parse(headers) ? { headers: parse(headers) } : {}) }; }
  function closeForm() { setAdding(false); setName(""); setScope("project"); setKind("stdio"); setCommand(""); setUrl(""); setArgs(""); setHeaders(""); setEnv(""); }
  async function save() { if (!name.trim()) return; setBusy(true); try { acceptItems(await api.save(scope, projectPath, name.trim(), config())); closeForm(); } catch (error) { onError(error); } finally { setBusy(false); } }
  return <section className="settings-group settings-group-wide" aria-label={tr("MCP 配置")}>
    <header className="section-heading"><div><h2>{tr("可配置 MCP 服务")}</h2><p className="field-hint">{tr("支持项目级和全局配置。")}</p></div><div className="button-row"><button className="primary" type="button" aria-expanded={adding} aria-controls="mcp-add-form" disabled={busy || adding} onClick={() => setAdding(true)}><Plus size={16} />{tr("添加 MCP")}</button><button type="button" disabled={busy} onClick={() => void refresh()}>{tr("刷新")}</button></div></header>
    {adding && <div id="mcp-add-form" className="form-grid compact-form">
      <label>{tr("服务名称")}<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={tr("例如 docs")} /></label>
      <label>{tr("配置范围")}<select value={scope} onChange={(event) => setScope(event.target.value as McpConfigScope)}><option value="project">{tr("当前项目")}</option><option value="global">{tr("全局")}</option></select></label>
      <label>{tr("传输类型")}<select value={kind} onChange={(event) => setKind(event.target.value as "stdio" | "http")}><option value="stdio">stdio</option><option value="http">HTTP</option></select></label>
      {kind === "stdio" ? <><label>{tr("启动命令")}<input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="node" /></label><label>{tr("参数（每行一个）")}<textarea rows={2} value={args} onChange={(event) => setArgs(event.target.value)} /></label><label>{tr("环境变量 JSON（可选）")}<input type="password" value={env} onChange={(event) => setEnv(event.target.value)} placeholder='{"TOKEN":"…"}' /></label></> : <><label>{tr("服务 URL")}<input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://…/mcp" /></label><label>{tr("请求头 JSON（可选）")}<input type="password" value={headers} onChange={(event) => setHeaders(event.target.value)} placeholder='{"Authorization":"Bearer …"}' /></label></>}
      <div className="button-row"><button className="primary" type="button" disabled={busy || !name.trim() || (kind === "stdio" ? !command.trim() : !url.trim())} onClick={() => void save()}>{tr("保存 MCP 服务")}</button><button type="button" disabled={busy || (!command.trim() && !url.trim())} onClick={() => void api.test(config()).then((result) => { if (!result.ok) throw new Error(result.message); }).catch(onError)}>{tr("测试连接")}</button><button type="button" disabled={busy} onClick={closeForm}>{tr("取消")}</button></div>
    </div>}
    <div className="stack-list">{items.length ? items.map((item) => <article className="settings-card" key={`${item.scope}:${item.name}`}><div className="settings-card-heading"><div><h3>{item.name}</h3><p className="subtle">{item.scope === "global" ? tr("全局") : tr("当前项目")} · {item.config.url ? item.config.url : item.config.command}</p></div><label className="checkbox-label"><input type="checkbox" checked={item.config.enabled !== false} onChange={() => void api.setEnabled(item.scope, projectPath, item.name, item.config.enabled === false).then(acceptItems).catch(onError)} />{tr("启用")}</label></div><div className="button-row"><button type="button" onClick={() => void api.test(item.config).then((result) => { if (!result.ok) throw new Error(result.message); }).catch(onError)}>{tr("测试连接")}</button><button className="danger-ghost" type="button" onClick={() => void api.remove(item.scope, projectPath, item.name).then(acceptItems).catch(onError)}>{tr("删除")}</button></div></article>) : <p className="empty-state">{tr("还没有配置 MCP 服务。")}</p>}</div>
  </section>;
}
export function HistoryView({
  tasks,
  onSelect,
  onRemove,
}: {
  tasks: TaskView[];
  onSelect: (id: string) => void;
  onRemove?: (id: string) => Promise<void> | void;
}) {
  const tr = useI18n();
  return (
    <section className="standard-view">
      <header className="section-heading">
        <h1>{tr("历史")}</h1>
        <span className="subtle">{tasks.length} {tr("个任务")}</span>
      </header>
      {[...tasks].reverse().map((task) => (
        <article className="history-task" key={task.id}>
          <header className="section-heading">
            <button className="text-button" onClick={() => onSelect(task.id)}>
              {task.scope.title}
            </button>
            <Status status={task.status} running={task.running} />
            {onRemove && !task.running && !["staged", "validated", "committing"].includes(task.status) && (
              <button type="button" aria-label={tr("删除任务 {title}", { title: task.scope.title })} title={tr("删除历史记录")} onClick={() => void onRemove(task.id)}>
                <Trash2 size={15} />
              </button>
            )}
          </header>
          <code>{task.id}</code>
          {task.summary && <p>{task.summary}</p>}
          <AuditEvents task={task} />
        </article>
      ))}
      {!tasks.length && <p className="empty-state">{tr("暂无任务记录")}</p>}
    </section>
  );
}
