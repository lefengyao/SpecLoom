import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareHubModuleResources } from "./hub-module-resources.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const hubRoot = resolve(process.env.TRAILBLAZER_HUB_ROOT ?? join(root, "..", "TraiblazerHub"));
const require = createRequire(join(hubRoot, "package.json"));
const JSZip = require("jszip");
const { updateModuleIndex } = await import(pathToFileURL(join(hubRoot, "scripts/module-index.mjs")).href);
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const hubPkg = JSON.parse(await readFile(join(hubRoot, "package.json"), "utf8"));
const releaseBase = join(hubRoot, "release", hubPkg.version, "modules");
const moduleDir = join(releaseBase, `specloom-${pkg.version}`);
const childPath = relative(releaseBase, moduleDir);
if (!childPath || childPath.startsWith("..") || isAbsolute(childPath)) throw new Error("Unsafe module build directory");
await rm(moduleDir, { recursive: true, force: true });
await mkdir(moduleDir, { recursive: true });
await prepareHubModuleResources({ directory: moduleDir });

const zip = new JSZip();
/** @param {string} directory */
async function addFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) await addFiles(file);
    else zip.file(relative(moduleDir, file).replaceAll("\\", "/"), await readFile(file));
  }
}
await addFiles(moduleDir);
const archiveName = `specloom-module-${pkg.version}.zip`;
const archivePath = join(releaseBase, archiveName);
const archive = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
await writeFile(archivePath, archive);
const sha256 = createHash("sha256").update(archive).digest("hex");
const indexPath = updateModuleIndex(releaseBase, hubPkg.version, { id: "specloom", version: pkg.version, hostApiVersion: 2, entry: `specloom-${pkg.version}/renderer/index.html`, archive: archiveName, bytes: archive.length, sha256 });
await writeFile(join(releaseBase, `${archiveName}.sha256`), `${sha256}  ${archiveName}\n`);
await mkdir(join(hubRoot, "exports"), { recursive: true });
await cp(archivePath, join(hubRoot, "exports", archiveName));
await cp(join(releaseBase, `${archiveName}.sha256`), join(hubRoot, "exports", `${archiveName}.sha256`));
console.log(JSON.stringify({ archivePath, moduleDir, indexPath, bytes: archive.length, sha256 }, null, 2));
