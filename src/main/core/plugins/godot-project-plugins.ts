import * as fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  GodotPluginIdSchema,
  RevealPluginDirectoryInputSchema,
  type GodotPluginEntry,
  type PluginInventory,
} from "../../../shared/godot-plugins";
import { GodotMcpInstaller } from "./godot-mcp-installer";
import { verifyGodotMcpBundle, defaultGodotMcpResourceRoot, type GodotMcpBundleManifest } from "../godot-mcp/bundle";
import type { GodotMcpBridgeStatus } from "../godot-mcp/bridge";
import { ProjectError } from "../errors";
import { PathPolicy } from "../path-policy";
import { defaultFileSystem, decodeText, hasCode } from "../store-fs";

const PROJECT_FILE_LIMIT = 1_048_576;
const PLUGIN_FILE_LIMIT = 65_536;
const MAX_ADDON_FILE_BYTES = 8 * 1024 * 1024;
const PLUGIN_SCAN_LIMIT = 512;
const ENABLED_PLUGIN_LIMIT = 1_024;
const GODOT_MCP_PLUGIN_ID = "addons/godot_mcp/plugin.cfg";
const GODOT_MCP_MARKER = "addons/godot_mcp/.specloom-managed.json";
const GODOT_MCP_PREFIX = "addons/godot_mcp/";

type ConfigSetting = { present: boolean; value?: string };

/** Reads plugin metadata as data only. No Godot code or plugin script is loaded. */
export class GodotProjectPluginManager {
  private readonly policy: PathPolicy;

  constructor(readonly root: string, private readonly resourceRoot = defaultGodotMcpResourceRoot(), private readonly getConnection: () => GodotMcpBridgeStatus | undefined = () => undefined) {
    this.policy = new PathPolicy(root, defaultFileSystem);
  }

  async list(): Promise<PluginInventory> {
    const projectPath = await this.policy.resolve("project.godot", true);
    const projectBytes = await this.readBytes(projectPath, PROJECT_FILE_LIMIT);
    if (!projectBytes) throw new ProjectError("INVALID_PROJECT", "Godot project.godot was not found");
    const project = decodeText(projectBytes, PROJECT_FILE_LIMIT);
    if (!/(?:^|\r?\n)\s*config_version\s*=\s*5\s*(?:#.*)?(?:\r?\n|$)/u.test(project)) {
      throw new ProjectError("INVALID_PROJECT", "Godot 4 project.godot with config_version=5 is required");
    }

    const enabledSetting = findSetting(project, "editor_plugins", "enabled");
    const enabledIds = parseEnabledPluginIds(enabledSetting);
    const pluginRows = new Map<string, GodotPluginEntry>();
    let scanLimitReached = false;
    const addonsPath = await this.policy.resolve("addons", true);
    try {
      const addonsStat = await fs.lstat(addonsPath);
      if (addonsStat.isSymbolicLink() || !addonsStat.isDirectory()) {
        throw new ProjectError("PATH_ESCAPE", "The addons directory must be a real directory");
      }
      const addonDirectories = (await fs.readdir(addonsPath, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b, "en"));
      if (addonDirectories.length > PLUGIN_SCAN_LIMIT) scanLimitReached = true;
      for (const addonName of addonDirectories.slice(0, PLUGIN_SCAN_LIMIT)) {
        let id: string;
        try { id = GodotPluginIdSchema.parse(`addons/${addonName}/plugin.cfg`); }
        catch { continue; }
        if (id === GODOT_MCP_PLUGIN_ID || id === "addons/specloom_capture/plugin.cfg") continue;
        const directory = path.join(addonsPath, addonName);
        let directoryStat: Awaited<ReturnType<typeof fs.lstat>>;
        try { directoryStat = await fs.lstat(directory); }
        catch (error) { if (hasCode(error, "ENOENT")) continue; throw error; }
        if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory() || await isReparsePoint(directory)) continue;
        const configPath = path.join(directory, "plugin.cfg");
        let configStat: Awaited<ReturnType<typeof fs.lstat>>;
        try { configStat = await fs.lstat(configPath); }
        catch (error) { if (hasCode(error, "ENOENT")) continue; throw error; }
        if (configStat.isSymbolicLink() || !configStat.isFile() || await isReparsePoint(configPath)) continue;
        let bytes: Buffer | undefined;
        try { bytes = await this.readBytes(configPath, PLUGIN_FILE_LIMIT); }
        catch (error) {
          if (!(error instanceof ProjectError) || error.code !== "VALIDATION_FAILED") throw error;
          pluginRows.set(id, invalidPlugin(id, addonName));
          continue;
        }
        if (!bytes) continue;
        pluginRows.set(id, parsePluginConfig(id, addonName, bytes));
      }
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }

    // Enabled entries are authoritative for detecting stale references, even if
    // the corresponding addon directory was deleted or is outside the scan cap.
    for (const id of enabledIds) {
      if (id === GODOT_MCP_PLUGIN_ID || id === "addons/specloom_capture/plugin.cfg" || pluginRows.has(id)) continue;
      const folder = id.slice("addons/".length, -"/plugin.cfg".length);
      pluginRows.set(id, {
        id: GodotPluginIdSchema.parse(id),
        name: folder,
        enabled: true,
        metadataValid: false,
        issue: "missing_config",
      });
    }

    const godotMcp = await this.inspectGodotMcp(project, enabledIds);
    return {
      godotMcp,
      plugins: [...pluginRows.values()]
        .map((plugin) => ({ ...plugin, enabled: enabledIds.includes(plugin.id) }))
        .sort((a, b) => a.name.localeCompare(b.name, "en") || a.id.localeCompare(b.id, "en")),
      scanLimitReached,
    };
  }

