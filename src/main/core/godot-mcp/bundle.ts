import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ProjectError } from "../errors";

const digest = z.string().regex(/^[a-f0-9]{64}$/i);
const upstreamDigest = z.union([digest, z.null()]);
const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.object({ name: z.literal("GodotMCP-Standalone"), version: z.string().min(1).max(32), pluginVersion: z.string().min(1).max(32) }).strict(),
  files: z.record(z.string(), z.object({ upstreamSha256: upstreamDigest, packagedSha256: digest }).strict()).refine(files => Object.keys(files).length <= 128),
}).strict();

export type GodotMcpBundleManifest = z.infer<typeof manifestSchema>;

const REQUIRED_FILES = [
  "addons/godot_mcp/plugin.cfg",
  "addons/godot_mcp/plugin.gd",
  "addons/godot_mcp/command_router.gd",
  "addons/godot_mcp/websocket_client.gd",
  "addons/godot_mcp/commands/editor_commands.gd",
  "addons/godot_mcp/commands/project_commands.gd",
  "addons/godot_mcp/commands/scene_commands.gd",
  "addons/godot_mcp/commands/runtime_commands.gd",
  "addons/godot_mcp/services/mcp_runtime.gd",
  "LICENSE",
  "NOTICE.md",
] as const;

const APPROVED_ROUTES = [
  "editor/get_game_screenshot",
  "editor/get_output_log",
  "editor/get_screenshot",
  "mcp/diagnostics",
  "project/get_info",
  "runtime/get_node_properties",
  "runtime/get_scene_tree",
  "scene/get_tree",
].sort();
const MAX_FILES = 128;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

function bundleError(root: string, message: string, details: Record<string, unknown> = {}): ProjectError {
  return new ProjectError("BACKEND_UNAVAILABLE", `Godot MCP bundle is unavailable at ${root}: ${message}`, { resourceRoot: root, ...details });
}

function safeRelativePath(value: string): boolean {
  if (!value || value.includes("\\") || path.posix.isAbsolute(value)) return false;
  const parts = value.split("/");
  if (parts.some(part => !part || part === "." || part === "..")) return false;
  return value === "LICENSE" || value === "NOTICE.md" || value.startsWith("addons/godot_mcp/");
}

async function walkAddon(root: string, relative: string): Promise<string[]> {
  const target = path.join(root, ...relative.split("/"));
  const entries = await readdir(target, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const child = `${relative}/${entry.name}`;
    if (entry.isSymbolicLink()) throw bundleError(root, "symbolic links are not allowed in the addon bundle", { path: child });
    if (entry.isDirectory()) result.push(...await walkAddon(root, child));
    else if (entry.isFile()) result.push(child);
    else throw bundleError(root, "unsupported filesystem entry in addon bundle", { path: child });
  }
  return result;
}

