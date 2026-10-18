import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchSourceElectron } from "./source-electron";

test("new-session typing works before a slow MCP inventory finishes and survives switching and reload", async () => {
  test.setTimeout(60000);
  const data = await mkdtemp(path.join(os.tmpdir(), "specloom-input-e2e-"));
  const gate = path.join(data, "release-mcp"); const started = path.join(data, "mcp-started");
  const server = path.join(data, "slow-mcp.cjs");
  await writeFile(server, `const fs=require('node:fs');const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;const send=result=>console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));if(m.method==='initialize')send({protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'slow',version:'1'}});else if(m.method==='tools/list'){fs.writeFileSync(process.argv[3],'started');const timer=setInterval(()=>{if(fs.existsSync(process.argv[2])){clearInterval(timer);send({tools:[{name:'echo',description:'慢连接工具',inputSchema:{type:'object',properties:{}}}]});}},25);}else send({});});`);
  const app = await launchSourceElectron(data);
  try {
    const window = await app.firstWindow(); const errors: string[] = []; window.on("pageerror", error => errors.push(error.message));
    await window.getByRole("button", { name: "创建示例项目", exact: true }).click();
    await expect(window.getByRole("heading", { name: "灯塔守望", exact: true })).toBeVisible();
    const project = await window.evaluate(async () => (await globalThis.window.specloom.state()).project!.path);
    await writeFile(path.join(project, ".mcp.json"), JSON.stringify({ mcpServers: { slow: { command: process.execPath, args: [server, gate, started] } } }));
    await window.getByRole("button", { name: "新建会话", exact: true }).first().click();
    const input = window.getByLabel("任务消息");
    await expect(window.getByRole("heading", { name: "新会话", exact: true })).toBeVisible({ timeout: 1500 });
    await expect(input).toBeEnabled({ timeout: 1500 }); await expect(input).toBeFocused();
    // Background MCP startup now respects the session's approval mode.
    const permissions = window.getByRole("combobox", { name: "审批权限" });
    await permissions.selectOption("full"); await expect(permissions).toBeEnabled();
    await input.fill("能力加载中也可以编辑草稿"); await input.pressSequentially(" draft");
    await expect(input).toHaveValue("能力加载中也可以编辑草稿 draft");
    await expect.poll(async () => (await import("node:fs/promises")).stat(started).then(() => true, () => false), { timeout: 15000 }).toBe(true);
    await expect(window.getByRole("region", { name: "会话能力清单" }).getByText("已连接", { exact: true })).not.toBeVisible();
    await writeFile(gate, "release");
    const inventory = window.getByRole("region", { name: "会话能力清单" });
    await expect(inventory.getByText("MCP · 1", { exact: true })).toBeVisible({ timeout: 10000 });
    await inventory.getByText("MCP · 1", { exact: true }).click();
    await expect(inventory.getByText("已连接", { exact: true })).toBeVisible();
    await expect(input).toHaveValue("能力加载中也可以编辑草稿 draft");
    const first = await window.evaluate(async () => { const api = globalThis.window.specloom; const state = await api.state(); return (await api.sessions!.list(state.project!.path))[0]!; });
    await window.getByRole("button", { name: "会话设置 新会话", exact: true }).click();
    await window.getByLabel("会话名称").fill("慢连接会话"); await window.getByRole("button", { name: "保存名称", exact: true }).click();
    await window.getByRole("button", { name: "新建会话", exact: true }).click();
    await expect(input).toBeEnabled(); await input.fill("第二会话草稿");
    await window.getByRole("button", { name: "慢连接会话", exact: true }).click();
    await expect(input).toHaveValue("能力加载中也可以编辑草稿 draft");
    await expect.poll(async () => window.evaluate(async id => { const api = globalThis.window.specloom; const state = await api.state(); return (await api.sessions!.list(state.project!.path)).find(s => s.id === id)?.draft; }, first.id)).toBe("能力加载中也可以编辑草稿 draft");
    await window.reload(); await window.getByRole("button", { name: "慢连接会话", exact: true }).click();
    await expect(input).toBeEnabled(); await expect(input).toHaveValue("能力加载中也可以编辑草稿 draft");
    expect(errors).toEqual([]);
  } finally { await writeFile(gate, "release"); await app.close(); await rm(data, { recursive: true, force: true }); }
});

test("new-session typing works after deleting the last session", async () => {
  test.setTimeout(60000);
  const data = await mkdtemp(path.join(os.tmpdir(), "specloom-delete-last-session-e2e-"));
  const app = await launchSourceElectron(data);
  try {
    const window = await app.firstWindow();
    await window.getByRole("button", { name: "创建示例项目", exact: true }).click();
    await expect(window.getByRole("heading", { name: "灯塔守望", exact: true })).toBeVisible();
    await window.getByRole("button", { name: "新建会话", exact: true }).first().click();
    await expect(window.getByRole("heading", { name: "新会话", exact: true })).toBeVisible();
    await window.getByRole("button", { name: "会话设置 新会话", exact: true }).click();
    await window.getByRole("button", { name: "删除会话", exact: true }).click();
    const confirmation = window.getByRole("dialog", { name: "删除会话" });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole("button", { name: "确认删除", exact: true }).click();
    await expect(window.locator(".session-row")).toHaveCount(0);
    await window.getByRole("button", { name: "新建会话", exact: true }).first().click();
    await expect(window.getByRole("heading", { name: "新会话", exact: true })).toBeVisible();
    const input = window.getByLabel("任务消息");
    await expect(input).toBeEnabled();
    await expect(input).toBeFocused();
    await input.fill("删除最后会话后仍然可以输入");
    await expect(input).toHaveValue("删除最后会话后仍然可以输入");
  } finally {
    await app.close();
    await rm(data, { recursive: true, force: true });
  }
});

