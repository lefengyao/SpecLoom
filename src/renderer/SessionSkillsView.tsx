import { RefreshCw } from "lucide-react";
import type { ChatSessionsApi } from "../shared/chat";
import type { DesktopApi, SkillsApi } from "../shared/desktop-api";
import type { ManagedSkill } from "../shared/skill-management";
import { useCallback, useEffect, useRef, useState } from "react";
import { CopyButton, IconButton } from "./ui";
import { useSessionCapabilities } from "./useSessionCapabilities";
import { useStateChangeRefresh } from "./useWorkspace";
import "./capability-views.css";

export function SessionSkillsView({ api, projectPath, onError, onOpenChat, skillsApi, onStateChanged }: { api: ChatSessionsApi; projectPath: string; onError: (error: unknown) => void; onOpenChat?: (() => void) | undefined; skillsApi?: SkillsApi | undefined; onStateChanged?: DesktopApi["onStateChanged"] }) {
  const inventory = useSessionCapabilities(skillsApi ? undefined : api, projectPath, onError);
  const [projectSkills, setProjectSkills] = useState<ManagedSkill[]>([]);
  const [projectLoading, setProjectLoading] = useState(!!skillsApi);
  const [projectError, setProjectError] = useState(false);
  const generation = useRef(0);
  const refreshProject = useCallback(async () => {
    if (!skillsApi) return;
    const current = ++generation.current;
    setProjectLoading(true); setProjectError(false);
    try {
      const items = await skillsApi.listProject(projectPath);
      if (current === generation.current) setProjectSkills(items);
    } catch (error) {
      if (current === generation.current) { setProjectError(true); onError(error); }
    } finally { if (current === generation.current) setProjectLoading(false); }
  }, [skillsApi, projectPath, onError]);
  useStateChangeRefresh(onStateChanged, refreshProject);
  useEffect(() => {
    setProjectSkills([]); setProjectError(false); setProjectLoading(!!skillsApi);
    void refreshProject();
    return () => { generation.current++; };
  }, [skillsApi, refreshProject]);
  const skills = skillsApi ? projectSkills : inventory.capabilities?.skills;
  const loading = skillsApi ? projectLoading : inventory.loading;
  const error = skillsApi ? projectError : inventory.error;
  const refresh = skillsApi ? refreshProject : inventory.refresh;
  return <section className="standard-view">
    <header className="section-heading"><div><h1>Skills</h1><span className="subtle">{!skillsApi && inventory.sessionTitle ? `会话能力：${inventory.sessionTitle}` : "项目工作流"}</span></div><IconButton label="刷新 Skills" disabled={loading} onClick={() => void refresh()}><RefreshCw size={16} /></IconButton></header>
    <p className="field-hint">在会话中调用 Skill，智能体会读取指令并执行其中的步骤。将项目工作流放在 <code>.specloom/skills/&lt;id&gt;/SKILL.md</code>，下一轮会话会重新发现。</p>
    {loading ? <p className="empty-state">正在加载 Skills…</p> : error ? <p className="empty-state">{!skillsApi && inventory.discoveryError ? "Skills 加载失败。下一次发送消息会重新加载。" : "Skills 加载失败，请重试刷新。"}</p> : skills?.length ? <div className="capability-browser">{skills.map((skill) => {
      const prompt = `调用 Skill ${skill.id}，并按它的步骤执行。`;
      return <article className="capability-entry" key={skill.id}><h2>{skill.name}</h2><p>{skill.purpose}</p><code>{skill.id}</code>{"enabled" in skill && !skill.enabled && <span className="subtle">已禁用</span>}<div className="skill-use-request"><code>{prompt}</code><CopyButton value={prompt} label={`复制 Skill 调用 ${skill.id}`} onError={onError} /></div></article>;
    })}</div> : <p className="empty-state">{skillsApi ? "当前项目没有可用 Skills。" : skills ? "当前会话没有发现可用 Skills。" : "新建会话后可查看项目 Skills 清单。"}</p>}
    {onOpenChat && <button type="button" onClick={onOpenChat}>打开工作区会话</button>}
    {skillsApi && <InstalledSkills skillsApi={skillsApi} onStateChanged={onStateChanged} onError={onError} />}
  </section>;
}

function InstalledSkills({ skillsApi, onStateChanged, onError }: { skillsApi: SkillsApi; onStateChanged?: DesktopApi["onStateChanged"]; onError: (error: unknown) => void }) {
  const [items, setItems] = useState<Awaited<ReturnType<SkillsApi["list"]>>>([]);
  const [busy, setBusy] = useState(false);
  const requestSeq = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++requestSeq.current;
    try {
      const next = await skillsApi.list();
      if (request === requestSeq.current) setItems(next);
    } catch (error) { if (request === requestSeq.current) onError(error); }
  }, [skillsApi, onError]);
  useStateChangeRefresh(onStateChanged, refresh);
  useEffect(() => { void refresh(); return () => { requestSeq.current++; }; }, [refresh]);
  async function install() { const selected = await skillsApi.selectDirectory?.(); if (!selected) return; setBusy(true); try { await skillsApi.installDirectory(selected); await refresh(); } catch (error) { onError(error); } finally { setBusy(false); } }
  return <section className="skill-management" aria-label="已安装 Skills"><header className="section-heading"><div><h2>已安装 Skills</h2><p className="field-hint">从本地 Skill 目录导入到全局库；启用后新项目会自动使用。</p></div><div className="button-row"><button type="button" disabled={busy} onClick={() => void install()}>安装本地 Skill</button><button type="button" disabled={busy} onClick={() => void refresh()}>刷新</button></div></header>{items.length ? <div className="capability-browser">{items.map((item) => <article className="capability-entry" key={item.id}><header><strong>{item.name}</strong><label className="checkbox-label"><input type="checkbox" checked={item.enabled} onChange={() => void skillsApi.setEnabled(item.id, !item.enabled).then(refresh).catch(onError)} />启用</label></header><p>{item.purpose}</p><code>{item.id}</code><button className="danger-ghost" type="button" onClick={() => void skillsApi.remove(item.id).then(refresh).catch(onError)}>卸载</button></article>)}</div> : <p className="empty-state">还没有安装全局 Skill。</p>}</section>;
}
