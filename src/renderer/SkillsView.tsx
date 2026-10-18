import { BookOpen, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { DesktopApi, TaskView } from "../shared/desktop-api";
import type { FileReadResult, SkillSource } from "../shared/contracts";
import { IconButton, isTerminal } from "./ui";
import { SessionSkillsView } from "./SessionSkillsView";

interface Skill {
  id: string;
  name: string;
  purpose: string;
  allowedSources: string[];
  path: string;
  version: string;
}
interface LoadedSkill extends Skill {
  instructions: string;
  referencedContent: FileReadResult[];
  sources: SkillSource[];
}
export function SkillsView(props: {
  api: DesktopApi;
  task: TaskView | undefined;
  onError: (value: unknown) => void;
  onNewTask: () => void;
  projectPath?: string | undefined;
  onOpenChat?: (() => void) | undefined;
  skillsApi?: DesktopApi["skills"] | undefined;
}) {
  if (props.api.sessions && props.projectPath !== undefined && (!props.task || isTerminal(props.task.status))) return <SessionSkillsView api={props.api.sessions} projectPath={props.projectPath} onError={props.onError} onOpenChat={props.onOpenChat} skillsApi={props.skillsApi ?? props.api.skills} onStateChanged={props.api.onStateChanged} />;
  return <LegacySkillsView {...props} />;
}

function LegacySkillsView({
  api,
  task,
  onError,
  onNewTask,
}: {
  api: DesktopApi;
  task: TaskView | undefined;
  onError: (value: unknown) => void;
  onNewTask: () => void;
}) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loaded, setLoaded] = useState<LoadedSkill>();
  const [sourcePaths, setSourcePaths] = useState("");
  const [busy, setBusy] = useState(false);
  const taskId = task && !isTerminal(task.status) ? task.id : undefined;
  const refresh = useCallback(async () => {
    if (taskId)
      setSkills((await api.tool(taskId, "skills.list", {})) as Skill[]);
  }, [api, taskId]);
  useEffect(() => {
    setLoaded(undefined);
    setSkills([]);
    void refresh().catch(onError);
  }, [refresh, onError]);
  async function load(skill: Skill) {
    if (!task || !taskId) return;
    setBusy(true);
    try {
      const paths = sourcePaths
        .split(/\r?\n/)
        .map((path) => path.trim())
        .filter(Boolean);
      setLoaded(
        (await api.tool(task.id, "skills.load", {
          id: skill.id,
          expectedVersion: skill.version,
          ...(paths.length ? { sourcePaths: paths } : {}),
        })) as LoadedSkill,
      );
    } catch (value) {
      onError(value);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="standard-view">
      <header className="section-heading">
        <div>
          <h1>Skills</h1>
          <span className="subtle">{task?.scope.title ?? "未选择任务"}</span>
        </div>
        <IconButton
          label="刷新 Skills"
          onClick={() => {
            void refresh().catch(onError);
          }}
          disabled={!taskId || busy || !!task?.running}
        >
          <RefreshCw size={16} />
        </IconButton>
      </header>
      {!taskId ? (
        <div className="empty-state">
          <button onClick={onNewTask}>新建任务</button>
        </div>
      ) : (
        <div className="skills-layout">
          <aside>
            <label>
              来源路径（可选）
              <textarea
                rows={3}
                className="path-input"
                value={sourcePaths}
                onChange={(event) => setSourcePaths(event.target.value)}
              />
            </label>
            <div className="skill-list">
              {skills.map((skill) => (
                <button
                  className={loaded?.id === skill.id ? "selected" : ""}
                  key={skill.id}
                  disabled={busy || !!task?.running}
                  onClick={() => {
                    void load(skill);
                  }}
                >
                  <BookOpen size={16} />
                  <div>
                    <strong>{skill.name}</strong>
                    <p>{skill.purpose}</p>
                    <code>{skill.id}</code>
                  </div>
                </button>
              ))}
            </div>
            {!skills.length && (
              <p className="empty-state">当前范围内无可用 Skills</p>
            )}
          </aside>
          <section className="skill-detail">
            {loaded ? (
              <>
                <h2>{loaded.name}</h2>
                <code>{loaded.path}</code>
                <h3>步骤</h3>
                <pre className="markdown-preview">{loaded.instructions}</pre>
                <h3>来源</h3>
                {loaded.sources.map((source) => (
                  <div className="source-row" key={source.path}>
                    <code>{source.path}</code>
                    <code className="version-text" title={source.version}>
                      {source.version}
                    </code>
                  </div>
                ))}
                {loaded.referencedContent.map((file) => (
                  <details key={file.path}>
                    <summary>{file.path}</summary>
                    <pre className="markdown-preview">{file.content}</pre>
                  </details>
                ))}
              </>
            ) : (
              <p className="empty-state">选择 Skill</p>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
