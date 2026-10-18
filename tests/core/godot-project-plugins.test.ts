import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GodotProjectPluginManager } from "../../src/main/core/plugins/godot-project-plugins";

const roots: string[] = [];
async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-godot-plugins-"));
  roots.push(root);
  await writeFile(path.join(root, "project.godot"), [
    "config_version=5",
    "",
    "[application]",
    'config/name="Fixture"',
    "",
    "[editor_plugins]",
    'enabled=PackedStringArray("res://addons/missing/plugin.cfg")',
    "",
  ].join("\n"));
  await mkdir(path.join(root, "addons/dialogue"), { recursive: true });
  await writeFile(path.join(root, "addons/dialogue/plugin.cfg"), [
    "[plugin]",
    'name="Dialogue Manager"',
    'description="Dialogue graph editor"',
    'author="Trailblazer"',
    'version="3.1.0"',
    'script="plugin.gd"',
    "",
  ].join("\n"));
  await mkdir(path.join(root, "addons/texture"), { recursive: true });
  await writeFile(path.join(root, "addons/texture/plugin.cfg"), [
    "[plugin]",
    'name="Texture Atlas"',
    'description="Preview texture atlases"',
    'version="1.2.0"',
    'script="plugin.gd"',
    "",
  ].join("\n"));
  await mkdir(path.join(root, "addons/shared-assets"), { recursive: true });
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Godot project plugin management", () => {
  it("lists plugin metadata and missing enabled references without treating asset folders as plugins", async () => {
    const manager = new GodotProjectPluginManager(await fixture());

    await expect(manager.list()).resolves.toMatchObject({
      godotMcp: { status: "missing", enabled: false, connected: false },
      scanLimitReached: false,
      plugins: [
        {
          id: "addons/dialogue/plugin.cfg",
          name: "Dialogue Manager",
          description: "Dialogue graph editor",
          author: "Trailblazer",
          version: "3.1.0",
          enabled: false,
          metadataValid: true,
        },
        {
          id: "addons/missing/plugin.cfg",
          name: "missing",
          enabled: true,
          metadataValid: false,
          issue: "missing_config",
        },
        {
          id: "addons/texture/plugin.cfg",
          name: "Texture Atlas",
          enabled: false,
          metadataValid: true,
        },
      ],
    });
  });

  it("uses the directory name for malformed metadata and still lists valid siblings", async () => {
    const root = await fixture();
    await mkdir(path.join(root, "addons/broken"), { recursive: true });
    await writeFile(path.join(root, "addons/broken/plugin.cfg"), "[plugin]\nname=PackedStringArray(\"not a string\")\n");
    const manager = new GodotProjectPluginManager(root);

    const inventory = await manager.list();
    expect(inventory.plugins.find((plugin) => plugin.id === "addons/broken/plugin.cfg")).toMatchObject({
      name: "broken",
      metadataValid: false,
      issue: "invalid_config",
    });
    expect(inventory.plugins.some((plugin) => plugin.name === "Dialogue Manager")).toBe(true);
  });

  it("surfaces oversized plugin metadata and scan overflow without failing the inventory", async () => {
    const root = await fixture();
    await mkdir(path.join(root, "addons/oversized"), { recursive: true });
    await writeFile(path.join(root, "addons/oversized/plugin.cfg"), `[plugin]\nname="${"x".repeat(65_540)}"\nscript="plugin.gd"\n`);
    await mkdir(path.join(root, "addons/z-overflow"), { recursive: true });
    const inventory = await new GodotProjectPluginManager(root).list();

    expect(inventory.scanLimitReached).toBe(false);
    expect(inventory.plugins.find((plugin) => plugin.id === "addons/oversized/plugin.cfg")).toMatchObject({
      metadataValid: false,
      issue: "invalid_config",
    });
    await Promise.all(Array.from({ length: 514 }, (_, index) => mkdir(path.join(root, "addons", `unused-${index.toString().padStart(4, "0")}`))));
    await expect(new GodotProjectPluginManager(root).list()).resolves.toMatchObject({ scanLimitReached: true });
  });

  it("ignores a reparse-point addon and does not follow it into another directory", async () => {
    const root = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), "specloom-external-addon-"));
    roots.push(outside);
    await writeFile(path.join(outside, "plugin.cfg"), '[plugin]\nname="External"\nscript="plugin.gd"\n');
    const link = path.join(root, "addons/external-link");
    try { await symlink(outside, link, process.platform === "win32" ? "junction" : "dir"); }
    catch (error) {
      if (process.platform === "win32" && typeof error === "object" && error !== null && "code" in error && ["EPERM", "EACCES", "UNKNOWN"].includes(String(error.code))) return;
      throw error;
    }
    const inventory = await new GodotProjectPluginManager(root).list();
    expect(inventory.plugins.some((plugin) => plugin.name === "External")).toBe(false);
  });

  it("rejects non-Godot project roots", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "specloom-not-godot-"));
    roots.push(root);

    await expect(new GodotProjectPluginManager(root).list()).rejects.toMatchObject({ code: "INVALID_PROJECT" });
  });

  it("enables and disables one valid project plugin while preserving other enabled references", async () => {
    const root = await fixture();
    const settingsPath = path.join(root, "project.godot");
    await writeFile(settingsPath, (await readFile(settingsPath, "utf8")).replace(
      'PackedStringArray("res://addons/missing/plugin.cfg")',
      'PackedStringArray("res://addons/missing/plugin.cfg", "res://addons/third-party/plugin.cfg")',
    ));
    const manager = new GodotProjectPluginManager(root);

    await expect(manager.setEnabled("addons/texture/plugin.cfg", true)).resolves.toMatchObject({ restartRequired: true });
    let settings = await readFile(settingsPath, "utf8");
    expect(settings).toContain('"res://addons/third-party/plugin.cfg"');
    expect(settings).toContain('"res://addons/texture/plugin.cfg"');

    await expect(manager.setEnabled("addons/texture/plugin.cfg", false)).resolves.toMatchObject({ restartRequired: true });
    settings = await readFile(settingsPath, "utf8");
    expect(settings).not.toContain('"res://addons/texture/plugin.cfg"');
    expect(settings).toContain('"res://addons/missing/plugin.cfg"');
    expect(settings).toContain('"res://addons/third-party/plugin.cfg"');
  });

  it("allows disabling a stale reference but refuses enabling missing plugin metadata", async () => {
    const root = await fixture();
    const manager = new GodotProjectPluginManager(root);

    await expect(manager.setEnabled("addons/missing/plugin.cfg", true)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(manager.setEnabled("addons/missing/plugin.cfg", false)).resolves.toMatchObject({ restartRequired: true });
    await expect(manager.list()).resolves.toMatchObject({ plugins: [{ id: "addons/dialogue/plugin.cfg" }, { id: "addons/texture/plugin.cfg" }] });
  });

  it("installs and enables the official Godot MCP addon, then retains it on disable", async () => {
    const root = await fixture();
    const manager = new GodotProjectPluginManager(root);

    await expect(manager.installGodotMcp()).resolves.toMatchObject({ restartRequired: true, installedVersion: "1.1.0" });
    await expect(manager.list()).resolves.toMatchObject({ godotMcp: { status: "ready", enabled: true, connected: false } });
    await expect(manager.setGodotMcpEnabled(false)).resolves.toMatchObject({ restartRequired: true });
    await expect(manager.list()).resolves.toMatchObject({ godotMcp: { status: "ready", enabled: false, connected: false } });
    expect(await readFile(path.join(root, "addons/godot_mcp/plugin.gd"), "utf8")).toContain("EditorPlugin");
    const settings = await readFile(path.join(root, "project.godot"), "utf8");
    expect(settings).toContain('"res://addons/missing/plugin.cfg"');
    expect(settings).not.toContain('"res://addons/godot_mcp/plugin.cfg"');
    expect(settings).toContain('"res://addons/missing/plugin.cfg"');
  });

  it("removes the bridge entry but preserves a conflicting autoload owned by the project", async () => {
    const root = await fixture();
    const settingsPath = path.join(root, "project.godot");
    const settings = (await readFile(settingsPath, "utf8"))
      .replace('PackedStringArray("res://addons/missing/plugin.cfg")', 'PackedStringArray("res://addons/missing/plugin.cfg", "res://addons/specloom_capture/plugin.cfg")')
      + '\n[autoload]\nSpecLoomCapture="*res://addons/custom/runtime.gd"\n';
    await writeFile(settingsPath, settings);
    const manager = new GodotProjectPluginManager(root);

    await expect(manager.list()).resolves.toMatchObject({ godotMcp: { status: "missing", enabled: false } });
    await expect(manager.setGodotMcpEnabled(false)).resolves.toMatchObject({ restartRequired: true });
    const updated = await readFile(settingsPath, "utf8");
    expect(updated).toContain('SpecLoomCapture="*res://addons/custom/runtime.gd"');
    expect(updated).not.toContain('"res://addons/specloom_capture/plugin.cfg"');
  });

  it("uses the nearest safe existing directory when an enabled plugin reference has no folder", async () => {
    const root = await fixture();
    await expect(new GodotProjectPluginManager(root).resolveRevealTarget("addons/missing/plugin.cfg")).resolves.toBe(path.join(root, "addons"));
  });

  it("rejects a guessed plugin ID that is not present in the scanned inventory", async () => {
    const root = await fixture();
    await mkdir(path.join(root, "addons/unscanned"), { recursive: true });
    await expect(new GodotProjectPluginManager(root).resolveRevealTarget("addons/unscanned/plugin.cfg")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
