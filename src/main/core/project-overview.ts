import fs from "node:fs/promises";
import path from "node:path";
import type { GitBranch, GitHead, GitIssue, GitRemote, GitSnapshot, ProjectDocumentRef, ProjectOverview } from "../../shared/project-overview";
import { FileStore } from "./file-store";
import { GitQueryBudget, gitIssue, sanitizeGitRemoteUrl, type GitQueryRunner, type GitQueryResult } from "./git-query";
import { decodeText, digestBytes, hasCode } from "./store-fs";

const TEXT_LIMIT = 1024 * 1024;
const samePath = (a: string, b: string) => process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const failure = (result: GitQueryResult): GitIssue => result.failure ?? gitIssue("query-failed");
const validCommit = (value: string) => /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(value);

async function inspectGit(root: string, runner?: GitQueryRunner): Promise<GitSnapshot> {
  const query = new GitQueryBudget(root, runner);
  const probe = await query.query(["rev-parse", "--is-bare-repository", "--is-inside-work-tree"]);
  if (probe.failure?.code === "unavailable") return { state: "unavailable", issue: probe.failure };
  if (probe.failure) return { state: "error", issue: probe.failure };
  if (probe.exitCode !== 0) {
    if (/not a git repository/i.test(probe.stderr)) return { state: "not-repository" };
    return { state: "error", issue: failure(probe) };
  }
  if (probe.stdout.trim().split(/\r?\n/)[0] === "true") {
    const directory = await query.query(["rev-parse", "--absolute-git-dir"]);
    return directory.exitCode === 0 && !directory.failure ? { state: "bare", gitDir: directory.stdout.trim() } : { state: "error", issue: failure(directory) };
  }
  const location = await query.query(["rev-parse", "--show-toplevel", "--absolute-git-dir", "--path-format=absolute", "--git-common-dir"]);
  const [worktreeRoot, gitDir, commonDir] = location.stdout.trim().split(/\r?\n/);
  if (location.exitCode !== 0 || location.failure || !worktreeRoot || !gitDir || !commonDir) return { state: "error", issue: failure(location) };
  const issues: GitIssue[] = [];
  const branch = await query.query(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const commit = await query.query(["rev-parse", "--verify", "--quiet", "HEAD"]);
  const branchName = branch.exitCode === 0 && !branch.failure ? branch.stdout.trim() : undefined;
  const commitHash = commit.exitCode === 0 && !commit.failure && validCommit(commit.stdout.trim()) ? commit.stdout.trim() : undefined;
  let head: GitHead;
  if (branch.failure || commit.failure) head = { kind: "unknown", issue: failure(branch.failure ? branch : commit) };
  else if (branchName && commitHash) head = { kind: "branch", name: branchName, commit: commitHash };
  else if (branchName && commit.exitCode === 1) head = { kind: "unborn", name: branchName };
  else if (branch.exitCode === 1 && commitHash) head = { kind: "detached", commit: commitHash };
  else head = { kind: "unknown", issue: gitIssue("query-failed") };
  if (head.kind === "unknown") issues.push(head.issue);
  const refs = await query.query(["for-each-ref", "--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(symref)%00", "refs/heads/", "refs/remotes/"]);
  const branches: GitBranch[] = [];
  const branchesState = refs.exitCode === 0 && !refs.failure ? "loaded" : "error";
  if (branchesState === "loaded") for (const line of refs.stdout.split(/\r?\n/)) {
    if (!line) continue;
    const [ref, hash, upstream, symref] = line.split("\0");
    if (!ref || !hash || symref || !validCommit(hash)) continue;
    const kind = ref.startsWith("refs/heads/") ? "local" : ref.startsWith("refs/remotes/") ? "remote" : undefined;
    if (!kind) continue;
    branches.push({ ref, name: ref.slice(kind === "local" ? 11 : 13), kind, commit: hash, ...(upstream ? { upstream } : {}) });
  }
  else issues.push(failure(refs));
  const remoteConfig = await query.query(["config", "--null", "--get-regexp", "^remote\\..*\\.[^.]+$"]);
  // git config exits 1 for an absent key, including a repository with no remotes.
  const remotesState = !remoteConfig.failure && (remoteConfig.exitCode === 0 || remoteConfig.exitCode === 1) ? "loaded" : "error";
  const remoteMap = new Map<string, GitRemote>();
  if (remotesState === "loaded") for (const entry of remoteConfig.stdout.split("\0")) {
    const separator = entry.indexOf("\n"); if (separator < 0) continue;
    const match = /^remote\.(.+)\.([^.]+)$/i.exec(entry.slice(0, separator));
    if (!match?.[1]) continue;
    const name = match[1];
    const remote = remoteMap.get(name) ?? { name, fetchUrls: [], pushUrls: [] };
    const key = match[2]?.toLowerCase();
    if (key === "url" || key === "pushurl") {
      const url = sanitizeGitRemoteUrl(entry.slice(separator + 1));
      if (url) (key === "url" ? remote.fetchUrls : remote.pushUrls).push(url);
    }
    remoteMap.set(name, remote);
  }
  else issues.push(failure(remoteConfig));
  const remotes = [...remoteMap.values()].map(remote => ({ ...remote, pushUrls: remote.pushUrls.length ? remote.pushUrls : [...remote.fetchUrls] }));
  return {
    state: "repository", location: !samePath(gitDir, commonDir) ? "linked-worktree" : samePath(root, worktreeRoot) ? "root" : "nested",
    worktreeRoot, gitDir, commonDir, head, branches, branchesState,
    branchesTruncated: refs.failure?.code === "output-limit", remotes, remotesState, issues,
  };
}

async function inspectDocument(store: FileStore, relative: string): Promise<ProjectDocumentRef> {
  try {
    const target = await store.policy.resolve(relative);
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.size > TEXT_LIMIT) return { path: relative, state: "unsupported", size: stat.size };
    const handle = await fs.open(target, "r");
    try {
      if (!(await handle.stat()).isFile()) return { path: relative, state: "unsupported" };
      const chunks: Buffer[] = []; let size = 0;
      while (size <= TEXT_LIMIT) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, TEXT_LIMIT + 1 - size));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        size += bytesRead; chunks.push(chunk.subarray(0, bytesRead));
      }
      if (size > TEXT_LIMIT) return { path: relative, state: "unsupported", size };
      const bytes = Buffer.concat(chunks);
      try { decodeText(bytes, TEXT_LIMIT); }
      catch { return { path: relative, state: "unsupported", size }; }
      await store.policy.assertSafe(target);
      return { path: relative, state: "file", version: digestBytes(bytes), size };
    } finally { await handle.close(); }
  } catch (error) {
    if (hasCode(error, "ENOENT")) return { path: relative, state: "missing", version: "absent" };
    return { path: relative, state: "unreadable" };
  }
}

/** Independent read-only inspection; never call from the high-frequency workspace state getter. */
export async function readProjectOverview(projectPath: string, options: { gitRunner?: GitQueryRunner } = {}): Promise<ProjectOverview> {
  const store = new FileStore(projectPath, { maxTextBytes: TEXT_LIMIT });
  const inspectedAt = new Date().toISOString();
  try { await store.policy.validateRoot(); }
  catch { return { projectPath, inspectedAt, git: { state: "error", issue: gitIssue("invalid-project") }, documents: { gitignore: { path: ".gitignore", state: "unreadable" }, readmes: [] } }; }
  const [git, documents] = await Promise.all([
    inspectGit(store.root, options.gitRunner),
    (async () => {
      const names = await fs.readdir(store.root).catch(() => [] as string[]);
      const readmeNames = names.filter(name => /^readme(?:[._-].*)?$/i.test(name)).sort((a, b) => a.localeCompare(b));
      const [gitignore, ...readmes] = await Promise.all([".gitignore", ...readmeNames].map(name => inspectDocument(store, name)));
      return { gitignore: gitignore!, readmes };
    })(),
  ]);
  return { projectPath, inspectedAt, git, documents };
}
