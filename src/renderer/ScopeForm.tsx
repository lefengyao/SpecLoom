import { FileText, Folder, ShieldCheck } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { MAX_TASK_GOAL_LENGTH, type TaskScopeSpec } from "../shared/contracts";
import type { DesktopApi, ProjectTreeEntry } from "../shared/desktop-api";
import { Modal } from "./ui";
import { useI18n } from "./i18n";

export const defaultScope: Omit<TaskScopeSpec, "id"> = {
  title: "实现守灯人移动与交互",
  readPaths: ["*"],
  writePaths: ["*"],
  allowDelete: false,
  mode: "manual",
};

interface TreeRow {
  path: string;
  name: string;
  kind: ProjectTreeEntry["kind"];
  depth: number;
  /** All project files below this row; a file row holds itself. */
  files: string[];
}

const pathLines = (value: string) => value.split(/\r?\n/).map((path) => path.trim()).filter(Boolean);

function matchesPath(file: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("/**")) {
    const base = pattern.slice(0, -3);
    return file === base || file.startsWith(`${base}/`);
  }
  return file === pattern;
}

function patternsFor(selected: Set<string>, rows: TreeRow[], filePaths: string[]): string {
  if (filePaths.length > 0 && selected.size === filePaths.length && filePaths.every((path) => selected.has(path))) return "*";
  const patterns: string[] = [];
  const covered = new Set<string>();
  for (const row of rows.filter((item) => item.kind === "directory").sort((a, b) => a.depth - b.depth)) {
    if (!row.files.length || row.files.every((path) => covered.has(path))) continue;
    if (row.files.every((path) => selected.has(path))) {
      patterns.push(`${row.path}/**`);
      row.files.forEach((path) => covered.add(path));
    }
  }
  for (const path of [...selected].sort()) if (!covered.has(path)) patterns.push(path);
  return patterns.join("\n");
}

/** Large projects can have thousands of rows; typing in other fields must not reconcile them. */
const ScopeTree = memo(function ScopeTree({
  label,
  rows,
  selected,
  onToggle,
}: {
  label: string;
  rows: TreeRow[];
  selected: Set<string>;
  onToggle: (row: TreeRow) => void;
}) {
  return (
    <div className="scope-tree-list" role="group" aria-label={label}>
      {rows.map((row) => {
        const count = row.files.filter((path) => selected.has(path)).length;
        const checked = row.files.length > 0 && count === row.files.length;
        return (
          <label
            key={row.path}
            className={`scope-tree-row${row.kind === "directory" ? " is-directory" : ""}`}
            style={{ paddingLeft: 6 + row.depth * 14 }}
          >
            <input
              type="checkbox"
              checked={checked}
              ref={(element) => { if (element) element.indeterminate = count > 0 && !checked; }}
              onChange={() => onToggle(row)}
            />
            {row.kind === "directory" ? <Folder size={14} /> : <FileText size={14} />}
            <span>{row.name}</span>
          </label>
        );
      })}
    </div>
  );
});

