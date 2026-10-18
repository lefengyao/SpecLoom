import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readProjectOverview } from "../../src/main/core/project-overview";
import { GIT_OUTPUT_LIMIT, GitQueryBudget, gitIssue, gitQueryEnvironment, sanitizeGitRemoteUrl, type GitQueryRunner } from "../../src/main/core/git-query";

const temporary: string[] = [];
async function directory() { const root = await fs.mkdtemp(path.join(os.tmpdir(), "specloom-overview-")); temporary.push(root); return root; }
function git(root: string, ...args: string[]) { return execFileSync("git", ["-c", "user.name=SpecLoom Test", "-c", "user.email=test@example.invalid", ...args], { cwd: root, env: gitQueryEnvironment(), encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim(); }
async function repository(commit = true) { const root = await directory(); git(root, "init", "-b", "main"); if (commit) git(root, "commit", "--allow-empty", "-m", "initial"); return root; }
afterEach(async () => { for (const root of temporary.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe("project overview", () => {
  it("reads all local and remote-tracking branches, upstreams and sanitized remote URLs without changing files", async () => {
    const root = await repository();
    const hash = git(root, "rev-parse", "HEAD");
    git(root, "branch", "feature/one"); git(root, "branch", "feature/two");
    git(root, "update-ref", "refs/remotes/origin/main", hash);
    git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    git(root, "remote", "add", "origin", "https://user:token@example.com/team/repo.git?access=secret#token");
    git(root, "config", "--add", "remote.origin.url", "https://other:password@example.org/repo.git?key=secret");
    git(root, "config", "--add", "remote.origin.pushurl", "https://push:secret@example.net/repo.git#secret");
    git(root, "config", "branch.main.remote", "origin"); git(root, "config", "branch.main.merge", "refs/heads/main");
    await fs.writeFile(path.join(root, "README.md"), "# Project\n"); await fs.writeFile(path.join(root, ".gitignore"), "build/\n");
    const before = git(root, "status", "--porcelain");
    const overview = await readProjectOverview(root);
    expect(overview.git.state).toBe("repository");
    if (overview.git.state !== "repository") throw new Error("Expected repository");
    expect(overview.git.location).toBe("root");
    expect(overview.git.head).toEqual({ kind: "branch", name: "main", commit: hash });
    expect(overview.git.branches).toHaveLength(4);
    expect(overview.git.branches.find(branch => branch.name === "main")).toMatchObject({ upstream: "origin/main" });
    expect(overview.git.branches.some(branch => branch.name === "origin/HEAD")).toBe(false);
    expect(overview.git.remotes).toEqual([{ name: "origin", fetchUrls: ["https://example.com/team/repo.git", "https://example.org/repo.git"], pushUrls: ["https://example.net/repo.git"] }]);
    expect(overview.documents.readmes[0]).toMatchObject({ path: "README.md", state: "file", size: 10 });
    expect(overview.documents.gitignore).toMatchObject({ state: "file", size: 7 });
    expect(JSON.stringify(overview)).not.toMatch(/password|access=|key=|user:token|push:secret/);
    expect(git(root, "status", "--porcelain")).toBe(before);
  });
  it("distinguishes an unborn branch, missing remotes, and missing root documents", async () => {
    const overview = await readProjectOverview(await repository(false));
    expect(overview.git).toMatchObject({ state: "repository", head: { kind: "unborn", name: "main" }, branches: [], branchesState: "loaded", remotes: [], remotesState: "loaded", issues: [] });
    expect(overview.documents).toEqual({ gitignore: { path: ".gitignore", state: "missing", version: "absent" }, readmes: [] });
  });
  it("distinguishes detached HEAD and linked worktrees", async () => {
    const root = await repository(); git(root, "checkout", "--detach");
    expect((await readProjectOverview(root)).git).toMatchObject({ state: "repository", head: { kind: "detached" } });
    const parent = await directory(); const linked = path.join(parent, "linked"); git(root, "worktree", "add", "--detach", linked);
    expect((await readProjectOverview(linked)).git).toMatchObject({ state: "repository", location: "linked-worktree", head: { kind: "detached" } });
  });
  it("discovers only selected-root documents when a project belongs to a parent repository", async () => {
    const root = await repository(); const child = path.join(root, "child"); await fs.mkdir(child);
    await fs.writeFile(path.join(root, "README.md"), "parent"); await fs.writeFile(path.join(root, ".gitignore"), "parent/\n");
    await fs.writeFile(path.join(child, "ReadMe.txt"), "child");
    await fs.writeFile(path.join(child, "README.zh-CN.md"), "localized");
    const overview = await readProjectOverview(child);
    expect(overview.git).toMatchObject({ state: "repository", location: "nested" });
    expect(overview.documents.readmes.map(file => file.path)).toEqual(["ReadMe.txt", "README.zh-CN.md"].sort((a, b) => a.localeCompare(b)));
    expect(overview.documents.gitignore.state).toBe("missing");
  });
  it("distinguishes no repository and a bare repository", async () => {
    const root = await directory(); expect((await readProjectOverview(root)).git).toEqual({ state: "not-repository" });
    git(root, "init", "--bare"); expect((await readProjectOverview(root)).git).toMatchObject({ state: "bare" });
  });
  it("marks oversized, binary and linked documents without reading beyond the selected project", async () => {
    const root = await directory();
    await fs.writeFile(path.join(root, "README.bin"), Buffer.from([0, 1, 2]));
    await fs.writeFile(path.join(root, ".gitignore"), Buffer.alloc(1024 * 1024 + 1));
    const overview = await readProjectOverview(root);
    expect(overview.documents.gitignore.state).toBe("unsupported"); expect(overview.documents.readmes[0]?.state).toBe("unsupported");
  });
  it("returns classified unavailable, ownership and timeout errors without raw stderr", async () => {
    const root = await directory();
    for (const code of ["unavailable", "ownership", "timeout"] as const) {
      const gitRunner: GitQueryRunner = vi.fn(async () => ({ exitCode: -1, stdout: "", stderr: "https://user:password@example.invalid?token=secret", failure: gitIssue(code) }));
      const result = await readProjectOverview(root, { gitRunner });
      expect(result.git.state).toBe(code === "unavailable" ? "unavailable" : "error");
      expect(JSON.stringify(result)).not.toMatch(/password|secret/);
    }
  });
  it("shows branch/remote query failures separately while retaining known repository and HEAD facts", async () => {
    const root = await directory(); const hash = "a".repeat(40);
    const gitRunner: GitQueryRunner = vi.fn(async args => {
      if (args[0] === "rev-parse" && args[1] === "--is-bare-repository") return { exitCode: 0, stdout: "false\ntrue\n", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { exitCode: 0, stdout: `${root}\n${root}/.git\n${root}/.git\n`, stderr: "" };
      if (args[0] === "symbolic-ref") return { exitCode: 0, stdout: "main\n", stderr: "" };
      if (args[0] === "rev-parse") return { exitCode: 0, stdout: hash, stderr: "" };
      return { exitCode: -1, stdout: "", stderr: "hidden credential", failure: gitIssue(args[0] === "for-each-ref" ? "output-limit" : "timeout") };
    });
    const result = await readProjectOverview(root, { gitRunner });
    expect(result.git).toMatchObject({ state: "repository", head: { kind: "branch", name: "main" }, branchesState: "error", branchesTruncated: true, remotesState: "error", issues: [{ code: "output-limit" }, { code: "timeout" }] });
    expect(JSON.stringify(result)).not.toContain("hidden credential");
  });
});

describe("read-only Git query limits", () => {
  it("clears inherited Git routing and injected config, preserving unrelated environment", () => {
    const env = gitQueryEnvironment({ PATH: "bin", GIT_DIR: "outside", git_work_tree: "outside", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "danger", GIT_INDEX_FILE: "outside" });
    expect(env.PATH).toBe("bin"); expect(env.GIT_DIR).toBeUndefined(); expect(env.git_work_tree).toBeUndefined(); expect(env.GIT_CONFIG_COUNT).toBeUndefined(); expect(env.GIT_CONFIG_KEY_0).toBeUndefined(); expect(env.GIT_INDEX_FILE).toBeUndefined();
  });
  it("enforces a total deadline and aggregate stdout/stderr limit", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const runner: GitQueryRunner = vi.fn(async () => ({ exitCode: 0, stdout: "a".repeat(GIT_OUTPUT_LIMIT), stderr: "x" }));
    const budget = new GitQueryBudget("test", runner);
    expect((await budget.query(["rev-parse"])).failure?.code).toBe("output-limit");
    const expired = new GitQueryBudget("test", runner); now.mockReturnValue(11_001);
    expect((await expired.query(["rev-parse"])).failure?.code).toBe("timeout");
    expect(runner).toHaveBeenCalledTimes(1);
  });
  it("sanitizes HTTP URL userinfo/query/fragment", () => {
    expect(sanitizeGitRemoteUrl("https://alice:secret@example.org/repo.git?token=hidden#private")).toBe("https://example.org/repo.git");
    expect(sanitizeGitRemoteUrl("git@example.org:team/repo.git")).toBe("git@example.org:team/repo.git");
  });
});
