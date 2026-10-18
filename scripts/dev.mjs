import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { createDevelopmentRuntime, developmentEnvironment, developmentArguments, projectRoot } from "./dev-runtime.mjs";

/** @type {string} */
const electronPath = createRequire(import.meta.url)("electron");
/** @type {import('node:child_process').ChildProcess | undefined} */
let electronProcess;
/** @type {Awaited<ReturnType<typeof createDevelopmentRuntime>> | undefined} */
let runtime;
let stopping = false;

/** @param {number} [exitCode] */
async function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  const child = electronProcess;
  electronProcess = undefined;
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
  await runtime?.close();
  process.exit(exitCode);
}

async function restartElectron() {
  const previous = electronProcess;
  electronProcess = undefined;
  if (previous && previous.exitCode === null && previous.signalCode === null) {
    const exited = once(previous, "exit");
    previous.kill();
    await exited;
  }
  if (stopping || !runtime) return;
  const environment = developmentEnvironment(runtime);
  const child = spawn(electronPath, developmentArguments(runtime, environment), {
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
  runtime = await createDevelopmentRuntime();
  console.log(`SpecLoom source renderer: ${runtime.rendererUrl}`);
  await runtime.watch(restartElectron);
} catch (error) {
  console.error(error);
  await shutdown(1);
}
