import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  PLUGIN_API_VERSION,
  PluginInventorySchema,
  PluginManifestSchema,
  PluginPageSummarySchema,
  type PluginInventory,
  type PluginManifest,
  type PluginSummary,
} from "../../../shared/plugins";
import { ProjectError } from "../errors";

type CommandContext = { projectPath: string };
type CommandHandler = (input: unknown, context: CommandContext) => unknown | Promise<unknown>;
interface PluginRecord {
  manifest: PluginManifest;
  root: string;
  source: "builtin" | "user";
  enabled: boolean;
  active: boolean;
  error?: string;
  moduleUrl?: string;
  commands: Map<string, CommandHandler>;
}
interface PluginState { version: 1; enabled: Record<string, boolean> }
export interface PluginManagerOptions {
  builtinDirectory: string;
  userDataDirectory: string;
  getProjectPath: () => string | undefined;
  storage?: (pluginId: string) => { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };
}

const MAX_PLUGIN_FILE = 512 * 1024;
const STATE_VERSION = 1;

function safeId(value: string): string {
  return value.replace(/[^a-z0-9._-]/giu, "_");
}
function statePath(root: string): string { return path.join(root, "plugins-state.json"); }
function storagePath(root: string, id: string): string { return path.join(root, "plugin-storage", `${safeId(id)}.json`); }

