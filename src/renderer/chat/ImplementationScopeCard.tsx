import { useMemo, useState } from "react";
import { MAX_TASK_GOAL_LENGTH } from "../../shared/contracts";
import { Modal } from "../ui";

/** Chat implementation defaults mirror the task form's common write scope. */
export const defaultImplementationReadPaths = ["*"];
export const defaultImplementationWritePaths = [
  "specs/entities/**",
  "specs/components/**",
  "scenes/**",
  "scripts/**",
];

export interface ImplementationScopeInput {
  goal: string;
  readPaths: string[];
  writePaths: string[];
}

function parsePaths(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Compact scope card shown when a chat implementation turn has no task scope.
 *
 * A workflow run needs at least one read and one write path. The card collects
 * only those inputs plus the goal; it never edits an existing task scope.
 */
export function ImplementationScopeCard({
  initialGoal,
  busy,
  onClose,
  onStart,
}: {
  initialGoal: string;
  busy: boolean;
  onClose: () => void;
  onStart: (input: ImplementationScopeInput) => void;
}) {
  const [goal, setGoal] = useState(initialGoal);
  const [read, setRead] = useState(defaultImplementationReadPaths.join("\n"));
  const [write, setWrite] = useState(defaultImplementationWritePaths.join("\n"));
  const readPaths = useMemo(() => parsePaths(read), [read]);
  const writePaths = useMemo(() => parsePaths(write), [write]);
  const ready = goal.trim().length > 0 && readPaths.length > 0 && writePaths.length > 0;
  return (
    <Modal title="确认实现范围" onClose={onClose}>
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready || busy) return;
          onStart({ goal: goal.trim(), readPaths, writePaths });
        }}
      >
        <p className="field-hint">工作流需要一份实现范围；确认后会使用默认模型启动。</p>
        <label>
          实现目标
          <textarea
            aria-describedby="implementation-goal-hint"
            className="path-input"
            rows={3}
            maxLength={MAX_TASK_GOAL_LENGTH}
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
          />
        </label>
        <span id="implementation-goal-hint" className="field-hint">
          这段目标会作为工作流运行的目标，不改写任务范围。
        </span>
        <label>
          读取范围
          <textarea
            className="path-input"
            rows={3}
            value={read}
            onChange={(event) => setRead(event.target.value)}
          />
        </label>
        <label>
          修改范围
          <textarea
            className="path-input"
            rows={4}
            value={write}
            onChange={(event) => setWrite(event.target.value)}
          />
        </label>
        <footer className="form-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy || !ready}>
            {busy ? "正在启动…" : "开始实现"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
