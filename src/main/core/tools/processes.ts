import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { ProjectError } from "../errors";
import { windowsOwnedJob } from "./windows-job-host";
import { ProcessOutputDecoder } from "./process-output-decoder";
export type WorkProgress = (text: string) => void | Promise<void>;
export const MONITOR_IDLE_NOTICE_AFTER = 3;
export const MONITOR_IDLE_POLL_LIMIT = 5;
export const MONITOR_IDLE_TIMEOUT_MS = 120_000;
const STOP_TIMEOUT_MS = 5_000;
const PARTIAL_OUTPUT_DELAY_MS = 100;
interface Job {
  id: string; child: ChildProcess; lines: string[]; characters: number; base: number;
  status: "running" | "stopping" | "completed" | "cancelled" | "error"; exitCode: number | null;
  done: Promise<void>; progress: Promise<void>; stop?: Promise<void>; closed: boolean; cancelRequested: boolean;
  executable: string; args: string[]; env: NodeJS.ProcessEnv; startedAt: string;
  monitorCommand?: string; monitorShell?: string; onProgress?: WorkProgress;
  readCursor: number; revision: number; observedRevision: number; unchangedPolls: number; lastProgressAt: number;
  partialOutput: string; partialRevision: number; observedPartialRevision: number;
  blockage?: { kind: "existing-instance"; message: string };
}
const existingInstance = /EADDRINUSE|address\s+already\s+in\s+use|port\s+\d+\s+(?:is\s+)?(?:already\s+)?in\s+use|(?:another|existing)\s+instance|instance\s+(?:is\s+)?already\s+running|已有.{0,20}实例|(?:另一个|其他)实例.{0,20}(?:运行|启动)|实例.{0,20}(?:已在运行|正在运行)/i;
const conflictNotice = "启动输出提示已有实例或端口被占用。Monitor 仅能停止本会话拥有的作业；先 list 核对可操作的作业，再按原命令 restart。若占用来自外部实例，请立即告知用户阻塞原因和需要关闭的实例，不能按进程名或端口批量结束程序。";
function shellCommand(command: string, shell?: string): { executable: string; args: string[] } {
  if (shell === "cmd") return { executable: "cmd.exe", args: ["/d", "/s", "/c", `chcp 65001 >nul & ${command}`] };
  if (shell === "powershell" || (!shell && process.platform === "win32")) {
    // Parse the original script separately so leading using/param declarations stay valid.
    // An ASCII -Command wrapper also avoids -EncodedCommand serializing errors as CLIXML.
    // Windows PowerShell resets $? after invoking a script block; capture it inside the script.
    const encoded = Buffer.from(command + "\nexit ([int](-not $?))", "utf16le").toString("base64");
    const script = "$ProgressPreference = 'SilentlyContinue'; $utf8 = New-Object System.Text.UTF8Encoding($false); [Console]::InputEncoding = $utf8; [Console]::OutputEncoding = $utf8; $OutputEncoding = $utf8; & ([ScriptBlock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('" + encoded + "'))))";
    return { executable: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script] };
  }
  const candidates = ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe"];
  return { executable: process.platform === "win32" ? candidates.find(p => existsSync(p)) ?? "bash.exe" : "bash", args: ["--noprofile", "--norc", "-c", command] };
}
async function killTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") await new Promise<void>((resolve, reject) => {
    // The PID comes exclusively from this still-live ChildProcess, never user input or process-name discovery.
    const kill = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    const timer = setTimeout(() => { kill.kill(); reject(new ProjectError("COMMAND_FAILED", "停止本会话进程树超时，进程可能仍在运行。")); }, STOP_TIMEOUT_MS);
    kill.once("error", () => { clearTimeout(timer); if (child.kill()) resolve(); else reject(new ProjectError("COMMAND_FAILED", "无法停止本会话进程，进程可能仍在运行。")); });
    kill.once("close", code => { clearTimeout(timer); if (code === 0 || child.exitCode !== null || child.signalCode !== null) resolve(); else reject(new ProjectError("COMMAND_FAILED", "操作系统未能停止本会话进程树，进程可能仍在运行。")); });
  });
  else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
}
/** Owns every subprocess and cleans up its process tree on stop or workspace shutdown. */
export class WorkProcesses {
  private readonly jobs = new Map<string, Job>();
  constructor(private readonly root: string) {}
  async code(language: string, code: string, options: { timeoutMs?: number; signal?: AbortSignal; progress?: WorkProgress } = {}) {
    if (language === "javascript") return this.runExecutable(process.execPath, ["-e", code], { ...options, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    const candidates: { executable: string; prefix: string[] }[] = [];
    if (process.env.SPECLOOM_PYTHON_EXECUTABLE) candidates.push({ executable: process.env.SPECLOOM_PYTHON_EXECUTABLE, prefix: [] });
    if (process.platform === "win32") {
      candidates.push({ executable: "py.exe", prefix: ["-3"] });
      if (process.env.CONDA_PREFIX) candidates.push({ executable: path.join(process.env.CONDA_PREFIX, "python.exe"), prefix: [] });
      const installations = path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Python");
      if (path.isAbsolute(installations)) try { for (const item of readdirSync(installations, { withFileTypes: true })) if (item.isDirectory() && /^Python3\d+$/.test(item.name)) candidates.push({ executable: path.join(installations, item.name, "python.exe"), prefix: [] }); } catch { /* Optional installation location. */ }
      candidates.push({ executable: "python.exe", prefix: [] }, { executable: "python3.exe", prefix: [] });
    } else candidates.push({ executable: "python3", prefix: [] }, { executable: "python", prefix: [] });
    for (const candidate of candidates) {
      const probe = await this.runExecutable(candidate.executable, [...candidate.prefix, "--version"], { timeoutMs: 3000, ...(options.signal ? { signal: options.signal } : {}) });
      if (probe.exitCode === 0 && /^Python 3\./m.test(probe.output)) return this.runExecutable(candidate.executable, [...candidate.prefix, "-c", code], options);
    }
    throw new ProjectError("BACKEND_UNAVAILABLE", "未找到可运行的 Python 3。请安装 Python，或将 SPECLOOM_PYTHON_EXECUTABLE 指向真实解释器；Windows Store 占位命令不能执行代码。");
  }
  private start(executable: string, args: string[], progress?: WorkProgress, env?: NodeJS.ProcessEnv, monitor?: { command: string; shell?: string }): Job {
    if ([...this.jobs.values()].filter(j => !j.closed).length >= 16) throw new ProjectError("COMMAND_FAILED", "后台任务数量已达 16");
    // Keep only recent finished jobs, never orphan a live process.
    for (const job of [...this.jobs.values()].filter(j => j.closed).slice(0, Math.max(0, this.jobs.size - 64))) this.jobs.delete(job.id);
    const environment = Object.fromEntries(Object.entries(env ?? process.env).filter(([name]) => !["BASH_ENV", "ENV", "BASHOPTS", "SHELLOPTS"].includes(name) && !name.startsWith("BASH_FUNC_")));
    const managed = process.platform === "win32" ? windowsOwnedJob(executable, args) : undefined;
    const child = spawn(managed?.executable ?? executable, managed?.args ?? args, { cwd: this.root, windowsHide: true, detached: process.platform !== "win32", stdio: [managed ? "pipe" : "ignore", "pipe", "pipe"], env: environment });
    if (managed && child.stdin) { child.stdin.on("error", () => undefined); child.stdin.end(managed.input, "utf8"); }
    let resolve!: () => void;
    const job: Job = { id: randomUUID(), child, lines: [], characters: 0, base: 0, status: "running", exitCode: null, done: new Promise<void>(done => { resolve = done; }), progress: Promise.resolve(), closed: false, cancelRequested: false,
      executable, args: [...args], env: environment, startedAt: new Date().toISOString(), readCursor: 0, revision: 0, observedRevision: 0, unchangedPolls: 0, lastProgressAt: Date.now(),
      partialOutput: "", partialRevision: 0, observedPartialRevision: 0,
      ...(progress ? { onProgress: progress } : {}), ...(monitor ? { monitorCommand: monitor.command, ...(monitor.shell ? { monitorShell: monitor.shell } : {}) } : {}),
    };
    this.jobs.set(job.id, job);
    const updates: string[] = []; let draining = false; let dropped = false;
    const report = (line: string) => {
      job.revision++;
      job.lastProgressAt = Date.now();
      const newConflict = !job.blockage && existingInstance.test(line);
      if (newConflict) job.blockage = { kind: "existing-instance", message: conflictNotice };
      if (!progress) return;
      updates.push(line.slice(0, 2000)); if (newConflict) updates.push(conflictNotice); if (updates.length > 128) { updates.shift(); dropped = true; }
      if (draining) return;
      draining = true;
      job.progress = (async () => {
        try { while (updates.length) { const batch = updates.splice(0, 16).join("\n"); const prefix = dropped ? "[进度输出已合并，请使用 Monitor poll 获取增量]\n" : ""; dropped = false; await progress((prefix + batch).slice(-16384)); } }
        catch { updates.length = 0; } finally { draining = false; }
      })();
    };
    const append = (line: string) => {
      const bounded = line.slice(0, 8192); job.lines.push(bounded); job.characters += bounded.length;
      while (job.lines.length > 2000 || job.characters > 262144) { job.characters -= job.lines.shift()!.length; job.base++; }
      report(line);
    };
    const partials = ["", ""];
    for (const [streamIndex, stream] of [child.stdout!, child.stderr!].entries()) {
      const decoder = new ProcessOutputDecoder(managed?.outputMarker); let pending = "";
      let previewTimer: ReturnType<typeof setTimeout> | undefined;
      const updatePartial = (text: string) => {
        const previous = partials[streamIndex]!;
        if (text === previous) return;
        partials[streamIndex] = text; job.partialOutput = partials.filter(Boolean).join("\n"); job.partialRevision++;
        if (text) {
          const continuation = text.startsWith(previous);
          report(`${continuation ? "[未换行输出片段]" : "[未换行输出已更新]"}\n${continuation ? text.slice(previous.length) : text}`);
        }
      };
      const receive = (text: string) => { pending += text; while (pending.includes("\n") || pending.length > 8192) { const index = pending.indexOf("\n"); const end = index >= 0 ? index : 8192; append(pending.slice(0, end).replace(/\r$/, "")); pending = pending.slice(end + (index >= 0 ? 1 : 0)); updatePartial(""); } };
      stream.on("data", (bytes: Buffer) => {
        job.revision++; job.lastProgressAt = Date.now(); receive(decoder.write(bytes));
        // A fixed deadline from the first chunk cannot be postponed by a chatty process.
        previewTimer ??= setTimeout(() => { previewTimer = undefined; updatePartial((pending + decoder.preview()).slice(0, 8192)); }, PARTIAL_OUTPUT_DELAY_MS);
        previewTimer.unref();
      });
      let finished = false;
      const finish = () => { if (finished) return; finished = true; clearTimeout(previewTimer); previewTimer = undefined; receive(decoder.end()); if (pending) append(pending); pending = ""; updatePartial(""); };
      stream.once("end", finish); stream.once("close", finish);
    }
    child.once("error", (error) => { job.status = "error"; append(`进程启动失败：${error.message}`); });
    child.once("close", (code) => { job.exitCode = code; job.closed = true; job.revision++; job.lastProgressAt = Date.now(); if (job.cancelRequested) job.status = "cancelled"; else if (job.status === "running") job.status = code === 0 ? "completed" : "error"; resolve(); });
    return job;
  }
  async run(command: string, options: { shell?: string; timeoutMs?: number; signal?: AbortSignal; progress?: WorkProgress } = {}) {
    const selected = shellCommand(command, options.shell); return this.runExecutable(selected.executable, selected.args, options);
  }
  async runExecutable(executable: string, args: string[], options: { timeoutMs?: number; signal?: AbortSignal; progress?: WorkProgress; env?: NodeJS.ProcessEnv } = {}) {
    options.signal?.throwIfAborted(); const job = this.start(executable, args, options.progress, options.env); let timedOut = false;
    const abort = () => { void this.stop(job).catch(() => undefined); };
    options.signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => { timedOut = true; abort(); }, options.timeoutMs ?? 600000);
    try { await job.done; await job.progress; options.signal?.throwIfAborted(); const output = job.lines.join("\n"); return { id: job.id, output: output.slice(-131072), exitCode: job.exitCode, status: job.status, timedOut, truncated: job.base > 0 || output.length > 131072, executable }; }
    finally { clearTimeout(timeout); options.signal?.removeEventListener("abort", abort); }
  }
  async monitor(input: { operation: string; command?: string; shell?: string; id?: string; cursor?: number; waitMs?: number }, progress?: WorkProgress, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    if (input.operation === "start") {
      if (!input.command) throw new ProjectError("VALIDATION_FAILED", "Monitor start 需要 command");
      const existing = [...this.jobs.values()].find(job => !job.closed && job.monitorCommand === input.command && job.monitorShell === input.shell);
      if (existing) return { ...this.view(existing, existing.readCursor), reused: true, notice: "相同命令的本会话作业仍在运行；如需重新测试，使用此作业 ID 和原命令执行 restart。" };
      const selected = shellCommand(input.command, input.shell); const job = this.start(selected.executable, selected.args, progress, undefined, { command: input.command, ...(input.shell ? { shell: input.shell } : {}) });
      this.attachCancellation(job, signal);
      return this.view(job, 0);
    }
    if (input.operation === "list") return [...this.jobs.values()].map(j => this.view(j, j.base + j.lines.length));
    const job = input.id && this.jobs.get(input.id); if (!job) throw new ProjectError("VALIDATION_FAILED", "Monitor 作业不存在或不属于本会话；只能停止 list 返回的本会话作业。若实例由外部启动，请告知用户阻塞原因并请其关闭或提供安全操作方式。");
    if (input.operation === "restart") {
      if (!job.monitorCommand || input.command !== job.monitorCommand || (input.shell !== undefined && input.shell !== job.monitorShell)) throw new ProjectError("VALIDATION_FAILED", "Monitor restart 需要本会话作业 ID 及完全相同的原 command/shell；变更命令请通过已审批的 start 执行。");
      await this.stop(job); signal?.throwIfAborted();
      const next = this.start(job.executable, job.args, progress, job.env, { command: job.monitorCommand, ...(job.monitorShell ? { shell: job.monitorShell } : {}) });
      this.attachCancellation(next, signal);
      return { ...this.view(next, 0), restartedFrom: job.id };
    }
    if (input.operation === "cancel") { await this.stop(job); return this.view(job, input.cursor ?? job.readCursor); }
    if (input.operation !== "poll") throw new ProjectError("VALIDATION_FAILED", "未知 Monitor 操作");
    const waitMs = input.waitMs ?? 1_000;
    if (waitMs && !job.closed && (input.waitMs !== undefined || job.revision === job.observedRevision)) {
      await new Promise<void>(resolve => { const timer = setTimeout(done, Math.min(waitMs, 30000)); const abort = () => { done(); }; function done() { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve(); } signal?.addEventListener("abort", abort, { once: true }); void job.done.then(done); });
    }
    if (job.status === "stopping" && job.stop) await job.stop;
    // Output forwarding is an observer; a stalled UI/disk callback must not block process controls.
    signal?.throwIfAborted();
    const changed = job.revision !== job.observedRevision;
    job.unchangedPolls = changed ? 0 : job.unchangedPolls + 1; job.observedRevision = job.revision;
    const view = this.view(job, input.cursor ?? job.readCursor, job.partialRevision !== job.observedPartialRevision); job.readCursor = view.cursor; job.observedPartialRevision = job.partialRevision;
    const unchangedForMs = Math.max(0, Date.now() - job.lastProgressAt);
    const stalled = job.unchangedPolls >= MONITOR_IDLE_NOTICE_AFTER && (job.closed || !!job.blockage || unchangedForMs >= MONITOR_IDLE_TIMEOUT_MS);
    const notice = job.unchangedPolls >= MONITOR_IDLE_NOTICE_AFTER ? `Monitor 连续 ${job.unchangedPolls} 次没有新输出或状态变化。${job.closed ? "作业已结束，请检查已有结果。" : job.blockage ? conflictNotice : stalled ? "作业已持续至少 120 秒没有进展；请核对是否需要停止本会话作业并按原命令重启测试。" : "作业可能仍在正常启动或静默运行，请使用 waitMs=30000 等待，不能仅凭短暂无输出判断失败或重启。"}` : undefined;
    if (job.unchangedPolls === MONITOR_IDLE_NOTICE_AFTER) void Promise.resolve().then(() => (progress ?? job.onProgress)?.(notice!)).catch(() => undefined);
    return { ...view, changed, unchangedPolls: job.unchangedPolls, unchangedForMs, stalled, ...(notice ? { notice } : {}) };
  }
  private attachCancellation(job: Job, signal?: AbortSignal): void {
    const abort = () => { void this.stop(job).catch(() => undefined); };
    signal?.addEventListener("abort", abort, { once: true }); void job.done.then(() => signal?.removeEventListener("abort", abort)); if (signal?.aborted) abort();
  }
  private async stop(job: Job): Promise<void> {
    if (job.closed) return;
    if (job.stop) return job.stop;
    job.cancelRequested = true; job.status = "stopping"; job.revision++; job.lastProgressAt = Date.now();
    job.stop = (async () => {
      try {
        await killTree(job.child);
        await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new ProjectError("COMMAND_FAILED", "等待本会话进程停止超时，进程可能仍在运行，不能开始重启。")), STOP_TIMEOUT_MS); void job.done.then(() => { clearTimeout(timer); resolve(); }); });
      } catch (error) { if (!job.closed) { job.status = "running"; job.cancelRequested = false; job.revision++; job.lastProgressAt = Date.now(); } throw error; }
    })();
    try { await job.stop; } finally { delete job.stop; }
  }
  private view(job: Job, cursor: number, includePartial = true) { const output = job.lines.slice(Math.max(0, cursor - job.base)).join("\n"); return { id: job.id, status: job.status, exitCode: job.exitCode, output: output.slice(-131072), cursor: job.base + job.lines.length, truncated: cursor < job.base || output.length > 131072, ownership: "session" as const, startedAt: job.startedAt, canCancel: !job.closed, canRestart: job.monitorCommand !== undefined,
    // A snapshot of unfinished lines; output/cursor continue to describe append-only completed records.
    ...(includePartial && job.partialRevision > 0 ? { partialOutput: job.partialOutput } : {}),
    ...(job.monitorCommand ? { command: job.monitorCommand, ...(job.monitorShell ? { shell: job.monitorShell } : {}) } : {}), ...(job.blockage ? { blockage: job.blockage } : {}),
  }; }
  async close(): Promise<void> { await Promise.all([...this.jobs.values()].filter(j => !j.closed).map(job => this.stop(job))); }
}
