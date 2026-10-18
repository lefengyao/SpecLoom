import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { createDevelopmentRuntime, developmentEnvironment, projectRoot } from "./dev-runtime.mjs";

/** @type {Awaited<ReturnType<typeof createDevelopmentRuntime>> | undefined} */
let runtime;
/** @type {import('node:child_process').ChildProcess | undefined} */
let testProcess;
let stopping = false;

/** @param {number} [exitCode] */
async function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  const child = testProcess;
  testProcess = undefined;
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    if (process.platform === "win32" && child.pid) {
      const termination = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
      await once(termination, "exit");
    } else child.kill();
    await exited;
  }
  await runtime?.close();
  process.exit(exitCode);
}

process.once("SIGINT", () => void shutdown(130));
process.once("SIGTERM", () => void shutdown(143));

try {
  runtime = await createDevelopmentRuntime();
  const playwrightCli = createRequire(import.meta.url).resolve("@playwright/test/cli");
  console.log(`Testing SpecLoom source: ${runtime.rendererUrl}`);
  const child = spawn(process.execPath, [playwrightCli, "test", ...process.argv.slice(2)], {
    cwd: projectRoot,
    stdio: "inherit",
    env: developmentEnvironment(runtime),
  });
  testProcess = child;
  const [code] = await once(child, "exit");
  await shutdown(typeof code === "number" ? code : 1);
} catch (error) {
  console.error(error);
  await shutdown(1);
}