  async setEnabled(idInput: string, enabled: boolean): Promise<{ restartRequired: boolean }> {
    const id = GodotPluginIdSchema.parse(idInput);
    if (id === GODOT_MCP_PLUGIN_ID) throw new ProjectError("VALIDATION_FAILED", "Manage the official Godot MCP plugin through its dedicated installer");
    const baseline = await this.readProjectSettings();
    const enabledSetting = findSetting(baseline.text, "editor_plugins", "enabled");
    const references = parsePackedStringArray(enabledSetting);
    const reference = `res://${id}`;
    const alreadyEnabled = references.includes(reference);
    if (enabled) {
      const inventory = await this.list();
      const plugin = inventory.plugins.find((item) => item.id === id);
      if (!plugin?.metadataValid) throw new ProjectError("VALIDATION_FAILED", "Only an installed plugin with valid metadata can be enabled");
    }
    if (alreadyEnabled === enabled) return { restartRequired: false };
    const nextReferences = enabled ? [...references, reference] : references.filter((item) => item !== reference);
    const next = writeSetting(baseline.text, "editor_plugins", "enabled", `PackedStringArray(${nextReferences.map(quoteGodotString).join(", ")})`);
    await this.writeProjectSettings(baseline.bytes, next);
    return { restartRequired: true };
  }

  async installGodotMcp(): Promise<{ restartRequired: boolean; installedVersion: string; changedPaths: string[] }> {
    return new GodotMcpInstaller(this.root, this.resourceRoot).installAndEnable();
  }

  async setGodotMcpEnabled(enabled: boolean): Promise<{ restartRequired: boolean }> {
    return new GodotMcpInstaller(this.root, this.resourceRoot).setEnabled(enabled);
  }

