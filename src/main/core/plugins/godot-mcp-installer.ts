import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { verifyGodotMcpBundle, defaultGodotMcpResourceRoot, type GodotMcpBundleManifest } from "../godot-mcp/bundle";
import { ProjectError } from "../errors";
import { PathPolicy } from "../path-policy";
import { defaultFileSystem, hasCode } from "../store-fs";

const ADDON_PREFIX = "addons/godot_mcp/";
const MARKER = "addons/godot_mcp/.specloom-managed.json";
const PLUGIN_REF = "res://addons/godot_mcp/plugin.cfg";
const OLD_PLUGIN_REF = "res://addons/specloom_capture/plugin.cfg";
const OLD_AUTOLOAD = '"*res://addons/specloom_capture/runtime.gd"';
const PROJECT_LIMIT = 1_048_576;
const MAX_FILES = 128;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

interface ManagedMarker { schemaVersion: 1; sourceVersion: string; files: Record<string, string> }
export interface GodotMcpInstallResult { restartRequired: boolean; installedVersion: string; changedPaths: string[] }

export class GodotMcpInstaller {
  private readonly policy: PathPolicy;
  constructor(readonly root: string, private readonly resourceRoot = defaultGodotMcpResourceRoot()) { this.policy = new PathPolicy(root, defaultFileSystem); }

