import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchSourceElectron } from "./source-electron";

test("entity workbench mounts a component, fills a field and saves", async () => {
  test.setTimeout(120000);
  const data = await mkdtemp(path.join(os.tmpdir(), "specloom-entity-e2e-"));
  const application = await launchSourceElectron(data);
  try {
    const window = await application.firstWindow();
    await expect(window.getByRole("heading", { name: "SpecLoom", exact: true })).toBeVisible();
    await window.getByRole("button", { name: "创建示例项目" }).click();
    await expect(window.getByRole("heading", { name: "灯塔守望", exact: true })).toBeVisible();

    const component = [
      "---",
      "schemaVersion: 1",
      "id: health",
      "type: component",
      "title: 生命",
      "description: 生命值组件",
      "status: draft",
      "version: 1",
      "fields:",
      "  - key: current",
      "    label: 当前值",
      "    type: number",
      "    default: 100",
      "  - key: max",
      "    label: 最大值",
      "    type: number",
      "    default: 100",
      "---",
      "",
      "# 生命",
      "",
    ].join("\n");
    const created = await window.evaluate(async ({ component }) => {
      const api = globalThis.window.specloom;
      const state = await api.state();
      try {
        await api.saveDocument(state.project!.path, "specs/components/health.md", component, "absent");
        return { ok: true };
      } catch (error) {
        return { ok: false, message: String(error), error: error as { message?: string; code?: string; details?: unknown } };
      }
    }, { component });
    expect(created).toEqual({ ok: true });

    await window.getByRole("button", { name: "实体", exact: true }).click();
    await expect(window.getByRole("heading", { name: "实体工作台", exact: true })).toBeVisible();
    await expect(window.getByRole("tab", { name: "工作台", exact: true })).toHaveAttribute("aria-selected", "true");
    await window.getByRole("button", { name: /守灯人/ }).click();
    await window.getByRole("button", { name: /生命/ }).click();
    const currentInput = window.getByRole("spinbutton", { name: "当前值", exact: true });
    await expect(currentInput).toBeVisible();
    await currentInput.fill("90");
    await window.getByRole("button", { name: "保存资料" }).click();
    await expect(window.getByText("已保存", { exact: true })).toBeVisible({ timeout: 10000 });

    const saved = await window.evaluate(async () => {
      const api = globalThis.window.specloom;
      const state = await api.state();
      const docs = await api.documents();
      const entity = docs.find((item) => item.path === "specs/entities/characters/keeper.md")!;
      return (await api.readDocument(entity.path, entity.version)).content;
    });
    expect(saved).toContain("current: 90");
    await window.screenshot({ path: ".local/entity-workbench.png", fullPage: true });

    const layoutResult = await window.evaluate(async () => {
      const api = globalThis.window.specloom;
      const state = await api.state();
      await api.entityLayout!.save({ keeper: { health: { x: 12, y: 34 } } });
      return { projectPath: state.project!.path, layout: await api.entityLayout!.read() };
    });
    expect(layoutResult.layout).toEqual({ keeper: { health: { x: 12, y: 34 } } });
    const layoutFile = await readFile(path.join(layoutResult.projectPath, ".specloom", "editor", "entity-layouts.json"), "utf8");
    expect(JSON.parse(layoutFile)).toEqual({ keeper: { health: { x: 12, y: 34 } } });

    await window.getByRole("tab", { name: "详情", exact: true }).click();
    await expect(window.getByRole("tab", { name: "详情", exact: true })).toHaveAttribute("aria-selected", "true");
    await window.getByRole("tab", { name: "源码", exact: true }).click();
    await expect(window.getByRole("tab", { name: "源码", exact: true })).toHaveAttribute("aria-selected", "true");
  } finally {
    await application.close();
    await rm(data, { recursive: true, force: true });
  }
});
