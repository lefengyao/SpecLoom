import { spawn } from "node:child_process";
import type { GitIssue } from "../../shared/project-overview";

export const GIT_QUERY_TIMEOUT_MS = 5_000;
export const GIT_INSPECTION_TIMEOUT_MS = 10_000;
export const GIT_OUTPUT_LIMIT = 2 * 1024 * 1024;
export interface GitQueryResult { exitCode: number; stdout: string; stderr: string; failure?: GitIssue }
export interface GitQueryOptions { cwd: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number }
export type GitQueryRunner = (args: readonly string[], options: GitQueryOptions) => Promise<GitQueryResult>;

const issueMessages: Record<GitIssue["code"], string> = {
  unavailable: "未找到 Git，请安装 Git 后重试。",
  ownership: "Git 拒绝读取此仓库：目录所有者不受信任，请检查所有权或已有安全目录设置。",
  timeout: "Git 读取超时，请稍后重试。",
  "output-limit": "Git 读取超过输出上限，结果不完整。",
  "invalid-project": "项目目录不可读取。",
  "query-failed": "Git 读取失败，请检查本地仓库状态。",
};
export function gitIssue(code: GitIssue["code"]): GitIssue { return { code, message: issueMessages[code] }; }
export function gitQueryEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => !/^GIT_/i.test(key)));
  return { ...env, LC_ALL: "C", LANG: "C", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat" };
}
/** stderr is private diagnostic input; callers must return only classified issues. */
export const runGitQuery: GitQueryRunner = (args, options) => new Promise(resolve => {
  let child;
  try { child = spawn("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], {
    cwd: options.cwd, env: options.env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  }); } catch { resolve({ exitCode: -1, stdout: "", stderr: "", failure: gitIssue("query-failed") }); return; }
  const output: Buffer[] = []; const errors: Buffer[] = [];
  let bytes = 0; let failure: GitIssue | undefined;
  const timer = setTimeout(() => { failure = gitIssue("timeout"); child.kill("SIGKILL"); }, options.timeout);
  const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > options.maxBuffer) { failure ??= gitIssue("output-limit"); child.kill("SIGKILL"); return; }
    chunks.push(chunk);
  };
  child.stdout.on("data", collect(output)); child.stderr.on("data", collect(errors));
  child.on("error", (error: NodeJS.ErrnoException) => { failure ??= gitIssue(error.code === "ENOENT" ? "unavailable" : "query-failed"); });
  child.on("close", exitCode => {
    clearTimeout(timer);
    const stdout = Buffer.concat(output).toString("utf8"); const stderr = Buffer.concat(errors).toString("utf8");
    if (/dubious ownership|unsafe repository/i.test(stderr)) failure ??= gitIssue("ownership");
    resolve({ exitCode: exitCode ?? -1, stdout, stderr, ...(failure ? { failure } : {}) });
  });
});

/** One inspection has one deadline and one aggregate output budget. */
export class GitQueryBudget {
  private readonly deadline = Date.now() + GIT_INSPECTION_TIMEOUT_MS;
  private remaining = GIT_OUTPUT_LIMIT;
  constructor(private readonly cwd: string, private readonly runner: GitQueryRunner = runGitQuery) {}
  async query(args: readonly string[]): Promise<GitQueryResult> {
    const timeout = Math.min(GIT_QUERY_TIMEOUT_MS, this.deadline - Date.now());
    if (timeout <= 0) return { exitCode: -1, stdout: "", stderr: "", failure: gitIssue("timeout") };
    if (this.remaining <= 0) return { exitCode: -1, stdout: "", stderr: "", failure: gitIssue("output-limit") };
    try {
      const result = await this.runner(args, { cwd: this.cwd, env: gitQueryEnvironment(), timeout, maxBuffer: this.remaining });
      this.remaining -= Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
      if (this.remaining < 0) return { exitCode: -1, stdout: "", stderr: "", failure: gitIssue("output-limit") };
      if (/dubious ownership|unsafe repository/i.test(result.stderr)) return { ...result, failure: gitIssue("ownership") };
      return result;
    } catch { return { exitCode: -1, stdout: "", stderr: "", failure: gitIssue("query-failed") }; }
  }
}

export function sanitizeGitRemoteUrl(value: string): string {
  const clean = [...value].filter(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127).join("").trim();
  if (/^https?:\/\//i.test(clean)) {
    try { const url = new URL(clean); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.toString(); }
    catch { return "[无法显示的远程地址]"; }
  }
  // Other URL transports can carry userinfo or token-bearing query strings too.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(clean)) {
    try { const url = new URL(clean); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.toString(); }
    catch { return "[无法显示的远程地址]"; }
  }
  return clean.split(/[?#]/, 1)[0] ?? "";
}
