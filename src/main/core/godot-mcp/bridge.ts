import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { ProjectError } from "../errors";

export const GODOT_MCP_SERVICE_ID = "specloom";
export const GODOT_MCP_BASE_PORT = 6505;
export const GODOT_MCP_PORT_COUNT = 10;
export const GODOT_MCP_MAX_MESSAGE_BYTES = 24 * 1024 * 1024;
export const GODOT_MCP_REQUEST_TIMEOUT_MS = 30_000;
export const GODOT_MCP_ALLOWED_ROUTES = new Set([
  "mcp/diagnostics",
  "editor/get_output_log",
  "editor/get_screenshot",
  "editor/get_game_screenshot",
  "project/get_info",
  "scene/get_tree",
  "runtime/get_scene_tree",
  "runtime/get_node_properties",
]);

export interface GodotMcpBridgeOptions {
  basePort?: number;
  portCount?: number;
  requestTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  maxMessageBytes?: number;
}

export interface GodotMcpBridgeStatus {
  state: "stopped" | "listening" | "connected";
  connected: boolean;
  projectPath: string;
  port: number | null;
  pendingRequests: number;
}

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort?: () => void;
}

function normalizedPath(value: string): string {
  const normalized = value.replace(/[\\/]+/g, "/").replace(/\/$/, "");
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function messageText(data: WebSocket.RawData): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

export class GodotMcpBridge {
  private server: WebSocketServer | undefined;
  private peer: WebSocket | undefined;
  private peerHandshake = false;
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  private state: GodotMcpBridgeStatus["state"] = "stopped";
  private port: number | null = null;
  private closed = false;
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly listeners = new Set<(status: GodotMcpBridgeStatus) => void>();
  private readonly options: Required<GodotMcpBridgeOptions>;

  constructor(readonly projectPath: string, options: GodotMcpBridgeOptions = {}) {
    this.options = {
      basePort: options.basePort ?? GODOT_MCP_BASE_PORT,
      portCount: options.portCount ?? GODOT_MCP_PORT_COUNT,
      requestTimeoutMs: options.requestTimeoutMs ?? GODOT_MCP_REQUEST_TIMEOUT_MS,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? 3_000,
      maxMessageBytes: options.maxMessageBytes ?? GODOT_MCP_MAX_MESSAGE_BYTES,
    };
  }

  async start(): Promise<number> {
    if (this.server && this.port !== null) return this.port;
    this.closed = false;
    const attempts = this.options.basePort === 0 ? 1 : this.options.portCount;
    let lastError: unknown;
    for (let offset = 0; offset < attempts; offset++) {
      const requestedPort = this.options.basePort === 0 ? 0 : this.options.basePort + offset;
      try {
        const server = await this.listen(requestedPort);
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("WebSocket listener did not expose a TCP port");
        this.server = server;
        this.port = address.port;
        this.state = "listening";
        server.on("connection", socket => this.accept(socket));
        server.on("error", () => { /* socket errors are surfaced through connection state and diagnostics */ });
        this.emitStatus();
        return this.port;
      } catch (error) {
        lastError = error;
      }
    }
    this.state = "stopped";
    throw new ProjectError("BACKEND_UNAVAILABLE", `Could not bind the Godot MCP loopback service on ports ${this.options.basePort}-${this.options.basePort + attempts - 1}.`, { cause: lastError instanceof Error ? lastError.message : String(lastError) });
  }

  getPort(): number | null { return this.port; }
  isConnected(): boolean { return this.state === "connected" && this.peer?.readyState === WebSocket.OPEN; }
  pendingCount(): number { return this.pending.size; }
  getStatus(): GodotMcpBridgeStatus {
    return { state: this.state, connected: this.isConnected(), projectPath: this.projectPath, port: this.port, pendingRequests: this.pending.size };
  }

  onStatus(listener: (status: GodotMcpBridgeStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.getStatus());
    return () => this.listeners.delete(listener);
  }

  waitUntilConnected(timeoutMs = 1_000): Promise<boolean> {
    if (this.isConnected()) return Promise.resolve(true);
    return new Promise(resolve => {
      const timer = setTimeout(() => { unsubscribe(); resolve(false); }, timeoutMs);
      const unsubscribe = this.onStatus(status => {
        if (status.connected) { clearTimeout(timer); unsubscribe(); resolve(true); }
      });
    });
  }

  call(route: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (!GODOT_MCP_ALLOWED_ROUTES.has(route)) throw new ProjectError("VALIDATION_FAILED", "Godot MCP route is not allowlisted", { route });
    signal?.throwIfAborted();
    if (!this.isConnected() || !this.peer) throw new ProjectError("BACKEND_UNAVAILABLE", "Godot MCP addon is not connected. Enable the SpecLoom Godot MCP plugin in the project and reload it.", { route, projectPath: this.projectPath });
    const id = `specloom_${randomUUID()}`;
    const message = JSON.stringify({ jsonrpc: "2.0", id, method: route, params });
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        method: route,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.removePending(id);
          reject(new ProjectError("BACKEND_UNAVAILABLE", `Godot MCP request timed out: ${route}`, { reason: "timeout", route, projectPath: this.projectPath }));
        }, this.options.requestTimeoutMs),
        ...(signal ? { signal } : {}),
      };
      if (signal) {
        pending.abort = () => {
          this.removePending(id);
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        };
        signal.addEventListener("abort", pending.abort, { once: true });
      }
      this.pending.set(id, pending);
      this.peer!.send(message, error => {
        if (error) {
          this.removePending(id);
          reject(new ProjectError("BACKEND_UNAVAILABLE", `Could not send Godot MCP request: ${route}`, { route, projectPath: this.projectPath }, { cause: error }));
        }
      });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
    const peer = this.peer;
    this.peer = undefined;
    this.peerHandshake = false;
    if (peer && peer.readyState !== WebSocket.CLOSED) peer.close(1000, "SpecLoom project closed");
    for (const id of this.pending.keys()) {
      const pending = this.removePending(id);
      pending?.reject(new ProjectError("BACKEND_UNAVAILABLE", "Godot MCP project bridge closed", { projectPath: this.projectPath }));
    }
    const server = this.server;
    this.server = undefined;
    this.port = null;
    this.state = "stopped";
    this.emitStatus();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  }

  private listen(port: number): Promise<WebSocketServer> {
    return new Promise((resolve, reject) => {
      const server = new WebSocketServer({ host: "127.0.0.1", port, maxPayload: this.options.maxMessageBytes });
      const onListening = () => { server.off("error", onError); resolve(server); };
      const onError = (error: Error) => { server.off("listening", onListening); server.close(); reject(error); };
      server.once("listening", onListening);
      server.once("error", onError);
    });
  }

  private accept(socket: WebSocket): void {
    if (this.peer && this.peer.readyState === WebSocket.OPEN) { socket.close(1013, "Project addon already connected"); return; }
    this.peer = socket;
    this.peerHandshake = false;
    socket.on("message", data => this.onMessage(socket, data));
    socket.on("close", () => this.onClose(socket));
    socket.on("error", () => this.onClose(socket));
    const hello = JSON.stringify({ jsonrpc: "2.0", method: "server_hello", params: {
      projectPath: this.projectPath,
      serviceId: GODOT_MCP_SERVICE_ID,
      port: this.port,
    } });
    socket.send(hello, error => { if (error) socket.close(1011, "Could not send service identity"); });
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = setTimeout(() => {
      if (this.peer === socket && !this.peerHandshake) socket.close(1008, "SpecLoom service handshake timed out");
    }, this.options.handshakeTimeoutMs);
  }

  private onMessage(socket: WebSocket, data: WebSocket.RawData): void {
    if (this.peer !== socket) return;
    let message: Record<string, unknown>;
    try {
      const raw = messageText(data);
      if (Buffer.byteLength(raw, "utf8") > this.options.maxMessageBytes) { socket.close(1009, "Message too large"); return; }
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected JSON object");
      message = parsed as Record<string, unknown>;
    } catch {
      socket.close(1007, "Invalid JSON-RPC message");
      return;
    }

    if (!this.peerHandshake) {
      const params = message.params;
      if (message.method !== "client_hello" || !params || typeof params !== "object" || Array.isArray(params)) {
        socket.close(1008, "SpecLoom service handshake required");
        return;
      }
      const identity = params as Record<string, unknown>;
      if (identity.serviceId !== GODOT_MCP_SERVICE_ID || typeof identity.projectPath !== "string" || normalizedPath(identity.projectPath) !== normalizedPath(this.projectPath)) {
        socket.close(1008, "Godot project or service identity mismatch");
        return;
      }
      this.peerHandshake = true;
      if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
      this.handshakeTimer = undefined;
      this.state = "connected";
      this.emitStatus();
      return;
    }

    if (typeof message.id !== "string" && typeof message.id !== "number") return;
    const id = message.id;
    const pending = this.removePending(id);
    if (!pending) return;
    if (message.error && typeof message.error === "object") {
      const error = message.error as { code?: unknown; message?: unknown };
      pending.reject(new ProjectError("BACKEND_UNAVAILABLE", typeof error.message === "string" ? error.message : "Godot MCP tool failed", { route: pending.method, godotCode: error.code }));
    } else {
      pending.resolve(message.result);
    }
  }

  private onClose(socket: WebSocket): void {
    if (this.peer !== socket) return;
    this.peer = undefined;
    this.peerHandshake = false;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
    if (!this.closed) this.state = this.server ? "listening" : "stopped";
    for (const id of this.pending.keys()) {
      const pending = this.removePending(id);
      pending?.reject(new ProjectError("BACKEND_UNAVAILABLE", "Godot MCP addon disconnected", { projectPath: this.projectPath }));
    }
    this.emitStatus();
  }

  private removePending(id: string | number): PendingRequest | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.signal && pending.abort) pending.signal.removeEventListener("abort", pending.abort);
    return pending;
  }

  private emitStatus(): void {
    const status = this.getStatus();
    for (const listener of this.listeners) listener(status);
  }
}