  async installAndEnable(): Promise<GodotMcpInstallResult> {
    const manifest = await verifyGodotMcpBundle(this.resourceRoot);
    const resources = await this.readResources(manifest);
    const projectPath = await this.policy.resolve("project.godot", true);
    const projectBytes = await this.readLimited(projectPath, PROJECT_LIMIT);
    const projectText = projectBytes.toString("utf8");
    if (!/(?:^|\r?\n)\s*config_version\s*=\s*5\s*(?:#.*)?(?:\r?\n|$)/u.test(projectText)) throw new ProjectError("INVALID_PROJECT", "Godot 4 project.godot with config_version=5 is required");
    const enabled = readPackedStringArray(projectText, "editor_plugins", "enabled");
    const autoload = readSetting(projectText, "autoload", "SpecLoomCapture");
    if (autoload.present && autoload.value !== OLD_AUTOLOAD) throw new ProjectError("VALIDATION_FAILED", "SpecLoomCapture Autoload is owned by the project and was left unchanged", { conflict: "autoload" });

    const previous = await this.readMarker();
    const changed: string[] = [];
    const backups = new Map<string, Buffer | undefined>();
    const written = new Map<string, Buffer>();
    for (const [relative, bytes] of resources) {
      await this.assertSafeAddonPath(relative);
      const target = await this.policy.resolve(relative, true);
      const current = await this.readOptional(target, MAX_FILE_BYTES);
      if (current && !this.isManagedContent(relative, current, previous, manifest)) {
        throw new ProjectError("VALIDATION_FAILED", "Godot MCP installation conflicts with a modified project file", { path: relative, conflict: "modified_file" });
      }
      if (current?.equals(bytes)) continue;
      backups.set(relative, current);
      changed.push(relative);
    }
    const refs = enabled.filter(item => item !== OLD_PLUGIN_REF);
    if (!refs.includes(PLUGIN_REF)) refs.push(PLUGIN_REF);
    let nextProject = writeSetting(projectText, "editor_plugins", "enabled", `PackedStringArray(${refs.map(value => JSON.stringify(value)).join(", ")})`);
    const ownedAutoload = readSetting(nextProject, "autoload", "SpecLoomCapture");
    if (ownedAutoload.present && ownedAutoload.value === OLD_AUTOLOAD) nextProject = removeSetting(nextProject, "autoload", "SpecLoomCapture");
    const projectChanged = nextProject !== projectText;
    const hashes = Object.fromEntries(resources.map(([relative, bytes]) => [relative, sha256(bytes)]));
    const marker: ManagedMarker = { schemaVersion: 1, sourceVersion: manifest.source.version, files: hashes };
    const markerBytes = Buffer.from(`${JSON.stringify(marker, null, 2)}\n`);
    const markerPath = await this.policy.resolve(MARKER, true);
    const oldMarkerBytes = await this.readOptional(markerPath, 1_048_576);
    const markerChanged = !oldMarkerBytes?.equals(markerBytes);
    if (markerChanged) backups.set(MARKER, oldMarkerBytes);
    try {
      for (const [relative, bytes] of resources) {
        if (!backups.has(relative)) continue;
        const target = await this.policy.resolve(relative, true);
        const current = await this.readOptional(target, MAX_FILE_BYTES);
        if (!sameBytes(current, backups.get(relative))) throw new ProjectError("VERSION_CONFLICT", "A Godot MCP addon file changed during installation", { path: relative });
        await this.writeAtomically(relative, bytes);
        written.set(relative, bytes);
      }
      if (markerChanged) {
        const current = await this.readOptional(markerPath, 1_048_576);
        if (!sameBytes(current, oldMarkerBytes)) throw new ProjectError("VERSION_CONFLICT", "The Godot MCP ownership marker changed during installation", { path: MARKER });
        await this.writeAtomically(MARKER, markerBytes);
        written.set(MARKER, markerBytes);
      }
      if (projectChanged) await this.writeProject(projectPath, projectBytes, nextProject);
    } catch (error) {
      await this.rollback(backups, written).catch(() => undefined);
      throw error;
    }
    return { restartRequired: projectChanged || changed.length > 0 || markerChanged, installedVersion: manifest.source.version, changedPaths: [...changed, ...(markerChanged ? [MARKER] : []), ...(projectChanged ? ["project.godot"] : [])] };
  }

  async setEnabled(enabled: boolean): Promise<{ restartRequired: boolean }> {
    const projectPath = await this.policy.resolve("project.godot", true);
    const baseline = await this.readLimited(projectPath, PROJECT_LIMIT);
    const source = baseline.toString("utf8");
    if (!/(?:^|\r?\n)\s*config_version\s*=\s*5\s*(?:#.*)?(?:\r?\n|$)/u.test(source)) throw new ProjectError("INVALID_PROJECT", "Godot 4 project.godot with config_version=5 is required");
    const current = readPackedStringArray(source, "editor_plugins", "enabled");
    if (enabled) {
      const manifest = await verifyGodotMcpBundle(this.resourceRoot);
      const resources = await this.readResources(manifest);
      const marker = await this.readMarker();
      for (const [relative] of resources) {
        const bytes = await this.readOptional(await this.policy.resolve(relative, true), MAX_FILE_BYTES);
        if (!bytes || !this.isManagedContent(relative, bytes, marker, manifest)) throw new ProjectError("VALIDATION_FAILED", "Godot MCP must be installed and verified before enabling", { path: relative });
      }
    }
    const withoutOld = current.filter(item => item !== OLD_PLUGIN_REF);
    const next = enabled ? [...withoutOld.filter(item => item !== PLUGIN_REF), PLUGIN_REF] : withoutOld.filter(item => item !== PLUGIN_REF);
    let updated = writeSetting(source, "editor_plugins", "enabled", `PackedStringArray(${next.map(value => JSON.stringify(value)).join(", ")})`);
    const autoload = readSetting(updated, "autoload", "SpecLoomCapture");
    if (autoload.present && autoload.value === OLD_AUTOLOAD) updated = removeSetting(updated, "autoload", "SpecLoomCapture");
    if (updated === source) return { restartRequired: false };
    await this.writeProject(projectPath, baseline, updated);
    return { restartRequired: true };
  }

  private async readResources(manifest: GodotMcpBundleManifest): Promise<[string, Buffer][]> {
    const names = Object.keys(manifest.files).filter(name => name.startsWith(ADDON_PREFIX)).sort();
    if (!names.length || names.length > MAX_FILES) throw new ProjectError("BACKEND_UNAVAILABLE", "Godot MCP bundle contains an invalid addon file inventory");
    const files: [string, Buffer][] = [];
    for (const relative of names) {
      const bytes = await fs.readFile(path.join(this.resourceRoot, ...relative.split("/")));
      if (bytes.byteLength > MAX_FILE_BYTES || sha256(bytes) !== manifest.files[relative]!.packagedSha256) throw new ProjectError("BACKEND_UNAVAILABLE", "Godot MCP packaged resource digest changed", { path: relative });
      files.push([relative, bytes]);
    }
    return files;
  }

  private isManagedContent(relative: string, bytes: Buffer, marker: ManagedMarker | undefined, manifest: GodotMcpBundleManifest): boolean {
    const hash = sha256(bytes);
    return hash === manifest.files[relative]?.upstreamSha256 || hash === manifest.files[relative]?.packagedSha256 || hash === marker?.files[relative];
  }

  private async readMarker(): Promise<ManagedMarker | undefined> {
    try {
      const bytes = await this.readLimited(await this.policy.resolve(MARKER, true), 1_048_576);
      const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || (parsed as ManagedMarker).schemaVersion !== 1 || typeof (parsed as ManagedMarker).files !== "object") return undefined;
      return parsed as ManagedMarker;
    } catch (error) { if (hasCode(error, "ENOENT")) return undefined; if (error instanceof SyntaxError) return undefined; throw error; }
  }

  private async assertSafeAddonPath(relative: string): Promise<void> {
    if (!relative.startsWith(ADDON_PREFIX) || relative.includes("\\") || relative.split("/").some(part => !part || part === "." || part === "..")) throw new ProjectError("PATH_ESCAPE", "Unsafe Godot MCP addon path", { path: relative });
    await this.policy.resolve(relative, true);
  }

  private async readOptional(target: string, maxBytes: number): Promise<Buffer | undefined> {
    try { return await this.readLimited(target, maxBytes); } catch (error) { if (hasCode(error, "ENOENT")) return undefined; throw error; }
  }
  private async readLimited(target: string, maxBytes: number): Promise<Buffer> {
    const handle = await fs.open(target, "r");
    try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > maxBytes) throw new ProjectError("VALIDATION_FAILED", "Godot MCP file exceeds the supported size", { path: target, limit: maxBytes }); const bytes = await handle.readFile(); if (bytes.length > maxBytes) throw new ProjectError("VALIDATION_FAILED", "Godot MCP file exceeds the supported size", { path: target, limit: maxBytes }); return bytes; }
    finally { await handle.close(); }
  }
  private async writeAtomically(relative: string, bytes: Buffer): Promise<void> {
    await this.assertSafeAddonPath(relative);
    const target = await this.policy.resolve(relative, true);
    await this.policy.ensureParent(target);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, bytes, { flag: "wx" }); await this.policy.assertSafe(target, true); await fs.rename(temporary, target); }
    finally { try { await fs.unlink(temporary); } catch { /* Keep the original filesystem error. */ } }
  }
  private async writeProject(target: string, expected: Buffer, text: string): Promise<void> {
    if (Buffer.byteLength(text) > PROJECT_LIMIT) throw new ProjectError("VALIDATION_FAILED", "Updated Godot project settings exceed the size limit");
    const temporary = path.join(this.root, `project.godot.${randomUUID()}.tmp`);
    try { await fs.writeFile(temporary, text, { flag: "wx" }); const current = await this.readLimited(target, PROJECT_LIMIT); if (!current.equals(expected)) throw new ProjectError("VERSION_CONFLICT", "project.godot changed while installing Godot MCP"); await this.policy.assertSafe(target, true); await fs.rename(temporary, target); }
    finally { try { await fs.unlink(temporary); } catch { /* Ignore cleanup failure. */ } }
  }
  private async rollback(backups: Map<string, Buffer | undefined>, written: Map<string, Buffer>): Promise<void> {
    for (const [relative, bytes] of [...backups].reverse()) {
      const attempted = written.get(relative);
      if (!attempted) continue;
      if (relative === MARKER || relative.startsWith(ADDON_PREFIX)) {
        const target = await this.policy.resolve(relative, true);
        const current = await this.readOptional(target, MAX_FILE_BYTES);
        if (!sameBytes(current, attempted)) continue;
        if (bytes) await this.writeAtomically(relative, bytes);
        else { try { await fs.unlink(target); } catch (error) { if (!hasCode(error, "ENOENT")) throw error; } }
      }
    }
  }
}

