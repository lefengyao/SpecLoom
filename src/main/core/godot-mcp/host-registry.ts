import { realpathSync } from "node:fs";
import path from "node:path";
import { ProjectError } from "../errors";
import { getGodotMcpToolDefinition } from "./tool-definitions";
import { GodotMcpBridge, type GodotMcpBridgeOptions, type GodotMcpBridgeStatus } from "./bridge";
import { LogSnapshotStore, type LogLevel, type LogPage } from "./output-log";

const RECONNECT_HINT = "Open this project in Godot and enable the SpecLoom Godot MCP plugin, then reload the project.";
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
const MAX_SCREENSHOT_DIMENSION = 32_768;
const MAX_SCREENSHOT_PIXELS = 100_000_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface GodotMcpImageResult {
  mimeType: "image/png";
  base64: string;
  width: number;
  height: number;
}

export interface GodotMcpRegistryOptions {
  bridgeOptions?: GodotMcpBridgeOptions;
  createBridge?: (projectPath: string, options?: GodotMcpBridgeOptions) => GodotMcpBridge;
}

interface RegistryEntry {
  host: GodotMcpProjectHost;
  leases: number;
}

function pathKey(value: string): string {
  const normalized = path.resolve(value).replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function validateScreenshot(value: unknown, expectedTarget: "editor" | "game"): GodotMcpImageResult {
  const result = asObject(value);
  if (!result || result.success !== true || result.target !== expectedTarget || typeof result.image_base64 !== "string" ||
      typeof result.width !== "number" || typeof result.height !== "number") {
    throw new ProjectError("BACKEND_UNAVAILABLE", `Godot returned an invalid ${expectedTarget} screenshot response`, { reason: "invalid_screenshot" });
  }
  const base64 = result.image_base64;
  if (base64.length === 0 || base64.length > Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    throw new ProjectError("BACKEND_UNAVAILABLE", `Godot returned invalid or oversized ${expectedTarget} screenshot data`, { reason: "invalid_screenshot" });
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.byteLength > MAX_SCREENSHOT_BYTES || bytes.toString("base64") !== base64 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.byteLength < 24) {
    throw new ProjectError("BACKEND_UNAVAILABLE", `Godot returned invalid or oversized ${expectedTarget} PNG data`, { reason: "invalid_screenshot" });
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!Number.isSafeInteger(result.width) || !Number.isSafeInteger(result.height) || result.width !== width || result.height !== height ||
      width <= 0 || height <= 0 || width > MAX_SCREENSHOT_DIMENSION || height > MAX_SCREENSHOT_DIMENSION || width * height > MAX_SCREENSHOT_PIXELS) {
    throw new ProjectError("BACKEND_UNAVAILABLE", `Godot returned invalid ${expectedTarget} screenshot dimensions`, { reason: "invalid_screenshot" });
  }
  return { mimeType: "image/png", base64, width, height };
}

export class GodotMcpProjectHost {
  private startPromise: Promise<number> | undefined;
  private readonly logSnapshots = new LogSnapshotStore();

  constructor(readonly root: string, readonly bridge: GodotMcpBridge) {}

  start(): Promise<number> {
    this.startPromise ??= this.bridge.start().catch(error => { this.startPromise = undefined; throw error; });
    return this.startPromise;
  }

  status(): GodotMcpBridgeStatus { return this.bridge.getStatus(); }

  async call(name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const definition = getGodotMcpToolDefinition(name);
    if (!definition) throw new ProjectError("VALIDATION_FAILED", "Godot MCP tool is not registered", { name });
    const parsed = definition.schema.safeParse(input);
    if (!parsed.success) throw new ProjectError("VALIDATION_FAILED", "Godot MCP tool arguments do not match the registered schema", {
      paths: parsed.error.issues.map(issue => issue.path.map(String).join(".")).slice(0, 8),
    });
    const params = parsed.data as Record<string, unknown>;

    if (name === "get_output_log" && typeof params.cursor === "string") {
      return this.logSnapshots.pageFromCursor(params.cursor, params.direction as "older" | "newer" | undefined, {
        limit: Number(params.limit ?? 100), ...(params.levels ? { levels: params.levels as LogLevel[] } : {}),
      });
    }

    try { await this.start(); }
    catch (error) {
      if (name === "get_diagnostics") return this.offlineDiagnostics(error);
      throw error instanceof ProjectError ? error : new ProjectError("BACKEND_UNAVAILABLE", "Could not start the Godot MCP bridge", { projectPath: this.root }, { cause: error });
    }

    if (name === "get_diagnostics") {
      const status = this.status();
      if (!status.connected) return { bridge: status, plugin: { state: "unavailable" }, reconnect_hint: RECONNECT_HINT };
      try { return { bridge: this.status(), plugin: await this.bridge.call(definition.route, {}) }; }
      catch (error) { return { bridge: this.status(), plugin: { state: "unavailable", error: error instanceof Error ? error.message : String(error) }, reconnect_hint: RECONNECT_HINT }; }
    }
    if (!this.bridge.isConnected()) throw new ProjectError("BACKEND_UNAVAILABLE", `Godot MCP addon is disconnected. ${RECONNECT_HINT}`, { projectPath: this.root, route: definition.route });

    if (name === "get_output_log") {
      const result = asObject(await this.bridge.call(definition.route, {}, signal));
      if (!result || result.success !== true || result.source !== "editor_output" || typeof result.content !== "string") {
        const detail = typeof result?.error === "string" ? result.error : "Godot returned an invalid Output panel response";
        throw new ProjectError("BACKEND_UNAVAILABLE", detail, { route: definition.route });
      }
      const snapshot = this.logSnapshots.createSnapshot(result.content, result.history_truncated === true);
      return this.logSnapshots.latestPage(snapshot.id, { limit: Number(params.limit ?? 100), ...(params.levels ? { levels: params.levels as LogLevel[] } : {}) });
    }

    const result = await this.bridge.call(definition.route, params, signal);
    if (name === "get_editor_screenshot" || name === "get_game_screenshot") {
      return validateScreenshot(result, name === "get_editor_screenshot" ? "editor" : "game");
    }
    const object = asObject(result);
    if (object?.success === false) throw new ProjectError("BACKEND_UNAVAILABLE", typeof object.error === "string" ? object.error : "Godot MCP tool returned an error", { route: definition.route });
    return result;
  }

  async close(): Promise<void> { this.startPromise = undefined; await this.bridge.close(); }

  private offlineDiagnostics(cause: unknown): Record<string, unknown> {
    return { bridge: this.status(), plugin: { state: "unavailable", error: cause instanceof Error ? cause.message : String(cause) }, reconnect_hint: RECONNECT_HINT };
  }
}

export class GodotMcpHostRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly createBridge: NonNullable<GodotMcpRegistryOptions["createBridge"]>;

  constructor(private readonly options: GodotMcpRegistryOptions = {}) {
    this.createBridge = options.createBridge ?? ((projectPath, bridgeOptions) => new GodotMcpBridge(projectPath, bridgeOptions));
  }

  forProject(root: string): GodotMcpProjectHost {
    const canonical = this.canonicalRoot(root);
    const key = pathKey(canonical);
    let entry = this.entries.get(key);
    if (!entry) {
      const bridge = this.createBridge(canonical, this.options.bridgeOptions);
      entry = { host: new GodotMcpProjectHost(canonical, bridge), leases: 0 };
      this.entries.set(key, entry);
    }
    return entry.host;
  }

  async acquire(root: string): Promise<GodotMcpProjectHost> {
    const host = this.forProject(root);
    const entry = this.entries.get(pathKey(host.root))!;
    entry.leases++;
    try { await host.start(); return host; }
    catch (error) { entry.leases--; throw error; }
  }

  async release(root: string): Promise<void> {
    let key: string;
    try { key = pathKey(this.canonicalRoot(root)); }
    catch { key = pathKey(root); }
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.leases = Math.max(0, entry.leases - 1);
    if (entry.leases > 0) return;
    this.entries.delete(key);
    await entry.host.close();
  }

  async call(root: string, name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return this.forProject(root).call(name, input, signal);
  }

  status(root: string): GodotMcpBridgeStatus {
    const canonical = this.canonicalRoot(root);
    return this.entries.get(pathKey(canonical))?.host.status() ?? {
      state: "stopped", connected: false, projectPath: canonical, port: null, pendingRequests: 0,
    };
  }

  async closeAll(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(entries.map(entry => entry.host.close()));
  }

  private canonicalRoot(root: string): string {
    try { return realpathSync.native(root); }
    catch (error) { throw new ProjectError("INVALID_PROJECT", "Godot MCP project root is unavailable", { root }, { cause: error }); }
  }
}

/** One service registry shared by the desktop host, Hub windows, Agent sessions and inbound MCP. */
export const godotMcpHostRegistry = new GodotMcpHostRegistry();
