import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import type { ChangeEntry } from "../../src/shared/contracts";
import { FileStore } from "../../src/main/core/file-store";
import { ProjectError } from "../../src/main/core/errors";
import { ProjectLayout } from "../../src/main/core/project-layout";
import { TaskScope } from "../../src/main/core/task-scope";
import { GODOT_VALIDATION_IMAGE, Validator, type ValidatorSnapshotRunner } from "../../src/main/core/validator";

const roots: string[] = [];
const md = (data: Record<string, unknown>) => `---\n${stringify(data)}---\n\n# Specification\n`;
const entity = (id = "hero", changes: Record<string, unknown> = {}) => md({ id, type: "character", status: "draft", version: 1, relations: [], source: "user", ...changes });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-validator-"));
  roots.push(root);
  await writeFile(path.join(root, "project.godot"), 'config_version=5\n[application]\nconfig/name="Validator fixture"\n');
  await new ProjectLayout().initialize(root);
  await writeFile(path.join(root, "specs/entities/characters/hero.md"), entity());
  return { root, store: new FileStore(root) };
}

async function put(root: string, relative: string, content: string) {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), content);
}

function backend(exitCode = 0, stderr = "") {
  const runContainer = vi.fn().mockResolvedValue({ exitCode, stdout: "Godot 4.4.1", stderr, durationMs: 3, command: ["docker", "run", "godot"] });
  const dispose = vi.fn().mockResolvedValue(undefined);
  const create = vi.fn().mockResolvedValue({ runContainer, dispose, dependencies: () => ({ "project.godot": "sha256:" + "a".repeat(64) }) });
  return { runner: { create } as unknown as ValidatorSnapshotRunner, create, runContainer, dispose };
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("specification validation", () => {
  it("accepts initialized project templates and returns source versions", async () => {
    const { store } = await fixture();
    const { result, dependencies, sources } = await new Validator(store).validateWithDependencies({ runGodot: false });
    expect(result.status).toBe("pass");
    expect(result.diagnostics).toEqual([]);
    expect(dependencies["specs/entities/characters/hero.md"]).toMatch(/^sha256:/);
    expect(dependencies[".specloom/generated-manifest.json"]).toMatch(/^sha256:/);
    expect(sources).toContainEqual({ path: "specs/project.md", version: dependencies["specs/project.md"] });
  });

  it("reports all missing entity fields and disallows unsupported types", async () => {
    const { root, store } = await fixture();
    await put(root, "specs/entities/characters/hero.md", md({ id: "hero", type: "weapon" }));
    const result = await new Validator(store).validate({ runGodot: false });
    expect(result.status).toBe("fail");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("ENTITY_TYPE_INVALID");
    for (const field of ["status", "version", "relations", "source"]) {
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ path: "specs/entities/characters/hero.md", code: "SPEC_FIELD_INVALID", severity: "error", message: expect.stringContaining(field) }));
    }
    expect(result.diagnostics.every((diagnostic) => diagnostic.path && diagnostic.code && diagnostic.message && diagnostic.severity)).toBe(true);
  });

  it("reports duplicate IDs and unresolved relations in deterministic order", async () => {
    const { root, store } = await fixture();
    await put(root, "specs/entities/maps/map.md", entity("hero", { type: "map", relations: ["missing"] }));
    const result = await new Validator(store).validate({ runGodot: false });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "SPEC_ID_DUPLICATE", path: "specs/entities/maps/map.md" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "RELATION_NOT_FOUND", path: "specs/entities/maps/map.md" }));
    const keys = result.diagnostics.map((entry) => `${entry.path}:${entry.code}:${entry.message}`);
    expect(keys).toEqual([...keys].sort());
  });

  it("handles malformed YAML and missing front matter without crashing", async () => {
    const { root, store } = await fixture();
    await put(root, "specs/entities/characters/hero.md", "# Hero\n");
    await put(root, "specs/entities/items/item.md", "---\nid: [\n---\n");
    const result = await new Validator(store).validate({ runGodot: false });
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(["FRONTMATTER_MISSING", "FRONTMATTER_INVALID"]);
  });

  it("checks Markdown specifications with uppercase extensions", async () => {
    const { root, store } = await fixture();
    await put(root, "specs/entities/items/bad.MD", "# Missing front matter\n");
    const result = await new Validator(store).validate({ runGodot: false });
    expect(result.status).toBe("fail");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ path: "specs/entities/items/bad.MD", code: "FRONTMATTER_MISSING" }));
  });

  it.each([
    ["specs/entities/characters/hero.md", "hero", { type: "map" }],
    ["specs/entities/characters/hero.md", "different", {}],
    ["specs/entities/characters/nested/hero.md", "hero", {}],
  ])("requires the entity type and ID to match %s", async (relative, id, changes) => {
    const { root, store } = await fixture();
    if (relative !== "specs/entities/characters/hero.md") await rm(path.join(root, "specs/entities/characters/hero.md"));
    await put(root, relative, entity(id, changes));
    const result = await new Validator(store).validate({ runGodot: false });
    expect(result.status).toBe("fail");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ path: relative, code: "ENTITY_LAYOUT_INVALID" }));
  });

  it.runIf(process.platform === "win32")("checks staged specification paths using Windows file identities", async () => {
    const { store } = await fixture();
    const current = await store.listVersion("specs/entities/characters/hero.md");
    const relative = "SPECS/ENTITIES/CHARACTERS/HERO.MD";
    const overlay: ChangeEntry[] = [{ path: relative, operation: "update", expectedVersion: current.version, nextContent: md({ id: "hero", type: "character" }), sourceTaskId: "build", sourceTool: "test" }];
    const result = await new Validator(store).validate({ overlay, runGodot: false });
    expect(result.status).toBe("fail");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ path: relative, code: "SPEC_FIELD_INVALID", message: expect.stringContaining("status") }));
  });

  it("requires path-based entity relations to target entity specifications of the declared type", async () => {
    const { root, store } = await fixture();
    await put(root, "scripts/foo.gd", "extends Node\n");
    await put(root, "specs/entities/maps/island.md", entity("island", { type: "map" }));
    await put(root, "specs/entities/characters/hero.md", entity("hero", { relations: [{ path: "scripts/foo.gd", type: "character" }, { path: "specs/entities/maps/island.md", type: "character" }] }));
    const result = await new Validator(store).validate({ runGodot: false });
    expect(result.status).toBe("fail");
    expect(result.diagnostics.map((entry) => entry.code)).toContain("RELATION_TARGET_INVALID");
    expect(result.diagnostics.map((entry) => entry.code)).toContain("RELATION_TYPE_MISMATCH");
    await put(root, "specs/entities/characters/hero.md", entity("hero", { relations: [{ path: "specs/entities/maps/island.md", type: "map" }] }));
    expect((await new Validator(store).validate({ runGodot: false })).status).toBe("pass");
  });

  it.runIf(process.platform === "win32")("resolves entity relation paths using Windows file identities", async () => {
    const { root, store } = await fixture();
    await put(root, "specs/entities/maps/island.md", entity("island", { type: "map" }));
    const relation = { path: "SPECS/ENTITIES/MAPS/ISLAND.MD", type: "map" };
    await put(root, "specs/entities/characters/hero.md", entity("hero", { relations: [relation] }));
    expect((await new Validator(store).validate({ runGodot: false })).status).toBe("pass");
    await put(root, "specs/entities/characters/hero.md", entity("hero", { relations: [{ ...relation, type: "character" }] }));
    const result = await new Validator(store).validate({ runGodot: false });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "RELATION_TYPE_MISMATCH" }));
  });

  it("validates task inputs and generated targets against the staged view", async () => {
    const { root, store } = await fixture();
    await put(root, "specs/tasks/build.md", md({ id: "build", title: "Build", readPaths: ["*"], writePaths: ["scripts/**"], inputs: ["scripts/input.gd", { id: "missing-entity" }] }));
    await put(root, ".specloom/generated-manifest.json", JSON.stringify({ schemaVersion: 1, files: { "scenes/missing.tscn": { entityId: "hero" } } }));
    const result = await new Validator(store).validate({ runGodot: false });
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(["GENERATED_TARGET_NOT_FOUND", "TASK_INPUT_NOT_FOUND", "TASK_INPUT_NOT_FOUND"]);
    const { dependencies } = await new Validator(store).validateWithDependencies({ runGodot: false });
    expect(dependencies["scripts/input.gd"]).toBe("absent");
    expect(dependencies["scenes/missing.tscn"]).toBe("absent");
  });

  it("applies overlays without writing source files and records their baseline", async () => {
    const { root, store } = await fixture();
    const previous = await store.listVersion("specs/entities/characters/hero.md");
    const scope = new TaskScope({ id: "build", title: "Build", readPaths: ["*"], writePaths: ["specs/entities/characters/hero.md"], allowDelete: false, mode: "manual" });
    const overlay: ChangeEntry[] = [{ path: previous.path, operation: "update", expectedVersion: previous.version, nextContent: entity("hero", { relations: ["absent"] }), sourceTaskId: "build", sourceTool: "test" }];
    const { result, dependencies } = await new Validator(store).validateWithDependencies({ scope, overlay, runGodot: false });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "RELATION_NOT_FOUND" }));
    expect(dependencies[previous.path]).toBe(previous.version);
    expect(await readFile(path.join(root, previous.path), "utf8")).toBe(entity());
  });

  it("rejects overlays outside scope and stale baseline versions", async () => {
    const { store } = await fixture();
    const previous = await store.listVersion("specs/entities/characters/hero.md");
    const overlay: ChangeEntry[] = [{ path: previous.path, operation: "update", expectedVersion: previous.version, nextContent: entity(), sourceTaskId: "build", sourceTool: "test" }];
    const scope = new TaskScope({ id: "build", title: "Build", readPaths: ["*"], writePaths: ["scripts/**"], allowDelete: false, mode: "manual" });
    await expect(new Validator(store).validate({ scope, overlay, runGodot: false })).rejects.toMatchObject({ code: "TASK_SCOPE_DENIED" });
    await expect(new Validator(store).validate({ overlay: [{ ...overlay[0]!, expectedVersion: "sha256:" + "b".repeat(64) }], runGodot: false })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });

  it("checks script and scene budgets from bounded project constraints", async () => {
    const { root, store } = await fixture();
    await put(root, "specs/project.md", md({ schemaVersion: 1, id: "project", title: "Game", description: "Game", constraints: { maxScriptLines: 2, maxSceneNodes: 1 } }));
    const overlay: ChangeEntry[] = [
      { path: "scripts/new.gd", operation: "create", expectedVersion: "absent", nextContent: "extends Node\nvar a = 1\nvar b = 2\n", sourceTaskId: "build", sourceTool: "test" },
      { path: "scenes/new.tscn", operation: "create", expectedVersion: "absent", nextContent: '[gd_scene format=3]\n[node name="Root" type="Node"]\n[node name="Child" type="Node" parent="."]\n', sourceTaskId: "build", sourceTool: "test" },
    ];
    const result = await new Validator(store).validate({ overlay, runGodot: false });
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(["SCENE_NODE_BUDGET_EXCEEDED", "SCRIPT_LINE_BUDGET_EXCEEDED"]);
    await put(root, "specs/project.md", md({ schemaVersion: 1, id: "project", title: "Game", description: "Game", constraints: { maxScriptLines: 1000000 } }));
    const invalid = await new Validator(store).validate({ runGodot: false });
    expect(invalid.diagnostics).toContainEqual(expect.objectContaining({ code: "PROJECT_CONSTRAINT_INVALID", path: "specs/project.md" }));
  });

  it("rejects update and delete operations for an absent baseline", async () => {
    const { store } = await fixture();
    const base = { path: "scripts/absent.gd", expectedVersion: "absent" as const, sourceTaskId: "build", sourceTool: "test" };
    await expect(new Validator(store).validate({ overlay: [{ ...base, operation: "update", nextContent: "extends Node\n" }], runGodot: false })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    await expect(new Validator(store).validate({ overlay: [{ ...base, operation: "delete" }], runGodot: false })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });

  it("uses effective staged source content for reference version checks", async () => {
    const { root, store } = await fixture();
    await put(root, "scripts/input.gd", "extends Node\n");
    const before = await store.listVersion("scripts/input.gd");
    await put(root, "specs/entities/characters/hero.md", entity("hero", { source: { path: "scripts/input.gd", version: before.version } }));
    const overlay: ChangeEntry[] = [{ path: before.path, operation: "update", expectedVersion: before.version, nextContent: "extends Node2D\n", sourceTaskId: "build", sourceTool: "test" }];
    const { result, dependencies } = await new Validator(store).validateWithDependencies({ overlay, runGodot: false });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "REFERENCE_VERSION_STALE", path: "specs/entities/characters/hero.md" }));
    expect(dependencies[before.path]).toBe(before.version);
  });

  it("applies default line and node budgets to staged outputs", async () => {
    const { store } = await fixture();
    const overlay: ChangeEntry[] = [
      { path: "scripts/new.gd", operation: "create", expectedVersion: "absent", nextContent: Array.from({ length: 251 }, () => "# line").join("\n"), sourceTaskId: "build", sourceTool: "test" },
      { path: "scenes/new.tscn", operation: "create", expectedVersion: "absent", nextContent: Array.from({ length: 81 }, (_, index) => `[node name="N${index}" type="Node"]`).join("\n"), sourceTaskId: "build", sourceTool: "test" },
    ];
    const result = await new Validator(store).validate({ overlay, runGodot: false });
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(["SCENE_NODE_BUDGET_EXCEEDED", "SCRIPT_LINE_BUDGET_EXCEEDED"]);
  });

  it.each([
    ["scripts/new.GD", Array.from({ length: 251 }, () => "# line").join("\n"), "SCRIPT_LINE_BUDGET_EXCEEDED"],
    ["scenes/new.TSCN", Array.from({ length: 81 }, (_, index) => `[node name="N${index}" type="Node"]`).join("\n"), "SCENE_NODE_BUDGET_EXCEEDED"],
  ])("applies generated budgets to uppercase extensions in %s", async (relative, content, code) => {
    const { store } = await fixture();
    const overlay: ChangeEntry[] = [{ path: relative, operation: "create", expectedVersion: "absent", nextContent: content, sourceTaskId: "build", sourceTool: "test" }];
    const result = await new Validator(store).validate({ overlay, runGodot: false });
    expect(result.status).toBe("fail");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ path: relative, code }));
  });
});

