import { vi } from "vitest";
import type {
  ChangeReview,
  DesktopApi,
  TaskView,
  WorkspaceState,
} from "../../src/shared/desktop-api";
import type {
  FileReadResult,
  TaskScopeSpec,
  ValidationResult,
} from "../../src/shared/contracts";

export const version = `sha256:${"a".repeat(64)}` as const;
export const task: TaskView = {
  id: "task-1",
  scope: {
    id: "task-1",
    title: "守灯人移动",
    readPaths: ["*"],
    writePaths: ["scenes/**", "scripts/**"],
    mode: "manual",
    allowDelete: false,
  },
  status: "staged",
  running: false,
  summary: "",
  events: [],
};
const project = {
  schemaVersion: 1 as const,
  name: "灯塔守望",
  description: "探索海岛",
  path: "C:/Godot/lantern",
  godot: {
    configVersion: 5,
    features: ["4.4", "GL Compatibility"],
    mainScene: "res://scenes/main.tscn",
  },
};
const model = {
  id: "model-1",
  name: "开发模型",
  provider: "openai-compatible" as const,
  model: "gpt-test",
  baseUrl: "https://api.openai.com/v1",
  approved: true,
  timeoutMs: 120000,
  maxToolRounds: 12,
};
export function fixture(
  options: { project?: boolean; tasks?: boolean; changes?: boolean } = {},
) {
  let state: WorkspaceState = {
    tasks: options.tasks ? [structuredClone(task)] : [],
    models: [model],
    ...(options.project ? { project } : {}),
  };
  let review: ChangeReview = {
    changeSet: {
      id: "change-1",
      taskId: task.id,
      status: "staged",
      digest: "digest-exact-123",
      dependencies: {},
      entries: options.changes
        ? [
            {
              path: "scripts/keeper.gd",
              operation: "update",
              expectedVersion: version,
              nextContent: "extends CharacterBody2D\nconst SPEED = 180",
              sourceTaskId: task.id,
              sourceTool: "files.write",
            },
          ]
        : [],
    },
    before: {
      "scripts/keeper.gd": "extends CharacterBody2D\nconst SPEED = 120",
    },
    approved: false,
  };
  const api = {
    state: vi.fn(async () => structuredClone(state)),
    selectProject: vi.fn(async () => {
      state = { ...state, project };
      return structuredClone(state);
    }),
    openProject: vi.fn(async () => structuredClone(state)),
    createExample: vi.fn(async () => {
      state = { ...state, project };
      return structuredClone(state);
    }),
    createTask: vi.fn(async (scope: Omit<TaskScopeSpec, "id">) => {
      const created = {
        ...structuredClone(task),
        id: "new-task",
        scope: { ...scope, id: "new-task" },
      };
      state.tasks.push(created);
      return created;
    }),
    tool: vi.fn(
      async (
        _id: string,
        name: string,
        input: Record<string, unknown>,
      ): Promise<unknown> =>
        name === "files.list_versions"
          ? [
              {
                path: (input.paths as string[])[0],
                version,
                exists: true,
                size: 20,
              },
            ]
          : name === "files.read"
            ? { path: input.path, version, content: "# 大纲\n旧内容" }
            : {},
    ),
    preview: vi.fn(async (taskId: string): Promise<ChangeReview> => ({
      ...structuredClone(review),
      changeSet: { ...structuredClone(review.changeSet), taskId },
    })),
    approve: vi.fn(async () => {
      review.changeSet.status = "applied";
      state.tasks[0]!.status = "applied";
      return structuredClone(review.changeSet);
    }),
    reject: vi.fn(async () => {
      review.changeSet.status = "rejected";
      return structuredClone(review.changeSet);
    }),
    validate: vi.fn(async (): Promise<ValidationResult> => {
      review.validation = { status: "pass", checks: [], diagnostics: [] };
      return review.validation;
    }),
    agent: vi.fn(async () => ({ summary: "已生成移动脚本", toolCalls: 1 })),
    cancel: vi.fn(async () => undefined),
    saveModel: vi.fn(async (profile: typeof model) => {
      state.models = [profile];
      return profile;
    }),
    removeModel: vi.fn(async () => {
      state.models = [];
    }),
    readDocument: vi.fn(async (path: string): Promise<FileReadResult> => ({
      path,
      version,
      content: "# 大纲\n旧内容",
    })),
    documents: vi.fn(async () => [
      { path: "specs/outline.md", version, size: 20 },
    ]),
  } satisfies DesktopApi;
  Object.defineProperty(window, "specloom", { configurable: true, value: api });
  return {
    api,
    state: () => state,
    review: () => review,
    setState: (next: WorkspaceState) => {
      state = next;
    },
    setReview: (next: ChangeReview) => {
      review = next;
    },
  };
}
