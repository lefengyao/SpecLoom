import type { Readable, Writable } from "node:stream";

export const MAX_RPC_BYTES = 5 * 1024 * 1024;

export class PluginRpcError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PluginRpcError";
  }
}

interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; }
interface RpcMessage {
  id?: string;
  method?: string;
  params?: unknown;
  ok?: boolean;
  result?: unknown;
  error?: { code?: string; message?: string };
}
type RequestHandler = (method: string, params: unknown) => Promise<unknown>;

export class PluginRpc {
  private buffer = "";
  private sequence = 0;
  private readonly pending = new Map<string, Pending>();
  private closed?: Error;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly onRequest: RequestHandler,
    private readonly onFailure?: (error: Error) => void,
  ) {
    input.on("data", (chunk: Buffer) => this.receive(chunk));
    input.on("error", (error) => this.fail(error));
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(this.closed);
    const id = `r${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PluginRpcError("TIMEOUT", `Plugin request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  close(error = new PluginRpcError("CLOSED", "Plugin RPC closed")): void {
    if (this.closed) return;
    this.closed = error;
    for (const [id, item] of this.pending) {
      clearTimeout(item.timer);
      item.reject(error);
      this.pending.delete(id);
    }
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer += chunk.toString("utf8");
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_RPC_BYTES * 2) {
      this.fail(new PluginRpcError("LIMIT_EXCEEDED", "Plugin RPC buffer exceeded limit"));
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_RPC_BYTES) {
        this.fail(new PluginRpcError("LIMIT_EXCEEDED", "Plugin RPC message exceeded limit"));
        return;
      }
      let message: RpcMessage;
      try { message = JSON.parse(line) as RpcMessage; }
      catch {
        this.onFailure?.(new PluginRpcError("PROTOCOL_ERROR", "Plugin wrote invalid JSON"));
        continue;
      }
      if (message.method) { void this.dispatch(message); continue; }
      if (!message.id) {
        this.onFailure?.(new PluginRpcError("PROTOCOL_ERROR", "Plugin response has no id"));
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new PluginRpcError(message.error?.code ?? "PLUGIN_ERROR", message.error?.message ?? "Plugin request failed"));
    }
  }

  private async dispatch(message: RpcMessage): Promise<void> {
    const id = message.id!;
    try {
      this.write({ id, ok: true, result: await this.onRequest(message.method!, message.params) });
    } catch (error) {
      const failure = error instanceof PluginRpcError
        ? error
        : new PluginRpcError("PLUGIN_ERROR", error instanceof Error ? error.message : String(error));
      this.write({ id, ok: false, error: { code: failure.code, message: failure.message } });
    }
  }

  private write(message: RpcMessage): void {
    if (this.closed) throw this.closed;
    const line = JSON.stringify(message) + "\n";
    if (Buffer.byteLength(line, "utf8") > MAX_RPC_BYTES) throw new PluginRpcError("LIMIT_EXCEEDED", "Plugin RPC message exceeded limit");
    this.output.write(line);
  }

  private fail(error: Error): void {
    this.close(error);
    this.onFailure?.(error);
  }
}
