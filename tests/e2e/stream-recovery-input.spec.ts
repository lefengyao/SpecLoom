import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchSourceElectron } from "./source-electron";

test("source desktop clears accepted input, preserves the next draft and recovers interrupted streams", async () => {
  test.setTimeout(60000);
  const data = await mkdtemp(path.join(os.tmpdir(), "specloom-stream-recovery-e2e-"));
  const attempts = new Map<string, { role: string; content?: string }[][]>();
  const failures: string[] = [];
  let transientResponse: ServerResponse | undefined;
  let permanentResponse: ServerResponse | undefined;
  const server = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const payload = JSON.parse(body) as { messages: { role: string; content?: string }[] };
      const prompt = [...payload.messages].reverse().find((message) => message.role === "user")?.content ?? "";
      const requests = attempts.get(prompt) ?? [];
      requests.push(payload.messages);
      attempts.set(prompt, requests);
      response.setHeader("Content-Type", "text/event-stream");
      if (prompt === "中断后恢复" && requests.length === 1) {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "即将中断的半截回复" } }] })}\n\n`);
        transientResponse = response;
      } else if (prompt === "中断后恢复") {
        response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "重试后的完整回复" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      } else if (prompt === "持续中断") {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `失败请求${requests.length}的半截回复` } }] })}\n\n`);
        if (requests.length === 1) permanentResponse = response;
        else setTimeout(() => response.destroy(), 50);
      } else {
        failures.push(`Unexpected prompt: ${prompt}`);
        response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "unexpected request" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      }
    } catch (error) {
      failures.push(String(error));
      response.destroy();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const app = await launchSourceElectron(data);
  try {
    const window = await app.firstWindow();
    const errors: string[] = [];
    window.on("pageerror", (error) => errors.push(error.message));
    await window.getByRole("button", { name: "创建示例项目" }).click();
    await expect(window.getByRole("heading", { name: "灯塔守望", exact: true })).toBeVisible();
    await window.evaluate(async (port) => {
      const api = globalThis.window.specloom;
      await api.saveProvider!({ id: "e2e-stream-recovery", name: "Local stream fixture", protocol: "openai", baseUrl: `http://127.0.0.1:${port}/v1`, models: ["fixture"], modelSettings: {} });
      await api.setDefaultModel!({ providerId: "e2e-stream-recovery", model: "fixture" });
    }, (server.address() as AddressInfo).port);
    await window.reload();
    await window.getByRole("button", { name: "新建会话", exact: true }).first().click();
    const input = window.getByLabel("任务消息");
    await input.fill("中断后恢复");
    await window.getByRole("button", { name: "发送", exact: true }).click();
    await expect(input).toHaveValue("");
    await expect(window.locator(".chat-user .bubble-content")).toHaveText("中断后恢复", { timeout: 20000 });
    await expect(window.getByText("即将中断的半截回复", { exact: true })).toBeVisible({ timeout: 20000 });
    await input.fill("下一条尚未发送的草稿");
    expect(transientResponse).toBeTruthy();
    transientResponse!.destroy();
    await expect(window.getByText("重试后的完整回复", { exact: true })).toBeVisible({ timeout: 20000 });
    await expect(window.getByRole("button", { name: "停止", exact: true })).not.toBeVisible();
    await expect(window.getByText("即将中断的半截回复", { exact: true })).not.toBeVisible();
    await expect(window.locator(".chat-assistant .bubble-content")).toHaveText("重试后的完整回复");
    await expect(input).toHaveValue("下一条尚未发送的草稿");
    const recovered = await window.evaluate(async () => {
      const api = globalThis.window.specloom;
      const state = await api.state();
      return (await api.sessions!.list(state.project!.path)).find((session) => session.items.some((item) => item.kind === "message" && item.role === "user" && item.content === "中断后恢复"));
    });
    expect(recovered?.status).toBe("completed");
    expect(recovered?.items.flatMap((item) => item.kind === "message" && item.role === "assistant" ? [item.content] : [])).toEqual(["重试后的完整回复"]);
    expect(attempts.get("中断后恢复")).toHaveLength(2);
    expect(attempts.get("中断后恢复")![1]).toEqual(attempts.get("中断后恢复")![0]);

    await window.getByRole("button", { name: "新建会话", exact: true }).first().click();
    await input.fill("持续中断");
    await window.getByRole("button", { name: "发送", exact: true }).click();
    await expect(input).toHaveValue("");
    await expect(window.locator(".chat-user .bubble-content")).toHaveText("持续中断", { timeout: 20000 });
    await expect(window.getByText("失败请求1的半截回复", { exact: true })).toBeVisible({ timeout: 20000 });
    expect(permanentResponse).toBeTruthy();
    permanentResponse!.destroy();
    await expect(window.locator(".run-error")).toContainText("The model stream failed while receiving data.", { timeout: 20000 });
    await expect(window.getByRole("button", { name: "停止", exact: true })).not.toBeVisible();
    await expect(input).toHaveValue("");
    const failed = await window.evaluate(async () => {
      const api = globalThis.window.specloom;
      const state = await api.state();
      return (await api.sessions!.list(state.project!.path)).find((session) => session.items.some((item) => item.kind === "message" && item.role === "user" && item.content === "持续中断"));
    });
    expect(failed?.status).toBe("error");
    expect(failed?.draft).toBe("");
    expect(attempts.get("持续中断")).toHaveLength(6);
    expect(failures).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(data, { force: true, recursive: true });
  }
});