export async function verifyGodotMcpBundle(root: string): Promise<GodotMcpBundleManifest> {
  try {
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw bundleError(root, "resource root must be a normal directory");
    const manifestPath = path.join(root, "manifest.json");
    const manifestBytes = await readFile(manifestPath);
    if (manifestBytes.byteLength > 1_048_576) throw bundleError(root, "manifest exceeds the size limit", { path: manifestPath });
    let parsed: unknown;
    try { parsed = JSON.parse(manifestBytes.toString("utf8")); }
    catch { throw bundleError(root, "manifest is not valid JSON", { path: manifestPath }); }
    const validated = manifestSchema.safeParse(parsed);
    if (!validated.success) throw bundleError(root, "manifest schema is invalid", { issues: validated.error.issues.slice(0, 8).map(issue => issue.path.join(".")) });
    const manifest = validated.data;
    if (manifest.source.version !== "1.1.0" || manifest.source.pluginVersion !== "1.0.0") throw bundleError(root, "upstream version does not match the reviewed release", { version: manifest.source.version, pluginVersion: manifest.source.pluginVersion });
    const names = Object.keys(manifest.files);
    if (names.length > MAX_FILES || REQUIRED_FILES.some(file => !manifest.files[file])) throw bundleError(root, "manifest is missing required addon files", { required: REQUIRED_FILES.filter(file => !manifest.files[file]) });
    for (const relative of names) if (!safeRelativePath(relative)) throw bundleError(root, "manifest contains an unsafe path", { path: relative });

    const actualAddonFiles = (await walkAddon(root, "addons/godot_mcp")).sort();
    const manifestedAddonFiles = names.filter(name => name.startsWith("addons/godot_mcp/")).sort();
    if (actualAddonFiles.length !== manifestedAddonFiles.length || actualAddonFiles.some((name, index) => name !== manifestedAddonFiles[index])) {
      throw bundleError(root, "addon files do not match the manifest inventory");
    }

    let totalBytes = 0;
    for (const relative of names) {
      const filePath = path.join(root, ...relative.split("/"));
      const fileInfo = await lstat(filePath);
      if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.size > MAX_FILE_BYTES) throw bundleError(root, "resource file type or size is not allowed", { path: filePath, size: fileInfo.size });
      totalBytes += fileInfo.size;
      if (totalBytes > MAX_TOTAL_BYTES) throw bundleError(root, "resource bundle exceeds the total size limit");
      const bytes = await readFile(filePath);
      const actualHash = createHash("sha256").update(bytes).digest("hex");
      if (actualHash !== manifest.files[relative]!.packagedSha256.toLowerCase()) throw bundleError(root, "resource digest does not match the manifest", { path: filePath });
    }

    const pluginConfig = await readFile(path.join(root, REQUIRED_FILES[0]), "utf8");
    const scriptMatch = pluginConfig.match(/^\s*script\s*=\s*"([^"]+)"\s*$/im);
    if (!scriptMatch || !["plugin.gd", "res://addons/godot_mcp/plugin.gd"].includes(scriptMatch[1]!)) throw bundleError(root, "plugin.cfg contains an unsupported script path", { path: path.join(root, REQUIRED_FILES[0]) });

    const router = await readFile(path.join(root, "addons/godot_mcp/command_router.gd"), "utf8");
    const allowlist = router.match(/const\s+ALLOWED_BACKEND_ROUTES\s*:[^=]+?=\s*\[([\s\S]*?)\]/)?.[1];
    const routes = allowlist?.match(/"([^"]+)"/g)?.map(item => item.slice(1, -1)).sort();
    if (!routes || JSON.stringify(routes) !== JSON.stringify(APPROVED_ROUTES)) throw bundleError(root, "Godot addon route allowlist does not match the approved eight routes");

    const websocketClient = await readFile(path.join(root, "addons/godot_mcp/websocket_client.gd"), "utf8");
    if (!websocketClient.includes("serviceId") || !websocketClient.includes("client_hello")) throw bundleError(root, "Godot addon is missing the SpecLoom service handshake");
    const pluginScript = await readFile(path.join(root, "addons/godot_mcp/plugin.gd"), "utf8");
    if (pluginScript.includes("_dismiss_dialogs_recursive") || pluginScript.includes("_check_and_dismiss_dialogs")) throw bundleError(root, "Godot addon contains automatic dialog dismissal behavior");
    const notice = await readFile(path.join(root, "NOTICE.md"), "utf8");
    if (!notice.includes("GodotMCP-Standalone") || !notice.includes("1.1.0") || !notice.includes("1.0.0") || !notice.includes("SpecLoom")) throw bundleError(root, "upstream attribution notice is incomplete", { path: path.join(root, "NOTICE.md") });
    return manifest;
  } catch (error) {
    if (error instanceof ProjectError) throw error;
    throw bundleError(root, error instanceof Error ? error.message : String(error));
  }
}

export function defaultGodotMcpResourceRoot(): string {
  const developmentRoot = process.env.SPECLOOM_DEV_APP_ROOT;
  if (typeof developmentRoot === "string" && developmentRoot.length > 0) {
    return path.resolve(developmentRoot, "resources", "godot-mcp");
  }
  const resourcesPath = Reflect.get(process, "resourcesPath");
  return typeof resourcesPath === "string" && resourcesPath.length > 0
    ? path.join(resourcesPath, "godot-mcp")
    : path.resolve(process.cwd(), "resources", "godot-mcp");
}
