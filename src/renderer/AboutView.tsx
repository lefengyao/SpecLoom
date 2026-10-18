import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectMetadata } from "../shared/contracts";
import type { DesktopApi } from "../shared/desktop-api";
import type { GitSnapshot, ProjectDocumentRef, ProjectOverview } from "../shared/project-overview";
import { APP_INFO } from "../shared/app-info";
import "./about-view.css";

interface DocumentPreview { loading?: boolean; content?: string; error?: string }
export interface AboutViewProps { project: ProjectMetadata; api: DesktopApi; active: boolean; onOpenFile(path: string): void }
const documentState = { missing: "尚未创建", file: "可读取", unreadable: "无法读取", unsupported: "不支持预览（仅支持 1 MiB 以内的 UTF-8 文本）" };
const locations = { root: "仓库根目录", nested: "父仓库中的项目目录", "linked-worktree": "链接工作树" };

function GitDetails({ git }: { git: GitSnapshot }) {
  if (git.state === "not-repository") return <p className="subtle">当前项目不属于 Git 仓库。</p>;
  if (git.state === "unavailable" || git.state === "error") return <p role="alert" className="about-error">{git.issue.message}</p>;
  if (git.state === "bare") return <><p>裸仓库（没有工作树）</p><code>{git.gitDir}</code></>;
  const head = git.head.kind === "branch" ? git.head.name : git.head.kind === "unborn" ? `${git.head.name}（尚无提交）` : git.head.kind === "detached" ? `分离 HEAD · ${git.head.commit.slice(0, 12)}` : "无法确定";
  return <>
    <dl className="about-facts"><dt>仓库位置</dt><dd>{locations[git.location]}</dd><dt>工作树根目录</dt><dd><code>{git.worktreeRoot}</code></dd><dt>当前 HEAD</dt><dd>{head}</dd>{git.head.kind === "branch" && <><dt>当前提交</dt><dd><code>{git.head.commit}</code></dd></>}</dl>
    {git.issues.length > 0 && <div role="alert" className="about-error">{git.issues.map((issue, i) => <p key={`${issue.code}-${i}`}>{issue.message}</p>)}</div>}
    <h3>分支</h3>
    {git.branchesState === "error" ? <p className="about-error">分支列表读取失败。</p> : git.branches.length ? <div className="about-scroll"><table className="about-table"><thead><tr><th>类型</th><th>分支</th><th>上游</th></tr></thead><tbody>{git.branches.map(branch => <tr key={branch.ref}><td>{branch.kind === "local" ? "本地" : "远程跟踪"}</td><td><code>{branch.name}</code>{branch.kind === "local" && (git.head.kind === "branch" || git.head.kind === "unborn") && git.head.name === branch.name && <span className="about-current">当前</span>}</td><td><code>{branch.upstream || "—"}</code></td></tr>)}</tbody></table></div> : <p className="subtle">没有已创建的分支引用。</p>}
    {git.branchesTruncated && <p role="alert" className="about-error">分支列表超过读取上限，结果不完整。</p>}
    <h3>远程仓库</h3>
    {git.remotesState === "error" ? <p className="about-error">远程仓库读取失败。</p> : git.remotes.length ? git.remotes.map(remote => <div className="about-remote" key={remote.name}><strong>{remote.name}</strong><dl className="about-facts"><dt>Fetch</dt><dd>{remote.fetchUrls.length ? remote.fetchUrls.map((url, i) => <code key={`${url}-${i}`}>{url}</code>) : "未配置"}</dd><dt>Push</dt><dd>{remote.pushUrls.length ? remote.pushUrls.map((url, i) => <code key={`${url}-${i}`}>{url}</code>) : "未配置"}</dd></dl></div>) : <p className="subtle">未配置远程仓库。</p>}
    <p className="subtle">来自本地 Git 信息；远程跟踪分支可能尚未更新。</p>
  </>;
}

