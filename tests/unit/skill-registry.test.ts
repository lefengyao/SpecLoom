import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectError } from "../../src/main/core/errors";
import { SkillRegistry, type SkillFileAccess } from "../../src/main/core/skill-registry";
import { TaskScope } from "../../src/main/core/task-scope";
import type { FileReadResult, FileVersion, VersionToken } from "../../src/shared/contracts";

const skillPath = ".specloom/skills/reader/SKILL.md";

function version(content: string): VersionToken {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function skill(sources = ["specs/project.md", "specs/entities/**"]): string {
  return `---\nid: reader\nname: Reader\npurpose: Read project facts\nallowedSources: ${JSON.stringify(sources)}\n---\n\n# Procedure\n\nRead the source receipts. No permission is granted.\n`;
}

class FixtureFiles implements SkillFileAccess {
  readonly files = new Map<string, string>([
    [skillPath, skill()], ["specs/project.md", "# Project"],
    ["specs/entities/hero.md", "# Hero"], ["scripts/private.gd", "secret"],
  ]);
  readonly reads: string[] = [];
  beforeRead: ((relativePath: string) => void) | undefined;

  async listVersion(relativePath: string): Promise<FileVersion> {
    const content = this.files.get(relativePath);
    return { path: relativePath, version: content === undefined ? "absent" : version(content), exists: content !== undefined, size: content === undefined ? 0 : Buffer.byteLength(content) };
  }

  async listFiles(prefix = ""): Promise<FileVersion[]> {
    return Promise.all([...this.files.keys()].filter((relativePath) => !prefix || relativePath === prefix || relativePath.startsWith(`${prefix}/`)).sort().map((relativePath) => this.listVersion(relativePath)));
  }

  async read(relativePath: string, expectedVersion: VersionToken): Promise<FileReadResult> {
    this.beforeRead?.(relativePath);
    const current = await this.listVersion(relativePath);
    if (current.version !== expectedVersion) throw new ProjectError("VERSION_CONFLICT", "Fixture source changed", { path: relativePath });
    if (!current.exists) throw new ProjectError("FILE_NOT_FOUND", "Fixture file is missing", { path: relativePath });
    this.reads.push(relativePath);
    return { path: relativePath, content: this.files.get(relativePath)!, version: current.version };
  }
}

function scope(readPaths = [".specloom/skills/**", "specs/**"]): TaskScope {
  return new TaskScope({ id: "read-skill", title: "Read skill", readPaths, writePaths: [], allowDelete: false, mode: "manual" });
}

describe("SkillRegistry", () => {
  it("discovers metadata only for Skill files the task can read", async () => {
    const files = new FixtureFiles();
    files.files.set(".specloom/skills/hidden/SKILL.md", skill().replace("id: reader", "id: hidden"));
    files.files.set(".specloom/skills/reader/notes.md", "not a Skill");
    const listed = await new SkillRegistry(files).list(scope([skillPath]));
    expect(listed).toEqual([{ id: "reader", name: "Reader", purpose: "Read project facts", allowedSources: ["specs/project.md", "specs/entities/**"], path: skillPath, version: version(skill()) }]);
    expect(files.reads).toEqual([skillPath]);
  });

  it("loads instructions and required source contents with every version receipt", async () => {
    const files = new FixtureFiles();
    const registry = new SkillRegistry(files);
    const loaded = await registry.load("reader", version(skill()), scope());
    expect(loaded.instructions).toContain("# Procedure");
    expect(loaded.referencedContent.map((file) => [file.path, file.content])).toEqual([["specs/entities/hero.md", "# Hero"], ["specs/project.md", "# Project"]]);
    expect(loaded.sources).toEqual([
      { path: skillPath, version: version(skill()) },
      { path: "specs/entities/hero.md", version: version("# Hero") },
      { path: "specs/project.md", version: version("# Project") },
    ]);
  });

  it("rejects a stale Skill token even after discovery", async () => {
    const files = new FixtureFiles();
    const registry = new SkillRegistry(files);
    const [listed] = await registry.list(scope());
    files.files.set(skillPath, `${skill()}\nChanged instructions.`);
    await expect(registry.load("reader", listed!.version, scope())).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(files.reads).toEqual([skillPath]);
  });

  it("rejects a stale cached source and then requires fresh receipts", async () => {
    const files = new FixtureFiles();
    const registry = new SkillRegistry(files);
    await registry.load("reader", version(skill()), scope());
    files.files.set("specs/project.md", "# Updated project");
    await expect(registry.load("reader", version(skill()), scope())).rejects.toMatchObject({ code: "VERSION_CONFLICT", details: expect.objectContaining({ path: "specs/project.md" }) });
    const refreshed = await registry.load("reader", version(skill()), scope());
    expect(refreshed.sources).toContainEqual({ path: "specs/project.md", version: version("# Updated project") });
  });

  it("rejects a source edit between its version listing and read", async () => {
    const files = new FixtureFiles();
    files.beforeRead = (relativePath) => {
      if (relativePath === "specs/project.md") files.files.set(relativePath, "changed during load");
    };
    await expect(new SkillRegistry(files).load("reader", version(skill()), scope())).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });

  it("requires explicit sources to exist", async () => {
    const files = new FixtureFiles();
    files.files.delete("specs/project.md");
    await expect(new SkillRegistry(files).load("reader", version(skill()), scope())).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
  });

  it("keeps optional prefix selection within allowed sources and the task scope", async () => {
    const files = new FixtureFiles();
    files.files.set("specs/entities/other.md", "# Other");
    const registry = new SkillRegistry(files);
    const loaded = await registry.load("reader", version(skill()), scope([skillPath, "specs/project.md", "specs/entities/hero.md"]), ["specs/entities/hero.md"]);
    expect(loaded.referencedContent.map((file) => file.path)).toEqual(["specs/entities/hero.md", "specs/project.md"]);
    await expect(registry.load("reader", version(skill()), scope(), ["scripts/private.gd"])).rejects.toMatchObject({ code: "TASK_SCOPE_DENIED" });
    await expect(registry.load("reader", version(skill()), scope(), ["specs/**"])).rejects.toMatchObject({ code: "TASK_SCOPE_DENIED" });
    await expect(registry.load("reader", version(skill()), scope(), ["specs/../scripts/private.gd"])).rejects.toMatchObject({ code: "PATH_ESCAPE" });
    await expect(registry.load("reader", version(skill()), scope([skillPath]))).rejects.toMatchObject({ code: "TASK_SCOPE_DENIED" });
    expect(files.reads).not.toContain("scripts/private.gd");
  });

  it("does not reuse cached results to bypass a narrower read scope", async () => {
    const files = new FixtureFiles();
    const registry = new SkillRegistry(files);
    await registry.load("reader", version(skill()), scope());
    await expect(registry.load("reader", version(skill()), scope([skillPath]))).rejects.toMatchObject({ code: "TASK_SCOPE_DENIED" });
  });

  it("bounds source count before reading any source content", async () => {
    const files = new FixtureFiles();
    files.files.set("specs/entities/second.md", "# Second");
    await expect(new SkillRegistry(files, { maxSourceFiles: 2 }).load("reader", version(skill()), scope())).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(files.reads).toEqual([skillPath]);
  });

  it("bounds the combined Skill and source context bytes", async () => {
    const files = new FixtureFiles();
    await expect(new SkillRegistry(files, { maxContextBytes: Buffer.byteLength(skill()) + 10 }).load("reader", version(skill()), scope())).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    files.files.set(skillPath, skill([]));
    await expect(new SkillRegistry(files, { maxContextBytes: 10 }).load("reader", version(skill([])), scope())).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it.each([
    "# Missing front matter", skill().replace("id: reader", "id: other"),
    skill().replace("purpose: Read project facts", "purpose: ''"),
    skill(["../secrets"]), skill([".specloom/history/**"]), skill(["*"]),
    skill().replace("allowedSources:", "allowedSources: {}\nignored:"),
    skill().replace("name: Reader", "name: Reader\nname: Duplicate"),
    skill().replace("---\n\n# Procedure", "shell: true\n---\n\n# Procedure"),
  ])("rejects invalid metadata without source reads", async (content) => {
    const files = new FixtureFiles();
    files.files.set(skillPath, content);
    await expect(new SkillRegistry(files).list(scope())).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(files.reads).toEqual([skillPath]);
  });

  it("isolates returned data from the next load", async () => {
    const files = new FixtureFiles();
    const registry = new SkillRegistry(files);
    const loaded = await registry.load("reader", version(skill()), scope());
    loaded.sources[0]!.version = "absent";
    loaded.allowedSources.push("scripts/**");
    loaded.referencedContent[0]!.content = "corrupted";
    const next = await registry.load("reader", version(skill()), scope());
    expect(next.sources[0]!.version).toBe(version(skill()));
    expect(next.allowedSources).not.toContain("scripts/**");
    expect(next.referencedContent[0]!.content).toBe("# Hero");
  });

  it("loads all eight bundled Skills as procedure-only versioned sources", async () => {
    const files = new FixtureFiles();
    files.files.delete(skillPath);
    const directory = path.resolve("skills");
    const skillDirectories = await readdir(directory);
    for (const id of skillDirectories) files.files.set(`.specloom/skills/${id}/SKILL.md`, await readFile(path.join(directory, id, "SKILL.md"), "utf8"));
    const registry = new SkillRegistry(files);
    const listed = await registry.list(scope(["*"]));
    expect(listed.map((item) => item.id)).toEqual(["entity-authoring", "entity-catalog", "godot-generation", "godot-validation", "project-context", "prompt-library", "specification-reading", "task-planning"]);
    for (const metadata of listed) {
      expect(metadata.purpose.length).toBeGreaterThan(0);
      expect(metadata.allowedSources.length).toBeGreaterThan(0);
    }
  });
});
