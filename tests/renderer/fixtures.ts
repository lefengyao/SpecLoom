import { vi } from "vitest";
import type {
  ChangeReview,
  DesktopApi,
  RecentProject,
  TaskView,
  WorkspaceState,
} from "../../src/shared/desktop-api";
import type {
  FileReadResult,
  TaskScopeSpec,
  ValidationResult,
} from "../../src/shared/contracts";
import { defaultPreferences, type Preferences } from "../../src/shared/preferences";

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
  engine: "godot" as const,
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
const provider = {
  id: "provider-1",
  name: "本地供应商",
  protocol: "openai" as const,
  baseUrl: "https://api.openai.com/v1",
  models: ["gpt-test"],
  modelSettings: {},
  hasKey: true,
  keyStorage: "plain" as const,
};
export function fixture(
  options: {
    project?: boolean;
    tasks?: boolean;
    finishedTask?: boolean;
    changes?: boolean;
    recent?: RecentProject[];
    preferences?: Partial<Preferences>;
    workspacePrompt?: string;
  } = {},
) {
  let state: WorkspaceState = {
    tasks: options.tasks ? [{ ...structuredClone(task), ...(options.finishedTask ? { status: "applied" } : {}) }] : [],
    models: [model],
    providers: [provider],
    defaultModel: { providerId: provider.id, model: provider.models[0]! },
    recent: structuredClone(options.recent ?? []),
    preferences: { ...defaultPreferences, ...options.preferences },
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
  const savedDocuments = new Map<string, FileReadResult>();
  const api = {
    saveDocument: vi.fn(async (_projectPath: string, path: string, content: string, _expectedVersion: string): Promise<FileReadResult> => {
      if (_projectPath !== state.project?.path || !_expectedVersion) throw new Error("Project or version missing");
      const saved = { path, content, version };
      savedDocuments.set(path, saved);
      return saved;
    }),
    importMaterialImage: vi.fn<(projectPath: string, dataUrl: string) => Promise<string>>(async () => `assets/specloom/materials/${"a".repeat(64)}.png`),
    readMaterialImage: vi.fn<(projectPath: string, path: string) => Promise<string>>(async () => "data:image/png;base64,iVBORw0KGgo="),
    readWorkspacePrompt: vi.fn(async (projectPath: string): Promise<FileReadResult> => {
      if (projectPath !== state.project?.path) throw new Error("Project changed");
      return { path: "specs/prompts/system-prompt.md", version, content: options.workspacePrompt ?? "" };
    }),
    saveWorkspacePrompt: vi.fn(async (projectPath: string, content: string, expectedVersion: string): Promise<FileReadResult> => {
      if (projectPath !== state.project?.path || expectedVersion !== version) throw new Error("Project or prompt changed");
      return { path: "specs/prompts/system-prompt.md", version, content };
    }),
    state: vi.fn(async () => structuredClone(state)),
    selectProject: vi.fn(async () => {
      state = { ...state, project };
      return structuredClone(state);
    }),
    openProject: vi.fn(async () => {
      state = { ...state, project };
      return structuredClone(state);
    }),
    forgetProject: vi.fn(async (forgotten: string) => {
      state = {
        ...state,
        recent: state.recent.filter((entry) => entry.path !== forgotten),
      };
      return structuredClone(state);
    }),
    updatePreferences: vi.fn(async (patch: Partial<Preferences>) => {
      state = { ...state, preferences: { ...state.preferences, ...patch } };
      return structuredClone(state);
    }),
    openGodot: vi.fn(async () => undefined),
    openExternalEditor: vi.fn(async () => undefined),
    removeTask: vi.fn(async (taskId: string) => {
      state = { ...state, tasks: state.tasks.filter((item) => item.id !== taskId) };
      return structuredClone(state);
    }),
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
    chat: vi.fn(async () => ({ summary: "这是普通对话回复", toolCalls: 0 })),
    cancelChat: vi.fn(async () => undefined),
    pluginManagement: {
      list: vi.fn(async () => ({ godotMcp: { status: "missing" as const, enabled: false, connected: false }, plugins: [], scanLimitReached: false })),
      setGodotPluginEnabled: vi.fn(async () => ({ restartRequired: true })),
      setGodotMcpEnabled: vi.fn(async () => ({ restartRequired: true })),
      installGodotMcp: vi.fn(async () => ({ restartRequired: true, installedVersion: "1.1.0", changedPaths: [] })),
      revealDirectory: vi.fn(async () => undefined),
    },
    saveModel: vi.fn(async (profile: typeof model) => {
      state.models = [profile];
      return profile;
    }),
    removeModel: vi.fn(async () => {
      state.models = [];
    }),
    readDocument: vi.fn(async (path: string): Promise<FileReadResult> => savedDocuments.get(path) ?? ({
      path,
      version,
      content: "# 大纲\n旧内容",
    })),
    documents: vi.fn(async () => [
      { path: "specs/outline.md", version, size: 20 },
      ...[...savedDocuments.values()].filter((file) => file.path !== "specs/outline.md").map((file) => ({ path: file.path, version: file.version, size: file.content.length })),
    ]),
    projectTree: vi.fn(async () => [
      { path: "project.godot", kind: "file" as const },
      { path: "specs", kind: "directory" as const },
      { path: "specs/outline.md", kind: "file" as const },
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
