import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { writeMaterial } from "../../src/shared/project-materials";
import { launchSourceElectron } from "./source-electron";

test("material views preserve parent hierarchy, filters, editor selection and local scrolling at narrow widths", async () => {
  test.setTimeout(120000);
  const userData = await mkdtemp(path.join(os.tmpdir(), "specloom-material-views-"));
  const project = path.join(userData, "game");
  const files: Record<string, string> = {
    "specs/project.md": writeMaterial({ schemaVersion: 1, id: "project", title: "导航验证", description: "资料浏览与响应式布局验证", materialGroups: { entity: [
      { id: "characters", name: "角色分组", order: 0 },
      { id: "guards", name: "守卫分组", parentId: "characters", order: 0 },
      { id: "empty", name: "空分组", order: 1 },
    ] } }, "# 导航验证"),
    "specs/entities/character.md": writeMaterial({ schemaVersion: 1, id: "character", title: "巡逻角色", type: "character", groupId: "characters", components: [] }, "# 巡逻角色"),
    "specs/entities/guard.md": writeMaterial({ schemaVersion: 1, id: "guard", title: "前院守卫", type: "enemy", parent: "character", extends: "template", groupId: "guards", components: [{ id: "health", values: {} }] }, "# 前院守卫"),
    "specs/entities/elite.md": writeMaterial({ schemaVersion: 1, id: "elite", title: "精英守卫", type: "enemy", parent: "guard", extends: "template", groupId: "guards", components: [] }, "# 精英守卫"),
    "specs/entities/template.md": writeMaterial({ schemaVersion: 1, id: "template", title: "角色模板", type: "character", groupId: "characters", components: [] }, "# 角色模板"),
    "specs/entities/orphan.md": writeMaterial({ schemaVersion: 1, id: "orphan", title: "缺失父级", type: "entity", parent: "missing", components: [] }, "# 缺失父级"),
    "specs/entities/unparsed.md": "# 尚未归类的文档",
    "specs/components/health.md": writeMaterial({ schemaVersion: 1, id: "health", title: "生命值", type: "component", parent: "state_machine", fields: [] }, "# 生命值"),
  };
  for (const [relativePath, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(project, relativePath)), { recursive: true });
    await writeFile(path.join(project, relativePath), content);
  }
  const app = await launchSourceElectron(userData);
  try {
    const window = await app.firstWindow();
    await window.setViewportSize({ width: 860, height: 780 });
    await expect(window.getByRole("main").getByRole("button", { name: "打开项目", exact: true })).toBeEnabled();
    await window.evaluate(root => globalThis.window.specloom.openProject(root), project);
    await window.reload();
    await window.getByRole("button", { name: "实体", exact: true }).click();
    const explorer = window.getByRole("region", { name: "资料浏览器" });
    await expect(explorer.getByRole("button", { name: "查看 前院守卫", exact: true })).toBeVisible();
    await expect(window.locator(".error-notice")).toHaveCount(0);
    await expect(explorer.getByRole("button", { name: "列表显示" })).toHaveAttribute("aria-pressed", "true");
    await expect(explorer.getByRole("button", { name: "展开分组栏" })).toHaveAttribute("aria-expanded", "false");
    await expect(explorer.getByRole("tree", { name: "分组列表" })).toHaveCount(0);
    await explorer.getByRole("button", { name: "展开分组栏" }).click();
    await explorer.getByRole("treeitem", { name: /^角色分组/ }).click();
    await explorer.getByRole("button", { name: "收起分组栏" }).click();
    await explorer.getByRole("button", { name: "展开 前院守卫", exact: true }).click();
    await expect(explorer.getByRole("list", { name: "前院守卫的子资料", exact: true }).getByRole("button", { name: "查看 精英守卫", exact: true })).toBeVisible();
    await explorer.getByRole("button", { name: "关系图显示" }).click();
    const graph = explorer.getByRole("region", { name: "父级关系画布" });
    await expect(graph.getByRole("button", { name: "查看 巡逻角色", exact: true })).toContainText("根资料");
    const edges = await graph.locator(".material-graph-edge").evaluateAll(elements => elements.map(element => [element.getAttribute("data-source"), element.getAttribute("data-target")]));
    expect(edges).toEqual(expect.arrayContaining([
      ["specs/entities/character.md", "specs/entities/guard.md"],
      ["specs/entities/guard.md", "specs/entities/elite.md"],
    ]));
    expect(edges).toHaveLength(2);
    await expect(graph.getByRole("button", { name: "查看 角色模板", exact: true })).toBeVisible();
    await graph.getByRole("button", { name: "查看 前院守卫", exact: true }).click();
    await expect(window.getByRole("textbox", { name: "名称", exact: true })).toHaveValue("前院守卫");
    await expect(window.getByLabel("父级资料", { exact: true })).toHaveValue("character");
    await expect(window.getByLabel("继承自", { exact: true })).toHaveValue("template");
    await expect(window.getByLabel("分组", { exact: true })).toHaveValue("guards");
    await expect(window.getByRole("region", { name: "实体组件" })).toContainText("生命值");
    await explorer.getByLabel("筛选实体类型").selectOption("enemy");
    await expect(explorer.locator(".explorer-count")).toHaveText("2 项 / 共 6 项");
    await expect(graph.getByRole("button", { name: "查看 巡逻角色", exact: true })).toContainText("路径上下文");
    await explorer.getByLabel("搜索资料").fill("精英");
    await expect(explorer.locator(".explorer-count")).toHaveText("1 项 / 共 6 项");
    await expect(graph.getByRole("button", { name: "查看 前院守卫", exact: true })).toContainText("路径上下文");
    await expect(graph.getByRole("button", { name: "查看 前院守卫", exact: true })).toHaveAttribute("aria-pressed", "true");

    const horizontalOverflow = () => window.evaluate(() => ({
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      content: document.querySelector(".main-content")!.scrollWidth - document.querySelector(".main-content")!.clientWidth,
    }));
    expect(await horizontalOverflow()).toEqual({ page: 0, content: 0 });
    expect(await graph.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
    const pageScroll = await window.evaluate(() => ({ x: globalThis.window.scrollX, content: document.querySelector(".main-content")!.scrollLeft }));
    await graph.focus();
    await graph.press("ArrowRight");
    expect(await graph.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    expect(await window.evaluate(() => ({ x: globalThis.window.scrollX, content: document.querySelector(".main-content")!.scrollLeft }))).toEqual(pageScroll);
    const wheelStart = Number((await explorer.getByLabel("关系图缩放比例").textContent())!.replace("%", ""));
    const graphBox = (await graph.boundingBox())!;
    const panPoint = { x: graphBox.x + graphBox.width - 32, y: graphBox.y + graphBox.height - 36 };
    await window.mouse.move(panPoint.x, panPoint.y);
    await window.mouse.wheel(0, -120);
    await expect.poll(async () => Number((await explorer.getByLabel("关系图缩放比例").textContent())!.replace("%", ""))).toBeGreaterThan(wheelStart);
    const beforeDrag = await graph.evaluate(element => element.scrollLeft);
    await window.mouse.move(panPoint.x, panPoint.y);
    await window.mouse.down();
    await window.mouse.move(panPoint.x - 48, panPoint.y, { steps: 3 });
    await window.mouse.up();
    expect(await graph.evaluate(element => element.scrollLeft)).toBeGreaterThan(beforeDrag);
    await explorer.getByRole("button", { name: "适配视图" }).click();
    expect(await graph.evaluate(element => element.scrollLeft)).toBe(0);
    expect(await graph.evaluate(element => element.clientHeight)).toBeLessThan(400);
    expect(await graph.evaluate(element => element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1)).toBe(true);
    const scale = explorer.getByLabel("关系图缩放比例");
    const fittedScale = Number((await scale.textContent())!.replace("%", ""));
    await explorer.getByRole("button", { name: "放大关系图" }).click();
    expect(Number((await scale.textContent())!.replace("%", ""))).toBeGreaterThan(fittedScale);
    await explorer.getByRole("button", { name: "缩小关系图" }).click();
    await expect(explorer.getByRole("button", { name: "放大关系图" })).toBeEnabled();
    await explorer.locator(".explorer-toolbar").scrollIntoViewIfNeeded();
    await expect(window.locator(".error-notice")).toHaveCount(0);
    await window.screenshot({ path: ".local/navigation-materials-narrow-graph.png" });

    await explorer.getByRole("button", { name: "图标显示" }).click();
    await expect(explorer.getByLabel("搜索资料")).toHaveValue("精英");
    await expect(explorer.getByLabel("筛选实体类型")).toHaveValue("enemy");
    const iconTree = explorer.getByRole("list", { name: "资料图标层级", exact: true });
    const characterContext = iconTree.getByRole("button", { name: "查看 巡逻角色", exact: true });
    const guardContext = iconTree.getByRole("button", { name: "查看 前院守卫", exact: true });
    await expect(characterContext).toContainText("路径上下文");
    await expect(guardContext).toContainText("路径上下文");
    await expect(guardContext.locator(".material-type-badge")).toHaveText("敌人");
    await expect(guardContext).toHaveAttribute("aria-pressed", "true");
    await expect(iconTree.getByRole("list", { name: "巡逻角色的子资料", exact: true }).getByRole("button", { name: "查看 前院守卫", exact: true })).toBeVisible();
    expect((await characterContext.boundingBox())?.width ?? 0).toBeGreaterThan(180);
    expect((await guardContext.boundingBox())?.height ?? Infinity).toBeLessThan(130);
    const expandGuard = iconTree.getByRole("button", { name: "展开 前院守卫", exact: true });
    if (await expandGuard.count()) await expandGuard.click();
    await expect(iconTree.getByRole("list", { name: "前院守卫的子资料", exact: true }).getByRole("button", { name: "查看 精英守卫", exact: true })).toBeVisible();
    expect(await horizontalOverflow()).toEqual({ page: 0, content: 0 });
    await window.screenshot({ path: ".local/navigation-materials-icon-hierarchy.png" });
    await explorer.getByLabel("搜索资料").fill("不存在的资料");
    await expect(explorer.getByText("没有符合条件的资料，可调整搜索或筛选条件。")).toBeVisible();
    await explorer.getByRole("button", { name: "清除其他筛选" }).click();
    await explorer.getByRole("button", { name: "展开分组栏" }).click();
    await expect(explorer.getByRole("treeitem", { name: /^角色分组/ })).toHaveAttribute("aria-selected", "true");
    await explorer.getByRole("treeitem", { name: /^空分组/ }).click();
    await expect(explorer.getByText(/这是一个空分组/)).toBeVisible();
    await explorer.getByRole("treeitem", { name: /^全部资料/ }).click();
    await explorer.getByRole("button", { name: "收起分组栏" }).click();
    await explorer.getByRole("button", { name: "关系图显示" }).click();
    await expect(explorer.getByRole("region", { name: "关系错误" }).getByRole("button", { name: "查看 缺失父级", exact: true })).toBeVisible();
    await expect(explorer.getByRole("region", { name: "未归类" }).getByRole("button", { name: "查看 unparsed.md", exact: true })).toBeVisible();

    await window.getByRole("button", { name: "组件", exact: true }).click();
    await explorer.getByRole("button", { name: "列表显示" }).click();
    await expect(explorer.getByRole("list", { name: "状态机基类的子资料", exact: true }).getByRole("button", { name: "查看 生命值", exact: true })).toContainText("自定义组件");
    await explorer.getByLabel("组件来源").selectOption("user");
    for (const mode of ["列表显示", "关系图显示", "图标显示"]) {
      await explorer.getByRole("button", { name: mode }).click();
      await expect(explorer.getByLabel("组件来源")).toHaveValue("user");
      await expect(explorer.locator(".explorer-count")).toHaveText("1 项 / 共 2 项");
      await expect(explorer.getByRole("button", { name: "查看 生命值", exact: true })).toContainText("自定义组件");
      if (mode === "图标显示") {
        const componentIcons = explorer.getByRole("list", { name: "资料图标层级", exact: true });
        const parent = componentIcons.getByRole("button", { name: "查看 状态机基类", exact: true });
        await expect(parent).toContainText("路径上下文");
        await expect(componentIcons.getByRole("list", { name: "状态机基类的子资料", exact: true }).getByRole("button", { name: "查看 生命值", exact: true })).toBeVisible();
      }
      else {
        const ancestor = explorer.getByRole("button", { name: "查看 状态机基类", exact: true });
        await expect(ancestor).toContainText("官方组件");
        await expect(ancestor).toContainText("路径上下文");
      }
      expect(await horizontalOverflow()).toEqual({ page: 0, content: 0 });
    }
    await explorer.getByRole("button", { name: "关系图显示" }).click();
    await explorer.getByRole("button", { name: "查看 生命值", exact: true }).click();
    await expect(window.getByRole("textbox", { name: "名称", exact: true })).toHaveValue("生命值");
    await expect(window.getByLabel("父级资料", { exact: true })).toHaveValue("state_machine");
    await explorer.getByLabel("组件来源").selectOption("system");
    await expect(explorer.getByRole("button", { name: "查看 状态机基类", exact: true })).toContainText("官方组件");
    await expect(explorer.getByRole("button", { name: "查看 生命值", exact: true })).toHaveCount(0);
    await window.setViewportSize({ width: 1280, height: 780 });
    await expect(explorer.getByRole("button", { name: "展开分组栏" })).toHaveAttribute("aria-expanded", "false");
    await explorer.getByRole("button", { name: "展开分组栏" }).click();
    await window.setViewportSize({ width: 860, height: 780 });
    await expect(explorer.getByRole("button", { name: "收起分组栏" })).toHaveAttribute("aria-expanded", "true");
    await explorer.getByRole("button", { name: "收起分组栏" }).click();
  } finally {
    await app.evaluate(({ BrowserWindow }) => { for (const browserWindow of BrowserWindow.getAllWindows()) browserWindow.destroy(); });
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test("retained pages navigate promptly, retain drafts, and badge component identity in a continuous tree", async () => {
  test.setTimeout(120000);
  const userData = await mkdtemp(path.join(os.tmpdir(), "specloom-navigation-"));
  const project = path.join(userData, "game");
  await mkdir(path.join(project, "specs", "components"), { recursive: true });
  await writeFile(path.join(project, "specs", "components", "copied.md"), writeMaterial({
    schemaVersion: 1, id: "copied", title: "我的组件", type: "component", parent: "state_machine", scope: "system", group: "官方组件", fields: [],
  }, ""));
  const app = await launchSourceElectron(userData);
  try {
    const window = await app.firstWindow();
    await expect(window.getByRole("main").getByRole("button", { name: "打开项目", exact: true })).toBeEnabled();
    await window.evaluate(root => globalThis.window.specloom.openProject(root), project);
    await window.reload();
    await expect(window.getByRole("heading", { name: "game", exact: true })).toBeVisible();
    await window.getByRole("button", { name: "组件", exact: true }).click();
    const explorer = window.getByRole("region", { name: "资料浏览器" });
    await expect(explorer.getByRole("button", { name: "收起分组栏" })).toHaveAttribute("aria-expanded", "true");
    await expect(explorer.getByRole("button", { name: "查看 状态机基类", exact: true })).toContainText("官方组件");
    await expect(explorer.getByRole("list", { name: "状态机基类的子资料", exact: true }).getByRole("button", { name: "查看 我的组件", exact: true })).toContainText("自定义组件");
    await expect(explorer.getByRole("group", { name: "官方组件", exact: true })).toHaveCount(0);
    await expect(explorer.getByRole("group", { name: "自定义组件", exact: true })).toHaveCount(0);
    await window.getByRole("button", { name: "查看 我的组件", exact: true }).click();
    await window.getByRole("textbox", { name: "说明", exact: true }).fill("切页保留草稿");
    await window.evaluate(() => {
      (globalThis.window as unknown as { retainedEditor: Element | null }).retainedEditor = document.querySelector(".document-editor");
    });
    const timings = await window.evaluate(async () => {
      const durations: number[] = [];
      const click = (name: string) => (Array.from(document.querySelectorAll<HTMLButtonElement>(".workspace-tabs button")).find(button => button.textContent?.trim() === name))!.click();
      const painted = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      for (let index = 0; index < 10; index++) {
        click("设置"); await painted();
        const start = performance.now(); click("组件"); await painted();
        durations.push(performance.now() - start);
      }
      return durations.sort((left, right) => left - right);
    });
    console.log(`Retained navigation: median=${timings[5]!.toFixed(1)}ms p95=${timings[9]!.toFixed(1)}ms (click to two animation frames)`);
    expect(timings[9]).toBeLessThan(500);
    expect(await window.evaluate(() => document.querySelector(".document-editor") === (globalThis.window as unknown as { retainedEditor: Element }).retainedEditor)).toBe(true);
    await expect(window.getByRole("textbox", { name: "说明", exact: true })).toHaveValue("切页保留草稿");
    const overflow = await window.locator(".main-content").evaluate(element => getComputedStyle(element).overflowY);
    expect(overflow).toBe("auto");
    await window.getByRole("button", { name: "工作区", exact: true }).click();
    const box = await window.locator(".chat-workbench").boundingBox();
    expect(box?.height).toBeGreaterThan(200);
    await window.getByRole("button", { name: "组件", exact: true }).click();
    await expect(window.getByRole("textbox", { name: "说明", exact: true })).toHaveValue("切页保留草稿");
    await window.screenshot({ path: ".local/navigation-components.png" });
    await window.getByRole("button", { name: "保存资料", exact: true }).click();
    await expect(window.locator(".version-text")).toContainText("已保存", { timeout: 20000 });
  } catch (error) {
    console.error(error);
    throw error;
  } finally {
    // Test projects can have a dirty editor when an assertion fails.
    await app.evaluate(({ BrowserWindow }) => { for (const browserWindow of BrowserWindow.getAllWindows()) browserWindow.destroy(); });
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});
