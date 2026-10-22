import { spawn } from "node:child_process";

const TIMEOUT_MS = 20_000;
const MAX_OUTPUT = 2 * 1024 * 1024;
const SAFE_ENV = {
  ...process.env,
  LC_ALL: "C",
  LANG: "C",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "cat",
};

function git(projectPath, args, options = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], {
        cwd: projectPath,
        env: { ...SAFE_ENV, ...(options.env ?? {}) },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(new Error(error?.code === "ENOENT" ? "未找到 Git，请先安装 Git。" : "无法启动 Git。"));
      return;
    }
    let stdout = "";
    let stderr = "";
    let size = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("Git 操作超时。"));
    }, options.timeoutMs ?? TIMEOUT_MS);
    const append = (target, chunk) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) {
        if (!settled) { settled = true; clearTimeout(timer); child.kill("SIGKILL"); reject(new Error("Git 输出超过上限。")); }
        return target;
      }
      return target + chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.on("error", (error) => {
      if (settled) return; settled = true; clearTimeout(timer);
      reject(new Error(error?.code === "ENOENT" ? "未找到 Git，请先安装 Git。" : "Git 启动失败。"));
    });
    child.on("close", (code) => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

async function run(projectPath, args, options) {
  const result = await git(projectPath, args, options);
  if (result.code !== 0) throw new Error(cleanError(result.stderr) || `Git 操作失败（退出码 ${result.code}）。`);
  return result.stdout;
}

function cleanError(value) {
  return String(value ?? "").trim().replace(/\/\/[^\s/@]+:[^\s/@]+@/gu, "//[redacted]@").slice(0, 2000);
}

async function repositoryState(projectPath) {
  const inside = await git(projectPath, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") return { state: "not-repository" };
  const branch = await git(projectPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const currentBranch = branch.code === 0 ? branch.stdout.trim() : "";
  const upstream = await git(projectPath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  const upstreamName = upstream.code === 0 ? upstream.stdout.trim() : "";
  let ahead = 0;
  let behind = 0;
  if (upstreamName) {
    const counts = await git(projectPath, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
    if (counts.code === 0) {
      const [left, right] = counts.stdout.trim().split(/\s+/u).map(Number);
      behind = Number.isSafeInteger(left) ? left : 0;
      ahead = Number.isSafeInteger(right) ? right : 0;
    }
  }
  const status = await git(projectPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const files = parseStatus(status.stdout);
  return {
    state: "repository",
    branch: currentBranch,
    upstream: upstreamName,
    ahead,
    behind,
    files,
    stagedCount: files.filter((file) => file.staged).length,
    unstagedCount: files.filter((file) => file.unstaged).length,
  };
}

function parseStatus(output) {
  const parts = output.split("\0");
  const files = [];
  for (let index = 0; index < parts.length; index++) {
    const raw = parts[index];
    if (!raw || raw.length < 4) continue;
    const x = raw[0];
    const y = raw[1];
    let file = raw.slice(3);
    if (x === "R" || x === "C") {
      index++;
      const renamed = parts[index];
      if (renamed) file = `${file} → ${renamed}`;
    }
    const untracked = x === "?" || y === "?";
    files.push({ path: file, index: x, worktree: y, staged: !untracked && x !== " ", unstaged: untracked || y !== " " });
  }
  return files;
}

async function diff(projectPath, input) {
  const file = typeof input?.path === "string" && input.path ? input.path : undefined;
  const staged = input?.staged === true;
  const args = ["diff", "--no-ext-diff", "--no-color", "--unified=3", ...(staged ? ["--cached"] : []), ...(file ? ["--", file] : [])];
  const text = await git(projectPath, args, { timeoutMs: 15_000 });
  if (text.code !== 0) throw new Error(cleanError(text.stderr) || "读取 Git 差异失败。");
  return { diff: text.stdout.slice(0, 500_000), truncated: text.stdout.length > 500_000 };
}

async function commit(projectPath, input) {
  const message = typeof input?.message === "string" ? input.message.trim() : "";
  if (!message) throw new Error("请填写提交说明。");
  if (message.length > 20_000) throw new Error("提交说明过长。");
  return { output: cleanError(await run(projectPath, ["commit", "-m", message], { timeoutMs: 30_000 })) };
}

async function branches(projectPath) {
  const output = await run(projectPath, ["branch", "--format=%(refname:short)"]);
  const current = (await git(projectPath, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  return { current, branches: output.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean) };
}

async function validateBranch(projectPath, name) {
  const value = typeof name === "string" ? name.trim() : "";
  if (!value || value.length > 120) throw new Error("请输入有效的分支名。");
  const check = await git(projectPath, ["check-ref-format", "--branch", value]);
  if (check.code !== 0) throw new Error("分支名不合法。");
  return value;
}

async function history(projectPath) {
  const output = await run(projectPath, ["log", "--max-count=50", "--format=%H%x00%h%x00%an%x00%at%x00%s%x00"]);
  const fields = output.split("\0");
  const commits = [];
  for (let index = 0; index + 4 < fields.length; index += 5) {
    const hash = fields[index];
    if (!hash) continue;
    commits.push({ hash, shortHash: fields[index + 1], author: fields[index + 2], authoredAt: Number(fields[index + 3]) || 0, subject: fields[index + 4] });
  }
  return { commits };
}

async function commitDetail(projectPath, input) {
  const hash = typeof input?.hash === "string" ? input.hash : "";
  if (!/^[a-f0-9]{7,64}$/iu.test(hash)) throw new Error("提交标识无效。");
  const meta = await run(projectPath, ["show", "-s", "--format=%H%x00%h%x00%an%x00%ae%x00%at%x00%s", hash]);
  const fields = meta.split("\0");
  const diff = await git(projectPath, ["show", "--no-ext-diff", "--no-color", "--format=", "--stat", "--patch", hash], { timeoutMs: 15_000 });
  return {
    hash: fields[0], shortHash: fields[1], author: fields[2], email: fields[3],
    authoredAt: Number(fields[4]) || 0, subject: fields[5]?.trim() ?? "",
    diff: diff.stdout.slice(0, 500_000), truncated: diff.stdout.length > 500_000,
  };
}

function text(value) { return typeof value === "string" ? value : ""; }

export async function activate(context) {
  const call = (handler) => async (input, commandContext) => handler(commandContext.projectPath, input);
  context.commands.register("state", call(repositoryState));
  context.commands.register("diff", call(diff));
  context.commands.register("stage", call(async (projectPath, input) => {
    const paths = Array.isArray(input?.paths) ? input.paths.filter((value) => typeof value === "string" && value) : [];
    if (!paths.length) throw new Error("请选择要暂存的文件。");
    await run(projectPath, ["add", "--", ...paths]);
    return repositoryState(projectPath);
  }));
  context.commands.register("unstage", call(async (projectPath, input) => {
    const paths = Array.isArray(input?.paths) ? input.paths.filter((value) => typeof value === "string" && value) : [];
    if (!paths.length) throw new Error("请选择要取消暂存的文件。");
    await run(projectPath, ["restore", "--staged", "--", ...paths]);
    return repositoryState(projectPath);
  }));
  context.commands.register("commit", call(commit));
  context.commands.register("branches", call(branches));
  context.commands.register("createBranch", call(async (projectPath, input) => {
    const name = await validateBranch(projectPath, input?.name);
    await run(projectPath, ["switch", "-c", name]);
    return branches(projectPath);
  }));
  context.commands.register("switchBranch", call(async (projectPath, input) => {
    const name = await validateBranch(projectPath, input?.name);
    await run(projectPath, ["switch", name]);
    return branches(projectPath);
  }));
  context.commands.register("fetch", call(async (projectPath) => { await run(projectPath, ["fetch", "--prune"], { timeoutMs: 60_000 }); return repositoryState(projectPath); }));
  context.commands.register("pull", call(async (projectPath) => { await run(projectPath, ["pull", "--ff-only"], { timeoutMs: 60_000 }); return repositoryState(projectPath); }));
  context.commands.register("push", call(async (projectPath) => { await run(projectPath, ["push"], { timeoutMs: 60_000 }); return repositoryState(projectPath); }));
  context.commands.register("history", call(history));
  context.commands.register("commitDetail", call(commitDetail));
  context.commands.register("init", call(async (projectPath) => { await run(projectPath, ["init"]); return repositoryState(projectPath); }));
}

export async function deactivate() {}