export function ScopeForm({
  initial = defaultScope,
  api,
  editing = false,
  busy,
  onClose,
  onCreate,
}: {
  initial: Omit<TaskScopeSpec, "id"> | undefined;
  api?: DesktopApi | undefined;
  editing?: boolean;
  busy: boolean;
  onClose: () => void;
  onCreate: (scope: Omit<TaskScopeSpec, "id">) => Promise<void>;
}) {
  const tr = useI18n();
  const [title, setTitle] = useState(initial.title);
  const [goal, setGoal] = useState(initial.goal ?? "");
  const [read, setRead] = useState(initial.readPaths.join("\n"));
  const [write, setWrite] = useState(initial.writePaths.join("\n"));
  const [allowDelete, setDelete] = useState(initial.allowDelete);
  const [rows, setRows] = useState<TreeRow[]>([]);
  const [filePaths, setFilePaths] = useState<string[]>([]);
  const [treeState, setTreeState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [query, setQuery] = useState("");
  const paths = pathLines;

  useEffect(() => {
    let alive = true;
    if (!api?.projectTree) {
      setTreeState("unavailable");
      return () => { alive = false; };
    }
    void api.projectTree().then((entries) => {
      if (!alive) return;
      const files = entries.filter((entry) => entry.kind === "file").map((entry) => entry.path);
      setRows(entries.map((entry) => ({
        path: entry.path,
        name: entry.path.split("/").at(-1) ?? entry.path,
        kind: entry.kind,
        depth: entry.path.split("/").length - 1,
        files: entry.kind === "file" ? [entry.path] : files.filter((path) => path.startsWith(`${entry.path}/`)),
      })));
      setFilePaths(files);
      setTreeState("ready");
    }, () => { if (alive) setTreeState("unavailable"); });
    return () => { alive = false; };
  }, [api]);

  const writePatterns = pathLines(write);
  const selected = useMemo(
    () => new Set(filePaths.filter((path) => writePatterns.some((pattern) => matchesPath(path, pattern)))),
    [write, filePaths],
  );
  const visibleRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => row.path.toLowerCase().includes(needle)
      || (row.kind === "directory" && row.files.some((path) => path.toLowerCase().includes(needle))));
  }, [rows, query]);

  const toggle = useCallback((row: TreeRow) => {
    const next = new Set(selected);
    const targets = row.files;
    const allOn = targets.every((path) => next.has(path));
    for (const path of targets) {
      if (allOn) next.delete(path);
      else next.add(path);
    }
    setWrite(patternsFor(next, rows, filePaths));
  }, [selected, rows, filePaths]);

  return (
    <Modal title={editing ? tr("编辑任务范围") : tr("确认任务范围")} onClose={onClose}>
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          void onCreate({
            title: title.trim(),
            ...(goal.trim() ? { goal: goal.trim() } : {}),
            readPaths: paths(read),
            writePaths: paths(write),
            mode: initial.mode,
            allowDelete,
          });
        }}
      >
        <label>
          {tr("任务名称")}
          <input
            required
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label>
          {tr("任务目标")}
          <textarea
            aria-describedby="task-goal-hint"
            className="path-input"
            rows={3}
            maxLength={MAX_TASK_GOAL_LENGTH}
            placeholder={tr("这次实现要完成什么？留空时使用任务名称。")}
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
          />
        </label>
        <span id="task-goal-hint" className="field-hint">
          {tr("首次实现消息会启动默认工作流；目标会随任务保存。")}
        </span>
        <fieldset className="scope-files">
          <legend>{tr("可写文件")}</legend>
          <span className="field-hint">{tr("勾选允许任务修改的文件；默认全选。读取范围可在高级选项中调整。")}</span>
          {treeState === "loading" && <span className="field-hint">{tr("正在读取项目文件…")}</span>}
          {treeState === "unavailable" && <span className="field-hint">{tr("暂时无法读取项目文件，可在高级选项中手动填写路径。")}</span>}
          {treeState === "ready" && <>
            <div className="scope-tree-toolbar">
              <input
                type="search"
                aria-label={tr("筛选文件")}
                placeholder={tr("筛选文件")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <button type="button" onClick={() => setWrite("*")}>{tr("全选")}</button>
              <button type="button" onClick={() => setWrite("")}>{tr("清空")}</button>
              <span className="subtle">{selected.size} / {filePaths.length}</span>
            </div>
            <ScopeTree label={tr("可写文件")} rows={visibleRows} selected={selected} onToggle={toggle} />
          </>}
        </fieldset>
        <details className="scope-advanced">
          <summary>{tr("高级：手动填写路径")}</summary>
          <label>
            {tr("可读路径")}
            <textarea
              required
              className="path-input"
              rows={3}
              value={read}
              onChange={(event) => setRead(event.target.value)}
            />
          </label>
          <label>
            {tr("可写路径")}
            <textarea
              className="path-input"
              rows={3}
              value={write}
              onChange={(event) => setWrite(event.target.value)}
            />
          </label>
        </details>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={allowDelete}
            onChange={(event) => setDelete(event.target.checked)}
          />
          {tr("允许删除")}
        </label>
        <footer className="form-actions">
          <button type="button" onClick={onClose}>
            {tr("取消")}
          </button>
          <button
            className="primary"
            disabled={busy || !title.trim() || !paths(read).length}
          >
            <ShieldCheck size={16} />
            {editing ? tr("保存范围") : tr("确认范围并创建")}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
