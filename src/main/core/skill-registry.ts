import { parseDocument } from "yaml";
import { z } from "zod";
import { FileReadResultSchema, VersionTokenSchema, type FileReadResult, type FileVersion, type SkillSource, type VersionToken } from "../../shared/contracts";
import { ProjectError } from "./errors";
import { matchesTaskPath, normalizeTaskPath, normalizeTaskPattern, type TaskScope } from "./task-scope";

export interface SkillFileAccess {
  listFiles(prefix?: string): Promise<FileVersion[]>;
  listVersion(path: string): Promise<FileVersion>;
  read(path: string, expectedVersion: VersionToken): Promise<FileReadResult>;
}

export interface SkillMetadata {
  id: string;
  name: string;
  purpose: string;
  allowedSources: string[];
  path: string;
  version: VersionToken;
}

export interface LoadedSkill extends SkillMetadata {
  instructions: string;
  referencedContent: FileReadResult[];
  sources: SkillSource[];
}

export interface SkillRegistryOptions {
  maxContextBytes?: number;
  maxSourceFiles?: number;
}

const skillId = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MetadataSchema = z.object({
  id: z.string().max(80).regex(skillId),
  name: z.string().trim().min(1).max(160),
  purpose: z.string().trim().min(1).max(2000),
  allowedSources: z.array(z.string().min(1)).max(128),
}).strict();

function validation(message: string, relativePath?: string): ProjectError {
  return new ProjectError("VALIDATION_FAILED", message, relativePath === undefined ? undefined : { path: relativePath });
}

function parseSkill(file: FileReadResult): SkillMetadata & { instructions: string } {
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(file.content);
  if (!header) throw validation("Skills require YAML front matter", file.path);
  let metadata: z.infer<typeof MetadataSchema>;
  try {
    const document = parseDocument(header[1]!, { uniqueKeys: true });
    if (document.errors.length) throw document.errors[0];
    metadata = MetadataSchema.parse(document.toJS());
    metadata.allowedSources = [...new Set(metadata.allowedSources.map((pattern) => normalizeTaskPattern(pattern)))];
  } catch {
    throw validation("Skill metadata must contain only valid id, name, purpose, and allowedSources fields", file.path);
  }
  if (file.path !== `.specloom/skills/${metadata.id}/SKILL.md`) throw validation("The Skill id must match its directory", file.path);
  const instructions = file.content.slice(header[0].length).trim();
  if (!instructions) throw validation("Skills require Markdown procedures after their metadata", file.path);
  return { ...metadata, path: file.path, version: file.version, instructions };
}

function selectionIsAllowed(requested: string, allowed: string): boolean {
  if (!requested.endsWith("/**")) return matchesTaskPath(requested, allowed);
  if (!allowed.endsWith("/**")) return false;
  const requestedPrefix = requested.slice(0, -3);
  const allowedPrefix = allowed.slice(0, -3);
  return requestedPrefix === allowedPrefix || requestedPrefix.startsWith(`${allowedPrefix}/`);
}

export class SkillRegistry {
  readonly #maxContextBytes: number;
  readonly #maxSourceFiles: number;
  readonly #receipts = new Map<string, SkillSource[]>();

