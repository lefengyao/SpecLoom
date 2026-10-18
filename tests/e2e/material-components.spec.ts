import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { parse } from "yaml";
import { FileStore } from "../../src/main/core/file-store";
import { Validator } from "../../src/main/core/validator";
import { launchSourceElectron } from "./source-electron";

async function saveMaterial(window: Page, project: string, directory: string) {
  const file = window.locator(".version-text");
  await expect(file).toBeVisible({ timeout: 20000 });
  const relative = (await file.getAttribute("title"))!;
  expect(relative).toMatch(new RegExp(`^specs/${directory}/[^/]+\\.md$`));
  await expect(window.getByLabel("名称", { exact: true })).toBeEnabled();
  const save = window.getByRole("button", { name: "保存资料", exact: true });
  if (await save.isEnabled()) await save.click();
  await expect(window.locator(".version-text")).toContainText("已保存", { timeout: 20000 });
  const content = await readFile(path.join(project, relative), "utf8");
  return { relative, content, data: parse(content.split("---")[1]!) as Record<string, unknown> };
}

test("name-first entities use separately managed components and nested parents", async () => {
  test.setTimeout(120000);
  const userData = await mkdtemp(path.join(os.tmpdir(), "specloom-material-e2e-"));
  const project = path.join(userData, "game");
  await mkdir(project);
  await mkdir(".local", { recursive: true });
  const app = await launchSourceElectron(userData);
  try {
    const window = await app.firstWindow();
    const errors: string[] = [];
    window.on("pageerror", (error) => errors.push(error.message));
    await expect(window.getByRole("heading", { name: "SpecLoom", exact: true })).toBeVisible({ timeout: 20000 });
    await expect(window.getByRole("button", { name: "创建示例项目", exact: true })).toBeEnabled();
    await window.evaluate((root) => globalThis.window.specloom.openProject(root), project);
    await window.reload();
    await expect(window.getByRole("heading", { name: "game", exact: true })).toBeVisible();
    const componentIds: Record<string, string> = {};
    for (const [template, title] of [["health", "生命值"], ["position", "坐标"], ["speed", "速度"]]) {
      await window.getByRole("button", { name: "组件", exact: true }).click();
      await window.getByRole("button", { name: "新建组件", exact: true }).click();
      const dialog = window.getByRole("dialog", { name: "新建组件" });
      await dialog.getByLabel("组件模板").selectOption(template!);
      await dialog.getByRole("button", { name: "创建组件", exact: true }).click();
      await expect(dialog).toBeHidden({ timeout: 20000 });
      await expect(window.getByLabel("名称", { exact: true })).toHaveValue(title!);
      await expect(window.getByLabel("字段名称 1")).toBeVisible();
      if (template === "health") await window.screenshot({ path: ".local/component-health.png", fullPage: true });
      const saved = await saveMaterial(window, project, "components");
      componentIds[template!] = String(saved.data.id);
      expect(saved.data.type).toBe("component");
    }
    await window.getByRole("button", { name: "实体", exact: true }).click();
    await window.getByRole("button", { name: "新建实体", exact: true }).click();
    const first = window.getByRole("dialog", { name: "新建实体" });
    await expect(first.getByRole("textbox")).toHaveCount(1);
    await first.getByLabel("名称", { exact: true }).fill("敌人");
    await first.getByRole("button", { name: "创建实体", exact: true }).click();
    await expect(first).toBeHidden({ timeout: 20000 });
    const parent = await saveMaterial(window, project, "entities");

    await window.getByRole("button", { name: "实体", exact: true }).click();
    await window.getByRole("button", { name: "新建实体", exact: true }).click();
    const child = window.getByRole("dialog", { name: "新建实体" });
    await child.getByLabel("名称", { exact: true }).fill("火焰哥布林");
    await child.getByRole("button", { name: "创建实体", exact: true }).click();
    await expect(child).toBeHidden({ timeout: 20000 });
    await window.getByLabel("父级资料", { exact: true }).selectOption(String(parent.data.id));
    await window.getByLabel("继承自", { exact: true }).selectOption(String(parent.data.id));
    await window.getByLabel("实体类型", { exact: true }).selectOption("enemy");
    for (const id of Object.values(componentIds)) {
      await window.getByLabel("选择组件", { exact: true }).selectOption(id);
      await window.getByRole("button", { name: "添加组件", exact: true }).click();
    }
    await window.getByLabel("生命值 · 当前值", { exact: true }).fill("160");
    await window.getByLabel("生命值 · 上限", { exact: true }).fill("160");
    await window.getByLabel("坐标 · X", { exact: true }).fill("12");
    await window.getByLabel("坐标 · Y", { exact: true }).fill("24");
    await window.getByLabel("速度 · 速度", { exact: true }).fill("210");
    await window.getByLabel("Markdown 正文").fill("# 火焰哥布林\n\n靠近玩家后发起攻击。");
    await window.getByLabel("分组", { exact: true }).fill("火焰生物");
    const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMw2pL3HwAExAJUkjHOGQAAAABJRU5ErkJggg==";
    await window.getByLabel("上传资料配图").setInputFiles({ name: "goblin.png", mimeType: "image/png", buffer: Buffer.from(image, "base64") });
    await expect(window.getByRole("button", { name: "更换配图", exact: true })).toBeVisible();
    await expect(window.locator(".material-image-preview img")).toBeVisible();
    await expect.poll(() => window.locator(".material-image-preview img").evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    const savedChild = await saveMaterial(window, project, "entities");
    expect(savedChild.data).toMatchObject({ title: "火焰哥布林", type: "enemy", group: "火焰生物", image: expect.stringMatching(/^assets\/specloom\/materials\//), parent: parent.data.id, extends: parent.data.id, components: [
      { id: componentIds.health, values: { current: 160, max: 160 } },
      { id: componentIds.position, values: { x: 12, y: 24 } },
      { id: componentIds.speed, values: { value: 210 } },
    ] });
    expect((await new Validator(new FileStore(project)).validate({ runGodot: false })).status).toBe("pass");
    const state = await window.evaluate(() => globalThis.window.specloom.state());
    expect(state.tasks).toEqual([]);
    await window.reload();
    await window.getByRole("button", { name: "实体", exact: true }).click();
    await window.getByLabel("筛选分组").selectOption("火焰生物");
    await expect(window.getByRole("list", { name: "资料列表" }).getByRole("listitem")).toHaveCount(1);
    await window.getByRole("button", { name: "列表显示", exact: true }).click();
    await window.getByRole("button", { name: "查看 火焰哥布林", exact: true }).click();
    await expect(window.getByLabel("分组", { exact: true })).toHaveValue("火焰生物");
    await expect(window.locator(".material-image-preview img")).toBeVisible();
    await window.getByRole("button", { name: "图标显示", exact: true }).click();
    await window.getByLabel("搜索资料").fill("不存在的资料");
    await expect(window.getByRole("list", { name: "资料列表" }).getByRole("listitem")).toHaveCount(0);
    await window.getByLabel("搜索资料").fill("");
    await window.getByRole("button", { name: "项目树", exact: true }).click();
    await window.getByRole("button", { name: "展开 敌人", exact: true }).click();
    await window.getByRole("tree").getByRole("button", { name: "火焰哥布林", exact: true }).click();
    await expect(window.getByLabel("生命值 · 当前值", { exact: true })).toHaveValue("160");
    await expect(window.getByLabel("父级资料", { exact: true })).toHaveValue(String(parent.data.id));
    await window.screenshot({ path: ".local/hierarchical-entity-components.png", fullPage: true });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});
