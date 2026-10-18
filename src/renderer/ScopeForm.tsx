import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import type { TaskScopeSpec } from "../shared/contracts";
import { Modal } from "./ui";

export const defaultScope: Omit<TaskScopeSpec, "id"> = {
  title: "实现守灯人移动与交互",
  readPaths: ["*"],
  writePaths: ["specs/entities/**", "specs/components/**", "scenes/**", "scripts/**"],
  allowDelete: false,
  mode: "manual",
};
export function ScopeForm({
  initial = defaultScope,
  busy,
  onClose,
  onCreate,
}: {
  initial: Omit<TaskScopeSpec, "id"> | undefined;
  busy: boolean;
  onClose: () => void;
  onCreate: (scope: Omit<TaskScopeSpec, "id">) => Promise<void>;
}) {
  const [title, setTitle] = useState(initial.title);
  const [read, setRead] = useState(initial.readPaths.join("\n"));
  const [write, setWrite] = useState(initial.writePaths.join("\n"));
  const [mode, setMode] = useState(initial.mode);
  const [allowDelete, setDelete] = useState(initial.allowDelete);
  const paths = (value: string) =>
    value
      .split(/\r?\n/)
      .map((path) => path.trim())
      .filter(Boolean);
  return (
    <Modal title="确认任务范围" onClose={onClose}>
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          void onCreate({
            title: title.trim(),
            readPaths: paths(read),
            writePaths: paths(write),
            mode,
            allowDelete,
          });
        }}
      >
        <label>
          任务名称
          <input
            required
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label>
          可读路径
          <textarea
            required
            className="path-input"
            rows={3}
            value={read}
            onChange={(event) => setRead(event.target.value)}
          />
        </label>
        <label>
          可写路径
          <textarea
            className="path-input"
            rows={4}
            value={write}
            onChange={(event) => setWrite(event.target.value)}
          />
        </label>
        <div className="form-row">
          <label>
            提交模式
            <select
              aria-label="提交模式"
              value={mode}
              onChange={(event) =>
                setMode(event.target.value as TaskScopeSpec["mode"])
              }
            >
              <option value="manual">手动审查</option>
              <option value="auto">自动提交</option>
            </select>
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={allowDelete}
              onChange={(event) => setDelete(event.target.checked)}
            />
            允许删除
          </label>
        </div>
        <footer className="form-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button
            className="primary"
            disabled={busy || !title.trim() || !paths(read).length}
          >
            <ShieldCheck size={16} />
            确认范围并创建
          </button>
        </footer>
      </form>
    </Modal>
  );
}