  async resolveRevealTarget(targetInput: string): Promise<string> {
    const target = RevealPluginDirectoryInputSchema.parse({ target: targetInput }).target;
    const root = await this.policy.validateRoot();
    if (target === "project") return root;
    if (target !== "godot-mcp" && !(await this.list()).plugins.some((plugin) => plugin.id === target)) {
      throw new ProjectError("VALIDATION_FAILED", "Plugin directory target is not present in the current project inventory");
    }
    const relative = target === "godot-mcp" ? "addons/godot_mcp" : target.slice(0, -"/plugin.cfg".length);
    try {
      const resolved = await this.policy.resolve(relative, true);
      const stats = await fs.lstat(resolved);
      if (stats.isSymbolicLink() || !stats.isDirectory() || await isReparsePoint(resolved)) throw new ProjectError("PATH_ESCAPE", "Plugin directory is not a safe directory");
      return resolved;
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        const addons = await this.policy.resolve("addons", true);
        try {
          const stats = await fs.lstat(addons);
          if (stats.isDirectory() && !stats.isSymbolicLink() && !(await isReparsePoint(addons))) return addons;
        } catch (parentError) { if (!hasCode(parentError, "ENOENT")) throw parentError; }
        return root;
      }
      throw error;
    }
  }

  private async readProjectSettings(): Promise<{ bytes: Buffer; text: string }> {
    const target = await this.policy.resolve("project.godot", true);
    const bytes = await this.readBytes(target, PROJECT_FILE_LIMIT);
    if (!bytes) throw new ProjectError("INVALID_PROJECT", "Godot project.godot was not found");
    const text = decodeText(bytes, PROJECT_FILE_LIMIT);
    if (!/(?:^|\r?\n)\s*config_version\s*=\s*5\s*(?:#.*)?(?:\r?\n|$)/u.test(text)) {
      throw new ProjectError("INVALID_PROJECT", "Godot 4 project.godot with config_version=5 is required");
    }
    return { bytes, text };
  }

  private async writeProjectSettings(expected: Buffer, content: string): Promise<void> {
    if (Buffer.byteLength(content, "utf8") > PROJECT_FILE_LIMIT) throw new ProjectError("VALIDATION_FAILED", "Updated project settings would exceed the supported size");
    const target = await this.policy.resolve("project.godot", true);
    const temporaryRelative = `project.godot.${randomUUID()}.tmp`;
    const temporary = await this.policy.resolve(temporaryRelative, true);
    try {
      await fs.writeFile(temporary, content, { flag: "wx" });
      const current = await this.readBytes(target, PROJECT_FILE_LIMIT);
      if (!current || !expected.equals(current)) throw new ProjectError("VERSION_CONFLICT", "project.godot changed while updating plugin settings");
      await this.policy.assertSafe(target, true);
      await fs.rename(temporary, target);
    } finally {
      try { await fs.unlink(temporary); } catch { /* Preserve the write error; an orphan temp file is recoverable. */ }
    }
  }

  private async inspectGodotMcp(project: string, enabledIds: string[]): Promise<PluginInventory["godotMcp"]> {
    const enabled = enabledIds.includes(GODOT_MCP_PLUGIN_ID);
    const connected = this.getConnection()?.connected === true;
    let manifest: GodotMcpBundleManifest;
    try { manifest = await verifyGodotMcpBundle(this.resourceRoot); }
    catch { return { status: "conflict", enabled, connected, issue: "bundle_unavailable" }; }
    let present = 0;
    const markerPath = await this.policy.resolve(GODOT_MCP_MARKER, true);
    let marker: { schemaVersion?: number; sourceVersion?: string; files?: Record<string, string> } | undefined;
    try { marker = JSON.parse((await this.readBytes(markerPath, 1_048_576))?.toString("utf8") ?? "") as typeof marker; }
    catch { marker = undefined; }
    const files = Object.entries(manifest.files).filter(([name]) => name.startsWith(GODOT_MCP_PREFIX));
    for (const [relative, expected] of files) {
      let bytes: Buffer | undefined;
      try { bytes = await this.readBytes(await this.policy.resolve(relative, true), MAX_ADDON_FILE_BYTES); }
      catch (error) {
        if (error instanceof ProjectError && ["PATH_ESCAPE", "VALIDATION_FAILED"].includes(error.code)) return { status: "conflict", enabled, connected, issue: "files_modified" };
        throw error;
      }
      if (!bytes) continue;
      present++;
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (hash !== expected.packagedSha256 && hash !== expected.upstreamSha256 && hash !== marker?.files?.[relative]) return { status: "conflict", enabled, connected, issue: "files_modified" };
    }
    if (present === 0) return { status: "missing", enabled, connected };
    if (present !== files.length || marker?.schemaVersion !== 1) return { status: "conflict", enabled, connected, issue: "metadata_invalid" };
    const oldAutoload = findSetting(project, "autoload", "SpecLoomCapture");
    if (oldAutoload.present && oldAutoload.value !== '"*res://addons/specloom_capture/runtime.gd"') return { status: "conflict", enabled, connected, issue: "project_setting_conflict" };
    return { status: "ready", installedVersion: marker?.sourceVersion ?? manifest.source.version, enabled, connected };
  }

  private async readBytes(target: string, limit: number): Promise<Buffer | undefined> {
    try {
      const handle = await fs.open(target, "r");
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > limit) {
          throw new ProjectError("VALIDATION_FAILED", "Plugin metadata file exceeds the supported size", { limit });
        }
        const bytes = await handle.readFile();
        if (bytes.length > limit) throw new ProjectError("VALIDATION_FAILED", "Plugin metadata file exceeds the supported size", { limit });
        return bytes;
      } finally { await handle.close(); }
    } catch (error) {
      if (hasCode(error, "ENOENT")) return undefined;
      throw error;
    }
  }
}

