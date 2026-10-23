import { TaskScopeSpecSchema, type TaskScopeSpec } from "../../shared/contracts";
import { ProjectError } from "./errors";

const windowsDeviceName = /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i;

export function normalizeTaskPath(relativePath: string): string {
  if (typeof relativePath !== "string" || !relativePath || /[<>:"|?*]/.test(relativePath)
    || [...relativePath].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new ProjectError("PATH_ESCAPE", "Task paths must be safe relative project paths");
  }
  const normalized = relativePath.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || /[. ]$/.test(segment) || windowsDeviceName.test(segment))) {
    throw new ProjectError("PATH_ESCAPE", "Task paths cannot contain traversal or ambiguous path segments", { path: relativePath });
  }
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  if (lowerSegments.some((segment) => segment === ".git" || segment === ".godot")
    || (lowerSegments[0] === ".specloom" && lowerSegments[1] !== "skills")) {
    throw new ProjectError("TASK_SCOPE_DENIED", "Tool state and engine internals cannot be granted to a task", { path: normalized });
  }
  return normalized;
}

export function normalizeTaskPattern(pattern: string, allowAll = false): string {
  if (allowAll && pattern === "*") return pattern;
  const normalized = pattern.replaceAll("\\", "/");
  return normalized.endsWith("/**")
    ? `${normalizeTaskPath(normalized.slice(0, -3))}/**`
    : normalizeTaskPath(normalized);
}

export function matchesTaskPath(relativePath: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.endsWith("/**")) return relativePath === pattern;
  return relativePath.startsWith(`${pattern.slice(0, -3)}/`);
}

function immutableDescription(specification: TaskScopeSpec): TaskScopeSpec {
  return Object.freeze({
    ...specification,
    readPaths: Object.freeze([...specification.readPaths]) as unknown as string[],
    writePaths: Object.freeze([...specification.writePaths]) as unknown as string[],
  });
}

export class TaskScope {
  readonly #specification: TaskScopeSpec;

  constructor(specification: TaskScopeSpec) {
    const parsed = TaskScopeSpecSchema.safeParse(specification);
    if (!parsed.success) throw new ProjectError("TASK_SCOPE_DENIED", "A task requires an explicit valid scope");
    const { goal, ...rest } = parsed.data;
    this.#specification = immutableDescription({
      ...rest,
      // The goal is prompt data only: it is normalized here and never read by
      // assertRead/assertWrite, so it cannot widen a task's permissions.
      ...(goal === undefined || goal.length === 0 ? {} : { goal }),
      readPaths: [...new Set(parsed.data.readPaths.map((pattern) => normalizeTaskPattern(pattern, true)))],
      writePaths: [...new Set(parsed.data.writePaths.map((pattern) => normalizeTaskPattern(pattern, true)))],
    });
  }

  assertRead(relativePath: string): string {
    const normalized = normalizeTaskPath(relativePath);
    if (!this.#specification.readPaths.some((pattern) => matchesTaskPath(normalized, pattern))) {
      throw new ProjectError("TASK_SCOPE_DENIED", "The task cannot read this path", { path: normalized, taskId: this.#specification.id });
    }
    return normalized;
  }

  assertWrite(relativePath: string, operation: "create" | "update" | "delete"): string {
    const normalized = normalizeTaskPath(relativePath);
    if (!["create", "update", "delete"].includes(operation)
      || (operation === "delete" && !this.#specification.allowDelete)
      || !this.#specification.writePaths.some((pattern) => matchesTaskPath(normalized, pattern))) {
      throw new ProjectError("TASK_SCOPE_DENIED", "The task cannot perform this file operation", { path: normalized, operation, taskId: this.#specification.id });
    }
    return normalized;
  }

  describe(): TaskScopeSpec {
    return immutableDescription(this.#specification);
  }
}
