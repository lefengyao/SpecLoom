import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchSourceElectron } from "./source-electron";

test("desktop navigation retains a live reply, guidance joins the same run, and unused text returns to the composer", async () => {
  test.setTimeout(120000);
  const data = await mkdtemp(path.join(os.tmpdir(), "specloom-guidance-e2e-"));
  await mkdir(".local", { recursive: true });
  let held: ServerResponse | undefined;
  let requests = 0;
  let interrupted = false;
  const received: string[][] = [];
  const failures: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      let body = ""; for await (const chunk of request) body += String(chunk);
      const payload = JSON.parse(body) as { messages: { role: string; content?: string }[] };
      requests++;
      received.push(payload.messages.filter(message => message.role === "user").map(message => message.content ?? ""));
      if (requests === 1) {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: [1, 2, 3].map(index => ({ id: `tool-${index}`, type: "function", function: { name: "TaskList", arguments: "{}" } })) } }] }));
      } else if (requests === 2) {
        response.setHeader("Content-Type", "text/event-stream");
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "原任务正在回复" } }] })}\n\n`);
        response.once("close", () => { if (!response.writableEnded) interrupted = true; });
        held = response;
      } else {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "原任务与补充文档检查一起完成" } }] }));
      }
    } catch (error) { failures.push(String(error)); response.destroy(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const app = await launchSourceElectron(data);
  try {
    const window = await app.firstWindow(); const errors: string[] = [];
    window.on("pageerror", error => errors.push(error.message));
    await window.getByRole("button", { name: "创建示例项目" }).click();
    await expect(window.getByRole("heading", { name: "灯塔守望", exact: true })).toBeVisible();
    await window.evaluate(async port => {
      const api = globalThis.window.specloom;
      await api.saveProvider!({ id: "guidance-e2e", name: "Local guidance fixture", protocol: "openai", baseUrl: `http://127.0.0.1:${port}/v1`, models: ["fixture"], modelSettings: {} });
      await api.setDefaultModel!({ providerId: "guidance-e2e", model: "fixture" });
    }, (server.address() as AddressInfo).port);
    await window.reload();
    await window.getByRole("button", { name: "新建会话", exact: true }).first().click();
    const input = window.getByLabel("任务消息");
    await input.fill("完成原任务"); await window.getByRole("button", { name: "发送", exact: true }).click();
    await expect(window.getByText("原任务正在回复", { exact: true })).toBeVisible({ timeout: 30000 });
    const before = await window.evaluate(async () => { const api = globalThis.window.specloom; return (await api.sessions!.list((await api.state()).project!.path)).find(s => s.status === "running")!; });
    await input.fill("同时检查文档"); await input.press("Enter");
    const staged = window.getByRole("region", { name: "待引导消息" });
    await window.getByRole("button", { name: "收起导航", exact: true }).click();
    await expect(window.getByRole("button", { name: "展开导航", exact: true })).toHaveAttribute("aria-expanded", "false");
    expect(await window.locator(".application-sidebar").evaluate(element => element.getBoundingClientRect().width)).toBeLessThan(80);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(900, 800));
    await expect.poll(() => window.locator(".application-sidebar").evaluate(element => element.getBoundingClientRect().width)).toBeLessThan(80);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1294, 800));
    await expect(staged).toContainText("同时检查文档");
    await staged.getByRole("button", { name: "引导", exact: true }).click();
    await expect(staged).toBeHidden();
    expect(requests).toBe(2); expect(interrupted).toBe(false);
    await input.fill("稍后再检查配图"); await input.press("Enter");
    await expect(staged).toContainText("稍后再检查配图");
    await window.getByRole("button", { name: "组件", exact: true }).click();
    await expect(window.getByRole("heading", { name: "官方组件", exact: true })).toBeVisible();
    await expect(window.getByRole("heading", { name: "自定义组件", exact: true })).toBeVisible();
    await window.getByRole("button", { name: "工作区", exact: true }).click();
    await expect(staged).toContainText("稍后再检查配图");
    // Measure two animation frames after each warmed page switch, excluding IPC setup and Playwright transport.
    const timings = await window.evaluate(async () => {
      const values: { page: string; ms: number }[] = [];
      for (let index = 0; index < 12; index++) {
        const page = index % 2 ? "工作区" : "组件";
        const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === page)!;
        const started = performance.now(); button.click();
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        values.push({ page, ms: performance.now() - started });
      }
      return values;
    });
    expect(Math.max(...timings.map(timing => timing.ms))).toBeLessThan(500);
    await expect(window.getByText("原任务正在回复", { exact: true })).toBeVisible();
    await window.getByRole("button", { name: "打开智能体侧栏", exact: true }).click();
    await expect(window.locator(".agent-sidebar")).toBeVisible();
    await expect(window.locator(".agent-sidebar")).toContainText("TaskList");
    await window.screenshot({ path: ".local/guidance-tool-sidebar.png", fullPage: true });
    expect(held).toBeTruthy();
    held!.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "，原回复完成" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    await expect(window.getByText("原任务与补充文档检查一起完成", { exact: true })).toBeVisible({ timeout: 20000 });
    await expect(input).toHaveValue("稍后再检查配图");
    await expect(staged).toBeHidden();
    const after = await window.evaluate(async id => { const api = globalThis.window.specloom; return (await api.sessions!.list((await api.state()).project!.path)).find(s => s.id === id)!; }, before.id);
    expect(after.runId).toBe(before.runId); expect(after.status).toBe("completed");
    expect(after.items.filter(item => item.kind === "message" && item.role === "user" && item.content === "同时检查文档")).toHaveLength(1);
    expect(after.items.flatMap(item => item.kind === "message" && item.role === "assistant" ? [item.content] : [])).toEqual(expect.arrayContaining(["原任务正在回复，原回复完成", "原任务与补充文档检查一起完成"]));
    expect(received.at(-1)).toContain("同时检查文档"); expect(received.at(-1)).not.toContain("稍后再检查配图");
    expect(interrupted).toBe(false); expect(failures).toEqual([]); expect(errors).toEqual([]);
    await window.reload();
    await expect(window.getByRole("button", { name: "展开导航", exact: true })).toHaveAttribute("aria-expanded", "false");
    await expect(window.getByLabel("任务消息")).toHaveValue("稍后再检查配图");
    await writeFile(".local/guidance-navigation-result.json", JSON.stringify({ timings, requests, sameRun: after.runId === before.runId, interrupted, errors }, null, 2));
  } finally {
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => undefined);
    await app.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(data, { recursive: true, force: true });
  }
});
