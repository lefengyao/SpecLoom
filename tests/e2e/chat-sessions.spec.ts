import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchSourceElectron } from "./source-electron";

test("session switching, delayed SSE, stop, structured answers and reload use the real desktop bridge", async () => {
  test.setTimeout(120_000);
  const data = await mkdtemp(path.join(os.tmpdir(), "specloom-chat-e2e-"));
  let asked = 0;
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += String(chunk);
    const payload = JSON.parse(body) as { tools?: { function: { name: string } }[]; messages: { role: string; content?: string }[] };
    expect(payload.tools?.map((t) => t.function.name)).toEqual(expect.arrayContaining(["Read", "Write", "ToolSearch", "AskUserQuestion"]));
    expect(payload.messages.find((m) => m.role === "system")?.content).not.toContain("no workspace tools");
    const prompt = [...payload.messages].reverse().find((m) => m.role === "user")?.content;
    if (prompt === "流式A") {
      response.setHeader("Content-Type", "text/event-stream");
      response.write('data: {"choices":[{"delta":{"reasoning_content":"先检查当前场景的移动逻辑"}}]}\n\n');
      response.write('data: {"choices":[{"delta":{"content":"首段实时显示"}}]}\n\n');
      // Keep the connection open; the first bubble must be visible before EOF.
      return;
    }
    response.setHeader("Content-Type", "application/json");
    if (prompt === "请澄清" && !payload.messages.some((m) => m.role === "tool")) {
      asked++;
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "question-call", type: "function", function: { name: "AskUserQuestion", arguments: JSON.stringify({ title: "确定移动方向", fields: [{ id: "direction", label: "方向", type: "single", required: true, options: [{ id: "left", label: "向左" }, { id: "right", label: "向右" }] }, { id: "details", label: "补充说明", type: "text", required: true }] }) } }] } }] }));
    } else response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "根据你的答案继续完成" } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const app = await launchSourceElectron(data);
  try {
    const window = await app.firstWindow(); const errors: string[] = []; window.on("pageerror", (e) => errors.push(e.message));
    await window.getByRole("button", { name: "创建示例项目" }).click();
    await expect(window.getByRole("heading", { name: "灯塔守望", exact: true })).toBeVisible();
    await window.evaluate(async (port) => {
      const api = globalThis.window.specloom;
      await api.saveProvider!({ id: "e2e", name: "SSE", protocol: "openai", baseUrl: `http://127.0.0.1:${port}/v1`, models: ["fixture"], modelSettings: {} });
      await api.setDefaultModel!({ providerId: "e2e", model: "fixture" });
    }, (server.address() as AddressInfo).port);
    await window.reload();
    const avatarBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    const avatarSource = `data:image/png;base64,${avatarBytes.toString("base64")}`;
    await window.getByRole("button", { name: "设置", exact: true }).first().click();
    await window.getByRole("navigation", { name: "设置分区" }).getByRole("button", { name: "个性化", exact: true }).click();
    await window.getByLabel("上传用户头像").setInputFiles({ name: "user.png", mimeType: "image/png", buffer: avatarBytes });
    await expect(window.getByRole("button", { name: "恢复默认用户头像", exact: true })).toBeEnabled();
    await window.getByLabel("上传智能体头像").setInputFiles({ name: "assistant.png", mimeType: "image/png", buffer: avatarBytes });
    await expect(window.getByRole("button", { name: "恢复默认智能体头像", exact: true })).toBeEnabled();
    await window.getByRole("button", { name: "工作区", exact: true }).click();
    await window.getByRole("button", { name: "新建会话", exact: true }).first().click();
    const capabilities = window.getByRole("region", { name: "会话能力清单" });
    await expect(capabilities).toBeVisible();
    await capabilities.getByText(/^工具 · \d+$/).click();
    await expect(capabilities.getByText("Read", { exact: true })).toBeVisible();
    await expect(capabilities.getByText("ToolSearch", { exact: true })).toBeVisible();
    await expect(capabilities.getByText(/^Skills · [1-9]\d*$/)).toBeVisible();
    await expect(window.locator(".message-bubble")).toHaveCount(0);
    await window.getByLabel("任务消息").fill("流式A"); await window.getByRole("button", { name: "发送", exact: true }).click();
    // Sending refreshes real project capabilities; Windows file discovery can exceed five seconds.
    await expect(window.getByText("首段实时显示", { exact: true })).toBeVisible({ timeout: 20000 });
    const progress = window.getByRole("status", { name: "智能体运行状态" });
    await expect(progress).toBeVisible();
    await expect(progress.locator(".thinking-dots i")).toHaveCount(3);
    expect(await progress.locator(".thinking-dots i").first().evaluate((dot) => getComputedStyle(dot).animationName)).not.toBe("none");
    await expect(window.getByLabel("模型返回的思考")).not.toContainText("先检查当前场景的移动逻辑");
    await window.getByRole("button", { name: "展开工具链", exact: true }).click();
    await window.getByLabel("模型返回的思考").locator("summary").click();
    await expect(window.getByLabel("模型返回的思考")).toContainText("先检查当前场景的移动逻辑");
    await expect(window.locator(".chat-user").getByRole("img", { name: "用户头像", exact: true })).toHaveAttribute("src", avatarSource);
    await expect(window.locator(".chat-assistant").getByRole("img", { name: "智能体头像", exact: true })).toHaveAttribute("src", avatarSource);
    await expect(window.locator(".run-summary summary")).toContainText("第 1 轮工具调用");
    await expect(window.getByRole("button", { name: "停止", exact: true })).toBeVisible();
    await window.getByRole("button", { name: "新建会话", exact: true }).click();
    await expect(window.getByRole("heading", { name: "新会话", exact: true })).toBeVisible();
    await window.getByLabel("任务消息").fill("B草稿");
    await window.getByRole("button", { name: "流式A", exact: true }).click();
    await expect(window.getByLabel("任务消息")).toHaveValue("");
    await expect(window.getByText("首段实时显示", { exact: true })).toBeVisible();
    await window.getByRole("button", { name: "停止", exact: true }).click();
    await expect(window.getByText("已停止，保留部分回复", { exact: true })).toBeVisible();
    await expect(window.getByRole("status", { name: "智能体运行状态" })).not.toBeVisible();
    await expect(window.getByText("INTERNAL_ERROR", { exact: true })).not.toBeVisible();
    await expect(window.getByText("首段实时显示", { exact: true })).toBeVisible();
    await window.getByRole("button", { name: "新会话", exact: true }).click(); await expect(window.getByLabel("任务消息")).toHaveValue("B草稿");
    await window.getByLabel("任务消息").fill("请澄清"); await window.getByRole("button", { name: "发送", exact: true }).click();
    await expect(window.getByRole("article", { name: "需求问答" }).getByText("确定移动方向", { exact: true })).toBeVisible({ timeout: 20000 });
    const before = await window.evaluate(async () => { const api = globalThis.window.specloom; const state = await api.state(); return api.sessions!.list(state.project!.path); });
    const waiting = before.find((s) => s.status === "waiting")!; expect(waiting).toBeTruthy();
    await window.getByRole("button", { name: "稍后处理", exact: true }).click(); await window.getByRole("button", { name: "继续回答", exact: true }).click();
    await window.getByLabel("向左").check(); await window.getByLabel("补充说明（必填）").fill("速度180"); await window.getByRole("button", { name: "提交回答", exact: true }).click();
    await expect(window.getByText("根据你的答案继续完成", { exact: true })).toBeVisible();
    const after = await window.evaluate(async () => { const api = globalThis.window.specloom; const state = await api.state(); return api.sessions!.list(state.project!.path); });
    expect(after.find((s) => s.id === waiting.id)?.runId).toBe(waiting.runId); expect(asked).toBe(1);
    await expect(window.getByRole("button", { name: "停止", exact: true })).not.toBeVisible();
    await window.screenshot({ path: ".local/workspace-interactions.png", fullPage: true });
    await window.reload(); await window.getByRole("button", { name: "请澄清", exact: true }).click();
    await expect(window.getByText("根据你的答案继续完成", { exact: true })).toBeVisible();
    await window.getByRole("button", { name: "流式A", exact: true }).click(); await expect(window.getByText("首段实时显示", { exact: true })).toBeVisible();
    await expect(window.locator(".chat-user").getByRole("img", { name: "用户头像", exact: true })).toHaveAttribute("src", avatarSource);
    await expect(window.locator(".chat-assistant").getByRole("img", { name: "智能体头像", exact: true })).toHaveAttribute("src", avatarSource);
    await window.getByRole("button", { name: "展开工具链", exact: true }).click();
    await window.getByLabel("模型返回的思考").locator("summary").click();
    await expect(window.getByLabel("模型返回的思考")).toContainText("先检查当前场景的移动逻辑");
    await window.evaluate(async () => {
      const api = globalThis.window.specloom; const state = await api.state();
      const task = await api.createTask({ title: "可恢复任务", readPaths: ["specs/**"], writePaths: [], allowDelete: false, mode: "manual" });
      const session = await api.sessions!.create(state.project!.path, undefined, task.id);
      await api.sessions!.remove(state.project!.path, session.id);
    });
    // Direct bridge setup bypasses the UI's state refresh after task creation.
    await window.reload();
    await window.getByRole("button", { name: "历史", exact: true }).click();
    await window.getByRole("button").filter({ hasText: "可恢复任务" }).click();
    await expect(window.getByRole("heading", { name: "可恢复任务", exact: true })).toBeVisible();
    await window.getByText("已授权范围", { exact: true }).click();
    await expect(window.getByText(/读取：specs\/\*\*/)).toBeVisible();
    await window.getByRole("button", { name: "设置", exact: true }).first().click();
    await window.getByRole("navigation", { name: "设置分区" }).getByRole("button", { name: "个性化", exact: true }).click();
    await window.getByRole("button", { name: "恢复默认用户头像", exact: true }).click();
    await expect(window.getByRole("button", { name: "恢复默认用户头像", exact: true })).toBeDisabled();
    await window.getByRole("button", { name: "恢复默认智能体头像", exact: true }).click();
    await expect(window.getByRole("button", { name: "恢复默认智能体头像", exact: true })).toBeDisabled();
    expect(errors).toEqual([]);
  } finally { await app.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(data, { force: true, recursive: true }); }
});
