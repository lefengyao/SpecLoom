import { _electron as electron } from "@playwright/test";
import { developmentArguments } from "../../scripts/dev-runtime.mjs";

/** Launch only the temporary source entrypoint prepared by scripts/test-e2e.mjs. */
export async function launchSourceElectron(userData: string) {
  const entryPath = process.env.SPECLOOM_DEV_ENTRY_PATH;
  const rendererUrl = process.env.SPECLOOM_DEV_SERVER_URL;
  const projectRoot = process.env.SPECLOOM_DEV_APP_ROOT;
  if (!entryPath || !rendererUrl || !projectRoot) {
    throw new Error("Source Electron tests require npm run test:e2e to prepare the development runtime");
  }
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  delete env.ELECTRON_RUN_AS_NODE;
  env.SPECLOOM_USER_DATA_DIR = userData;
  return electron.launch({
    args: [...developmentArguments({ entryPath }, env), "--headless", "--disable-gpu"],
    cwd: projectRoot,
    env,
  });
}
