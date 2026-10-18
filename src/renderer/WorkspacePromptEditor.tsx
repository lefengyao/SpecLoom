import { useEffect, useRef, useState } from "react";
import type { FileReadResult, ProjectMetadata } from "../shared/contracts";
import type { DesktopApi } from "../shared/desktop-api";
import { workspacePromptLimit } from "../shared/workspace-prompt";
import { describeError } from "./ui";

export function WorkspacePromptEditor({ api, project, busy }: { api: DesktopApi | undefined; project: ProjectMetadata | undefined; busy: boolean }) {
  const [loaded, setLoaded] = useState<FileReadResult>();
  const [draft, setDraft] = useState("");
  const [operation, setOperation] = useState<"idle" | "loading" | "saving">("idle");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    const request = ++generation.current;
    setLoaded(undefined);
    setDraft("");
    setError("");
    setSaved(false);
    if (api && project) {
      setOperation("loading");
      void api.readWorkspacePrompt(project.path).then((result) => {
        if (generation.current !== request) return;
        setLoaded(result);
        setDraft(result.content);
        setOperation("idle");
      }, (value: unknown) => {
        if (generation.current !== request) return;
        setError(describeError(value).message);
        setOperation("idle");
      });
    } else setOperation("idle");
    return () => { generation.current++; };
  }, [api, project?.path, reload]);

  async function save() {
    if (!api || !project || !loaded || operation !== "idle") return;
    const request = generation.current;
    setOperation("saving");
    setError("");
    setSaved(false);
    try {
      const result = await api.saveWorkspacePrompt(project.path, draft, loaded.version);
      if (generation.current !== request) return;
      setLoaded(result);
      setSaved(true);
    } catch (value) {
      if (generation.current !== request) return;
      setError(describeError(value).message);
    } finally {
      if (generation.current === request) setOperation("idle");
    }
  }
  const dirty = !!loaded && draft !== loaded.content;
  const disabled = busy || operation !== "idle" || !loaded;
  return (
    <div className="setting-block">
      <div className="setting-label">
        <span>当前项目提示词</span>
        <span className="field-hint">
          {project ? `对“${project.name}”的所有会话生效；最多 ${workspacePromptLimit} 字符` : "先打开项目，再配置项目提示词"}
        </span>
        <span className="field-hint">项目要求追加在全局提示词之后，任务权限、审批和版本检查始终生效。</span>
      </div>
      <textarea aria-label="当前项目提示词" rows={6} maxLength={workspacePromptLimit} value={draft} disabled={disabled}
        placeholder="例如：本项目采用 Godot 4.4；只实现海岛探索；命名遵循项目规范。"
        onChange={(event) => { setDraft(event.target.value); setSaved(false); }} />
      <div className="setting-actions">
        <span className="field-hint" role="status">
          {operation === "loading" ? "正在加载项目提示词…" : operation === "saving" ? "正在保存项目提示词…" : saved ? "项目提示词已保存" : `${draft.length} / ${workspacePromptLimit}${dirty ? " · 有未保存的修改" : loaded ? " · 已是最新" : ""}`}
        </span>
        {project && error && <button type="button" disabled={busy || operation !== "idle"} onClick={() => setReload((value) => value + 1)}>重新加载项目提示词</button>}
        <button type="button" className="primary" disabled={disabled || !dirty} onClick={() => void save()}>保存项目提示词</button>
      </div>
      {error && <p role="alert" className="field-hint">{error}。草稿已保留；重新加载会读取文件中的最新内容。</p>}
    </div>
  );
}
