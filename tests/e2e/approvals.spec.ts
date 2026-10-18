import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { ChatSession } from "../../src/shared/chat";
import { launchSourceElectron } from "./source-electron";

async function exists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
}

async function promptSession(window: Page, prompt: string): Promise<ChatSession | undefined> {
  return window.evaluate(async text => {
    const api = globalThis.window.specloom;
    const state = await api.state();
    return (await api.sessions!.list(state.project!.path)).find(session => session.items.some(item => item.kind === "message" && item.role === "user" && item.content === text));
  }, prompt);
}

test("source permissions gate external effects, persist modes, and reject stale approvals", async () => {
  test.setTimeout(180000);
  const data = await mkdtemp(path.join(os.tmpdir(), "specloom-approvals-e2e-"));
  const paths = {
    approve: path.join(data, "approved-external.txt"),
    deny: path.join(data, "denied-external.txt"),
    full: path.join(data, "full-external.txt"),
    cancel: path.join(data, "cancelled-external.txt"),
  };
  const counts = new Map<string, number>();
  const results = new Map<string, string>();
  const failures: string[] = [];
  const calls: Record<string, { path: string; content: string }> = {
    "请求批准后写入": { path: paths.approve, content: "approved once" },
    "拒绝外部写入": { path: paths.deny, content: "must not exist" },
    "项目内自动写入": { path: "approval-project.txt", content: "project auto" },
    "完全访问外部写入": { path: paths.full, content: "full access" },
    "取消外部写入": { path: paths.cancel, content: "must not exist" },
  };
  const server = createServer(async (request, response) => {
    try {
      let text = ""; for await (const chunk of request) text += String(chunk);
      const body = JSON.parse(text) as { messages: Array<{ role: string; content: string; tool_call_id?: string }> };
      const prompt = body.messages.filter(message => message.role === "user").at(-1)!.content;
      const round = (counts.get(prompt) ?? 0) + 1; counts.set(prompt, round);
      const call = calls[prompt];
      if (!call) throw new Error(`Unexpected fixture prompt: ${prompt}`);
      if (round === 2) results.set(prompt, body.messages.filter(message => message.role === "tool").at(-1)!.content);
      const delta = round === 1
        ? { tool_calls: [{ index: 0, id: `write-${prompt}`, function: { name: "Write", arguments: JSON.stringify(call) } }] }
        : { content: `${prompt}已完成` };
      response.setHeader("Content-Type", "text/event-stream");
      response.end([
        { choices: [{ delta }] },
        { choices: [{ delta: {}, finish_reason: round === 1 ? "tool_calls" : "stop" }] },
      ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n");
    } catch (error) { failures.push(String(error)); response.destroy(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const app = await launchSourceElectron(path.join(data, "profile"));
  try {
    const window = await app.firstWindow();
    const errors: string[] = [];
    window.on("pageerror", error => errors.push(error.message));
    window.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await window.getByRole("button", { name: "创建示例项目" }).click();
    await expect(window.getByRole("heading", { name: "灯塔守望", exact: true })).toBeVisible();
    await window.evaluate(async port => {
      const api = globalThis.window.specloom;
      await api.saveProvider!({ id: "approval-fixture", name: "Local approval fixture", protocol: "openai", baseUrl: `http://127.0.0.1:${port}/v1`, models: ["fixture"], modelSettings: {} });
      await api.setDefaultModel!({ providerId: "approval-fixture", model: "fixture" });
    }, (server.address() as AddressInfo).port);
    await window.reload();
    await window.getByRole("button", { name: "新建会话", exact: true }).first().click();
    const permissions = window.getByRole("combobox", { name: "审批权限" });
    const input = window.getByLabel("任务消息");
    const send = window.getByRole("button", { name: "发送", exact: true });
    expect(await permissions.locator("option").allTextContents()).toEqual(["请求批准", "帮我批准", "完全访问"]);
    await expect(permissions).toHaveValue("auto");
    await permissions.selectOption("ask");
    await expect(permissions).toBeEnabled();
    await expect(permissions).toHaveValue("ask");
    await window.reload();
    await expect(permissions).toHaveValue("ask");

    await input.fill("请求批准后写入"); await send.click();
    const approval = window.getByLabel("审批请求");
    await expect.poll(async () => (await promptSession(window, "请求批准后写入"))?.status, { timeout: 20000 }).toBe("waiting");
    await expect(approval).toBeVisible();
    await expect(permissions).toBeDisabled();
    await expect(input).toHaveValue("");
    expect(await exists(paths.approve)).toBe(false);
    expect(counts.get("请求批准后写入")).toBe(1);
    const pending = await promptSession(window, "请求批准后写入");
    expect(pending?.status).toBe("waiting");
    const approvalItem = pending!.items.find(item => item.kind === "approval")!;
    expect(approvalItem.kind).toBe("approval");

    const artifactRoot = path.resolve(".codex/artifacts/approvals");
    await mkdir(artifactRoot, { recursive: true });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setMinimumSize(0, 0));
    for (const [name, width, height] of [["desktop", 1280, 900], ["compact", 600, 800]] as const) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setContentSize(size.width, size.height), { width, height });
      await expect.poll(() => window.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width, height });
      await window.evaluate(() => { const timeline = document.querySelector(".conversation-timeline")!; timeline.scrollTop = timeline.scrollHeight; });
      await approval.scrollIntoViewIfNeeded();
      await window.screenshot({ path: path.join(artifactRoot, `${name}.png`) });
      const bounds = await window.evaluate(() => {
        const composer = document.querySelector(".session-composer")!.getBoundingClientRect();
        const card = document.querySelector(".approval-card")!.getBoundingClientRect();
        const controls = Array.from(document.querySelectorAll(".approval-card button, .composer-options select")).map(element => {
          const box = element.getBoundingClientRect();
          return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
        });
        return { width: innerWidth, height: innerHeight, cardBottom: card.bottom, composerTop: composer.top, overflow: document.documentElement.scrollWidth > innerWidth, controls };
      });
      expect(bounds.overflow).toBe(false);
      expect(bounds.cardBottom).toBeLessThanOrEqual(bounds.composerTop);
      expect(bounds.controls.every(box => box.left >= 0 && box.right <= bounds.width && box.top >= 0 && box.bottom <= bounds.height)).toBe(true);
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 900));
    await approval.getByRole("button", { name: "批准", exact: true }).click();
    await expect(window.getByText("请求批准后写入已完成", { exact: true })).toBeVisible({ timeout: 20000 });
    expect(await readFile(paths.approve, "utf8")).toBe("approved once");
    expect(counts.get("请求批准后写入")).toBe(2);
    expect((await promptSession(window, "请求批准后写入"))?.items.filter(item => item.kind === "tool" && item.status === "ok")).toHaveLength(1);
    await expect(approval.getByText("已批准", { exact: true })).toBeVisible();
    await expect(window.getByRole("button", { name: "停止", exact: true })).not.toBeVisible();

    await input.fill("拒绝外部写入"); await send.click();
    const denied = window.getByLabel("审批请求").last();
    await expect(denied).toBeVisible();
    expect(await exists(paths.deny)).toBe(false);
    await denied.getByRole("button", { name: "拒绝", exact: true }).click();
    await expect(window.getByText("拒绝外部写入已完成", { exact: true })).toBeVisible({ timeout: 20000 });
    expect(await exists(paths.deny)).toBe(false);
    expect(results.get("拒绝外部写入")).toContain('"ok":false');
    expect(results.get("拒绝外部写入")).toContain("APPROVAL_REQUIRED");
    await expect(denied.getByText("已拒绝", { exact: true })).toBeVisible();
    await expect(window.getByRole("button", { name: "停止", exact: true })).not.toBeVisible();

    await permissions.selectOption("auto"); await expect(permissions).toBeEnabled();
    await input.fill("项目内自动写入"); await send.click();
    await expect(window.getByText("项目内自动写入已完成", { exact: true })).toBeVisible({ timeout: 20000 });
    const auto = await promptSession(window, "项目内自动写入");
    expect(auto?.approvalMode).toBe("auto");
    expect(auto?.items.filter(item => item.kind === "approval")).toHaveLength(2);
    const projectPath = await window.evaluate(async () => (await globalThis.window.specloom.state()).project!.path);
    expect(await readFile(path.join(projectPath, "approval-project.txt"), "utf8")).toBe("project auto");

    await permissions.selectOption("full"); await expect(permissions).toBeEnabled();
    await window.reload(); await expect(permissions).toHaveValue("full");
    await input.fill("完全访问外部写入"); await send.click();
    await expect(window.getByText("完全访问外部写入已完成", { exact: true })).toBeVisible({ timeout: 20000 });
    expect(await readFile(paths.full, "utf8")).toBe("full access");
    expect((await promptSession(window, "完全访问外部写入"))?.items.filter(item => item.kind === "approval")).toHaveLength(2);

    await permissions.selectOption("ask"); await expect(permissions).toBeEnabled();
    await input.fill("取消外部写入"); await send.click();
    await expect(window.getByLabel("审批请求").last().getByText("等待批准", { exact: true })).toBeVisible({ timeout: 20000 });
    const cancelling = await promptSession(window, "取消外部写入");
    const request = cancelling!.items.filter(item => item.kind === "approval").at(-1)!;
    await window.getByRole("button", { name: "停止", exact: true }).click();
    await expect.poll(async () => (await promptSession(window, "取消外部写入"))?.status).toBe("cancelled");
    await expect(window.getByLabel("审批请求").last().getByText("已取消", { exact: true })).toBeVisible();
    expect(await exists(paths.cancel)).toBe(false);
    const stale = await window.evaluate(async identity => {
      const api = globalThis.window.specloom;
      try { await api.sessions!.approve((await api.state()).project!.path, identity.sessionId, identity.runId, identity.id, true); return "accepted"; }
      catch (error) { return String(error); }
    }, request.request);
    expect(stale).not.toBe("accepted");
    expect(await exists(paths.cancel)).toBe(false);
    expect(counts.get("取消外部写入")).toBe(1);
    expect(failures).toEqual([]); expect(errors).toEqual([]);
  } finally {
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => undefined);
    await app.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(data, { recursive: true, force: true });
  }
});