describe("isolated Godot validation", () => {
  it("does not report overall pass when Godot is unavailable", async () => {
    const { store } = await fixture();
    const result = await new Validator(store).validate();
    expect(result.status).toBe("skipped");
    expect(result.checks).toContainEqual(expect.objectContaining({ id: "godot-import", status: "skipped" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "GODOT_NOT_FOUND", severity: "warning" }));
  });

  it("executes import and bounded smoke checks only via a private snapshot", async () => {
    const { root, store } = await fixture();
    await put(root, "main.tscn", '[gd_scene format=3]\n[node name="Main" type="Node"]\n');
    const mock = backend();
    const result = await new Validator(store, mock.runner).validate({ smokeScene: "res://main.tscn" });
    expect(result.status).toBe("pass");
    expect(mock.create.mock.calls[0]![0].describe().readPaths).toEqual(["*"]);
    expect(mock.runContainer.mock.calls[0]![0]).toMatchObject({ image: GODOT_VALIDATION_IMAGE, entrypoint: "godot", args: ["--headless", "--path", "/workspace", "--editor", "--quit"], readOnlyWorkspace: false });
    expect(mock.runContainer.mock.calls[1]![0].args).toContain("--quit-after");
    expect(mock.dispose).toHaveBeenCalledOnce();
  });

  it("recognizes parser errors even when Godot exits zero and does not run smoke", async () => {
    const { store } = await fixture();
    const mock = backend(0, 'SCRIPT ERROR: Parse Error: Expected identifier.\n          at: GDScript::reload (res://scripts/bad.gd:3)\n');
    const result = await new Validator(store, mock.runner).validate({ smokeScene: "res://main.tscn" });
    expect(result.status).toBe("fail");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "GODOT_SCRIPT_ERROR", path: "scripts/bad.gd", line: 3 }));
    expect(mock.runContainer).toHaveBeenCalledOnce();
    expect(mock.dispose).toHaveBeenCalledOnce();
  });

  it("retains spaces in Godot diagnostic file paths", async () => {
    const { store } = await fixture();
    const mock = backend(0, "SCRIPT ERROR: Parse Error: Invalid identifier.\n          at: GDScript::reload (res://scripts/bad name.gd:7)\n");
    const result = await new Validator(store, mock.runner).validate();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "GODOT_SCRIPT_ERROR", path: "scripts/bad name.gd", line: 7 }));
  });

  it("maps a missing Docker image to an explicit skip", async () => {
    const { store } = await fixture();
    const mock = backend();
    mock.runContainer.mockRejectedValue(new ProjectError("BACKEND_UNAVAILABLE", "Pinned image is not available"));
    const result = await new Validator(store, mock.runner).validate();
    expect(result.status).toBe("skipped");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "GODOT_NOT_FOUND" }));
    expect(mock.dispose).toHaveBeenCalledOnce();
  });

  it("attributes smoke execution failures to the smoke check", async () => {
    const { root, store } = await fixture();
    await put(root, "main.tscn", '[gd_scene format=3]\n[node name="Main" type="Node"]\n');
    const mock = backend();
    mock.runContainer.mockResolvedValueOnce({ exitCode: 0, stdout: "Imported", stderr: "", durationMs: 3, command: ["godot"] });
    mock.runContainer.mockRejectedValueOnce(new ProjectError("COMMAND_FAILED", "Container execution timed out"));
    const result = await new Validator(store, mock.runner).validate({ smokeScene: "res://main.tscn" });
    expect(result.checks.map((check) => [check.id, check.status])).toEqual([["specifications", "pass"], ["godot-import", "pass"], ["godot-smoke", "fail"]]);
    expect(mock.dispose).toHaveBeenCalledOnce();
  });
});
