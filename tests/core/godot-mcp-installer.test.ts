import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GodotMcpInstaller } from "../../src/main/core/plugins/godot-mcp-installer";

const roots: string[] = [];
async function fixture(project = 'config_version=5\n\n[application]\nconfig/name="Fixture"\n\n[editor_plugins]\nenabled=PackedStringArray("res://addons/other/plugin.cfg", "res://addons/specloom_capture/plugin.cfg")\n\n[autoload]\nSpecLoomCapture="*res://addons/specloom_capture/runtime.gd"\n'): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-godot-mcp-install-")); roots.push(root);
  await writeFile(path.join(root, "project.godot"), project);
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("Godot MCP installer", () => {
  it("copies the verified addon, writes its marker, enables it and migrates only the exact legacy bridge settings", async () => {
    const root = await fixture();
    const result = await new GodotMcpInstaller(root).installAndEnable();
    const project = await readFile(path.join(root, "project.godot"), "utf8");
    const marker = JSON.parse(await readFile(path.join(root, "addons/godot_mcp/.specloom-managed.json"), "utf8")) as { files: Record<string, string> };
    expect(result).toMatchObject({ restartRequired: true, installedVersion: "1.1.0" });
    expect(project).toContain('"res://addons/other/plugin.cfg"');
    expect(project).toContain('"res://addons/godot_mcp/plugin.cfg"');
    expect(project).not.toContain('"res://addons/specloom_capture/plugin.cfg"');
    expect(project).not.toContain("SpecLoomCapture=");
    expect(await readFile(path.join(root, "addons/godot_mcp/plugin.cfg"), "utf8")).toContain('name="Godot MCP"');
    expect(Object.keys(marker.files)).toHaveLength(54);
  });

  it("is idempotent and preserves installed files when the managed plugin is disabled", async () => {
    const root = await fixture('config_version=5\n[editor_plugins]\nenabled=PackedStringArray()\n');
    const installer = new GodotMcpInstaller(root);
    await installer.installAndEnable();
    await expect(installer.installAndEnable()).resolves.toMatchObject({ restartRequired: false, changedPaths: [] });
    await expect(installer.setEnabled(false)).resolves.toMatchObject({ restartRequired: true });
    expect(await readFile(path.join(root, "addons/godot_mcp/plugin.cfg"), "utf8")).toContain('name="Godot MCP"');
    expect(await readFile(path.join(root, "project.godot"), "utf8")).not.toContain('"res://addons/godot_mcp/plugin.cfg"');
  });

  it("refuses to overwrite modified addon files before writing any resources", async () => {
    const root = await fixture('config_version=5\n[editor_plugins]\nenabled=PackedStringArray()\n');
    const addon = path.join(root, "addons/godot_mcp"); await mkdir(addon, { recursive: true });
    await writeFile(path.join(addon, "plugin.cfg"), "project-owned plugin");
    await expect(new GodotMcpInstaller(root).installAndEnable()).rejects.toMatchObject({ code: "VALIDATION_FAILED", details: { conflict: "modified_file" } });
    await expect(readFile(path.join(addon, "command_router.gd"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(root, "project.godot"), "utf8")).not.toContain("godot_mcp/plugin.cfg");
    expect(await readFile(path.join(addon, "plugin.cfg"), "utf8")).toBe("project-owned plugin");
  });

  it("updates files recorded by the prior SpecLoom marker and rejects an Autoload collision", async () => {
    const root = await fixture('config_version=5\n[editor_plugins]\nenabled=PackedStringArray()\n');
    const addon = path.join(root, "addons/godot_mcp"); await mkdir(addon, { recursive: true });
    const oldBytes = Buffer.from("older managed script\n");
    await writeFile(path.join(addon, "plugin.gd"), oldBytes);
    await writeFile(path.join(addon, ".specloom-managed.json"), JSON.stringify({ schemaVersion: 1, sourceVersion: "1.0.0", files: { "addons/godot_mcp/plugin.gd": createHash("sha256").update(oldBytes).digest("hex") } }));
    await expect(new GodotMcpInstaller(root).installAndEnable()).resolves.toMatchObject({ restartRequired: true, installedVersion: "1.1.0" });
    const collisionRoot = await fixture('config_version=5\n[editor_plugins]\nenabled=PackedStringArray()\n[autoload]\nSpecLoomCapture="*res://project/runtime.gd"\n');
    await expect(new GodotMcpInstaller(collisionRoot).installAndEnable()).rejects.toMatchObject({ code: "VALIDATION_FAILED", details: { conflict: "autoload" } });
  });
});