  constructor(private readonly files: SkillFileAccess, options: SkillRegistryOptions = {}) {
    this.#maxContextBytes = options.maxContextBytes ?? 256 * 1024;
    this.#maxSourceFiles = options.maxSourceFiles ?? 64;
    if (![this.#maxContextBytes, this.#maxSourceFiles].every((limit) => Number.isSafeInteger(limit) && limit > 0)) {
      throw validation("Skill context limits must be positive safe integers");
    }
  }

  async list(scope: TaskScope): Promise<SkillMetadata[]> {
    const discovered = await this.files.listFiles(".specloom/skills");
    const result: SkillMetadata[] = [];
    let contextBytes = 0;
    for (const file of discovered.sort((left, right) => left.path.localeCompare(right.path))) {
      if (!/^\.specloom\/skills\/[^/]+\/SKILL\.md$/.test(file.path)) continue;
      try {
        scope.assertRead(file.path);
      } catch (error) {
        if (error instanceof ProjectError && error.code === "TASK_SCOPE_DENIED") continue;
        throw error;
      }
      this.assertContextSize(contextBytes + file.size);
      const read = await this.readBound(file.path, file.version, scope);
      contextBytes += Buffer.byteLength(read.content, "utf8");
      this.assertContextSize(contextBytes);
      const { id, name, purpose, allowedSources, path, version } = parseSkill(read);
      result.push({ id, name, purpose, allowedSources, path, version });
    }
    return result;
  }

  async load(id: string, expectedVersion: VersionToken, scope: TaskScope, sourcePaths?: string[]): Promise<LoadedSkill> {
    if (!skillId.test(id) || id.length > 80) throw validation("A Skill id must name a single valid Skill directory");
    if (!VersionTokenSchema.safeParse(expectedVersion).success || expectedVersion === "absent") {
      throw validation("Loading a Skill requires its discovered content version");
    }
    const skillPath = `.specloom/skills/${id}/SKILL.md`;
    const selected = sourcePaths?.map((pattern) => normalizeTaskPattern(pattern));
    const cacheKey = JSON.stringify([id, expectedVersion, selected === undefined ? null : [...new Set(selected)].sort()]);
    try {
      const skillVersion = await this.checkedVersion(skillPath, scope);
      if (skillVersion.version !== expectedVersion) this.conflict(skillPath, expectedVersion, skillVersion.version);
      this.assertContextSize(skillVersion.size);
      const skillFile = await this.readBound(skillPath, expectedVersion, scope);
      const metadata = parseSkill(skillFile);
      let contextBytes = Buffer.byteLength(skillFile.content, "utf8");
      this.assertContextSize(contextBytes);
      const sourceVersions = await this.resolveSources(metadata.allowedSources, selected, scope);
      const cached = this.#receipts.get(cacheKey);
      if (cached) this.assertCachedVersions(cached, [{ path: skillPath, version: expectedVersion }, ...sourceVersions]);
      this.assertContextSize(contextBytes + sourceVersions.reduce((sum, file) => sum + file.size, 0));
      const referencedContent: FileReadResult[] = [];
      for (const source of sourceVersions) {
        const read = await this.readBound(source.path, source.version, scope);
        contextBytes += Buffer.byteLength(read.content, "utf8");
        this.assertContextSize(contextBytes);
        referencedContent.push(read);
      }
      const sources = [skillFile, ...referencedContent].map(({ path, version }) => ({ path, version }));
      // Recheck the full dependency set after reading so edits during assembly invalidate the load.
      for (const source of sources) {
        const current = await this.checkedVersion(source.path, scope);
        if (current.version !== source.version) this.conflict(source.path, source.version, current.version);
      }
      this.#receipts.set(cacheKey, sources.map((source) => ({ ...source })));
      if (this.#receipts.size > 128) this.#receipts.delete(this.#receipts.keys().next().value!);
      return { ...metadata, referencedContent, sources };
    } catch (error) {
      if (error instanceof ProjectError && error.code === "VERSION_CONFLICT") this.#receipts.delete(cacheKey);
      throw error;
    }
  }

  private async resolveSources(allowedSources: string[], selected: string[] | undefined, scope: TaskScope): Promise<FileVersion[]> {
    for (const requested of selected ?? []) {
      if (!allowedSources.some((allowed) => selectionIsAllowed(requested, allowed))) {
        throw new ProjectError("TASK_SCOPE_DENIED", "The Skill does not reference this source selection", { path: requested });
      }
    }
    const required = allowedSources.filter((pattern) => !pattern.endsWith("/**"));
    const patterns = [...new Set([...required, ...(selected ?? allowedSources)])];
    const discovered = new Map<string, FileVersion>();
    for (const pattern of patterns) {
      if (pattern.endsWith("/**")) {
        const prefix = pattern.slice(0, -3);
        for (const file of await this.files.listFiles(prefix)) {
          const normalized = scope.assertRead(file.path);
          if (!matchesTaskPath(normalized, pattern)) throw validation("The file adapter returned a path outside the selected source prefix", normalized);
          discovered.set(normalized, { ...file, path: normalized });
          this.assertSourceCount(discovered.size);
        }
      } else {
        const file = await this.checkedVersion(pattern, scope);
        discovered.set(file.path, file);
        this.assertSourceCount(discovered.size);
      }
    }
    return [...discovered.values()].sort((left, right) => left.path.localeCompare(right.path));
  }

  private async checkedVersion(relativePath: string, scope: TaskScope): Promise<FileVersion> {
    const normalized = scope.assertRead(relativePath);
    const current = await this.files.listVersion(normalized);
    if (normalizeTaskPath(current.path) !== normalized) throw validation("The file adapter returned a different source path", normalized);
    if (!current.exists || current.version === "absent") throw new ProjectError("FILE_NOT_FOUND", "A required Skill source is missing", { path: normalized });
    if (!VersionTokenSchema.safeParse(current.version).success || !Number.isSafeInteger(current.size) || current.size < 0) throw validation("The file adapter returned invalid source metadata", normalized);
    return { ...current, path: normalized };
  }

  private async readBound(relativePath: string, expectedVersion: VersionToken, scope: TaskScope): Promise<FileReadResult> {
    const current = await this.checkedVersion(relativePath, scope);
    if (current.version !== expectedVersion) this.conflict(relativePath, expectedVersion, current.version);
    const parsed = FileReadResultSchema.safeParse(await this.files.read(current.path, expectedVersion));
    if (!parsed.success || parsed.data.path !== current.path) throw validation("The file adapter returned invalid source content", current.path);
    if (parsed.data.version !== expectedVersion) this.conflict(current.path, expectedVersion, parsed.data.version);
    return parsed.data;
  }

  private assertCachedVersions(cached: SkillSource[], current: SkillSource[]): void {
    const currentVersions = new Map(current.map((source) => [source.path, source.version]));
    for (const source of cached) {
      const currentVersion = currentVersions.get(source.path) ?? "absent";
      if (source.version !== currentVersion) this.conflict(source.path, source.version, currentVersion);
      currentVersions.delete(source.path);
    }
    const added = currentVersions.entries().next().value;
    if (added) this.conflict(added[0], "absent", added[1]);
  }

  private assertSourceCount(count: number): void {
    if (count > this.#maxSourceFiles) throw validation("The Skill source count exceeds the configured context limit");
  }

  private assertContextSize(bytes: number): void {
    if (bytes > this.#maxContextBytes) throw validation("The Skill context exceeds the configured byte limit");
  }

  private conflict(relativePath: string, expectedVersion: VersionToken, currentVersion: VersionToken): never {
    throw new ProjectError("VERSION_CONFLICT", "Skill context changed; read current sources and load the Skill again", { path: relativePath, expectedVersion, currentVersion });
  }
}
