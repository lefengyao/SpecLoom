import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopController } from "../../src/main/desktop-controller";
import type { ModelVault } from "../../src/main/core/model-vault";

const roots: string[] = [];
const controllers: DesktopController[] = [];
afterEach(async () => {
  await Promise.all(controllers.splice(0).map((controller) => controller.shutdown()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(name: string, godot = true): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-plugin-management-"));
  roots.push(root);
  if (godot) await writeFile(path.join(root, "project.godot"), `config_version=5\n[application]\nconfig/name=${JSON.stringify(name)}\n`);
  await mkdir(path.join(root, "addons/example"), { recursive: true });
  await writeFile(path.join(root, "addons/example/plugin.cfg"), '[plugin]\nname="Example Editor"\ndescription="Test plugin"\nscript="plugin.gd"\n');
  return root;
}

describe("plugin management controller", () => {
  it("binds listing, toggles, and reveal resolution to the currently open Godot project", async () => {
    const first = await project("First project");
    const second = await project("Second project");
    const vault = { list: async () => [] } as unknown as ModelVault;
    const controller = new DesktopController(vault, first, path.resolve("skills"));
    controllers.push(controller);
    await controller.openProject(first);

    await expect(controller.listProjectPlugins()).resolves.toMatchObject({ plugins: [{ id: "addons/example/plugin.cfg", name: "Example Editor", enabled: false }] });
    await controller.setProjectPluginEnabled("addons/example/plugin.cfg", true);
    expect(await readFile(path.join(first, "project.godot"), "utf8")).toContain('"res://addons/example/plugin.cfg"');
    expect(await controller.resolvePluginRevealTarget("addons/example/plugin.cfg")).toBe(path.join(first, "addons/example"));

    await controller.openProject(second);
    expect(await readFile(path.join(second, "project.godot"), "utf8")).not.toContain('"res://addons/example/plugin.cfg"');
    await controller.setProjectPluginEnabled("addons/example/plugin.cfg", true);
    expect(await readFile(path.join(second, "project.godot"), "utf8")).toContain('"res://addons/example/plugin.cfg"');
    expect(await readFile(path.join(first, "project.godot"), "utf8")).toContain('"res://addons/example/plugin.cfg"');
  });

  it("rejects plugin management while a generic project is active", async () => {
    const root = await project("Generic workspace", false);
    const controller = new DesktopController({ list: async () => [] } as unknown as ModelVault, root, path.resolve("skills"));
    controllers.push(controller);
    await controller.openProject(root);

    await expect(controller.listProjectPlugins()).rejects.toMatchObject({ code: "INVALID_PROJECT" });
    await expect(controller.setProjectPluginEnabled("addons/example/plugin.cfg", true)).rejects.toMatchObject({ code: "INVALID_PROJECT" });
  });
});
