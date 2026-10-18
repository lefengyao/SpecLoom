import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type ElectronApplication, type Locator, type Page, type TestInfo } from "@playwright/test";
import { launchSourceElectron } from "./source-electron";

const longTitle = "规划灯塔守望中跨场景角色移动与地图系统的完整实施方案以及长期维护约定".repeat(4);
const longModel = "layout-very-long-model-name-with-extended-reasoning-and-project-capabilities";
const evidenceRoot = path.resolve(".local/evidence-layout");
type Measurement = Awaited<ReturnType<typeof measure>>;

async function prepareChat(page: Page, port = 9) {
  page.on("pageerror", error => console.log("layout-page-error", error.message));
  await page.getByRole("button", { name: "创建示例项目", exact: true }).click();
  await expect(page.getByRole("heading", { name: "灯塔守望", exact: true })).toBeVisible();
  await page.evaluate(async ({ model, port }) => {
    await window.specloom.providers!.save({ id: "layout-fixture", name: "布局验证长供应商名称 Layout Provider", protocol: "openai", baseUrl: `http://127.0.0.1:${port}/v1`, models: [model] });
    await window.specloom.setDefaultModel!({ providerId: "layout-fixture", model });
  }, { model: longModel, port });
  await page.reload();
  await page.getByRole("button", { name: "新建会话", exact: true }).first().click().catch(async error => { console.log("layout-setup-body", await page.locator("body").innerText()); throw error; });
  await expect(page.getByLabel("任务消息")).toBeEnabled();
  await page.locator(".session-settings-toggle").first().click();
  await page.getByLabel("会话名称", { exact: true }).fill(longTitle);
  await page.getByRole("button", { name: "保存名称", exact: true }).click();
  await expect(page.locator(".conversation-heading h2")).toHaveText(longTitle);
  await page.locator(".session-settings-toggle").first().click();
  await expect(page.getByLabel("选择模型", { exact: true })).toHaveValue(`layout-fixture:${longModel}`);
}

async function resize(app: ElectronApplication, page: Page, width: number, height: number, zoom = 1) {
  await app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    window.setContentSize(size.width, size.height);
    window.webContents.setZoomFactor(size.zoom);
  }, { width, height, zoom });
  await expect.poll(() => page.evaluate(() => innerHeight)).toBe(Math.round(height / zoom));
}

async function measure(page: Page, scenario: string) {
  return page.evaluate(scenario => {
    const box = (selector: string) => {
      const node = document.querySelector<HTMLElement>(selector)!;
      const rect = node.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, scrollHeight: node.scrollHeight };
    };
    return { scenario, viewport: { width: innerWidth, height: innerHeight }, reading: box(".conversation-timeline"), composer: box(".session-composer"), input: box(".session-composer textarea"), title: box(".conversation-heading h2"), model: box('[aria-label="选择模型"]'), footer: box(".session-composer footer"), guidance: document.querySelector(".guidance-queue") ? box(".guidance-queue") : null, attachments: document.querySelector(".attachment-tray") ? box(".attachment-tray") : null };
  }, scenario);
}

async function evidence(page: Page, testInfo: TestInfo, scenario: string, measurements: Measurement[]) {
  measurements.push(await measure(page, scenario));
  await mkdir(evidenceRoot, { recursive: true });
  const screenshot = path.join(evidenceRoot, `${scenario}.png`);
  await page.screenshot({ path: screenshot });
  await writeFile(path.join(evidenceRoot, `${testInfo.title.includes("narrow") ? "narrow" : "desktop"}-measurements.json`), JSON.stringify(measurements, null, 2));
  await testInfo.attach(scenario, { path: screenshot, contentType: "image/png" });
  console.log("layout", JSON.stringify(measurements.at(-1)));
}

async function reachable(locator: Locator) {
  await expect(locator).toBeVisible();
  expect(await locator.evaluate(node => {
    const rect = node.getBoundingClientRect();
    const within = rect.x >= 0 && rect.y >= 0 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1;
    const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return within && (target === node || !!target && node.contains(target));
  })).toBe(true);
}

