import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { PluginManager } from "../../src/main/core/plugins/plugin-manager";

const childPath = path.resolve("resources/plugin-host-child.mjs");

async function fixture(root: string, id: string, options: { official?: boolean } = {}) {
  const dir = path.join(root, id);
  await mkdir(path.join(dir, "main"), { recursive: true });
  await writeFile(path.join(dir, "plugin.json"), JSON.stringify({
    id, name: id, version: "0.1.0", apiVersion: 2, official: options.official === true, enabledByDefault: options.official === true,
    main: "main/index.mjs",
    nativePages: [{ id: "main", title: "Main" }],
  }));
  await writeFile(path.join(dir, "main", "index.mjs"), `export async function activate(context) {
  context.commands.register("ping", async (input, ctx) => ({ pong: true, input, projectPath: ctx.projectPath }));
}
export async function deactivate() {}`);
}

function managerFor(builtin: string, userData: string, project: string): PluginManager {
  return new PluginManager({ builtinDirectory: builtin, userDataDirectory: userData, getProjectPath: () => project, childPath, logDirectory: path.join(userData, "plugin-logs") });
}

test("discovers builtins enabled and user plugins disabled, then invokes commands", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-plugins-"));
  const builtin = path.join(root, "builtin");
  const userData = path.join(root, "data");
  const project = path.join(root, "project");
  await mkdir(builtin, { recursive: true }); await mkdir(project, { recursive: true });
  await fixture(builtin, "official", { official: true });
  await fixture(path.join(userData, "plugins"), "local");
  const manager = managerFor(builtin, userData, project);
  try {
    const inventory = await manager.list();
    expect(inventory.plugins.find((plugin) => plugin.id === "official")).toMatchObject({ enabled: true, source: "builtin" });
    expect(inventory.plugins.find((plugin) => plugin.id === "local")).toMatchObject({ enabled: false, source: "user" });
    expect(inventory.plugins.find((plugin) => plugin.id === "official")?.nativePages).toEqual([{ id: "main", title: "Main" }]);
    expect(await manager.invoke("official", "ping", { value: 1 })).toEqual({ pong: true, input: { value: 1 }, projectPath: project });
    await expect(manager.invoke("local", "ping")).rejects.toThrow("插件未启用");
  } finally { await manager.close(); await rm(root, { recursive: true, force: true }); }
});

test("enables a user plugin and installs/uninstalls a folder", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-plugins-install-"));
  const builtin = path.join(root, "builtin"); const userData = path.join(root, "data"); const sourceRoot = path.join(root, "source");
  await mkdir(builtin, { recursive: true }); await fixture(sourceRoot, "installed");
  const source = path.join(sourceRoot, "installed");
  const manager = managerFor(builtin, userData, root);
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
