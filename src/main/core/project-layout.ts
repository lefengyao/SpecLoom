import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";
import { SCHEMA_VERSION, type GodotConfig, type ProjectMetadata } from "../../shared/contracts";
import { AUDIO_SYSTEM_ID, AUDIO_SYSTEM_PATH, builtinAudioBuses, mergeBuiltinBuses, readAudioBuses } from "../../shared/audio-system";
import { ProjectError } from "./errors";

export interface ProjectLayoutOptions {
  bundledSkillsDirectory?: string;
  installedSkillsDirectory?: string;
}

export const EDITABLE_PROJECT_DIRECTORIES = [
  "specs/entities/characters", "specs/entities/enemies", "specs/entities/maps", "specs/entities/systems",
  "specs/entities/items", "specs/entities/events", "specs/components", "specs/settings", "specs/maps", "specs/ui",
  "specs/systems", "specs/features", "specs/decision_trees", "specs/tasks", "specs/decisions", "specs/prompts",
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

const AUDIO_SYSTEM_BODY = `# 音频

## 总线

- \`master\`：所有音频的最终出口，不能删除，也不能设置父总线。
- \`music\`：音乐。
- \`sfx\`：音效。

自定义总线直接写进 \`buses\`；事件用 \`bus\` 字段引用总线，名称在项目内唯一。`;

/**
 * Every project owns one audio system. Existing projects get the missing built-in
 * buses back; values already stored are never rewritten.
 */
async function ensureAudioSystem(root: string): Promise<void> {
  const target = path.join(root, AUDIO_SYSTEM_PATH);
  let content: string | undefined;
  try {
    content = await readFile(target, "utf8");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (content === undefined) {
    await writeInitialFile(root, AUDIO_SYSTEM_PATH, markdown({
      schemaVersion: SCHEMA_VERSION,
      id: AUDIO_SYSTEM_ID,
      title: "音频",
      type: "system",
      scope: "system",
      groupId: "group_audio",
      description: "项目音频总线与事件；master、music、sfx 为内置总线，可继续添加自定义总线。",
      buses: builtinAudioBuses(),
      events: [],
    }, AUDIO_SYSTEM_BODY));
    return;
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!match) return;
  let data: unknown;
  try {
    data = parse(match[1]!);
  } catch {
    return;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return;
  const frontmatter = data as Record<string, unknown>;
  const merged = mergeBuiltinBuses(readAudioBuses(frontmatter));
  if (!merged.changed) return;
  await writeFile(target, markdown({ ...frontmatter, buses: merged.buses }, match[2] ?? ""), "utf8");
}

export class ProjectLayout {
  constructor(private readonly options: ProjectLayoutOptions = {}) {}

  async initialize(projectRoot: string): Promise<ProjectMetadata> {
    let root: string;
    let godotContent: string | undefined;
    try {
      root = await realpath(projectRoot);
      if (!(await lstat(root)).isDirectory()) throw new Error("Project root must be a directory");
      const godotPath = path.join(root, "project.godot");
      try {
        const stats = await lstat(godotPath);
        if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("project.godot must be a regular file");
        godotContent = await readFile(godotPath, "utf8");
      } catch (error) { if (!isMissing(error)) throw error; }
    } catch {
      throw new ProjectError("INVALID_PROJECT", "选择现有项目目录；project.godot 如存在必须是普通文件");
    }
    const metadata: ProjectMetadata = { schemaVersion: SCHEMA_VERSION, path: root, ...(godotContent === undefined ? { name: path.basename(root), description: "A project workspace managed with SpecLoom.", godot: { features: [] }, engine: "generic" as const } : { ...parseGodotMetadata(godotContent, root), engine: "godot" as const }) };
    for (const directory of [...EDITABLE_PROJECT_DIRECTORIES, ...RESERVED_PROJECT_DIRECTORIES]) {
      await ensureProjectDirectory(root, directory);
    }
    await writeInitialFile(root, "specs/project.md", markdown({
      schemaVersion: SCHEMA_VERSION,
      id: "project",
      title: metadata.name,
      description: metadata.description,
      materialGroups: {
        component: [{ id: "group_basic_components", name: "基础组件", legacyName: "基础组件", order: 0, scope: "system" }],
        system: [{ id: "group_audio", name: "音频", legacyName: "音频", order: 0, scope: "system" }],
      },
    }, `# ${metadata.name}\n\n${metadata.description}`));
    await writeInitialFile(root, "specs/outline.md", markdown({ schemaVersion: SCHEMA_VERSION, id: "outline", title: "Project Outline", description: "High-level structure and milestones for the project." }, "# Project Outline\n\n## Overview\n\n## Milestones"));
    await writeInitialFile(root, "specs/components/state_machine.md", markdown({
      schemaVersion: SCHEMA_VERSION,
      id: "state_machine",
      title: "状态机基类",
      type: "component",
      scope: "system",
      groupId: "group_basic_components",
      description: "Reusable state-machine lifecycle data and behavior contract.",
      fields: [
        { key: "enabled", label: "启用", type: "boolean", default: true },
        { key: "current_state", label: "当前状态", type: "string", default: "idle" },
      ],
    }, "# 状态机基类\n\n## 行为契约\n\n- `on_enter(state)`：进入状态时调用。\n- `on_update(state, delta)`：状态持续期间每帧更新。\n- `on_exit(state)`：离开状态时调用。"));
    await writeInitialFile(root, "specs/components/decision_tree.md", markdown({
      schemaVersion: SCHEMA_VERSION,
      id: "decision_tree",
      title: "决策树",
      type: "component",
      scope: "system",
      groupId: "group_basic_components",
      description: "引用一棵决策树规范，用行为决策驱动实体或系统；同一所有者可挂多棵，用 key 区分。",
      fields: [
        { key: "enabled", label: "启用", type: "boolean", default: true },
        { key: "tree", label: "决策树", type: "string", default: "" },
      ],
    }, "# 决策树\n\n## 行为契约\n\n- `tree` 指向 `specs/decision_trees/<id>.md`，由实现按树结构执行。\n- 同一实体或系统可挂多个决策树实例，用 `key` 区分。\n- 决策树只描述选择逻辑，具体条件与动作由实现解释。"));
    await ensureAudioSystem(root);
    await writeInitialFile(root, ".specloom/project.yaml", stringify({ schemaVersion: SCHEMA_VERSION, project: { name: metadata.name, description: metadata.description }, godot: metadata.godot, defaultTaskMode: "manual" }));
    await writeInitialFile(root, ".specloom/generated-manifest.json", `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, files: {} }, null, 2)}\n`);
    if (this.options.bundledSkillsDirectory !== undefined) await this.copyBundledSkills(root, this.options.bundledSkillsDirectory);
    if (this.options.installedSkillsDirectory !== undefined) {
      try { await this.copyBundledSkills(root, this.options.installedSkillsDirectory); } catch (error) { if (!isMissing(error)) throw error; }
    }
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
