import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { PluginRpc } from "./plugin-rpc";

export interface PluginHostOptions {
  pluginId: string;
  version: string;
  root: string;
  entry: string;
  childPath: string;
  logDir: string;
  requestTimeoutMs?: number;
  onRequest: (method: string, params: unknown) => Promise<unknown>;
  onFailure?: (error: Error) => void;
}

export class PluginHost {
  private child?: ChildProcessWithoutNullStreams;
  private rpc?: PluginRpc;
  private log?: WriteStream;
  private failure?: Error;
  private stopping = false;
  private started = false;

  constructor(private readonly options: PluginHostOptions) {}

  async start(): Promise<string[]> {
    if (this.started) throw new Error("Plugin host already started");
    this.started = true;
    await mkdir(this.options.logDir, { recursive: true });
    this.log = createWriteStream(path.join(this.options.logDir, `${this.options.pluginId}.log`), { flags: "a" });
    this.log.on("error", (error) => this.fail(error));
    this.child = spawn(process.execPath, [this.options.childPath, this.options.root, this.options.entry], {
      cwd: this.options.root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.pipe(this.log, { end: false });
    this.rpc = new PluginRpc(this.child.stdout, this.child.stdin, this.options.onRequest, (error) => this.fail(error));
    this.child.once("error", (error) => this.fail(error));
    this.child.once("exit", (code, signal) => {
      if (!this.stopping) this.fail(new Error(`Plugin process exited (${signal ?? code ?? "unknown"})`));
    });
    try {
      const result = await this.rpc.request("activate", undefined, this.options.requestTimeoutMs ?? 15_000) as { commands?: unknown };
      if (!Array.isArray(result?.commands) || result.commands.some((item) => typeof item !== "string")) throw new Error("Plugin activate returned invalid command list");
      return result.commands as string[];
    } catch (error) {
      this.fail(error as Error);
      await this.stop();
      throw error;
    }
  }

  async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.failure) throw this.failure;
    if (!this.rpc) throw new Error("Plugin host is not running");
    return this.rpc.request(method, params, timeoutMs);
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.rpc && !this.failure) {
      try { await this.rpc.request("deactivate", undefined, 15_000); } catch { /* best effort */ }
    }
    this.rpc?.close();
    const child = this.child;
    if (child && child.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
        child.kill();
      });
    }
    if (this.log && !this.log.closed) await new Promise<void>((resolve) => { this.log!.once("error", () => resolve()); this.log!.end(() => resolve()); });
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.rpc?.close(error);
    this.child?.kill();
    if (!this.stopping) this.options.onFailure?.(error);
  }
}
