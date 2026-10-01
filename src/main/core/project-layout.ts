import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";
import { SCHEMA_VERSION, type GodotConfig, type ProjectMetadata } from "../../shared/contracts";
import { ProjectError } from "./errors";

export interface ProjectLayoutOptions {
  bundledSkillsDirectory?: string;
}

export const EDITABLE_PROJECT_DIRECTORIES = [
  "specs/entities/characters", "specs/entities/maps", "specs/entities/systems",
  "specs/entities/items", "specs/entities/events", "specs/tasks", "specs/decisions", "specs/prompts",
  ".specloom/skills",
] as const;

export const RESERVED_PROJECT_DIRECTORIES = [
  ".specloom/history/changes", ".specloom/history/validations",
] as const;

export function isReservedProjectPath(relativePath: string): boolean {
  const normalized = path.posix.normalize(relativePath.replaceAll("\\", "/")).replace(/\/$/, "").toLowerCase();
  return (normalized === ".specloom" || normalized.startsWith(".specloom/"))
    && normalized !== ".specloom/skills" && !normalized.startsWith(".specloom/skills/");
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function ensureProjectDirectory(root: string, relativePath: string): Promise<void> {
  let current = root;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) throw new ProjectError("PATH_ESCAPE", "Project layout cannot traverse symbolic links", { path: relativePath });
      if (!stats.isDirectory()) throw new ProjectError("INVALID_PROJECT", "A project layout directory is occupied by a file", { path: relativePath });
    } catch (error) {
      if (!isMissing(error)) throw error;
      try {
        await mkdir(current);
      } catch (creationError) {
        if (!(typeof creationError === "object" && creationError !== null && "code" in creationError && creationError.code === "EEXIST")) throw creationError;
      }
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) throw new ProjectError("PATH_ESCAPE", "Project layout cannot traverse symbolic links", { path: relativePath });
      if (!stats.isDirectory()) throw new ProjectError("INVALID_PROJECT", "A project layout directory is occupied by a file", { path: relativePath });
    }
  }
}

async function writeInitialFile(root: string, relativePath: string, content: string | Uint8Array): Promise<boolean> {
  const target = path.join(root, relativePath);
  await ensureProjectDirectory(root, path.posix.dirname(relativePath));
  try {
    const stats = await lstat(target);
    if (stats.isSymbolicLink()) throw new ProjectError("PATH_ESCAPE", "Project layout cannot write symbolic links", { path: relativePath });
    if (!stats.isFile()) throw new ProjectError("INVALID_PROJECT", "A project layout file is occupied by a directory", { path: relativePath });
    return false;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  try {
    await writeFile(target, content, { flag: "wx" });
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") return false;
    throw error;
  }
}

function parseGodotMetadata(content: string, root: string): Omit<ProjectMetadata, "path" | "schemaVersion"> {
  const values = new Map<string, string>();
  let section = "";
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(";") || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      section = trimmed.slice(1, -1);
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    values.set(section ? `${section}/${key}` : key, trimmed.slice(separator + 1).trim());
  }
  const stringValue = (key: string): string | undefined => {
    const raw = values.get(key);
    if (raw === undefined) return undefined;
    try {
      const value: unknown = JSON.parse(raw);
      return typeof value === "string" ? value : undefined;
    } catch {
      return undefined;
    }
  };
  const godot: GodotConfig = { features: [] };
  const configVersion = Number(values.get("config_version"));
  if (Number.isInteger(configVersion) && configVersion > 0) godot.configVersion = configVersion;
  const mainScene = stringValue("application/run/main_scene");
  if (mainScene !== undefined) godot.mainScene = mainScene;
  const featuresRaw = values.get("application/config/features");
  if (featuresRaw?.startsWith("PackedStringArray(") && featuresRaw.endsWith(")")) {
    try {
      const features: unknown = JSON.parse(`[${featuresRaw.slice("PackedStringArray(".length, -1)}]`);
      if (Array.isArray(features) && features.every((feature) => typeof feature === "string")) godot.features = features;
    } catch {
      // Malformed optional feature metadata does not invalidate a regular Godot project file.
    }
  }
  return {
    name: stringValue("application/config/name")?.trim() || path.basename(root),
    description: stringValue("application/config/description") || "A Godot project managed with SpecLoom.",
    godot,
  };
}

function markdown(frontmatter: Record<string, unknown>, body: string): string {
  return `---\n${stringify(frontmatter)}---\n\n${body}\n`;
}

export class ProjectLayout {
  constructor(private readonly options: ProjectLayoutOptions = {}) {}

  async initialize(projectRoot: string): Promise<ProjectMetadata> {
    let root: string;
    let godotContent: string;
    try {
      root = await realpath(projectRoot);
      if (!(await lstat(root)).isDirectory()) throw new Error("Project root must be a directory");
      const godotPath = path.join(root, "project.godot");
      const stats = await lstat(godotPath);
      if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("project.godot must be a regular file");
      godotContent = await readFile(godotPath, "utf8");
    } catch {
      throw new ProjectError("INVALID_PROJECT", "Select an existing Godot project containing a regular project.godot file");
    }
    const metadata: ProjectMetadata = { schemaVersion: SCHEMA_VERSION, path: root, ...parseGodotMetadata(godotContent, root) };
    for (const directory of [...EDITABLE_PROJECT_DIRECTORIES, ...RESERVED_PROJECT_DIRECTORIES]) {
      await ensureProjectDirectory(root, directory);
    }
    await writeInitialFile(root, "specs/project.md", markdown({ schemaVersion: SCHEMA_VERSION, id: "project", title: metadata.name, description: metadata.description }, `# ${metadata.name}\n\n${metadata.description}`));
    await writeInitialFile(root, "specs/outline.md", markdown({ schemaVersion: SCHEMA_VERSION, id: "outline", title: "Project Outline", description: "High-level structure and milestones for the project." }, "# Project Outline\n\n## Overview\n\n## Milestones"));
    await writeInitialFile(root, ".specloom/project.yaml", stringify({ schemaVersion: SCHEMA_VERSION, project: { name: metadata.name, description: metadata.description }, godot: metadata.godot, defaultTaskMode: "manual" }));
    await writeInitialFile(root, ".specloom/generated-manifest.json", `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, files: {} }, null, 2)}\n`);
    if (this.options.bundledSkillsDirectory !== undefined) await this.copyBundledSkills(root, this.options.bundledSkillsDirectory);
    return metadata;
  }

  async copyBundledSkills(projectRoot: string, bundledSkillsDirectory: string): Promise<string[]> {
    const root = await realpath(projectRoot);
    const sourceRoot = await realpath(bundledSkillsDirectory);
    const copied: string[] = [];
    await ensureProjectDirectory(root, ".specloom/skills");
    const visit = async (relativeDirectory: string): Promise<void> => {
      const entries = await readdir(path.join(sourceRoot, relativeDirectory), { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const relative = path.posix.join(relativeDirectory, entry.name);
        if (entry.isSymbolicLink()) throw new ProjectError("PATH_ESCAPE", "Bundled skills cannot contain symbolic links", { path: relative });
        if (entry.isDirectory()) {
          await ensureProjectDirectory(root, `.specloom/skills/${relative}`);
          await visit(relative);
        } else if (entry.isFile()) {
          const target = `.specloom/skills/${relative}`;
          if (await writeInitialFile(root, target, await readFile(path.join(sourceRoot, relative)))) copied.push(target);
        }
      }
    };
    await visit("");
    return copied;
  }
}
