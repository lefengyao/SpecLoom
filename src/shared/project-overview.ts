import type { VersionToken } from "./contracts";

/** All Git failures crossing a process boundary are classified, never raw stderr. */
export interface GitIssue {
  code: "unavailable" | "ownership" | "timeout" | "output-limit" | "invalid-project" | "query-failed";
  message: string;
}
export type GitHead =
  | { kind: "branch"; name: string; commit: string }
  | { kind: "unborn"; name: string }
  | { kind: "detached"; commit: string }
  | { kind: "unknown"; issue: GitIssue };
export interface GitBranch {
  /** Full ref distinguishes same-named local and remote-tracking branches. */
  ref: string;
  name: string;
  kind: "local" | "remote";
  commit: string;
  upstream?: string;
}
export interface GitRemote { name: string; fetchUrls: string[]; pushUrls: string[] }
export type GitRepositoryLocation = "root" | "nested" | "linked-worktree";
export interface GitRepositorySnapshot {
  state: "repository";
  location: GitRepositoryLocation;
  worktreeRoot: string;
  gitDir: string;
  commonDir: string;
  head: GitHead;
  branches: GitBranch[];
  branchesState: "loaded" | "error";
  branchesTruncated: boolean;
  remotes: GitRemote[];
  remotesState: "loaded" | "error";
  issues: GitIssue[];
}
export type GitSnapshot =
  | { state: "unavailable"; issue: GitIssue }
  | { state: "not-repository" }
  | { state: "bare"; gitDir: string }
  | { state: "error"; issue: GitIssue }
  | GitRepositorySnapshot;
export interface ProjectDocumentRef {
  /** Always a file directly inside the selected project, never its parent repository. */
  path: string;
  state: "missing" | "file" | "unreadable" | "unsupported";
  version?: VersionToken;
  size?: number;
}
export interface ProjectOverview {
  projectPath: string;
  inspectedAt: string;
  git: GitSnapshot;
  documents: { gitignore: ProjectDocumentRef; readmes: ProjectDocumentRef[] };
}
export interface ProjectOverviewApi { read(projectPath: string): Promise<ProjectOverview> }
