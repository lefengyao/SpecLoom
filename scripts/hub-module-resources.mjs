import { cp, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build as bundle } from "esbuild";
import { build as buildRenderer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));

/**
 * Prepare current source resources in a caller-owned, existing empty directory.
 * The caller decides whether to install development resources or publish a ZIP.
 * This function never clears directories or writes publication indexes/archives.
 * @param {{ directory: string }} options
 */
export async function prepareHubModuleResources({ directory }) {
  if (typeof directory !== "string" || !isAbsolute(directory)) throw new Error("Hub module resources require an absolute directory");
  const target = resolve(directory);
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Hub module resources require a real directory, not a link");
  if ((await readdir(target)).length) throw new Error("Hub module resources require an empty directory");
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

  await buildRenderer({
    configFile: join(root, "vite.config.ts"),
    build: { outDir: join(target, "renderer"), emptyOutDir: false },
  });
  await mkdir(join(target, "runtime"));
  await bundle({
    absWorkingDir: root, entryPoints: ["src/main/hub-module.ts"], outfile: join(target, "runtime/backend.mjs"),
    bundle: true, platform: "node", format: "esm", target: "node24", external: ["electron", "pdfjs-dist/*"],
    banner: { js: "import { createRequire as createNodeRequire } from 'node:module'; const require = createNodeRequire(import.meta.url);" },
    legalComments: "linked", logLevel: "info",
  });
  await bundle({
    absWorkingDir: root, entryPoints: ["src/main/preload.ts"], outfile: join(target, "runtime/preload.cjs"),
    bundle: true, platform: "node", format: "cjs", target: "node24", external: ["electron"], legalComments: "linked", logLevel: "info",
  });
  // This isolated parser includes its ZIP/XML dependencies. PDF.js stays external
  // so its worker, fonts and native canvas resolve from the copied assets below.
  await bundle({
    absWorkingDir: root, entryPoints: ["src/main/chat-attachment-worker.ts"], outfile: join(target, "runtime/chat-attachment-worker.cjs"),
    bundle: true, platform: "node", format: "cjs", target: "node24", external: ["pdfjs-dist/*"], legalComments: "linked", logLevel: "info",
  });
  await cp(join(root, "skills"), join(target, "skills"), { recursive: true });
  await cp(join(root, "resources/godot-mcp"), join(target, "resources/godot-mcp"), { recursive: true });
  // PDF.js loads its worker and optional native canvas relative to the module.
  for (const name of ["package.json", "LICENSE", "legacy/build", "cmaps", "standard_fonts", "wasm"]) {
    await cp(join(root, "node_modules/pdfjs-dist", name), join(target, "node_modules/pdfjs-dist", name), { recursive: true, filter: file => !file.endsWith(".map") });
  }
  for (const name of ["@napi-rs/canvas", "@napi-rs/canvas-win32-x64-msvc"]) {
    await cp(join(root, "node_modules", name), join(target, "node_modules", name), { recursive: true });
  }
  await cp(join(root, "docs/trailblazer-hub-module.md"), join(target, "INSTALL.md"));
  const manifest = {
    schemaVersion: 1, id: "specloom", name: "SpecLoom", version: pkg.version,
    host: "trailblazer-hub", hostApiVersion: 2, minimumHostVersion: "0.1.6",
    platform: "win32", arch: "x64", entry: "renderer/index.html", icon: "renderer/brand/icon.png", multiInstance: true,
    runtime: { entry: "runtime/backend.mjs", preload: "runtime/preload.cjs" },
    capabilities: ["workspace", "agent", "file-dialog", "encrypted-storage", "local-mcp", "skills", "offline-documents", "godot-plugin-management", "context-compression", "web-search"],
    source: { project: "SpecLoom", version: pkg.version },
  };
  await writeFile(join(target, "module.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  return manifest;
}