async function controlsReachable(page: Page) {
  for (const label of ["选择模型", "思考偏好", "联网搜索", "审批权限"]) await reachable(page.getByLabel(label, { exact: true }));
  await reachable(page.getByRole("button", { name: "添加附件或资料", exact: true }));
  await reachable(page.getByRole("button", { name: "发送", exact: true }));
  const overflow = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, nodes: [...document.querySelectorAll<HTMLElement>("body *")].filter(node => { const rect = node.getBoundingClientRect(); return rect.width > 0 && rect.right > innerWidth + 1 && !node.closest("[inert]") && getComputedStyle(node).position !== "fixed"; }).map(node => ({ tag: node.tagName, class: node.className, right: node.getBoundingClientRect().right })).slice(0, 12) }));
  expect(overflow.scrollWidth, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.width);
}

async function removeProfile(profile: string) {
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("specloom-layout-")) throw new Error("Unexpected layout cleanup path");
  await rm(resolved, { recursive: true, force: true });
}

test("chat reserves message height and keeps long labels, growth, sidebars and 125% controls usable", async ({ browserName }, testInfo) => {
  expect(browserName).toBe("chromium");
  test.setTimeout(120_000);
  const profile = await mkdtemp(path.join(os.tmpdir(), "specloom-layout-"));
  let pendingResponse: ServerResponse | undefined;
  let requests = 0;
  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    requests++;
    pendingResponse = response;
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const app = await launchSourceElectron(profile);
  const measurements: Measurement[] = [];
  try {
    const page = await app.firstWindow();
    await prepareChat(page, (server.address() as AddressInfo).port);
    const input = page.getByLabel("任务消息");
    for (const [width, height, minimum] of [[1366, 768, 460], [1920, 1080, 760]]) {
      await resize(app, page, width!, height!);
      await evidence(page, testInfo, `desktop-${width}-single-line`, measurements);
      const reading = measurements.at(-1)!;
      expect(reading.reading.height).toBeGreaterThanOrEqual(minimum!);
      expect(reading.composer.height).toBeLessThanOrEqual(120);
      expect(reading.input.height).toBe(44);
      expect(reading.reading.height - (height === 768 ? 375 : 687)).toBeGreaterThanOrEqual(50);
      expect(reading.title.scrollWidth).toBeGreaterThan(reading.title.clientWidth);
      expect(reading.model.width).toBeLessThanOrEqual(210);
      await controlsReachable(page);
    }
    await resize(app, page, 1366, 768);
    await input.fill("第一行\n第二行\n第三行\n第四行");
    await expect.poll(() => input.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThan(44);
    await evidence(page, testInfo, "desktop-multiline-growing", measurements);
    await input.fill(Array.from({ length: 35 }, (_, index) => `第 ${index + 1} 行布局验证`).join("\n"));
    await expect.poll(() => input.evaluate(node => node.getBoundingClientRect().height)).toBe(160);
    expect(await input.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
    await evidence(page, testInfo, "desktop-multiline-capped", measurements);
    await input.fill("短消息");
    await expect.poll(() => input.evaluate(node => node.getBoundingClientRect().height)).toBe(44);
    await evidence(page, testInfo, "desktop-multiline-shrunk", measurements);
    await page.getByRole("button", { name: "打开智能体侧栏", exact: true }).click();
    await expect(page.getByRole("complementary", { name: "智能体侧栏", exact: true })).toBeVisible();
    await reachable(input);
    await evidence(page, testInfo, "desktop-sidebar-open", measurements);
    await page.getByRole("button", { name: "关闭智能体侧栏", exact: true }).click();
    await expect(page.getByRole("complementary", { name: "智能体侧栏", exact: true })).toHaveCount(0);
    await expect(input).toHaveValue("短消息");
    await resize(app, page, 1366, 768, 1.25);
    await controlsReachable(page);
    await page.getByRole("button", { name: "添加附件或资料", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "添加文件", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "添加附件或资料", exact: true }).click();
    await evidence(page, testInfo, "desktop-125-percent", measurements);
    await resize(app, page, 1366, 768);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect.poll(() => requests).toBe(1);
    await expect(page.getByRole("button", { name: "停止", exact: true })).toBeVisible();
    await input.fill("补充要求：保持玩家输入和地图边界行为一致。\n验证附件以及引导消息同时显示时的剩余阅读空间。");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByRole("region", { name: "待引导消息", exact: true })).toBeVisible();
    await page.getByLabel("添加附件文件", { exact: true }).setInputFiles({ name: "layout-reference-with-a-long-file-name.txt", mimeType: "text/plain", buffer: Buffer.from("布局附件实际提取内容\n用于验证附件托盘的占用。") });
    await expect(page.getByRole("button", { name: "移除附件 layout-reference-with-a-long-file-name.txt", exact: true })).toBeVisible();
    await expect(page.getByText(/KiB · 已就绪/)).toBeVisible();
    await input.fill("继续完善布局");
    await controlsReachable(page);
    await reachable(page.getByRole("button", { name: "引导", exact: true }));
    await reachable(page.getByRole("button", { name: "停止", exact: true }));
    await evidence(page, testInfo, "desktop-guidance-and-attachment", measurements);
    expect(measurements.at(-1)!.reading.height).toBeGreaterThan(200);
    await page.getByRole("button", { name: "停止", exact: true }).click();
    await expect(page.getByRole("button", { name: "停止", exact: true })).toHaveCount(0);
  } finally {
    pendingResponse?.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "布局验证完成" } }] }));
    await app.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await removeProfile(profile);
  }
});