function findSetting(source: string, section: string, key: string): ConfigSetting {
  let active = false;
  let found: ConfigSetting | undefined;
  for (const line of source.split(/\r?\n/u)) {
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/u.exec(line);
    if (header) { active = header[1] === section; continue; }
    if (!active) continue;
    const equals = line.indexOf("=");
    if (equals < 0 || line.slice(0, equals).trim() !== key) continue;
    if (found) throw new ProjectError("VALIDATION_FAILED", `Godot project settings contain duplicate ${section}/${key} entries`);
    found = { present: true, value: line.slice(equals + 1).trim() };
  }
  return found ?? { present: false };
}

function parseEnabledPluginIds(setting: ConfigSetting): string[] {
  return parsePackedStringArray(setting).flatMap((item) => {
    const prefix = "res://";
    if (!item.startsWith(prefix)) return [];
    const id = item.slice(prefix.length);
    return GodotPluginIdSchema.safeParse(id).success ? [id] : [];
  });
}

function parsePackedStringArray(setting: ConfigSetting): string[] {
  if (!setting.present || !setting.value) return [];
  const value = stripTrailingComment(setting.value);
  const match = /^PackedStringArray\s*\(([\s\S]*)\)$/u.exec(value);
  if (!match) throw new ProjectError("VALIDATION_FAILED", "Godot editor plugin setting must be a PackedStringArray");
  const items = parseStringArray(match[1]!);
  if (items.length > ENABLED_PLUGIN_LIMIT) throw new ProjectError("VALIDATION_FAILED", "Godot editor plugin setting contains too many entries");
  return items;
}

function parseStringArray(source: string): string[] {
  const values: string[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    while (/\s/u.test(source[cursor] ?? "")) cursor++;
    if (cursor >= source.length) break;
    if (source[cursor] !== '"') throw new ProjectError("VALIDATION_FAILED", "Godot editor plugin setting contains unsupported syntax");
    const start = cursor++;
    let escaped = false;
    while (cursor < source.length) {
      const char = source[cursor++]!;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') break;
    }
    if (source[cursor - 1] !== '"') throw new ProjectError("VALIDATION_FAILED", "Godot editor plugin setting contains an unterminated string");
    try {
      const item = JSON.parse(source.slice(start, cursor)) as unknown;
      if (typeof item !== "string" || item.length > 512) throw new Error("Unsupported item");
      values.push(item);
    } catch { throw new ProjectError("VALIDATION_FAILED", "Godot editor plugin setting contains an invalid string"); }
    while (/\s/u.test(source[cursor] ?? "")) cursor++;
    if (cursor === source.length) break;
    if (source[cursor] !== ",") throw new ProjectError("VALIDATION_FAILED", "Godot editor plugin setting contains unsupported syntax");
    cursor++;
  }
  return values;
}

