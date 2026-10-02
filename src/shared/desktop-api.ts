import type { ChangeSetData, FileReadResult, ModelProfile, ProjectMetadata, TaskScopeSpec, ValidationResult } from "./contracts";

export interface TaskView {
  id: string;
  scope: TaskScopeSpec;
  status: string;
  running: boolean;
  summary: string;
  events: { time: string; tool: string; ok: boolean; message: string }[];
  conversation?: { role: "user" | "assistant"; content: string }[];
}
export interface ChangeReview {
  changeSet: ChangeSetData;
  before: Record<string, string>;
  validation?: ValidationResult;
  approved: boolean;
}
export interface McpConnection { url: string; token: string }
export interface RecoveryIssue { code: string; message: string; path?: string }
export interface WorkspaceState {
  project?: ProjectMetadata;
  tasks: TaskView[];
  models: ModelProfile[];
  mcp?: McpConnection;
  recoveryIssues?: RecoveryIssue[];
}
export interface DesktopApi {
  state(): Promise<WorkspaceState>;
  selectProject(): Promise<WorkspaceState>;
  openProject(path: string): Promise<WorkspaceState>;
  createExample(): Promise<WorkspaceState>;
  createTask(scope: Omit<TaskScopeSpec, "id">): Promise<TaskView>;
  tool(taskId: string, name: string, input: Record<string, unknown>): Promise<unknown>;
  preview(taskId: string): Promise<ChangeReview>;
  approve(taskId: string, digest: string): Promise<ChangeSetData>;
  reject(taskId: string): Promise<ChangeSetData>;
  validate(taskId: string): Promise<ValidationResult>;
  agent(taskId: string, modelId: string, prompt: string): Promise<{ summary: string; toolCalls: number }>;
  cancel(taskId: string): Promise<void>;
  saveModel(profile: ModelProfile, secret?: string): Promise<ModelProfile>;
  removeModel(id: string): Promise<void>;
  readDocument(path: string, expectedVersion: string): Promise<FileReadResult>;
  documents(): Promise<{ path: string; version: string; size: number }[]>;
}

declare global { interface Window { specloom: DesktopApi } }
