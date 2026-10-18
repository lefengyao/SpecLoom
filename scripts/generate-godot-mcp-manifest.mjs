import { createHash } from "node:crypto";
import { lstat, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const sourceRoot = process.argv[2] ? path.resolve(process.argv[2]) : "";
const bundleRoot = process.argv[3] ? path.resolve(process.argv[3]) : path.join(projectRoot, "resources", "godot-mcp");
if (!sourceRoot) throw new Error("Usage: node scripts/generate-godot-mcp-manifest.mjs <GodotMCP-Standalone-root> [bundle-root]");

/** @param {string} root @param {string} [relative] @returns {Promise<string[]>} */
async function collectFiles(root, relative = "") {
  const result = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    const absolute = path.join(root, ...child.split("/"));
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error(`Symbolic links are not supported: ${absolute}`);
    if (entry.isDirectory()) result.push(...await collectFiles(root, child));
    else if (info.isFile()) result.push(child);
    else throw new Error(`Unsupported file type: ${absolute}`);
  }
  return result.sort();
}

/** @param {Uint8Array} bytes */
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

const packageInfo = JSON.parse(await readFile(path.join(sourceRoot, "package.json"), "utf8"));
const addonSourceRoot = path.join(sourceRoot, "addons", "godot_mcp");
const addonTargetRoot = path.join(bundleRoot, "addons", "godot_mcp");
const sourceFiles = await collectFiles(addonSourceRoot);
const targetFiles = await collectFiles(addonTargetRoot);
if (JSON.stringify(sourceFiles) !== JSON.stringify(targetFiles)) throw new Error("Bundled addon file inventory differs from the upstream addon");

/** @type {Record<string, {upstreamSha256: string | null, packagedSha256: string}>} */
const files = {};
for (const relative of sourceFiles) {
  const source = await readFile(path.join(addonSourceRoot, ...relative.split("/")));
  const packaged = await readFile(path.join(addonTargetRoot, ...relative.split("/")));
  files[`addons/godot_mcp/${relative}`] = { upstreamSha256: sha256(source), packagedSha256: sha256(packaged) };
}
const upstreamLicense = await readFile(path.join(sourceRoot, "LICENSE"));
const packagedLicense = await readFile(path.join(bundleRoot, "LICENSE"));
files.LICENSE = { upstreamSha256: sha256(upstreamLicense), packagedSha256: sha256(packagedLicense) };
files["NOTICE.md"] = { upstreamSha256: null, packagedSha256: sha256(await readFile(path.join(bundleRoot, "NOTICE.md"))) };

const pluginConfig = await readFile(path.join(addonSourceRoot, "plugin.cfg"), "utf8");
const pluginVersion = pluginConfig.match(/^\s*version\s*=\s*"([^"]+)"\s*$/im)?.[1];
if (packageInfo.version !== "1.1.0" || !pluginVersion) throw new Error("Upstream package/plugin version metadata is missing or unexpected");
const manifest = {
  schemaVersion: 1,
  source: { name: "GodotMCP-Standalone", version: packageInfo.version, pluginVersion },
  files,
};
const manifestPath = path.join(bundleRoot, "manifest.json");
const temporaryPath = `${manifestPath}.tmp`;
await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "w" });
await rename(temporaryPath, manifestPath);
console.log(`Wrote ${Object.keys(files).length} resource digests to ${manifestPath}`);
