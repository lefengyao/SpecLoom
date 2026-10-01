import { spawn } from "node:child_process";
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

export const executeDocker: DockerExecutor = async (args, options) => {
  if (options.signal?.aborted) throw new ProjectError("COMMAND_FAILED", "Container command was cancelled", { reason: "aborted" });
  const started = performance.now();
  return new Promise<DockerExecutionResult>((resolve, reject) => {
    const child = spawn("docker", args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let interruption: "timeout" | "aborted" | "output-limit" | undefined;
    let finished = false;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const interrupt = (reason: typeof interruption): void => {
      if (finished || interruption !== undefined) return;
      interruption = reason;
      child.kill();
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
      reject(new ProjectError("BACKEND_UNAVAILABLE", "Docker could not be started", undefined, { cause: error }));
    });
    child.once("close", (exitCode) => {
      if (finished) return;
      clear();
      const result = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), exitCode: exitCode ?? -1, durationMs: performance.now() - started };
      if (interruption !== undefined) {
        reject(new ProjectError("COMMAND_FAILED", "Container command exceeded a limit or was cancelled", { ...result, reason: interruption }));
      } else resolve(result);
    });
    if (options.signal?.aborted) onAbort();
  });
};
