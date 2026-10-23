import { cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PLUGIN_API_VERSION,
  PluginInventorySchema,
  PluginManifestSchema,
  type PluginInventory,
  type PluginManifest,
  type PluginSummary,
} from "../../../shared/plugins";
import { ProjectError } from "../errors";
import { PluginHost } from "../../plugins/plugin-host";
import { PluginRpcError } from "../../plugins/plugin-rpc";

interface PluginRecord {
  manifest: PluginManifest;
  root: string;
  source: "builtin" | "user";
  enabled: boolean;
  error?: string;
  host?: PluginHost | undefined;
  commands: string[];
}
interface PluginState { version: 1; enabled: Record<string, boolean> }
export interface PluginManagerOptions {
  builtinDirectory: string;
  userDataDirectory: string;
  getProjectPath: () => string | undefined;
  childPath: string;
  logDirectory: string;
}

const MAX_PLUGIN_FILE = 512 * 1024;
const STATE_VERSION = 1;
const STORAGE_KEY = /^[A-Za-z0-9._:-]{1,128}$/u;
const STORAGE_VALUE_BYTES = 256 * 1024;
const SYNC_COMMANDS = new Set(["fetch", "pull", "push"]);

function safeId(value: string): string { return value.replace(/[^a-z0-9._-]/giu, "_"); }
function statePath(root: string): string { return path.join(root, "plugins-state.json"); }
function storagePath(root: string, id: string): string { return path.join(root, "plugin-storage", `${safeId(id)}.json`); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export class PluginManager {
  private readonly records = new Map<string, PluginRecord>();
  private readonly stateFile: string;
  private readonly storageQueues = new Map<string, Promise<void>>();
  private closed = false;

  constructor(private readonly options: PluginManagerOptions) { this.stateFile = statePath(options.userDataDirectory); }

  async list(): Promise<PluginInventory> {
    if (!this.records.size) await this.discover();
    await this.activateEnabled();
    return PluginInventorySchema.parse({ trusted: true, plugins: [...this.records.values()].map((record) => this.summary(record)) });
  }

  async setEnabled(id: string, enabled: boolean): Promise<PluginInventory> {
    if (!this.records.size) await this.discover();
    const record = this.records.get(id);
    if (!record) throw new ProjectError("VALIDATION_FAILED", "插件不存在");
    if (record.enabled === enabled && (enabled ? !!record.host : !record.host)) return this.list();
    record.enabled = enabled;
    delete record.error;
    if (enabled) {
      try { await this.activate(record); }
      catch (error) { record.error = message(error); record.enabled = false; }
    } else await this.deactivate(record);
    await this.saveState();
    return this.list();
  }

  async invoke(id: string, command: string, input?: unknown): Promise<unknown> {
    if (!this.records.size) await this.discover();
    const record = this.records.get(id);
    if (!record) throw new ProjectError("VALIDATION_FAILED", "插件不存在");
    if (!record.enabled) throw new ProjectError("VALIDATION_FAILED", "插件未启用");
    if (record.error) throw new ProjectError("BACKEND_UNAVAILABLE", record.error);
    await this.activateEnabled();
    if (!record.host) throw new ProjectError("BACKEND_UNAVAILABLE", "插件进程未运行");
    const projectPath = this.options.getProjectPath();
    if (!projectPath) throw new ProjectError("INVALID_PROJECT", "请先打开项目");
    try {
      return await record.host.request("invoke", { command, input, projectPath }, this.timeoutFor(command));
    } catch (error) {
      throw new ProjectError("COMMAND_FAILED", message(error));
    }
  }

  async installDirectory(source: string): Promise<PluginInventory> {
    const manifest = await this.readManifest(source);
    if (this.records.get(manifest.id)?.source === "builtin") throw new ProjectError("VALIDATION_FAILED", "不能覆盖内置插件");
    const target = path.join(this.options.userDataDirectory, "plugins", manifest.id);
    await rm(target, { recursive: true, force: true });
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, errorOnExist: false, force: true });
    await this.discover();
    return this.list();
  }

  async uninstall(id: string): Promise<PluginInventory> {
    if (!this.records.size) await this.discover();
    const record = this.records.get(id);
    if (!record) throw new ProjectError("VALIDATION_FAILED", "插件不存在");
    if (record.source === "builtin") throw new ProjectError("VALIDATION_FAILED", "内置插件不能卸载");
    await this.deactivate(record);
    await rm(record.root, { recursive: true, force: true });
    this.records.delete(id);
    await this.saveState();
    return this.list();
  }

  async revealTarget(id: string): Promise<string> {
    if (!this.records.size) await this.discover();
    const record = this.records.get(id);
    if (!record) throw new ProjectError("VALIDATION_FAILED", "插件不存在");
    return record.root;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const record of this.records.values()) await this.deactivate(record);
  }

  private async discover(): Promise<void> {
    this.records.clear();
    await this.scanDirectory(this.options.builtinDirectory, "builtin");
    await this.scanDirectory(path.join(this.options.userDataDirectory, "plugins"), "user");
    const state = await this.readState();
    for (const record of this.records.values()) {
      record.enabled = state.enabled[record.manifest.id] ?? (record.source === "builtin" && record.manifest.enabledByDefault !== false);
    }
  }

  private async scanDirectory(root: string, source: "builtin" | "user"): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const directory = path.join(root, entry.name);
      try {
        const manifest = await this.readManifest(directory);
        if (this.records.has(manifest.id)) continue;
        this.records.set(manifest.id, { manifest, root: directory, source, enabled: false, commands: [] });
      } catch (error) {
        this.records.set(`invalid:${source}:${entry.name}`, {
          manifest: { id: "invalid", name: entry.name, version: "0", apiVersion: PLUGIN_API_VERSION, main: "" }, root: directory,
          source, enabled: false, commands: [], error: message(error),
        });
      }
    }
  }

  private async readManifest(directory: string): Promise<PluginManifest> {
    const file = path.join(directory, "plugin.json");
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PLUGIN_FILE) throw new ProjectError("VALIDATION_FAILED", "plugin.json 不可用");
    return PluginManifestSchema.parse(JSON.parse(await readFile(file, "utf8")));
  }

  private async activateEnabled(): Promise<void> {
    if (this.closed) return;
    for (const record of this.records.values()) {
      if (!record.enabled || record.host || record.error) continue;
      await this.activate(record).catch((error) => { record.error = message(error); });
    }
  }

  private async activate(record: PluginRecord): Promise<void> {
    if (record.host) return;
    if (!record.manifest.main) throw new ProjectError("VALIDATION_FAILED", "插件缺少 main 入口");
    const root = await realpath(record.root);
    const resolved = await realpath(path.resolve(record.root, record.manifest.main));
    if (!resolved.startsWith(root + path.sep)) throw new ProjectError("PATH_ESCAPE", "插件入口路径不安全");
    const host = new PluginHost({
      pluginId: record.manifest.id,
      version: record.manifest.version,
      root: record.root,
      entry: resolved,
      childPath: this.options.childPath,
      logDir: this.options.logDirectory,
      onRequest: (method, params) => this.handleHostRequest(record.manifest.id, method, params),
      onFailure: (error) => { record.error = message(error); record.host = undefined; },
    });
    record.commands = await host.start();
    record.host = host;
    delete record.error;
  }

  private async deactivate(record: PluginRecord): Promise<void> {
    const host = record.host;
    record.host = undefined;
    record.commands = [];
    if (host) await host.stop();
  }

  private async handleHostRequest(pluginId: string, method: string, params: unknown): Promise<unknown> {
    if (method === "storage.get") return this.storageGet(pluginId, storageKey(params));
    if (method === "storage.set") return this.storageSet(pluginId, storageKey(params), storageValue(params));
    if (method === "storage.delete") return this.storageDelete(pluginId, storageKey(params));
    throw new PluginRpcError("METHOD_NOT_FOUND", `Unsupported plugin host request: ${method}`);
  }

  private async storageGet(pluginId: string, key: string): Promise<unknown> {
    const data = await this.readStorage(pluginId);
    return data[key];
  }

  private async storageSet(pluginId: string, key: string, value: unknown): Promise<void> {
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    if (bytes > STORAGE_VALUE_BYTES) throw new PluginRpcError("LIMIT_EXCEEDED", "Plugin storage value is too large");
    await this.withStorage(pluginId, async () => {
      const data = await this.readStorage(pluginId);
      data[key] = value;
      await this.writeStorage(pluginId, data);
    });
  }

  private async storageDelete(pluginId: string, key: string): Promise<void> {
    await this.withStorage(pluginId, async () => {
      const data = await this.readStorage(pluginId);
      delete data[key];
      await this.writeStorage(pluginId, data);
    });
  }

  private async withStorage(pluginId: string, action: () => Promise<void>): Promise<void> {
    const previous = this.storageQueues.get(pluginId) ?? Promise.resolve();
    const next = previous.then(action, action);
    this.storageQueues.set(pluginId, next.catch(() => undefined));
    await next;
  }

  private async readStorage(pluginId: string): Promise<Record<string, unknown>> {
    try {
      const value = JSON.parse(await readFile(storagePath(this.options.userDataDirectory, pluginId), "utf8")) as unknown;
      return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    } catch { return {}; }
  }

  private async writeStorage(pluginId: string, data: Record<string, unknown>): Promise<void> {
    const target = storagePath(this.options.userDataDirectory, pluginId);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(data), "utf8");
  }

  private timeoutFor(command: string): number { return SYNC_COMMANDS.has(command) ? 300_000 : 120_000; }

  private summary(record: PluginRecord): PluginSummary {
    const invalid = record.manifest.id === "invalid";
    return {
      id: record.manifest.id, name: record.manifest.name, version: record.manifest.version,
      ...(record.manifest.description ? { description: record.manifest.description } : {}),
      ...(record.manifest.author ? { author: record.manifest.author } : {}),
      official: record.manifest.official === true, source: record.source,
      enabled: record.enabled,
      status: invalid || record.error ? "error" : record.enabled && record.host ? "ready" : record.enabled ? "disabled" : "disabled",
      ...(record.error ? { error: record.error } : {}),
      nativePages: record.manifest.nativePages ?? [],
    };
  }

  private async readState(): Promise<PluginState> {
    try {
      const parsed = JSON.parse(await readFile(this.stateFile, "utf8")) as Partial<PluginState>;
      return { version: STATE_VERSION, enabled: parsed.enabled && typeof parsed.enabled === "object" ? parsed.enabled : {} };
    } catch { return { version: STATE_VERSION, enabled: {} }; }
  }

  private async saveState(): Promise<void> {
    await mkdir(path.dirname(this.stateFile), { recursive: true });
    const enabled = Object.fromEntries([...this.records.values()].filter((record) => record.manifest.id !== "invalid").map((record) => [record.manifest.id, record.enabled]));
    await writeFile(this.stateFile, JSON.stringify({ version: STATE_VERSION, enabled }), "utf8");
  }
}

function storageKey(params: unknown): string {
  const key = params && typeof params === "object" && "key" in params ? (params as { key?: unknown }).key : undefined;
  if (typeof key !== "string" || !STORAGE_KEY.test(key)) throw new PluginRpcError("VALIDATION_FAILED", "Plugin storage key is invalid");
  return key;
}
function storageValue(params: unknown): unknown {
  if (!params || typeof params !== "object" || !("value" in params)) throw new PluginRpcError("VALIDATION_FAILED", "Plugin storage value is missing");
  return (params as { value?: unknown }).value;
}