export function AboutView({ project, api, active, onOpenFile }: AboutViewProps) {
  const [overview, setOverview] = useState<ProjectOverview>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [previews, setPreviews] = useState<Record<string, DocumentPreview>>({});
  const request = useRef(0);
  const currentProject = useRef(project.path); currentProject.current = project.path;
  const documentRequests = useRef(new Map<string, number>());
  const refresh = useCallback(async () => {
    const id = ++request.current;
    if (!api.projectOverview) { setError("当前桌面端不支持项目概览，请更新后重试。"); return; }
    setLoading(true); setError("");
    try {
      const next = await api.projectOverview.read(project.path);
      if (id === request.current && next.projectPath === currentProject.current) { setOverview(next); setPreviews({}); documentRequests.current.clear(); }
    } catch { if (id === request.current) setError("项目概览读取失败，请重试。"); }
    finally { if (id === request.current) setLoading(false); }
  }, [api.projectOverview, project.path]);
  useEffect(() => {
    ++request.current; setOverview(undefined); setPreviews({}); setError(""); setLoading(false); documentRequests.current.clear();
  }, [project.path]);
  useEffect(() => {
    if (!active) { ++request.current; setLoading(false); return; }
    void refresh();
    const focused = () => { void refresh(); };
    window.addEventListener("focus", focused);
    return () => { ++request.current; window.removeEventListener("focus", focused); };
  }, [active, refresh]);
  const preview = async (document: ProjectDocumentRef) => {
    if (document.state !== "file" || previews[document.path]?.loading || previews[document.path]?.content !== undefined) return;
    if (documentRequests.current.has(document.path)) return;
    const root = project.path;
    const overviewRequest = request.current;
    const id = (documentRequests.current.get(document.path) ?? 0) + 1; documentRequests.current.set(document.path, id);
    setPreviews(previous => ({ ...previous, [document.path]: { loading: true } }));
    try {
      if (!api.projectFiles) throw new Error("Unavailable");
      const result = await api.projectFiles.readText(root, document.path);
      if (currentProject.current === root && request.current === overviewRequest && documentRequests.current.get(document.path) === id) setPreviews(previous => ({ ...previous, [document.path]: { content: result.content } }));
    } catch { if (currentProject.current === root && request.current === overviewRequest && documentRequests.current.get(document.path) === id) setPreviews(previous => ({ ...previous, [document.path]: { error: "文档读取失败，请刷新概览后重试。" } })); }
  };
  const renderDocument = (document: ProjectDocumentRef) => <div className="about-document" key={`${project.path}:${document.path}:${request.current}`}>
    <div className="about-document-title"><strong><code>{document.path}</code></strong><span className="subtle">{documentState[document.state]}</span>{document.state !== "missing" && <button type="button" onClick={() => onOpenFile(document.path)}>打开文件</button>}</div>
    {document.state === "file" && <details onToggle={event => { if (event.currentTarget.open) void preview(document); }}><summary>只读预览 {document.path}</summary>{previews[document.path]?.loading ? <p className="subtle">正在读取…</p> : previews[document.path]?.error ? <p role="alert" className="about-error">{previews[document.path]?.error}</p> : <pre className="about-preview">{previews[document.path]?.content}</pre>}</details>}
  </div>;
  const visible = overview?.projectPath === project.path ? overview : undefined;
  return <section className="standard-view about-view"><header className="standard-view-header"><div><span className="eyebrow">项目</span><h1>关于项目</h1><p className="subtle">项目资料与本地 Git 概览。</p></div><button type="button" onClick={() => { void refresh(); }} disabled={loading}>{loading ? "正在刷新…" : "刷新项目概览"}</button></header>
    <div className="settings-card"><h2>项目信息</h2><dl className="about-facts"><dt>项目名称</dt><dd>{project.name}</dd><dt>项目路径</dt><dd><code>{project.path}</code></dd><dt>描述</dt><dd>{project.description || "尚未填写项目描述"}</dd><dt>引擎</dt><dd>{project.engine === "generic" ? "通用项目" : "Godot"}</dd>{project.engine === "godot" && <><dt>Godot 特性</dt><dd>{project.godot?.features?.join(" · ") || "—"}</dd><dt>主场景</dt><dd>{project.godot?.mainScene || "未配置主场景"}</dd></>}</dl></div>
    <div className="settings-card"><h2>Git</h2>{error && <p role="alert" className="about-error">{error}</p>}{visible ? <><GitDetails git={visible.git} /><p className="subtle">检查时间：{new Date(visible.inspectedAt).toLocaleString()}</p></> : !error && <p className="subtle">{loading ? "正在读取 Git 信息…" : "尚未读取项目概览。"}</p>}</div>
    <div className="settings-card"><h2>项目文档</h2><p className="subtle">只显示当前项目根目录中的文件。</p>{visible ? <>{renderDocument(visible.documents.gitignore)}{visible.documents.readmes.length ? visible.documents.readmes.map(renderDocument) : <p className="subtle">根目录中尚无 README。</p>}</> : <p className="subtle">读取项目概览后显示文档。</p>}</div>
    <div className="settings-card"><h2>{APP_INFO.name}</h2><dl className="about-facts"><dt>版本</dt><dd>{APP_INFO.version}</dd><dt>说明</dt><dd>{APP_INFO.description}</dd><dt>作者</dt><dd>{APP_INFO.author}</dd></dl></div>
  </section>;
}
