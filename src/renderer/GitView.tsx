import { useCallback, useEffect, useRef, useState } from "react";
import { GitBranch, RefreshCw } from "lucide-react";
import type { DesktopApi } from "../shared/desktop-api";
import { GitDiff } from "./GitDiff";
import "./git.css";

type FileStatus = { path: string; index: string; worktree: string; staged: boolean; unstaged: boolean };
type Repo = { state: "repository" | "not-repository" | "unavailable"; branch?: string; files: FileStatus[]; ahead: number; behind: number; upstream?: string };
type BranchResult = { current: string; branches: string[] };
type Commit = { hash: string; shortHash: string; subject: string; author: string; authoredAt: number };
type CommitDetail = { shortHash: string; subject: string; author: string; email: string; diff: string };

export function GitView({ api, pluginId, projectPath, onError }: { api: DesktopApi; pluginId: string; projectPath: string; onError: (error: unknown) => void }) {
  const [repo, setRepo] = useState<Repo>();
  const [branches, setBranches] = useState<BranchResult>({ current: "", branches: [] });
  const [history, setHistory] = useState<Commit[]>([]);
  const [selected, setSelected] = useState<FileStatus>();
  const selectedRef = useRef<FileStatus | undefined>(undefined);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [diff, setDiff] = useState("");
  const [diffTitle, setDiffTitle] = useState("差异");
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<"branches" | "history">("branches");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const invoke = useCallback(async (command: string, input?: unknown): Promise<unknown> => {
    if (!api.plugins) throw new Error("插件宿主不可用");
    return await api.plugins.invoke(pluginId, command, input);
  }, [api, pluginId]);

  const report = useCallback((failure: unknown) => {
    const text = failure instanceof Error ? failure.message : String(failure);
    setError(text); onError(failure);
  }, [onError]);

  const refresh = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const next = await invoke("state") as Repo;
      setRepo(next);
      setPicked((previous) => {
        if (!previous.size) return previous;
        const kept = [...previous].filter((path) => next.files.some((file) => file.path === path));
        return kept.length === previous.size ? previous : new Set(kept);
      });
      if (next.state !== "repository") { setBranches({ current: "", branches: [] }); setHistory([]); return; }
      setBranches(await invoke("branches") as BranchResult);
      setHistory((await invoke("history") as { commits: Commit[] }).commits);
      const active = selectedRef.current;
      if (active) {
        const current = next.files.find((file) => file.path === active.path);
        if (current) {
          setSelected(current); selectedRef.current = current;
          setDiff(((await invoke("diff", { path: current.path, staged: current.staged && !current.unstaged }) as { diff: string }).diff) || "没有可显示的差异。");
        }
      }
    } catch (failure) { report(failure); }
    finally { setBusy(false); }
  }, [invoke, report]);

  useEffect(() => { void refresh(); }, [refresh, projectPath]);

  const act = async (command: string, input?: unknown) => {
    setBusy(true); setError("");
    try { await invoke(command, input); await refresh(); }
    catch (failure) { report(failure); }
    finally { setBusy(false); }
  };

  const select = async (file: FileStatus) => {
    selectedRef.current = file; setSelected(file);
    setDiffTitle(`差异 · ${file.path}`); setDiff("读取中…");
    try { setDiff(((await invoke("diff", { path: file.path, staged: file.staged && !file.unstaged }) as { diff: string }).diff) || "没有可显示的差异。"); }
    catch (failure) { report(failure); }
  };

  const showCommit = async (commit: Commit) => {
    setBusy(true); setError("");
    try {
      const detail = await invoke("commitDetail", { hash: commit.hash }) as CommitDetail;
      setDiffTitle(`提交 ${detail.shortHash}`);
      setDiff(`${detail.subject}\n${detail.author} <${detail.email}>\n\n${detail.diff}`);
    } catch (failure) { report(failure); }
    finally { setBusy(false); }
  };

  const createBranch = () => {
    const name = window.prompt("新分支名称");
    if (name?.trim()) void act("createBranch", { name: name.trim() });
  };

  const sync = async (command: string, label: string) => {
    if (!window.confirm(`确认执行 ${label}？`)) return;
    await act(command);
  };

  const statusText = (file: FileStatus) => file.index === "?" || file.worktree === "?" ? "??" : (file.index + file.worktree).replaceAll(" ", "");

  if (!repo) return <section className="git-view"><p className="git-empty">正在读取 Git 状态…</p>{error && <p role="alert" className="git-error">{error}</p>}</section>;
  if (repo.state === "unavailable") return <section className="git-view"><h1>Git</h1><p role="alert" className="git-error">{error || "Git 插件不可用。"}</p><button disabled={busy} onClick={() => void refresh()}>重试</button></section>;
  if (repo.state === "not-repository") return <section className="git-view"><div className="git-heading"><div><span className="git-eyebrow">SPECLOOM</span><h1>Git</h1></div></div><p className="git-empty">当前项目还没有 Git 仓库。</p><button className="primary" disabled={busy} onClick={() => void act("init")}>初始化仓库</button>{error && <p role="alert" className="git-error">{error}</p>}</section>;

  const allPicked = repo.files.length > 0 && repo.files.every((file) => picked.has(file.path));
  const somePicked = !allPicked && repo.files.some((file) => picked.has(file.path));
  const pickedFiles = repo.files.filter((file) => picked.has(file.path));
  const stagePaths = pickedFiles.filter((file) => !(file.staged && !file.unstaged)).map((file) => file.path);
  const unstagePaths = pickedFiles.filter((file) => file.staged).map((file) => file.path);
  const togglePick = (path: string) => setPicked((previous) => { const next = new Set(previous); if (next.has(path)) next.delete(path); else next.add(path); return next; });
  const toggleAll = () => setPicked(allPicked ? new Set() : new Set(repo.files.map((file) => file.path)));

  return <section className="git-view">
    <header className="git-heading">
      <div><span className="git-eyebrow">SPECLOOM</span><h1>Git</h1><span className="git-branch"><GitBranch size={14} />{repo.branch || "detached"}</span>{repo.upstream && <span className="git-sync">↑{repo.ahead} ↓{repo.behind}</span>}</div>
      <div className="git-actions"><button disabled={busy} onClick={() => void refresh()}><RefreshCw size={14} />刷新</button><button disabled={busy} onClick={() => void sync("fetch", "获取远程分支")}>获取</button><button disabled={busy} onClick={() => void sync("pull", "拉取远程变更（仅快进）")}>拉取</button><button disabled={busy} onClick={() => void sync("push", "推送当前分支")}>推送</button></div>
    </header>
    {error && <p role="alert" className="git-error">{error}</p>}
    <div className="git-layout">
      <aside className="git-panel git-files"><div className="git-panel-heading"><h2>变更</h2><span>{repo.files.length ? `${repo.files.length} 个文件` : ""}</span></div>
        {repo.files.length === 0 ? <p className="git-empty">工作区干净。</p> : <>
          <div className="git-bulk"><label className="git-pick-all"><input type="checkbox" aria-label="全选变更文件" checked={allPicked} ref={(input) => { if (input) input.indeterminate = somePicked; }} onChange={toggleAll} />全选</label>
            <span>{pickedFiles.length ? `已选 ${pickedFiles.length}` : ""}</span>
            <button disabled={busy || !stagePaths.length} onClick={() => void act("stage", { paths: stagePaths })}>暂存所选</button>
            <button disabled={busy || !unstagePaths.length} onClick={() => void act("unstage", { paths: unstagePaths })}>取消暂存所选</button></div>
          {repo.files.map((file) => <div key={file.path} className={`git-file${selected?.path === file.path ? " active" : ""}`}><input type="checkbox" aria-label={`选择 ${file.path}`} checked={picked.has(file.path)} disabled={busy} onChange={() => togglePick(file.path)} /><button className="git-file-name" onClick={() => void select(file)}><b>{statusText(file)}</b>{file.path}</button><button disabled={busy} onClick={() => void act(file.staged && !file.unstaged ? "unstage" : "stage", { paths: [file.path] })}>{file.staged && !file.unstaged ? "取消暂存" : "暂存"}</button></div>)}
        </>}
      </aside>
      <main className="git-panel git-diff"><div className="git-panel-heading"><h2>{diffTitle}</h2></div><GitDiff text={diff || "选择一个文件查看差异。"} /></main>
      <aside className="git-panel git-side">
        <div className="git-panel-heading"><h2>提交</h2></div>
        <textarea value={message} maxLength={20000} placeholder="提交说明" onChange={(event) => setMessage(event.target.value)} />
        <button className="primary" disabled={busy || !message.trim()} onClick={() => { const text = message.trim(); void act("commit", { message: text }).then(() => setMessage("")); }}>提交已暂存变更</button>
        <div className="git-tabs" role="tablist"><button className={tab === "branches" ? "active" : ""} onClick={() => setTab("branches")}>分支</button><button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>历史</button></div>
        {tab === "branches" ? <div className="git-list"><button disabled={busy} onClick={createBranch}>新建分支</button>{branches.branches.map((branch) => <button key={branch} className={branch === branches.current ? "git-row current" : "git-row"} disabled={busy || branch === branches.current} onClick={() => void act("switchBranch", { name: branch })}>{branch}{branch === branches.current ? <span>当前</span> : null}</button>)}</div>
          : <div className="git-list">{history.length === 0 ? <p className="git-empty">还没有提交。</p> : history.map((commit) => <button key={commit.hash} className="git-history" disabled={busy} onClick={() => void showCommit(commit)}><b>{commit.subject}</b><small>{commit.shortHash} · {commit.author} · {new Date(commit.authoredAt * 1000).toLocaleString()}</small></button>)}</div>}
      </aside>
    </div>
  </section>;
}
