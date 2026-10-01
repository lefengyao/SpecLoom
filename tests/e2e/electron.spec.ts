import { fileURLToPath } from "node:url";
import path from "node:path";
import { expect, test, _electron as electron } from "@playwright/test";

test("opens the packaged renderer behind the sandboxed preload", async () => {
  const environment = Object.fromEntries(Object.entries(process.env).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  ));
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.SPECLOOM_DEV_SERVER_URL;
  const application = await electron.launch({
    args: [path.resolve(fileURLToPath(new URL("../../", import.meta.url))), "--headless", "--disable-gpu"],
    env: environment,
  });
  try {
    const window = await application.firstWindow();
    await expect(window.getByRole("heading", { name: "SpecLoom" })).toBeVisible();
    await expect(window.getByRole("button", { name: "Select Godot Project" })).toBeDisabled();
    const preferences = await application.evaluate(({ BrowserWindow }) => {
      const activeWindow = BrowserWindow.getAllWindows()[0];
      const contents = activeWindow?.webContents as unknown as {
        getLastWebPreferences(): { sandbox: boolean; contextIsolation: boolean; nodeIntegration: boolean };
      };
      return contents.getLastWebPreferences();
    });
    expect(preferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false });
    expect(await window.evaluate(() => ({
      bridgeAvailable: "specloom" in window,
      nodeAvailable: "require" in window,
    }))).toEqual({ bridgeAvailable: true, nodeAvailable: false });
    await window.screenshot({ path: ".local/scaffold-desktop.png" });
  } finally {
    await application.close();
  }
});
