import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchSourceElectron } from "./source-electron";

test("workflow page copies the official template and renders its nodes", async () => {
  test.setTimeout(120000);
  const data = await mkdtemp(path.join(os.tmpdir(), "specloom-workflow-e2e-"));
  const application = await launchSourceElectron(data);
  try {
    const window = await application.firstWindow();
    await expect(window.getByRole("heading", { name: "SpecLoom", exact: true })).toBeVisible({ timeout: 20000 });
    await window.getByRole("button", { name: "创建示例项目" }).click();
    await expect(window.getByRole("heading", { name: "灯塔守望", exact: true })).toBeVisible();
    await window.getByRole("button", { name: "工作流", exact: true }).click();
    await expect(window.getByRole("heading", { name: "工作流", exact: true })).toBeVisible();
    await expect(window.getByText("官方开发审查流程可复制、可编辑、可运行")).toBeVisible();
    await window.getByRole("button", { name: "从官方复制" }).click();
    await expect(window.getByText("Agent 实现", { exact: true })).toBeVisible({ timeout: 20000 });
    await expect(window.getByText("读取规范", { exact: true })).toBeVisible();
    await expect(window.getByText("自动校验", { exact: true })).toBeVisible();
    await expect(window.getByText("人工审查", { exact: true })).toBeVisible();
    await expect(window.getByText("记录决策", { exact: true })).toBeVisible();
    await window.getByRole("button", { name: /添加只读 Agent/ }).click();
    await expect(window.getByText("只读 Agent", { exact: true })).toBeVisible();
    await window.getByRole("button", { name: "保存", exact: true }).click();
    await expect(window.getByText("未保存", { exact: true })).toHaveCount(0);
    await expect(window.getByText(/7 节点 · 1 写入/)).toBeVisible();
    await window.screenshot({ path: ".local/workflow-page.png", fullPage: true });
  } finally {
    await application.close();
    await rm(data, { recursive: true, force: true });
  }
});
