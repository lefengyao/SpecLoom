import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

/** @type {import('esbuild').BuildOptions} */
export const electronBuildOptions = {
  absWorkingDir: fileURLToPath(new URL("../", import.meta.url)),
  entryPoints: { main: "src/main/main.ts", preload: "src/main/preload.ts" },
  outdir: "dist/main",
  outExtension: { ".js": ".cjs" },
  platform: "node",
  format: "cjs",
  target: "node24",
  bundle: true,
  packages: "external",
  sourcemap: true,
  logLevel: "info",
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await build(electronBuildOptions);
}
