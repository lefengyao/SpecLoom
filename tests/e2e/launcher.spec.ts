import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchSourceElectron } from "./source-electron";

test("returns from a project to the launcher", async () => {
  test.setTimeout(120000);
  const data = await mkdtemp(path.join(os.tmpdir(), "specloom-launcher-e2e-"));
  const application = await launchSourceElectron(data);
  try {
    const window = await application.firstWindow();
    await expect(window.getByRole("heading", { name: "SpecLoom", exact: true })).toBeVisible({ timeout: 20000 });
    await window.getByRole("button", { name: "创建示例项目" }).click();
    await expect(window.getByRole("heading", { name: "灯塔守望", exact: true })).toBeVisible({ timeout: 20000 });
    await window.getByRole("button", { name: "返回初始界面" }).click();
    await expect(window.getByRole("button", { name: "创建示例项目" })).toBeVisible({ timeout: 20000 });
    await expect(window.getByRole("heading", { name: "灯塔守望", exact: true })).toHaveCount(0);
  } finally {
    await application.close();
    await rm(data, { recursive: true, force: true });
  }
});