test("narrow 620px renderer keeps the composer and sidebar controls reachable", async ({ browserName }, testInfo) => {
  expect(browserName).toBe("chromium");
  test.setTimeout(60_000);
  const profile = await mkdtemp(path.join(os.tmpdir(), "specloom-layout-"));
  const app = await launchSourceElectron(profile);
  const measurements: Measurement[] = [];
  try {
    const page = await app.firstWindow();
    await prepareChat(page);
    // Exercise the responsive renderer independently of the desktop host's minimum window size.
    await page.setViewportSize({ width: 620, height: 900 });
    expect(await page.evaluate(() => innerWidth)).toBe(620);
    const input = page.getByLabel("任务消息");
    await input.fill("窄窗口草稿");
    await evidence(page, testInfo, "narrow-620-single-line", measurements);
    await controlsReachable(page);
    expect(measurements.at(-1)!.reading.height).toBeGreaterThan(200);
    expect(measurements.at(-1)!.composer.bottom).toBeLessThanOrEqual(900);
    await input.fill(Array.from({ length: 30 }, (_, index) => `窄窗口第 ${index + 1} 行`).join("\n"));
    await expect.poll(() => input.evaluate(node => node.getBoundingClientRect().height)).toBe(160);
    await controlsReachable(page);
    await evidence(page, testInfo, "narrow-620-multiline-capped", measurements);
    await input.fill("窄窗口草稿");
    await expect.poll(() => input.evaluate(node => node.getBoundingClientRect().height)).toBe(44);
    await page.getByRole("button", { name: "打开智能体侧栏", exact: true }).click();
    await reachable(page.getByRole("button", { name: "关闭智能体侧栏", exact: true }));
    await evidence(page, testInfo, "narrow-620-sidebar-open", measurements);
    await page.getByRole("button", { name: "关闭智能体侧栏", exact: true }).click();
    await controlsReachable(page);
    await expect(input).toHaveValue("窄窗口草稿");
    await evidence(page, testInfo, "narrow-620-sidebar-closed", measurements);
  } finally {
    await app.close();
    await removeProfile(profile);
  }
});
