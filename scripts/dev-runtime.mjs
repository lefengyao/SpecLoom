import { mkdtemp, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer as createPortProbe } from "node:net";
import { fileURLToPath } from "node:url";
import { context } from "esbuild";
import { createServer } from "vite";

export const projectRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

/** @param {string} directory
 * @param {NodeJS.Platform} [platform]
 * @param {(candidate: string) => boolean} [accessible]
 */
export function installedProfileDirectory(directory, platform = process.platform, accessible = existsSync) {
  if (platform !== "win32" || !/^[a-z]:[\\/]/i.test(directory)) return directory;
  // Desktop packages can redirect Roaming reads to LocalCache while reporting the original path.
  // A local host share refers to the installation's actual profile; use it only when accessible.
  const resolved = path.win32.resolve(directory);
  const hostDirectory = `\\\\localhost\\${resolved[0]}$\\${resolved.slice(3)}`;
  return accessible(hostDirectory) ? hostDirectory : directory;
}

async function availableLocalPort() {
  const probe = createPortProbe();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Unable to allocate a local development port");
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve(undefined)));
  return address.port;
}

/** @param {{ entryPath: string; rendererUrl: string }} runtime
 * @param {NodeJS.ProcessEnv} [base]
 */
export function developmentEnvironment(runtime, base = process.env) {
  const profileRoot = process.platform === "win32"
    ? base.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
    : process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support")
      : base.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  /** @type {NodeJS.ProcessEnv} */
  const environment = {
    ...base,
    // Temporary entrypoints have no package name; Electron would otherwise use a different profile.
    SPECLOOM_USER_DATA_DIR: base.SPECLOOM_USER_DATA_DIR || installedProfileDirectory(path.join(profileRoot, "specloom")),
    SPECLOOM_DEV_ENTRY_PATH: runtime.entryPath,
    SPECLOOM_DEV_SERVER_URL: runtime.rendererUrl,
    SPECLOOM_DEV_APP_ROOT: projectRoot,
    NODE_PATH: [path.join(projectRoot, "node_modules"), base.NODE_PATH].filter(Boolean).join(path.delimiter),
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  return environment;
}

/** Chromium loads its encryption context before the application's setPath call.
 * @param {{ entryPath: string }} runtime
 * @param {NodeJS.ProcessEnv} environment
 */
export function developmentArguments(runtime, environment) {
  if (!environment.SPECLOOM_USER_DATA_DIR) throw new Error("The source runtime requires a user data directory");
  return [runtime.entryPath, `--user-data-dir=${environment.SPECLOOM_USER_DATA_DIR}`];
}

/** Source-only desktop runtime. Its emitted files and Vite cache live in OS temp. */
export async function createDevelopmentRuntime() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "specloom-dev-runtime-"));
  const entryPath = path.join(directory, "main", "main.cjs");
  /** @type {import('esbuild').BuildContext | undefined} */
  let buildContext;
  /** @type {import('vite').ViteDevServer | undefined} */
  let server;
  /** @type {(() => Promise<void>) | undefined} */
  let onRebuild;
  /** @type {Promise<void> | undefined} */
  let closing;
  const close = () => {
    closing ??= (async () => {
      onRebuild = undefined;
      await Promise.allSettled([buildContext?.dispose(), server?.close()]);
      const resolvedDirectory = path.resolve(directory);
      if (path.dirname(resolvedDirectory) !== path.resolve(os.tmpdir()) || !path.basename(resolvedDirectory).startsWith("specloom-dev-runtime-")) {
        throw new Error("Refusing to clean a development runtime outside the expected temporary directory");
      }
      await rm(resolvedDirectory, { recursive: true, force: true });
    })();
    return closing;
  };
  try {
    // Electron ignores NODE_PATH at bootstrap; a local link preserves normal package resolution.
    await symlink(path.join(projectRoot, "node_modules"), path.join(directory, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    server = await createServer({
      configFile: path.join(projectRoot, "vite.config.ts"),
      configLoader: "runner",
      cacheDir: path.join(directory, "vite-cache", "node_modules", ".vite"),
      server: { host: "127.0.0.1", port: await availableLocalPort(), strictPort: false },
    });
    await server.listen();
    await server.environments.client?.depsOptimizer?.scanProcessing;
    const rendererUrl = server.resolvedUrls?.local[0];
    if (!rendererUrl) throw new Error("Vite did not provide a local source renderer URL");
    buildContext = await context({
      absWorkingDir: projectRoot,
      entryPoints: { main: "src/main/main.ts", preload: "src/main/preload.ts", "chat-attachment-worker": "src/main/chat-attachment-worker.ts" },
      outdir: path.join(directory, "main"),
      outExtension: { ".js": ".cjs" },
      platform: "node",
      format: "cjs",
      target: "node24",
      bundle: true,
      packages: "external",
      sourcemap: true,
      logLevel: "warning",
      plugins: [{
        name: "development-source-reload",
        setup(build) {
          build.onEnd(async (result) => {
            if (!result.errors.length) await onRebuild?.();
          });
        },
      }],
    });
    await buildContext.rebuild();
    return {
      directory,
      entryPath,
      rendererUrl,
      projectRoot,
      close,
      /** @param {() => Promise<void>} callback */
      async watch(callback) {
        if (closing) throw new Error("The source runtime is already closed");
        onRebuild = callback;
        await buildContext?.watch();
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
