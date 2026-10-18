import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { ManagedSkillSchema, type ManagedSkill, type SkillImportOptions } from "../../shared/skill-management";
import { ProjectError } from "./errors";
import extract from "extract-zip";

const MetadataSchema = z.object({ id: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).max(80), name: z.string().trim().min(1).max(160), purpose: z.string().trim().min(1).max(2000), allowedSources: z.array(z.string().min(1)).max(128) }).strict();
const MAX_FILES = 4096; const MAX_BYTES = 20 * 1024 * 1024;
type Index = { schemaVersion: 1; skills: ManagedSkill[] };
type SkillState = { enabled: boolean; installedAt: string; updatedAt: string };
const missing = (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
const invalid = (message: string): never => { throw new ProjectError("VALIDATION_FAILED", message); };

export class SkillStore {
  readonly root: string; private queue: Promise<unknown> = Promise.resolve(); private cached: Index | undefined;
  constructor(userData: string) { this.root = path.join(userData, "skills"); }
  async list(): Promise<ManagedSkill[]> { return structuredClone((await this.readIndex()).skills); }
  refresh() { this.cached = undefined; return this.list(); }
  async importDirectory(sourceDirectory: string, options: SkillImportOptions = {}): Promise<ManagedSkill> { return this.serial(() => this.importFromDirectory(sourceDirectory, options, "global")); }
  async installProjectDirectory(sourceDirectory: string, projectPath: string, options: SkillImportOptions = {}): Promise<ManagedSkill> { return this.serial(() => this.importFromDirectory(sourceDirectory, options, "project", projectPath)); }
  async importProjectDirectory(sourceDirectory: string, projectPath: string, options: SkillImportOptions = {}): Promise<ManagedSkill> { return this.installProjectDirectory(sourceDirectory, projectPath, options); }
  async installArchive(archive: string, options: SkillImportOptions = {}): Promise<ManagedSkill> {
    return this.serial(async () => {
      const stat = await lstat(archive);
      if (!stat.isFile() || stat.isSymbolicLink()) invalid("Skill 压缩包必须是普通文件");
      if (stat.size > 50 * 1024 * 1024) invalid("Skill 压缩包超过 50 MB 限制");
      const temporary = await mkdtemp(path.join(os.tmpdir(), "specloom-skill-"));
      try {
        await extract(archive, { dir: temporary, onEntry: (entry) => {
          const normalized = path.posix.normalize(entry.fileName.replaceAll("\\", "/"));
          const mode = (entry.externalFileAttributes >> 16) & 0xffff;
          if (!entry.fileName || path.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../") || entry.fileName.includes("\0") || (mode & 0xf000) === 0xa000) invalid("Skill 压缩包包含不安全路径或符号链接");
        } });
        const entries = await readdir(temporary, { withFileTypes: true });
        const directory = entries.length === 1 && entries[0]!.isDirectory() ? path.join(temporary, entries[0]!.name) : temporary;
        return this.importFromDirectory(directory, options, "global");
      } finally { await rm(temporary, { recursive: true, force: true }).catch(() => undefined); }
    });
  }
  async listProject(projectPath: string): Promise<ManagedSkill[]> {
    const root = path.join(path.resolve(projectPath), ".specloom", "skills"); const state = await this.readProjectStates(root); const result: ManagedSkill[] = [];
    let entries; try { entries = await readdir(root, { withFileTypes: true }); } catch (error) { if (missing(error)) return []; throw error; }
    for (const entry of entries) { if (!entry.isDirectory() || entry.isSymbolicLink()) continue; try { const metadata = await this.metadata(path.join(root, entry.name, "SKILL.md")); const now = new Date().toISOString(); const current = state[metadata.id]; result.push(ManagedSkillSchema.parse({ ...metadata, enabled: current?.enabled ?? true, installedAt: current?.installedAt ?? now, updatedAt: current?.updatedAt ?? now, source: "directory" })); } catch { /* invalid project Skills remain handled by SkillRegistry */ } }
    return result.sort((a, b) => a.id.localeCompare(b.id));
  }
  async setEnabled(id: string, enabled: boolean): Promise<ManagedSkill> { return this.serial(async () => { const index = await this.readIndex(); const skill = index.skills.find((item) => item.id === id); if (!skill) throw new ProjectError("FILE_NOT_FOUND", "Skill 不存在"); skill.enabled = enabled; skill.updatedAt = new Date().toISOString(); await this.writeIndex(index); return structuredClone(skill); }); }
  async setProjectEnabled(id: string, enabled: boolean, projectPath: string): Promise<ManagedSkill> { const root = path.join(path.resolve(projectPath), ".specloom", "skills"); const list = await this.listProject(projectPath); const skill = list.find((item) => item.id === id); if (!skill) throw new ProjectError("FILE_NOT_FOUND", "项目 Skill 不存在"); const now = new Date().toISOString(); const state = await this.readProjectStates(root); state[id] = { enabled, installedAt: skill.installedAt, updatedAt: now }; await this.writeProjectStates(root, state); return { ...skill, enabled, updatedAt: now }; }
  async remove(id: string): Promise<void> { await this.serial(async () => { const index = await this.readIndex(); index.skills = index.skills.filter((item) => item.id !== id); await rm(path.join(this.root, "packages", id), { recursive: true, force: true }); await this.writeIndex(index); }); }
  async removeProject(id: string, projectPath: string): Promise<void> { const root = path.join(path.resolve(projectPath), ".specloom", "skills"); const target = path.join(root, id); if (!target.startsWith(`${root}${path.sep}`)) invalid("Skill 路径越界"); await rm(target, { recursive: true, force: true }); const state = await this.readProjectStates(root); delete state[id]; await this.writeProjectStates(root, state); }
  async syncToProject(projectRoot: string): Promise<void> {
    await this.serial(async () => {
      const index = await this.readIndex();
      for (const skill of index.skills.filter(item => item.enabled)) {
        const source = path.join(this.root, "packages", skill.id);
        const target = path.join(projectRoot, ".specloom", "skills", skill.id);
        try { await lstat(path.join(target, "SKILL.md")); continue; } catch (error) { if (!missing(error)) throw error; }
        await this.copyTree(source, target);
      }
    });
  }

  private async importFromDirectory(sourceDirectory: string, options: SkillImportOptions, scope: "global" | "project", projectPath?: string): Promise<ManagedSkill> {
    const source = await realpath(sourceDirectory).catch(() => { throw new ProjectError("FILE_NOT_FOUND", "Skill 目录不存在"); }); const stat = await lstat(source); if (!stat.isDirectory() || stat.isSymbolicLink()) invalid("Skill 来源必须是普通目录");
    const metadata = await this.metadata(path.join(source, "SKILL.md")); const files: string[] = []; await this.collect(source, source, files); if (files.length > MAX_FILES) invalid("Skill 文件数量超过限制"); let bytes = 0; for (const file of files) bytes += (await lstat(file)).size; if (bytes > MAX_BYTES) invalid("Skill 总大小超过 20 MB");
    const now = new Date().toISOString(); const target = scope === "global" ? path.join(this.root, "packages", metadata.id) : path.join(projectPath!, ".specloom", "skills", metadata.id); if (!options.overwrite) { try { await lstat(path.join(target, "SKILL.md")); throw new ProjectError("VALIDATION_FAILED", "同名 Skill 已存在，请确认覆盖"); } catch (error) { if (!missing(error)) throw error; } } await rm(target, { recursive: true, force: true }); await this.copyTree(source, target);
    if (scope === "project") return ManagedSkillSchema.parse({ ...metadata, enabled: options.enabled ?? true, installedAt: now, updatedAt: now, source: "directory" });
    const index = await this.readIndex(); const existing = index.skills.find((item) => item.id === metadata.id); const result = ManagedSkillSchema.parse({ ...metadata, enabled: options.enabled ?? existing?.enabled ?? true, installedAt: existing?.installedAt ?? now, updatedAt: now, source: "directory" }); index.skills = [...index.skills.filter((item) => item.id !== result.id), result].sort((a, b) => a.id.localeCompare(b.id)); await this.writeIndex(index); return structuredClone(result);
  }
  private async metadata(file: string): Promise<{ id: string; name: string; purpose: string }> { let content: string; try { content = await readFile(file, "utf8"); } catch { invalid("Skill 目录必须包含 SKILL.md"); return { id: "", name: "", purpose: "" }; } const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content); if (!header) invalid("SKILL.md 必须包含 YAML front matter"); try { const doc = parseDocument(header![1]!, { uniqueKeys: true }); if (doc.errors.length) throw doc.errors[0]; const value = MetadataSchema.parse(doc.toJS()); return { id: value.id, name: value.name, purpose: value.purpose }; } catch { invalid("SKILL.md 的 YAML 元数据无效"); return { id: "", name: "", purpose: "" }; } }
  private async collect(root: string, directory: string, output: string[]): Promise<void> { for (const entry of await readdir(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isSymbolicLink()) invalid("Skill 不允许包含符号链接"); if (entry.isDirectory()) await this.collect(root, file, output); else if (entry.isFile()) output.push(file); else invalid("Skill 只能包含普通文件"); } }
  private async copyTree(source: string, target: string): Promise<void> { await mkdir(target, { recursive: true }); const files: string[] = []; await this.collect(source, source, files); for (const file of files) { const relative = path.relative(source, file); const destination = path.join(target, relative); await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, await readFile(file)); } }
  private async readIndex(): Promise<Index> { if (this.cached) return this.cached; try { const parsed = z.object({ schemaVersion: z.literal(1), skills: z.array(ManagedSkillSchema) }).strict().parse(JSON.parse(await readFile(path.join(this.root, "index.json"), "utf8"))); this.cached = parsed; } catch { this.cached = { schemaVersion: 1, skills: [] }; } return this.cached; }
  private async readProjectStates(root: string): Promise<Record<string, SkillState>> { try { const value: unknown = JSON.parse(await readFile(path.join(root, ".state.json"), "utf8")); return typeof value === "object" && value !== null ? value as Record<string, SkillState> : {}; } catch { return {}; } }
  private async writeProjectStates(root: string, state: Record<string, SkillState>): Promise<void> { await mkdir(root, { recursive: true }); await writeFile(path.join(root, ".state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8"); }
  private async writeIndex(index: Index): Promise<void> { await mkdir(this.root, { recursive: true }); await mkdir(path.join(this.root, "packages"), { recursive: true }); const file = path.join(this.root, "index.json"); const temporary = `${file}.tmp`; await writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, "utf8"); await rename(temporary, file); this.cached = index; }
  private async serial<T>(operation: () => Promise<T>): Promise<T> { const run = this.queue.then(operation); this.queue = run.catch(() => undefined); return run; }
}
