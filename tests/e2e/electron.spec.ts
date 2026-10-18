import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchSourceElectron } from "./source-electron";

test("desktop project, model, agent, review, validation and entity authoring", async () => {
  test.setTimeout(120000);
  const data = await mkdtemp(path.join(os.tmpdir(), "specloom-desktop-"));
  await mkdir(".local", { recursive: true });
  let rounds = 0;
  let conversationRounds = 0;
  const started = Date.now();
  const boundaries: { elapsedMs: number; stage: string }[] = [];
  const boundary = (stage: string) => boundaries.push({ elapsedMs: Date.now() - started, stage });
  const systems: { content: string; task: boolean }[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const payload = JSON.parse(body) as { tools?: { function?: { name?: string } }[]; messages: { role: string; content: string }[] };
    const systemContent = payload.messages.find((message) => message.role === "system")?.content ?? "";
    const task = systemContent.includes("approved immutable scope");
    boundary(`request:${task ? "task" : "conversation"}:${task ? rounds : conversationRounds}`);
    systems.push({ content: systemContent, task });
    expect(payload.tools?.map((tool) => tool.function?.name)).toEqual(expect.arrayContaining(["Read", "ToolSearch"]));
    if (!task) {
      const calls = conversationRounds === 0 ? [{ id: "conversation-read", type: "function", function: { name: "Read", arguments: JSON.stringify({ path: "project.godot" }) } }]
        : conversationRounds === 1 ? [{ id: "conversation-discovery", type: "function", function: { name: "ToolSearch", arguments: JSON.stringify({ query: "Monitor" }) } }] : [];
      conversationRounds++;
      response.setHeader("Content-Type", "application/json");
      response.once("finish", () => boundary(`response:${calls[0]?.function.name ?? "summary"}`));
      response.end(JSON.stringify({ choices: [{ message: calls.length ? { role: "assistant", content: null, tool_calls: calls } : { role: "assistant", content: "已读取项目并发现后台执行工具。" } }] }));
      return;
    }
    const call = (name: string, input: Record<string, unknown>) => ({ id: `desktop-${rounds}`, type: "function", function: { name, arguments: JSON.stringify(input) } });
    const calls = rounds === 0 ? [call("files_list_versions", { paths: ["scripts/desktop.gd"] })]
      : rounds === 1 ? [call("files_write", { path: "scripts/desktop.gd", expectedVersion: "absent", content: "extends Node\n\nfunc _ready() -> void:\n\tpass\n" })] : [];
    rounds++;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: calls.length ? { role: "assistant", content: null, tool_calls: calls } : { role: "assistant", content: "变更已暂存，等待审查。" } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const application = await launchSourceElectron(data);
  try {
    const window = await application.firstWindow();
    const runtime = await application.evaluate(({ app }) => ({ packaged: app.isPackaged, userData: app.getPath("userData") }));
    expect(runtime.packaged).toBe(false);
    expect(window.url()).toBe(process.env.SPECLOOM_DEV_SERVER_URL);
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
    await window.getByRole("button", { name: "设置", exact: true }).first().click();
    await window.getByRole("navigation", { name: "设置分区" }).getByRole("button", { name: "智能体", exact: true }).click();
    await window.getByLabel("智能体自定义提示词").fill("桌面全局要求：使用中文注释");
    await window.getByRole("button", { name: "保存提示词", exact: true }).click();
    await expect(window.getByRole("button", { name: "保存提示词", exact: true })).toBeDisabled();
    await expect(window.getByLabel("当前项目提示词")).toBeEnabled();
    await window.getByLabel("当前项目提示词").fill("桌面项目要求：只实现海岛探索");
    await window.getByRole("button", { name: "保存项目提示词", exact: true }).click();
    await expect(window.getByText("项目提示词已保存", { exact: true })).toBeVisible();
    const promptState = await window.evaluate(() => globalThis.window.specloom.state());
    expect(promptState.tasks).toEqual([]);
    expect(await readFile(path.join(promptState.project!.path, "specs/prompts/system-prompt.md"), "utf8")).toBe("桌面项目要求：只实现海岛探索");
    await window.screenshot({ path: ".local/workspace-prompt-settings.png", fullPage: true });
    await window.getByRole("button", { name: "供应商", exact: true }).click();
    await window.getByRole("button", { name: "添加供应商", exact: true }).click();
    await window.getByLabel("供应商名称").fill("验收供应商");
    await window.getByLabel("服务地址").fill(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
    await window.getByRole("button", { name: "保存供应商", exact: true }).click();
    await expect(window.getByRole("heading", { name: "验收供应商 · 模型管理", exact: true })).toBeVisible();
    await window.getByLabel("手动模型 ID").fill("fixture");
    await window.getByRole("button", { name: "手动添加", exact: true }).click();
    await window.getByRole("button", { name: "保存模型配置", exact: true }).click();
    await expect(window.getByRole("heading", { name: "验收供应商 · 模型管理", exact: true })).toBeVisible();
    await window.getByRole("button", { name: "工作区", exact: true }).click();
    await window.getByRole("button", { name: "新建会话", exact: true }).first().click();
    await window.getByLabel("任务消息").fill("创建一个独立的小脚本，等待人工批准。");
    await window.getByRole("button", { name: "发送", exact: true }).click();
    boundary("conversation-send");
    // Capability refresh, three model rounds and durable checkpoints exceed 5s on Windows.
    await expect(window.getByText("已读取项目并发现后台执行工具。", { exact: true })).toBeVisible({ timeout: 20000 });
    await expect.poll(async () => window.evaluate(async () => {
      const api = globalThis.window.specloom;
      const sessions = await api.sessions!.list((await api.state()).project!.path);
      return sessions.find((session) => !session.taskId)?.status;
    }), { timeout: 20000 }).toBe("completed");
    boundary("conversation-completed");
    expect(conversationRounds).toBe(3);
    await window.getByRole("button", { name: "展开工具链", exact: true }).click();
    await expect(window.locator(".tool-chain-row").getByText("Read", { exact: true })).toBeVisible();
    await expect(window.locator(".tool-chain-row").getByText("ToolSearch", { exact: true })).toBeVisible();
    await window.getByRole("button", { name: "在侧栏展开工具链", exact: true }).click();
    await expect(window.getByRole("complementary", { name: "智能体侧栏" })).toContainText("ToolSearch");
    await window.getByRole("button", { name: "关闭智能体侧栏", exact: true }).click();
    await expect(window.locator(".run-summary summary")).toContainText("第 1 轮工具调用 · 2 次");
    await window.getByRole("button", { name: "新建任务", exact: true }).first().click();
    await window.getByLabel("任务名称").fill("桌面验收任务");
    boundary("task-create");
    await window.getByRole("button", { name: "确认范围并创建" }).click();
    await expect(window.getByRole("heading", { name: "桌面验收任务" })).toBeVisible({ timeout: 20000 });
    boundary("task-created");
    await window.getByLabel("任务消息").fill("创建一个独立的小脚本，等待人工批准。");
    await window.getByRole("button", { name: "发送", exact: true }).click();
    await expect(window.getByText("变更已暂存，等待审查。", { exact: true })).toBeVisible({ timeout: 20000 });
    expect(systems.some((system) => system.task)).toBe(true);
    expect(systems.some((system) => !system.task)).toBe(true);
    for (const system of systems) {
      expect(system.content).toContain("桌面全局要求");
      expect(system.content).toContain("桌面项目要求");
      expect(system.content.indexOf("You are SpecLoom")).toBeLessThan(system.content.indexOf("桌面全局要求"));
      expect(system.content.indexOf("桌面全局要求")).toBeLessThan(system.content.indexOf("桌面项目要求"));
      expect(system.content).not.toContain("no workspace tools");
      if (system.task) expect(system.content.indexOf("桌面项目要求")).toBeLessThan(system.content.indexOf("approved immutable scope"));
    }
    await expect(window.locator(".file-diff").getByText("scripts/desktop.gd", { exact: true })).toBeVisible();
    const state = await window.evaluate(() => globalThis.window.specloom.state());
    const project = state.project!.path;
    await expect(readFile(path.join(project, "scripts/desktop.gd"))).rejects.toMatchObject({ code: "ENOENT" });
    await window.screenshot({ path: ".local/mvp-desktop.png", fullPage: true });
    await window.getByRole("button", { name: "批准并提交" }).click();
    await expect(window.locator(".review-pane .status")).toHaveText("已提交");
    expect(await readFile(path.join(project, "scripts/desktop.gd"), "utf8")).toContain("func _ready");
    await window.getByRole("button", { name: "验证", exact: true }).click();
    const validation = window.getByRole("region", { name: "验证结果" });
    await expect(validation).toContainText(/验证(通过|跳过)/, { timeout: 60000 });
    if (await validation.getByText("验证跳过", { exact: true }).count()) {
      await expect(validation).toContainText("GODOT_NOT_FOUND");
    }
    await window.getByRole("button", { name: "实体", exact: true }).click();
    await window.getByRole("button", { name: "新建实体", exact: true }).click();
    const entityDialog = window.getByRole("dialog", { name: "新建实体" });
    await expect(entityDialog.getByRole("textbox")).toHaveCount(1);
    await entityDialog.getByLabel("名称", { exact: true }).fill("海玻璃");
    await entityDialog.getByRole("button", { name: "创建实体", exact: true }).click();
    await expect(entityDialog).toBeHidden({ timeout: 20000 });
    await expect(window.getByLabel("名称", { exact: true })).toHaveValue("海玻璃");
    await window.getByLabel("实体类型", { exact: true }).selectOption("item");
    boundary("entity-save");
    await window.getByRole("button", { name: "保存资料", exact: true }).click();
    const entityFile = window.locator(".version-text");
    await expect(entityFile).toBeVisible({ timeout: 20000 });
    const entityPath = (await entityFile.getAttribute("title"))!;
    await expect(entityFile).toContainText("已保存", { timeout: 20000 });
    boundary("entity-saved");
    const savedEntity = await readFile(path.join(project, entityPath), "utf8");
    expect(savedEntity).toContain("type: item");
    expect(savedEntity).toContain("title: 海玻璃");
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
  } catch (error) {
    const snapshots = await application.firstWindow().then(window => window.evaluate(async () => {
      const api = globalThis.window.specloom;
      const state = await api.state();
      if (!state.project || !api.sessions) return [];
      return (await api.sessions.list(state.project.path)).map(({ status, activity, seq, revision, items }) => ({
        status, activity, seq, revision,
        tools: items.filter(item => item.kind === "tool").map(({ name, status }) => ({ name, status })),
      }));
    })).catch(() => []);
    await test.info().attach("agent-boundaries", { body: JSON.stringify({ boundaries, snapshots }, null, 2), contentType: "application/json" });
    throw error;
  } finally {
    await application.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(data, { recursive: true, force: true });
  }
});