function sha256(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function sameBytes(left: Buffer | undefined, right: Buffer | undefined): boolean { return left === undefined ? right === undefined : right !== undefined && left.equals(right); }
function readSetting(source: string, section: string, key: string): { present: boolean; value?: string } {
  let active = false; let result: { present: boolean; value?: string } | undefined;
  for (const line of source.split(/\r?\n/u)) { const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/u.exec(line); if (header) { active = header[1] === section; continue; } if (active) { const index = line.indexOf("="); if (index > 0 && line.slice(0, index).trim() === key) { if (result) throw new ProjectError("VALIDATION_FAILED", `Duplicate Godot setting ${section}/${key}`); result = { present: true, value: line.slice(index + 1).trim() }; } } }
  return result ?? { present: false };
}
function readPackedStringArray(source: string, section: string, key: string): string[] {
  const setting = readSetting(source, section, key); if (!setting.present || !setting.value) return [];
  const match = /^PackedStringArray\s*\(([\s\S]*)\)$/u.exec(setting.value.replace(/\s+#.*$/u, ""));
  if (!match) throw new ProjectError("VALIDATION_FAILED", `Godot ${section}/${key} must be a PackedStringArray`);
  const values: string[] = []; const regex = /\s*("(?:\\.|[^"\\])*")\s*(?:,|$)/gy; let cursor = 0;
  while (cursor < match[1]!.length) { regex.lastIndex = cursor; const found = regex.exec(match[1]!); if (!found) throw new ProjectError("VALIDATION_FAILED", `Godot ${section}/${key} contains unsupported syntax`); values.push(JSON.parse(found[1]!) as string); cursor = regex.lastIndex; if (values.length > 1024) throw new ProjectError("VALIDATION_FAILED", "Godot enabled plugin list exceeds the limit"); }
  return values;
}
function writeSetting(source: string, section: string, key: string, value: string): string {
  const eol = source.includes("\r\n") ? "\r\n" : "\n"; const lines = source.split(/\r?\n/u); let start = -1; let end = lines.length;
  for (let index = 0; index < lines.length; index++) { const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/u.exec(lines[index]!); if (header?.[1] === section) start = index; else if (start >= 0 && header) { end = index; break; } }
  if (start < 0) return `${source.trimEnd()}${eol}${eol}[${section}]${eol}${key}=${value}${eol}`;
  for (let index = start + 1; index < end; index++) if (lines[index]!.slice(0, lines[index]!.indexOf("=")).trim() === key) { lines[index] = `${key}=${value}`; return lines.join(eol); }
  lines.splice(start + 1, 0, `${key}=${value}`); return lines.join(eol);
}
function removeSetting(source: string, section: string, key: string): string { const eol = source.includes("\r\n") ? "\r\n" : "\n"; let active = false; return source.split(/\r?\n/u).filter(line => { const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/u.exec(line); if (header) active = header[1] === section; return !(active && line.slice(0, line.indexOf("=")).trim() === key); }).join(eol); }
