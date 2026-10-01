import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { context } from "esbuild";
import { createServer } from "vite";
import { electronBuildOptions } from "./electron-build.mjs";

const projectRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
/** @type {string} */
const electronPath = createRequire(import.meta.url)("electron");
/** @type {import('node:child_process').ChildProcess | undefined} */
let electronProcess;
/** @type {import('esbuild').BuildContext | undefined} */
let buildContext;
/** @type {import('vite').ViteDevServer | undefined} */
let server;
let stopping = false;

/** @param {number} [exitCode] */
async function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  const child = electronProcess;
  electronProcess = undefined;
  child?.kill();
  await buildContext?.dispose();
  await server?.close();
  process.exit(exitCode);
}

/** @param {string} rendererUrl */
async function restartElectron(rendererUrl) {
  const previous = electronProcess;
  electronProcess = undefined;
  if (previous && previous.exitCode === null) {
    const exited = once(previous, "exit");
    previous.kill();
    await exited;
  }
  if (stopping) return;
  /** @type {NodeJS.ProcessEnv} */
  const environment = { ...process.env, SPECLOOM_DEV_SERVER_URL: rendererUrl };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, [projectRoot], {
    cwd: projectRoot,
    stdio: "inherit",
    env: environment,
  });
  electronProcess = child;
  child.once("error", (error) => {
    console.error(error);
    void shutdown(1);
  });
  child.once("exit", (code) => {
    if (electronProcess === child) void shutdown(code ?? 0);
  });
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

try {
  server = await createServer({ configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)) });
  await server.listen();
  const rendererUrl = server.resolvedUrls?.local[0];
  if (!rendererUrl) throw new Error("Vite did not provide a local renderer URL");
  console.log(`SpecLoom renderer: ${rendererUrl}`);
  buildContext = await context({
    ...electronBuildOptions,
    plugins: [{
      name: "restart-electron-after-build",
      setup(build) {
        build.onEnd(async (result) => {
          if (result.errors.length === 0 && !stopping) await restartElectron(rendererUrl);
        });
      },
    }],
  });
  await buildContext.watch();
} catch (error) {
  console.error(error);
  await shutdown(1);
}
