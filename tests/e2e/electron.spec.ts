import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, _electron as electron } from "@playwright/test";

test("desktop project, model, agent, review, validation and entity authoring", async () => {
  test.setTimeout(120000);
  const data = await mkdtemp(path.join(os.tmpdir(), "specloom-desktop-"));
  await mkdir(".local", { recursive: true });
  let rounds = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { void _chunk; }
    const call = (name: string, input: Record<string, unknown>) => ({ id: `desktop-${rounds}`, type: "function", function: { name, arguments: JSON.stringify(input) } });
    const calls = rounds === 0 ? [call("files_list_versions", { paths: ["scripts/desktop.gd"] })]
      : rounds === 1 ? [call("files_write", { path: "scripts/desktop.gd", expectedVersion: "absent", content: "extends Node\n\nfunc _ready() -> void:\n\tpass\n" })] : [];
    rounds++;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: calls.length ? { role: "assistant", content: null, tool_calls: calls } : { role: "assistant", content: "变更已暂存，等待审查。" } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.SPECLOOM_DEV_SERVER_URL;
  environment.SPECLOOM_USER_DATA_DIR = data;
  const executablePath = process.env.SPECLOOM_E2E_EXECUTABLE;
  const application = await electron.launch({
    ...(executablePath ? { executablePath: path.resolve(executablePath) } : {}),
    args: [...(executablePath ? [] : [path.resolve(fileURLToPath(new URL("../../", import.meta.url)))]), "--headless", "--disable-gpu", `--user-data-dir=${data}`],
    env: environment,
  });
  try {
    const window = await application.firstWindow();
    const runtime = await application.evaluate(({ app }) => ({ packaged: app.isPackaged, userData: app.getPath("userData") }));
    expect(runtime.packaged).toBe(!!executablePath);
    expect(path.resolve(runtime.userData)).toBe(path.resolve(data));
    const errors: string[] = [];
    window.on("pageerror", (error) => errors.push(error.message));
    await expect(window.getByRole("heading", { name: "SpecLoom", exact: true })).toBeVisible();
    await expect(window.getByRole("button", { name: "创建示例项目" })).toBeEnabled();
    const preferences = await application.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents as unknown as { getLastWebPreferences(): { sandbox: boolean; contextIsolation: boolean; nodeIntegration: boolean } };
      return contents.getLastWebPreferences();
    });
    expect(preferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false });
    expect(await window.evaluate(() => ({ bridge: "specloom" in window, node: "require" in window }))).toEqual({ bridge: true, node: false });
    await window.getByRole("button", { name: "创建示例项目" }).click();
    await expect(window.getByRole("heading", { name: "灯塔守望", exact: true })).toBeVisible();
    await window.getByRole("button", { name: "模型", exact: true }).click();
    await window.getByRole("button", { name: "添加模型", exact: true }).click();
    await window.getByLabel("配置名称").fill("验收模型");
    await window.getByLabel("模型 ID").fill("fixture");
    await window.getByLabel("端点 URL").fill(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
    await window.getByLabel("授权此端点接收任务上下文").check();
    await window.getByRole("button", { name: "保存模型" }).click();
    await expect(window.getByRole("dialog")).toHaveCount(0);
    await window.getByRole("button", { name: "工作区", exact: true }).click();
    await window.getByRole("button", { name: "新建任务", exact: true }).first().click();
    await window.getByLabel("任务名称").fill("桌面验收任务");
    await window.getByRole("button", { name: "确认范围并创建" }).click();
    await expect(window.getByRole("heading", { name: "桌面验收任务" })).toBeVisible();
    await window.getByLabel("任务消息").fill("创建一个独立的小脚本，等待人工批准。");
    await window.getByRole("button", { name: "发送", exact: true }).click();
    await expect(window.getByText("变更已暂存，等待审查。", { exact: true })).toBeVisible({ timeout: 20000 });
    await expect(window.locator(".file-diff").getByText("scripts/desktop.gd", { exact: true })).toBeVisible();
    const state = await window.evaluate(() => globalThis.window.specloom.state());
    const project = state.project!.path;
    await expect(readFile(path.join(project, "scripts/desktop.gd"))).rejects.toMatchObject({ code: "ENOENT" });
    await window.screenshot({ path: ".local/mvp-desktop.png", fullPage: true });
    await window.getByRole("button", { name: "批准并提交" }).click();
    await expect(window.locator(".review-pane .status")).toHaveText("已提交");
    expect(await readFile(path.join(project, "scripts/desktop.gd"), "utf8")).toContain("func _ready");
    await window.getByRole("button", { name: "验证", exact: true }).click();
    await expect(window.getByText("验证通过", { exact: true })).toBeVisible({ timeout: 60000 });
    await window.getByRole("button", { name: "规范与实体", exact: true }).click();
    await window.getByRole("button", { name: "新建实体", exact: true }).click();
    await window.getByLabel("实体 ID").fill("seaglass");
    await window.getByLabel("类型", { exact: true }).selectOption("item");
    await window.getByLabel("名称", { exact: true }).fill("海玻璃");
    await window.getByRole("button", { name: "暂存实体" }).click();
    await expect(window.locator(".file-diff").getByText("specs/entities/items/seaglass.md", { exact: true })).toBeVisible();
    await window.getByRole("button", { name: "批准并提交" }).click();
    await expect(window.locator(".review-pane .status")).toHaveText("已提交");
    expect(await readFile(path.join(project, "specs/entities/items/seaglass.md"), "utf8")).toContain("type: item");
    await window.getByRole("button", { name: "MCP", exact: true }).click();
    expect(state.mcp!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect((await fetch(state.mcp!.url, { method: "POST", body: "{}" })).status).toBe(401);
    await application.evaluate(({ BrowserWindow }) => { const active = BrowserWindow.getAllWindows()[0]!; active.setMinimumSize(320, 500); active.setSize(390, 844); });
    await window.getByRole("button", { name: "工作区", exact: true }).click();
    await expect.poll(() => window.evaluate(() => document.documentElement.scrollWidth <= globalThis.innerWidth)).toBe(true);
    await window.screenshot({ path: ".local/mvp-mobile.png", fullPage: true });
    await window.getByRole("button", { name: "新建任务", exact: true }).first().click();
    await expect(window.getByRole("dialog")).toBeVisible();
    await window.screenshot({ path: ".local/mvp-scope-mobile.png", fullPage: true });
    expect(errors).toEqual([]);
  } finally {
    await application.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(data, { recursive: true, force: true });
  }
});
