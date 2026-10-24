import { spawn, type ChildProcess } from "node:child_process";
import { ProjectError } from "./errors";

export interface DockerExecutionOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export interface DockerExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export type DockerExecutor = (args: string[], options: DockerExecutionOptions) => Promise<DockerExecutionResult>;

export interface ProcessExecutionOptions extends DockerExecutionOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Shown in error messages, e.g. "Docker" or "Godot". */
  label?: string;
}

export type ProcessExecutor = (executable: string, args: string[], options: ProcessExecutionOptions) => Promise<DockerExecutionResult>;

/** Windows shells spawn grandchildren; stop the whole owned tree, not just the launcher. */
function terminate(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid) {
    const kill = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    kill.once("error", () => { child.kill(); });
    return;
  }
  child.kill();
}

/** Spawn one bounded, non-shell process and capture its combined progress. */
export const executeProcess: ProcessExecutor = async (executable, args, options) => {
  const label = options.label ?? "Command";
  if (options.signal?.aborted) throw new ProjectError("COMMAND_FAILED", `${label} command was cancelled`, { reason: "aborted" });
  const started = performance.now();
  return new Promise<DockerExecutionResult>((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env ?? process.env,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let interruption: "timeout" | "aborted" | "output-limit" | undefined;
    let finished = false;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const interrupt = (reason: typeof interruption): void => {
      if (finished || interruption !== undefined) return;
      interruption = reason;
      terminate(child);
      forceKill = setTimeout(() => { child.kill("SIGKILL"); }, 100);
    };
    const capture = (chunks: Buffer[], chunk: Buffer): void => {
      if (interruption !== undefined) return;
      const remaining = options.maxOutputBytes - size;
      chunks.push(chunk.subarray(0, Math.max(0, remaining)));
      size += chunk.length;
      if (size > options.maxOutputBytes) interrupt("output-limit");
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    const onAbort = (): void => interrupt("aborted");
    const timer = setTimeout(() => interrupt("timeout"), options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const clear = (): void => {
      finished = true;
      clearTimeout(timer);
      if (forceKill !== undefined) clearTimeout(forceKill);
      options.signal?.removeEventListener("abort", onAbort);
    };
    child.once("error", (error) => {
      clear();
      reject(new ProjectError("BACKEND_UNAVAILABLE", `${label} could not be started`, undefined, { cause: error }));
    });
    child.once("close", (exitCode) => {
      if (finished) return;
      clear();
      const result = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), exitCode: exitCode ?? -1, durationMs: performance.now() - started };
      if (interruption !== undefined) {
        reject(new ProjectError("COMMAND_FAILED", `${label} command exceeded a limit or was cancelled`, { ...result, reason: interruption }));
      } else resolve(result);
    });
    if (options.signal?.aborted) onAbort();
  });
};

export const executeDocker: DockerExecutor = (args, options) => executeProcess("docker", args, { ...options, label: "Docker" });
