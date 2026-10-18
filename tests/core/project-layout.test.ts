import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { isReservedProjectPath, ProjectLayout } from "../../src/main/core/project-layout";

const temporaryDirectories: string[] = [];

async function fixture(godot = true): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-layout-"));
  temporaryDirectories.push(root);
  if (godot) await writeFile(path.join(root, "project.godot"), 'config_version=5\n\n[application]\nconfig/name="Test Game"\nconfig/description="A test adventure"\nrun/main_scene="res://main.tscn"\nconfig/features=PackedStringArray("4.5", "GL Compatibility")\n');
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Godot project layout", () => {
  it("classifies normalized metadata paths without allowing case or parent-segment bypasses", () => {
    expect(isReservedProjectPath("specs/project.md")).toBe(false);
    expect(isReservedProjectPath(".specloom/skills/godot/SKILL.md")).toBe(false);
    expect(isReservedProjectPath(".SPEClOOM/History/changes/change.json")).toBe(true);
    expect(isReservedProjectPath(".specloom/skills/../history/changes/change.json")).toBe(true);
    expect(isReservedProjectPath("./.specloom/project.yaml")).toBe(true);
  });

  it("opens a generic workspace without creating project.godot", async () => {
    const root = await fixture(false);
    expect(await new ProjectLayout().initialize(root)).toMatchObject({ engine: "generic", name: path.basename(root) });
    await expect(lstat(path.join(root, "project.godot"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects project.godot directories before writing", async () => {
    const root = await fixture(false);
    await mkdir(path.join(root, "project.godot"));
    await expect(new ProjectLayout().initialize(root)).rejects.toMatchObject({ code: "INVALID_PROJECT" });
    await expect(lstat(path.join(root, "specs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("initializes the editable tree and reserved metadata with Godot project details", async () => {
    const root = await fixture();
    const metadata = await new ProjectLayout().initialize(root);
    expect(metadata).toMatchObject({ path: root, name: "Test Game", description: "A test adventure", schemaVersion: 1, godot: { configVersion: 5, mainScene: "res://main.tscn", features: ["4.5", "GL Compatibility"] } });
    for (const relative of ["specs/entities/characters", "specs/entities/maps", "specs/entities/systems", "specs/entities/items", "specs/entities/events", "specs/components", "specs/settings", "specs/maps", "specs/ui", "specs/tasks", "specs/decisions", "specs/prompts", ".specloom/history/changes", ".specloom/history/validations", ".specloom/skills"]) {
      expect((await lstat(path.join(root, relative))).isDirectory()).toBe(true);
    }
    const markdown = await readFile(path.join(root, "specs/project.md"), "utf8");
    const frontmatter = parse(markdown.split("---\n")[1] ?? "") as { schemaVersion: number; description: string };
    expect(frontmatter).toMatchObject({ schemaVersion: 1, description: "A test adventure" });
    expect(await readFile(path.join(root, "specs/outline.md"), "utf8")).toContain("schemaVersion: 1");
    const config = parse(await readFile(path.join(root, ".specloom/project.yaml"), "utf8")) as Record<string, unknown>;
    expect(config).toMatchObject({ schemaVersion: 1, defaultTaskMode: "manual" });
    expect(config).not.toHaveProperty("apiKey");
    expect(JSON.parse(await readFile(path.join(root, ".specloom/generated-manifest.json"), "utf8"))).toEqual({ schemaVersion: 1, files: {} });
  });

  it("preserves hand-edited specs and project configuration on repeated initialization", async () => {
    const root = await fixture();
    const layout = new ProjectLayout();
    await layout.initialize(root);
    await writeFile(path.join(root, "specs/project.md"), "My edited specification\n");
    await writeFile(path.join(root, ".specloom/project.yaml"), "schemaVersion: 1\ncustom: preserved\n");
    await layout.initialize(root);
    expect(await readFile(path.join(root, "specs/project.md"), "utf8")).toBe("My edited specification\n");
    expect(await readFile(path.join(root, ".specloom/project.yaml"), "utf8")).toContain("custom: preserved");
  });

  it("copies bundled skills while preserving user edits and adding missing files", async () => {
    const root = await fixture();
    const bundle = await fixture(false);
    await mkdir(path.join(bundle, "godot"));
    await writeFile(path.join(bundle, "godot/SKILL.md"), "# Godot skill\n");
    const layout = new ProjectLayout({ bundledSkillsDirectory: bundle });
    await layout.initialize(root);
    const installed = path.join(root, ".specloom/skills/godot/SKILL.md");
    expect(await readFile(installed, "utf8")).toBe("# Godot skill\n");
    await writeFile(installed, "# User skill\n");
    await writeFile(path.join(bundle, "godot/reference.md"), "# Reference\n");
    await layout.copyBundledSkills(root, bundle);
    expect(await readFile(installed, "utf8")).toBe("# User skill\n");
    expect(await readFile(path.join(root, ".specloom/skills/godot/reference.md"), "utf8")).toBe("# Reference\n");
  });

  it("rejects metadata junctions that lead outside the selected project", async () => {
    const root = await fixture();
    const outside = await fixture(false);
    await symlink(outside, path.join(root, ".specloom"), "junction");
    await expect(new ProjectLayout().initialize(root)).rejects.toMatchObject({ code: "PATH_ESCAPE" });
    await expect(lstat(path.join(outside, "project.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