export class PluginManager {
  private readonly records = new Map<string, PluginRecord>();
  private readonly stateFile: string;
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
    if (record.enabled === enabled) return this.list();
    record.enabled = enabled;
    delete record.error;
    if (enabled) await this.activate(record).catch((error) => { record.error = message(error); record.enabled = false; });
    else await this.deactivate(record);
    await this.saveState();
    return this.list();
  }

  async invoke(id: string, command: string, input?: unknown): Promise<unknown> {
    if (!this.records.size) await this.discover();
    const record = this.records.get(id);
    if (!record) throw new ProjectError("VALIDATION_FAILED", "插件不存在");
    if (!record.enabled) throw new ProjectError("VALIDATION_FAILED", "插件未启用");
    await this.activateEnabled();
    const handler = record.commands.get(command);
    if (!handler) throw new ProjectError("VALIDATION_FAILED", `插件命令不存在: ${command}`);
    const projectPath = this.options.getProjectPath();
    if (!projectPath) throw new ProjectError("INVALID_PROJECT", "请先打开项目");
    return await handler(input, { projectPath });
  }

  async resolvePage(id: string, pageId: string): Promise<string> {
    if (!this.records.size) await this.discover();
    const record = this.records.get(id);
    if (!record?.enabled) throw new ProjectError("VALIDATION_FAILED", "插件未启用");
    const page = record.manifest.contributes?.pages?.find((item) => item.id === pageId);
    if (!page) throw new ProjectError("VALIDATION_FAILED", "插件页面不存在");
    return this.resolvePluginFile(record, page.entry);
  }

  async resolvePageAsset(id: string, pageId: string, asset: string): Promise<string> {
    if (!this.records.size) await this.discover();
    const record = this.records.get(id);
    if (!record?.enabled) throw new ProjectError("VALIDATION_FAILED", "插件未启用");
    const page = record.manifest.contributes?.pages?.find((item) => item.id === pageId);
    if (!page) throw new ProjectError("VALIDATION_FAILED", "插件页面不存在");
    if (!asset || asset.includes("\\") || asset.split("/").some((segment) => !segment || segment === ".." || segment === ".")) throw new ProjectError("PATH_ESCAPE", "插件资源路径不安全");
    return this.resolvePluginFile(record, path.posix.join(path.posix.dirname(page.entry), asset));
  }

  private async resolvePluginFile(record: PluginRecord, relative: string): Promise<string> {
    const root = await realpath(record.root);
    const target = await realpath(path.resolve(record.root, relative)).catch(() => undefined);
    if (!target || !target.startsWith(root + path.sep)) throw new ProjectError("PATH_ESCAPE", "插件文件路径不安全");
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PLUGIN_FILE) throw new ProjectError("VALIDATION_FAILED", "插件文件不可用");
    return target;
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
        this.records.set(manifest.id, { manifest, root: directory, source, enabled: false, active: false, commands: new Map() });
      } catch (error) {
        this.records.set(`invalid:${source}:${entry.name}`, {
          manifest: { id: "invalid", name: entry.name, version: "0", apiVersion: PLUGIN_API_VERSION }, root: directory,
          source, enabled: false, active: false, commands: new Map(), error: message(error),
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
      if (!record.enabled || record.active || record.error || !record.manifest.main) continue;
      await this.activate(record).catch((error) => { record.error = message(error); record.enabled = false; });
    }
  }

  private async activate(record: PluginRecord): Promise<void> {
    if (record.active) return;
    if (!record.manifest.main) { record.active = true; return; }
    const entry = path.resolve(record.root, record.manifest.main);
    const root = await realpath(record.root);
    const resolved = await realpath(entry);
    if (!resolved.startsWith(root + path.sep)) throw new ProjectError("PATH_ESCAPE", "插件入口路径不安全");
    const moduleUrl = pathToFileURL(resolved).href;
    record.moduleUrl = moduleUrl;
    const pluginModule = await import(moduleUrl) as {
      activate?: (context: unknown) => unknown | Promise<unknown>;
    };
    if (typeof pluginModule.activate !== "function") throw new ProjectError("VALIDATION_FAILED", "插件缺少 activate 导出");
    record.commands.clear();
    await pluginModule.activate({
      apiVersion: PLUGIN_API_VERSION,
      pluginId: record.manifest.id,
      projectPath: () => this.options.getProjectPath(),
      commands: { register: (name: string, handler: CommandHandler) => { record.commands.set(name, handler); } },
      storage: this.options.storage?.(record.manifest.id) ?? this.defaultStorage(record.manifest.id),
      log: (message: string, details?: unknown) => console.info(`[plugin:${record.manifest.id}]`, message, details ?? ""),
    });
    record.active = true;
    delete record.error;
  }

  private async deactivate(record: PluginRecord): Promise<void> {
    if (!record.active) return;
    try {
      if (record.moduleUrl) {
        const pluginModule = await import(record.moduleUrl) as { deactivate?: () => unknown | Promise<unknown> };
        await pluginModule.deactivate?.();
      }
    } finally {
      record.commands.clear();
      record.active = false;
    }
  }

  private defaultStorage(pluginId: string) {
    return {
      get: async (key: string): Promise<unknown> => {
        try {
          const data = JSON.parse(await readFile(storagePath(this.options.userDataDirectory, pluginId), "utf8")) as Record<string, unknown>;
          return data[key];
        } catch { return undefined; }
      },
      set: async (key: string, value: unknown): Promise<void> => {
        const target = storagePath(this.options.userDataDirectory, pluginId);
        await mkdir(path.dirname(target), { recursive: true });
        let data: Record<string, unknown> = {};
        try { data = JSON.parse(await readFile(target, "utf8")) as Record<string, unknown>; } catch { /* start empty */ }
        data[key] = value;
        await writeFile(target, JSON.stringify(data).slice(0, 256 * 1024), "utf8");
      },
    };
  }

  private summary(record: PluginRecord): PluginSummary {
    const invalid = record.manifest.id === "invalid";
    return {
      id: record.manifest.id, name: record.manifest.name, version: record.manifest.version,
      ...(record.manifest.description ? { description: record.manifest.description } : {}),
      ...(record.manifest.author ? { author: record.manifest.author } : {}),
      official: record.manifest.official === true, source: record.source,
      enabled: record.enabled, status: invalid ? "error" : record.error ? "error" : record.enabled ? "ready" : "disabled",
      ...(record.error ? { error: record.error } : {}),
      pages: (record.manifest.contributes?.pages ?? []).map((page) => PluginPageSummarySchema.parse({ ...page, pageId: `${record.manifest.id}:${page.id}` })),
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