test("keeps each of four newly created sessions selectable and editable", async () => {
  test.setTimeout(60000);
  const data = await mkdtemp(path.join(os.tmpdir(), "specloom-four-sessions-e2e-"));
  const app = await launchSourceElectron(data);
  try {
    const window = await app.firstWindow();
    await window.getByRole("button", { name: "创建示例项目", exact: true }).click();
    await expect(window.getByRole("heading", { name: "灯塔守望", exact: true })).toBeVisible();
    for (let index = 1; index <= 4; index += 1) {
      await window.getByRole("button", { name: "新建会话", exact: true }).first().click();
      await expect(window.getByRole("heading", { name: "新会话", exact: true })).toBeVisible();
      const input = window.getByLabel("任务消息");
      await expect(input).toBeEnabled();
      await expect(input).toBeFocused();
      await input.fill("第" + index + "个会话");
      await expect(input).toHaveValue("第" + index + "个会话");
    }
    await expect(window.locator(".session-row")).toHaveCount(4);
    const sessions = window.getByRole("button", { name: "新会话", exact: true });
    for (let index = 0; index < 4; index += 1) {
      await sessions.nth(index).click();
      await expect(window.getByLabel("任务消息")).toBeEnabled();
      await expect(window.getByLabel("任务消息")).toBeFocused();
    }
  } finally {
    await app.close();
    await rm(data, { recursive: true, force: true });
  }
});

test("keeps keyboard input and the caret after deleting a session from a populated list", async () => {
  test.setTimeout(60000);
  const data = await mkdtemp(path.join(os.tmpdir(), "specloom-delete-populated-session-e2e-"));
  const app = await launchSourceElectron(data);
  try {
    const window = await app.firstWindow();
    await window.getByRole("button", { name: "创建示例项目", exact: true }).click();
    await expect(window.getByRole("heading", { name: "灯塔守望", exact: true })).toBeVisible();
    const create = window.getByRole("button", { name: "新建会话", exact: true }).first();
    const input = window.getByLabel("任务消息");

    for (let index = 0; index < 3; index += 1) {
      await create.click();
      await expect(input).toBeEnabled();
      await expect(input).toBeFocused();
      await window.keyboard.type(`删除前会话${index}`);
      await expect(input).toHaveValue(`删除前会话${index}`);
    }

    await window.locator(".session-row.active").getByRole("button", { name: "会话设置 新会话", exact: true }).click();
    await window.getByRole("button", { name: "删除会话", exact: true }).click();
    const confirmation = window.getByRole("dialog", { name: "删除会话" });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole("button", { name: "确认删除", exact: true }).click();
    await expect(window.locator(".session-row")).toHaveCount(2);
    await expect.poll(() => window.evaluate(() => document.hasFocus())).toBe(true);

    for (let index = 0; index < 3; index += 1) {
      await create.click();
      await expect(input).toBeEnabled();
      await expect(input).toBeFocused();
      await expect.poll(() => window.evaluate(() => document.hasFocus())).toBe(true);
      await expect.poll(() => input.evaluate(element => element.matches(":focus-visible"))).toBe(true);
      const caretColor = await input.evaluate(element => getComputedStyle(element).caretColor);
      expect(caretColor).not.toBe("transparent");
      await window.keyboard.type(`删除后会话${index}`);
      await expect(input).toHaveValue(`删除后会话${index}`);
    }
  } finally {
    await app.close();
    await rm(data, { recursive: true, force: true });
  }
});

test("restores focus after deleting a background session", async () => {
  test.setTimeout(60000);
  const data = await mkdtemp(path.join(os.tmpdir(), "specloom-delete-background-session-e2e-"));
  const app = await launchSourceElectron(data);
  try {
    const window = await app.firstWindow();
    await window.getByRole("button", { name: "创建示例项目", exact: true }).click();
    await expect(window.getByRole("heading", { name: "灯塔守望", exact: true })).toBeVisible();
    const newSession = window.getByRole("button", { name: "新建会话", exact: true }).first();
    await newSession.click();
    await expect(window.getByRole("heading", { name: "新会话", exact: true })).toBeVisible();
    await window.getByLabel("任务消息").fill("当前会话草稿");
    await newSession.click();
    await expect(window.locator(".session-row")).toHaveCount(2);
    const input = window.getByLabel("任务消息");
    await expect(input).toBeFocused();
    const background = window.locator(".session-row").first();
    await background.getByRole("button", { name: "会话设置 新会话", exact: true }).click();
    await background.getByRole("button", { name: "删除会话", exact: true }).click();
    const confirmation = window.getByRole("dialog", { name: "删除会话" });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole("button", { name: "确认删除", exact: true }).click();
    await expect(window.locator(".session-row")).toHaveCount(1);
    await expect(input).toBeFocused();
    await expect(input).toBeEnabled();
    await input.fill("删除后台会话后仍可输入");
    await expect(input).toHaveValue("删除后台会话后仍可输入");
  } finally {
    await app.close();
    await rm(data, { recursive: true, force: true });
  }
});
