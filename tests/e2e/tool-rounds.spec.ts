import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchSourceElectron } from "./source-electron";

test("source chat ignores legacy round settings and preserves input clearing and continuation history", async () => {
  test.setTimeout(180000);
  const data = await mkdtemp(path.join(os.tmpdir(), "specloom-tool-round-e2e-"));
  const counts = new Map<string, number>();
  const failures: string[] = [];
  let continuationIds: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      let text = ""; for await (const chunk of request) text += String(chunk);
      const body = JSON.parse(text) as { messages: Array<{ role: string; content: string; tool_call_id?: string }> };
      const prompt = body.messages.filter(message => message.role === "user").at(-1)!.content;
      const round = (counts.get(prompt) ?? 0) + 1; counts.set(prompt, round);
      if (prompt === "继续") continuationIds = body.messages.flatMap(message => message.role === "tool" && message.tool_call_id ? [message.tool_call_id] : []);
      const needsTool = prompt === "默认长任务" ? round <= 13 : prompt === "旧配置任务" ? round <= 2 : prompt === "继续" && round === 1;
      response.setHeader("Content-Type", "text/event-stream");
      const delta = needsTool
        ? { tool_calls: [{ index: 0, id: `${prompt}-${round}`, function: { name: "TaskList", arguments: "{}" } }] }
        : { content: prompt === "继续" ? "已保留进度并继续完成" : prompt === "旧配置任务" ? "旧配置下两轮完成" : "十三轮工具任务完成" };
      response.end([
        { choices: [{ delta }] },
        { choices: [{ delta: {}, finish_reason: needsTool ? "tool_calls" : "stop" }] },
      ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n");
    } catch (error) { failures.push(String(error)); response.destroy(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const app = await launchSourceElectron(data);
  try {
    const window = await app.firstWindow();
    const errors: string[] = []; window.on("pageerror", error => errors.push(error.message));
    await window.getByRole("button", { name: "创建示例项目" }).click();
    await expect(window.getByRole("heading", { name: "灯塔守望", exact: true })).toBeVisible();
    await window.evaluate(async port => {
      const api = globalThis.window.specloom;
      await api.saveProvider!({ id: "round-fixture", name: "Local rounds fixture", protocol: "openai", baseUrl: `http://127.0.0.1:${port}/v1`, models: ["fixture"], modelSettings: {} });
      await api.setDefaultModel!({ providerId: "round-fixture", model: "fixture" });
    }, (server.address() as AddressInfo).port);
    await window.reload();
    await window.getByRole("button", { name: "新建会话", exact: true }).first().click();
    const input = window.getByLabel("任务消息");
    await input.fill("默认长任务"); await window.getByRole("button", { name: "发送", exact: true }).click();
    await expect(input).toHaveValue("");
    await expect(window.getByText("十三轮工具任务完成", { exact: true })).toBeVisible({ timeout: 60000 });
    expect(counts.get("默认长任务")).toBe(14);
    await expect.poll(async () => window.evaluate(async () => {
      const api = globalThis.window.specloom; const state = await api.state();
      return (await api.sessions!.list(state.project!.path)).find(session => session.items.some(item => item.kind === "message" && item.role === "user" && item.content === "默认长任务"))?.status;
    })).toBe("completed");
    const completed = await window.evaluate(async () => {
      const api = globalThis.window.specloom; const state = await api.state();
      return (await api.sessions!.list(state.project!.path)).find(session => session.items.some(item => item.kind === "message" && item.role === "user" && item.content === "默认长任务"));
    });
    expect(completed?.status).toBe("completed");
    expect(completed?.items.filter(item => item.kind === "tool")).toHaveLength(13);
    expect(completed?.items.filter(item => item.kind === "tool").every(item => item.status === "ok")).toBe(true);

    await window.evaluate(async () => {
      const api = globalThis.window.specloom;
      const provider = (await api.providers!.list()).find(provider => provider.id === "round-fixture")!;
      await api.providers!.save({ id: provider.id, name: provider.name, protocol: provider.protocol, baseUrl: provider.baseUrl,
        models: provider.models, modelSettings: { fixture: { maxToolRounds: 1 } } });
    });
    await window.getByRole("button", { name: "新建会话", exact: true }).first().click();
    await input.fill("旧配置任务"); await window.getByRole("button", { name: "发送", exact: true }).click();
    await expect(window.getByText("旧配置下两轮完成", { exact: true })).toBeVisible({ timeout: 20000 });
    await expect(window.getByRole("button", { name: "停止", exact: true })).not.toBeVisible();
    await expect(input).toHaveValue("");
    const legacy = await window.evaluate(async () => {
      const api = globalThis.window.specloom; const state = await api.state();
      return (await api.sessions!.list(state.project!.path)).find(session => session.items.some(item => item.kind === "message" && item.role === "user" && item.content === "旧配置任务"));
    });
    expect(legacy?.status).toBe("completed");
    expect(legacy?.items.filter(item => item.kind === "tool")).toHaveLength(2);
    expect(legacy?.items.some(item => item.kind === "tool" && item.status !== "ok")).toBe(false);
    await input.fill("继续"); await window.getByRole("button", { name: "发送", exact: true }).click();
    await expect(window.getByText("已保留进度并继续完成", { exact: true })).toBeVisible({ timeout: 20000 });
    await expect(input).toHaveValue("");
    await expect(window.getByRole("button", { name: "停止", exact: true })).not.toBeVisible();
    expect(continuationIds).toEqual(["旧配置任务-1", "旧配置任务-2", "继续-1"]);
    expect(counts.get("旧配置任务")).toBe(3);
    expect(counts.get("继续")).toBe(2);
    expect(failures).toEqual([]); expect(errors).toEqual([]);
  } finally {
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => undefined);
    await app.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(data, { recursive: true, force: true });
  }
});