function stripTrailingComment(value: string): string {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (escaped) escaped = false;
    else if (quoted && char === "\\") escaped = true;
    else if (char === '"') quoted = !quoted;
    else if (!quoted && char === "#") return value.slice(0, index).trimEnd();
  }
  return value;
}

function parsePluginConfig(id: string, folder: string, bytes: Buffer): GodotPluginEntry {
  const fallback = invalidPlugin(id, folder);
  let source: string;
  try { source = decodeText(bytes, PLUGIN_FILE_LIMIT); } catch { return fallback; }
  let active = false;
  const values = new Map<string, string>();
  for (const line of source.split(/\r?\n/u)) {
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/u.exec(line);
    if (header) { active = header[1] === "plugin"; continue; }
    if (!active || /^\s*(?:#|;|$)/u.test(line)) continue;
    const equals = line.indexOf("=");
    if (equals < 1) return fallback;
    const key = line.slice(0, equals).trim();
    if (!["name", "description", "author", "version", "script"].includes(key)) continue;
    if (values.has(key)) return fallback;
    const scalar = parseQuotedScalar(stripTrailingComment(line.slice(equals + 1).trim()));
    if (scalar === undefined) return fallback;
    const limit = key === "description" ? 1_024 : key === "version" ? 80 : 160;
    if (scalar.length > limit) return fallback;
    values.set(key, scalar);
  }
  const name = values.get("name");
  const script = values.get("script");
  if (!name || !script || !name.trim()) return fallback;
  return {
    id: GodotPluginIdSchema.parse(id),
    name: name.trim(),
    ...(values.has("description") ? { description: values.get("description") } : {}),
    ...(values.has("author") ? { author: values.get("author") } : {}),
    ...(values.has("version") ? { version: values.get("version") } : {}),
    enabled: false,
    metadataValid: true,
  };
}

function invalidPlugin(id: string, folder: string): GodotPluginEntry {
  return { id: GodotPluginIdSchema.parse(id), name: folder, enabled: false, metadataValid: false, issue: "invalid_config" };
}

function quoteGodotString(value: string): string { return JSON.stringify(value); }

function writeSetting(source: string, section: string, key: string, value: string): string {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/u);
  let start = -1;
  let end = lines.length;
  for (let index = 0; index < lines.length; index++) {
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/u.exec(lines[index]!);
    if (header?.[1] === section) start = index;
    else if (start >= 0 && header) { end = index; break; }
  }
  if (start < 0) return `${source.trimEnd()}${eol}${eol}[${section}]${eol}${key}=${value}${eol}`;
  for (let index = start + 1; index < end; index++) {
    if (lines[index]!.slice(0, lines[index]!.indexOf("=")).trim() === key) {
      lines[index] = `${key}=${value}`;
      return lines.join(eol);
    }
  }
  lines.splice(start + 1, 0, `${key}=${value}`);
  return lines.join(eol);
}

function removeSetting(source: string, section: string, key: string): string {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/u);
  let active = false;
  const output: string[] = [];
  for (const line of lines) {
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/u.exec(line);
    if (header) active = header[1] === section;
    if (active) {
      const equals = line.indexOf("=");
      if (equals >= 0 && line.slice(0, equals).trim() === key) continue;
    }
    output.push(line);
  }
  return output.join(eol);
}

async function isReparsePoint(target: string): Promise<boolean> {
  const resolved = await fs.realpath(target);
  return process.platform === "win32" ? resolved.toLowerCase() !== target.toLowerCase() : resolved !== target;
}

function parseQuotedScalar(value: string): string | undefined {
  if (!value.startsWith('"')) return undefined;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string" ? parsed : undefined;
  } catch { return undefined; }
}

