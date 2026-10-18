import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultGodotMcpResourceRoot, verifyGodotMcpBundle } from "../../src/main/core/godot-mcp/bundle";

let root: string;

const routeSource = `const ALLOWED_BACKEND_ROUTES: Array[String] = [
	"mcp/diagnostics",
	"editor/get_output_log",
	"editor/get_screenshot",
	"editor/get_game_screenshot",
	"project/get_info",
	"scene/get_tree",
	"runtime/get_scene_tree",
	"runtime/get_node_properties",
]`;

async function createFixture(pluginConfig = '[plugin]\nscript="plugin.gd"\n') {
  root = await mkdtemp(path.join(tmpdir(), "specloom-godot-bundle-"));
  const files: Record<string, string> = {
    "addons/godot_mcp/plugin.cfg": pluginConfig,
    "addons/godot_mcp/plugin.gd": "extends EditorPlugin\n",
    "addons/godot_mcp/command_router.gd": routeSource,
    "addons/godot_mcp/websocket_client.gd": "serviceId client_hello\n",
    "addons/godot_mcp/commands/editor_commands.gd": "editor/get_output_log editor/get_screenshot editor/get_game_screenshot\n",
    "addons/godot_mcp/commands/project_commands.gd": "project/get_info\n",
    "addons/godot_mcp/commands/scene_commands.gd": "scene/get_tree\n",
    "addons/godot_mcp/commands/runtime_commands.gd": "runtime/get_scene_tree runtime/get_node_properties\n",
    "addons/godot_mcp/services/mcp_runtime.gd": "extends Node\n",
    "LICENSE": "MIT License\nCopyright (c) KeeVeeG\n",
    "NOTICE.md": "GodotMCP-Standalone 1.1.0; plugin metadata version 1.0.0; SpecLoom service identity adaptation.\n",
  };
  const entries: Record<string, { upstreamSha256: string; packagedSha256: string }> = {};
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
    const digest = createHash("sha256").update(content).digest("hex");
    entries[relative] = { upstreamSha256: digest, packagedSha256: digest };
  }
  await writeFile(path.join(root, "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    source: { name: "GodotMCP-Standalone", version: "1.1.0", pluginVersion: "1.0.0" },
    files: entries,
  }));
  return { files, entries };
}

afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("Godot MCP application resource bundle", () => {
  it("uses the source resource directory when the development runtime also exposes Electron resourcesPath", () => {
    const sourceRoot = path.join(tmpdir(), "specloom-source");
    const electronResources = path.join(tmpdir(), "electron", "resources");
    const originalRoot = process.env.SPECLOOM_DEV_APP_ROOT;
    const originalResourcesPath = Object.getOwnPropertyDescriptor(process, "resourcesPath");
    process.env.SPECLOOM_DEV_APP_ROOT = sourceRoot;
    Object.defineProperty(process, "resourcesPath", { configurable: true, value: electronResources });
    try {
      expect(defaultGodotMcpResourceRoot()).toBe(path.join(sourceRoot, "resources", "godot-mcp"));
    } finally {
      if (originalRoot === undefined) delete process.env.SPECLOOM_DEV_APP_ROOT;
      else process.env.SPECLOOM_DEV_APP_ROOT = originalRoot;
      if (originalResourcesPath) Object.defineProperty(process, "resourcesPath", originalResourcesPath);
      else Reflect.deleteProperty(process, "resourcesPath");
    }
  });

  it("validates the vendored 1.1.0 addon and its SpecLoom-only handshake", async () => {
    const root = path.resolve(process.cwd(), "resources", "godot-mcp");
    const manifest = await verifyGodotMcpBundle(root);
    expect(manifest.source).toMatchObject({ version: "1.1.0", pluginVersion: "1.0.0" });
    expect(Object.keys(manifest.files).filter(file => file.startsWith("addons/godot_mcp/"))).toHaveLength(54);
  });

  it("validates hashes, attribution, service handshake, and the exact eight-route allowlist", async () => {
    await createFixture();
    const manifest = await verifyGodotMcpBundle(root);
    expect(manifest.source).toMatchObject({ name: "GodotMCP-Standalone", version: "1.1.0", pluginVersion: "1.0.0" });
    expect(Object.keys(manifest.files)).toHaveLength(11);
  });

  it("rejects missing scripts, modified resources, extra routes, and plugin path escapes", async () => {
    await createFixture();
    await rm(path.join(root, "addons/godot_mcp/commands/runtime_commands.gd"));
    await expect(verifyGodotMcpBundle(root)).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });

    await rm(root, { recursive: true, force: true });
    await createFixture();
    await writeFile(path.join(root, "addons/godot_mcp/plugin.gd"), "changed without updating manifest");
    await expect(verifyGodotMcpBundle(root)).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });

    await rm(root, { recursive: true, force: true });
    await createFixture();
    await writeFile(path.join(root, "addons/godot_mcp/plugin.cfg"), '[plugin]\nscript="../../outside.gd"\n');
    const data = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
    const content = '[plugin]\nscript="../../outside.gd"\n';
    data.files["addons/godot_mcp/plugin.cfg"].packagedSha256 = createHash("sha256").update(content).digest("hex");
    await writeFile(path.join(root, "manifest.json"), JSON.stringify(data));
    await expect(verifyGodotMcpBundle(root)).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });

    await rm(root, { recursive: true, force: true });
    await createFixture();
    const routePath = path.join(root, "addons/godot_mcp/command_router.gd");
    const extraRoute = `${routeSource.slice(0, -1)}\t"project/delete",\n]`;
    await writeFile(routePath, extraRoute);
    const routeManifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
    routeManifest.files["addons/godot_mcp/command_router.gd"].packagedSha256 = createHash("sha256").update(extraRoute).digest("hex");
    await writeFile(path.join(root, "manifest.json"), JSON.stringify(routeManifest));
    await expect(verifyGodotMcpBundle(root)).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
  });
});
