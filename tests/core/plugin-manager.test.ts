import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { PluginManager } from "../../src/main/core/plugins/plugin-manager";

async function fixture(root: string, id: string, options: { official?: boolean } = {}) {
  const dir = path.join(root, id);
  await mkdir(path.join(dir, "main"), { recursive: true });
  await mkdir(path.join(dir, "renderer"), { recursive: true });
  await writeFile(path.join(dir, "plugin.json"), JSON.stringify({
    id, name: id, version: "0.1.0", apiVersion: 1, official: options.official === true, enabledByDefault: options.official === true,
    main: "main/index.mjs",
    contributes: { pages: [{ id: "main", title: "Main", entry: "renderer/index.html" }] },
  }));
  await writeFile(path.join(dir, "main", "index.mjs"), `export async function activate(context) {
  context.commands.register("ping", async (input, ctx) => ({ pong: true, input, projectPath: ctx.projectPath }));
}
export async function deactivate() {}`);
  await writeFile(path.join(dir, "renderer", "index.html"), "<!doctype html><title>fixture</title>");
}

test("discovers builtins enabled and user plugins disabled, then invokes commands", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-plugins-"));
  const builtin = path.join(root, "builtin");
  const userData = path.join(root, "data");
  const project = path.join(root, "project");
  await mkdir(builtin, { recursive: true }); await mkdir(project, { recursive: true });
  await fixture(builtin, "official", { official: true });
  await fixture(path.join(userData, "plugins"), "local");
  const manager = new PluginManager({ builtinDirectory: builtin, userDataDirectory: userData, getProjectPath: () => project });
  try {
    const inventory = await manager.list();
    expect(inventory.plugins.find((plugin) => plugin.id === "official")).toMatchObject({ enabled: true, source: "builtin" });
    expect(inventory.plugins.find((plugin) => plugin.id === "local")).toMatchObject({ enabled: false, source: "user" });
    expect(await manager.invoke("official", "ping", { value: 1 })).toEqual({ pong: true, input: { value: 1 }, projectPath: project });
    await expect(manager.invoke("local", "ping")).rejects.toThrow("插件未启用");
    expect((await manager.resolvePage("official", "main")).replaceAll("\\", "/")).toContain("renderer/index.html");
    await expect(manager.resolvePage("official", "../main")).rejects.toThrow();
  } finally { await manager.close(); await rm(root, { recursive: true, force: true }); }
});

test("enables a user plugin and installs/uninstalls a folder", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-plugins-install-"));
  const builtin = path.join(root, "builtin"); const userData = path.join(root, "data"); const sourceRoot = path.join(root, "source");
  await mkdir(builtin, { recursive: true }); await fixture(sourceRoot, "installed");
  const source = path.join(sourceRoot, "installed");
  const manager = new PluginManager({ builtinDirectory: builtin, userDataDirectory: userData, getProjectPath: () => root });
  try {
    await manager.installDirectory(source);
    let inventory = await manager.list();
    expect(inventory.plugins.find((plugin) => plugin.id === "installed")).toMatchObject({ source: "user", enabled: false });
    inventory = await manager.setEnabled("installed", true);
    expect(inventory.plugins.find((plugin) => plugin.id === "installed")?.enabled).toBe(true);
    inventory = await manager.uninstall("installed");
    expect(inventory.plugins.some((plugin) => plugin.id === "installed")).toBe(false);
  } finally { await manager.close(); await rm(root, { recursive: true, force: true }); }
});
