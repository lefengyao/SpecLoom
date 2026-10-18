import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchSourceElectron } from "./source-electron";

async function removeProfile(profile: string) {
  const target = path.resolve(profile);
  if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith("specloom-progress-")) throw new Error("Unexpected progress cleanup path");
  await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

test("source workspace preserves public progress bubbles between tool stages and durable run files", async () => {
  test.setTimeout(120_000);
  const profile = await mkdtemp(path.join(os.tmpdir(), "specloom-progress-"));
  const tools = [
    ["Write", { path: "scripts/体验.gd", content: "extends Node\nvar speed = 1\n" }],
    ["Read", { path: "scripts/体验.gd" }],
    ["Edit", { path: "scripts/体验.gd", old_string: "speed = 1", new_string: "speed = 2" }],
    ["Bash", { command: "[System.IO.File]::WriteAllText('shell-生成.txt','中文内容',[Text.UTF8Encoding]::new($false)); [Console]::WriteLine('中文执行完成')", shell: "powershell" }],
  ] as const;
  const progressMessages = [
    "我会先创建脚本，随后核对文件内容。",
    "脚本已写入，现在读取并核对速度配置。",
    "速度配置仍为 1，我会把它调整到 2。",
    "脚本修改完成，接下来检查命令输出和生成文件。",
  ];
  const reasoning = "供应商推理详情：先创建脚本，再核对速度配置。";
  const finalReply = "中文文件编辑与命令检查完成。";
  let releaseFinal!: () => void;
  const finalGate = new Promise<void>(resolve => { releaseFinal = resolve; });
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += String(chunk);
    const payload = JSON.parse(body) as { messages: { role: string; content?: string }[] };
    const prompt = [...payload.messages].reverse().find(message => message.role === "user")?.content;
    const index = payload.messages.filter(message => message.role === "tool").length;
    const next = prompt === "编辑中文文件" ? tools[index] : undefined;
    response.setHeader("Content-Type", "text/event-stream");
    if (next) response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: progressMessages[index] } }] })}\n\n`);
    if (index === 0 && next) response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: reasoning } }] })}\n\n`);
    if (!next && prompt === "编辑中文文件") await finalGate;
    const message = next ? { role: "assistant", content: null, tool_calls: [{ index: 0, id: `operation-${index}`, type: "function", function: { name: next[0], arguments: JSON.stringify(next[1]) } }] } : { role: "assistant", content: prompt === "只解释" ? "这次只解释，不修改文件。" : finalReply };
    response.end(`data: ${JSON.stringify({ choices: [{ delta: message }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const app = await launchSourceElectron(profile);
  try {
    const page = await app.firstWindow(); const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.getByRole("button", { name: "创建示例项目", exact: true }).click();
    const project = page.getByRole("region", { name: "当前项目" });
    await expect(project.getByRole("button", { name: "项目信息：灯塔守望" })).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".application-body > .project-bar")).toHaveCount(0);
    await project.getByRole("button", { name: "项目信息：灯塔守望" }).click();
    await expect(project.getByText("主场景", { exact: true })).toBeVisible();
    await project.getByRole("button", { name: "项目信息：灯塔守望" }).click();
    await page.evaluate(async port => {
      await window.specloom.providers!.save({ id: "progress-fixture", name: "进度验证", protocol: "openai", baseUrl: `http://127.0.0.1:${port}/v1`, models: ["fixture"] });
      await window.specloom.setDefaultModel!({ providerId: "progress-fixture", model: "fixture" });
    }, (server.address() as AddressInfo).port);
    await page.reload();
    await page.getByRole("button", { name: "新建会话", exact: true }).first().click();
    await page.getByLabel("审批权限", { exact: true }).selectOption("full");
    await page.getByLabel("任务消息").fill("编辑中文文件");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const timeline = page.getByRole("log", { name: "对话时间线" });
    async function expectProgressSequence(includeFinal = true) {
      const bubbles = timeline.locator(".message-bubble.chat-progress");
      await expect(bubbles).toHaveCount(progressMessages.length);
      const stages = timeline.locator(".message-bubble.chat-progress + .tool-chain-box");
      await expect(stages).toHaveCount(tools.length);
      const toolTitles = ["写入文件", "读取文件", "编辑文件", "执行命令"];
      for (const [index, content] of progressMessages.entries()) {
        const bubble = bubbles.nth(index);
        await expect(bubble.locator(".bubble-content")).toHaveText(content);
        await expect(bubble.locator(".bubble-label")).toHaveText("智能体 · 进度说明");
        await expect(bubble).not.toContainText("生成中");
        expect(await bubble.evaluate(element => element.closest(".tool-chain-box") === null)).toBe(true);
        await expect(stages.nth(index).getByText(toolTitles[index]!, { exact: true })).toBeVisible();
      }
      const sequence = await timeline.locator(".message-bubble.chat-assistant, .tool-chain-box:has(.tool-chain-step)").evaluateAll(elements => elements.map(element => {
        if (element.classList.contains("tool-chain-box")) return element.querySelector(".tool-chain-row button")?.getAttribute("title");
        return element.querySelector(".bubble-content")?.textContent;
      }));
      const expected = progressMessages.flatMap((content, index) => [content, tools[index]![0]]);
      expect(sequence).toEqual(includeFinal ? expected.concat(finalReply) : expected);
      await expect(timeline.getByText(reasoning, { exact: true })).not.toBeVisible();
      if (includeFinal) await expect(timeline.locator(".message-bubble.chat-assistant").last()).not.toHaveClass(/chat-progress/);
    }
    await expect(timeline.locator(".tool-step-result").getByText("中文执行完成", { exact: true })).toBeVisible({ timeout: 45_000 });
    await expect(timeline.getByText(finalReply, { exact: true })).toHaveCount(0);
    await expectProgressSequence(false);
    releaseFinal();
    await expect(page.getByText(finalReply, { exact: true })).toBeVisible({ timeout: 45_000 });
    await expectProgressSequence();
    const report = page.getByRole("region", { name: "本次文件变更" });
    await expect(report).toBeVisible();
    await expect(report.getByText("scripts/体验.gd", { exact: true })).toBeVisible();
    await expect(report.getByText("shell-生成.txt", { exact: true })).toBeVisible();
    await expect(report.getByText("运行期间检测", { exact: true })).toBeVisible();
    const editStage = timeline.locator(".message-bubble.chat-progress + .tool-chain-box").nth(2);
    await expect(editStage.getByText("speed = 2", { exact: true })).toBeVisible();
    await expect(timeline.locator(".tool-step-result").getByText("中文执行完成", { exact: true })).toBeVisible();
    expect(await report.evaluate(element => element.closest(".tool-chain-box") === null)).toBe(true);
    const root = await page.evaluate(async () => (await window.specloom.state()).project!.path);
    expect(await readFile(path.join(root, "scripts/体验.gd"), "utf8")).toContain("speed = 2");
    expect(await readFile(path.join(root, "shell-生成.txt"), "utf8")).toBe("中文内容");
    await mkdir(".local/evidence-progress-bubbles", { recursive: true });
    await page.setViewportSize({ width: 1366, height: 1080 });
    await timeline.locator(".message-bubble.chat-progress").first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: ".local/evidence-progress-bubbles/public-progress.png" });
    await report.scrollIntoViewIfNeeded();
    await page.screenshot({ path: ".local/evidence-progress-bubbles/progress-and-files.png" });
    await page.reload();
    await page.getByRole("button", { name: "编辑中文文件", exact: true }).click();
    await expect(page.getByRole("region", { name: "本次文件变更" }).getByText("scripts/体验.gd", { exact: true })).toBeVisible();
    await expectProgressSequence();
    await page.getByLabel("任务消息").fill("只解释");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    // Refreshing real project capabilities can exceed five seconds on Windows.
    await expect(page.getByText("这次只解释，不修改文件。", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("region", { name: "本次文件变更" })).toHaveCount(2);
    await expect(page.getByRole("region", { name: "本次文件变更" }).last()).toContainText("本次未检测到文件修改");
    expect(errors).toEqual([]);
  } finally {
    releaseFinal();
    await app.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await removeProfile(profile);
  }
});
