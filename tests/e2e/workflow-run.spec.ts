import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchSourceElectron } from "./source-electron";

test("official workflow runs through approval and records a decision", async () => {
  test.setTimeout(180000);
  const data = await mkdtemp(path.join(os.tmpdir(), "specloom-workflow-run-"));
  const requests: string[] = [];
  let implementRound = 0;
  const writeContent = [
    "---",
    "schemaVersion: 1",
    "id: workflow_e2e",
    "type: character",
    "title: 工作流验收实体",
    "description: 工作流运行时创建的验收实体",
    "status: draft",
    "version: 1",
    "relations: []",
    "source: developer",
    "---",
    "",
    "# 工作流验收实体",
    "",
  ].join("\n");
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    requests.push(body);
    const isImplement = body.includes("根据目标和计划实现改动");
    let calls: { id: string; type: "function"; function: { name: string; arguments: string } }[] = [];
    if (isImplement && implementRound === 0) {
      calls = [{ id: "workflow-write", type: "function", function: { name: "files_write", arguments: JSON.stringify({ path: "specs/entities/characters/workflow_e2e.md", expectedVersion: "absent", content: writeContent }) } }];
    }
    if (isImplement) implementRound++;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: calls.length
          ? { role: "assistant", content: null, tool_calls: calls }
          : { role: "assistant", content: "已读取规范，完成规划与实现，等待人工审查。" },
        finish_reason: calls.length ? "tool_calls" : "stop",
      }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = "http://127.0.0.1:" + (server.address() as AddressInfo).port + "/v1";
  const application = await launchSourceElectron(data);
  try {
    const window = await application.firstWindow();
    await expect(window.getByRole("heading", { name: "SpecLoom", exact: true })).toBeVisible();
    await window.getByRole("button", { name: "创建示例项目" }).click();
    await expect(window.getByRole("heading", { name: "灯塔守望", exact: true })).toBeVisible();

    await window.getByRole("button", { name: "供应商", exact: true }).click();
    await window.getByRole("button", { name: "添加供应商", exact: true }).click();
    await window.getByLabel("供应商名称").fill("工作流验收供应商");
    await window.getByLabel("服务地址").fill(baseUrl);
    await window.getByRole("button", { name: "保存供应商", exact: true }).click();
    await expect(window.getByRole("heading", { name: "工作流验收供应商 · 模型管理", exact: true })).toBeVisible();
    await window.getByLabel("手动模型 ID").fill("fixture");
    await window.getByRole("button", { name: "手动添加", exact: true }).click();
    await window.getByRole("button", { name: "保存模型配置", exact: true }).click();

    const selected = await window.evaluate(async () => {
      const api = globalThis.window.specloom;
      const state = await api.state();
      const provider = state.providers?.[0];
      const model = provider?.models?.[0];
      if (!provider || !model) return undefined;
      await api.setDefaultModel?.({ providerId: provider.id, model });
      return { providerId: provider.id, model };
    });
    expect(selected).toBeTruthy();

    await window.getByRole("button", { name: "工作流", exact: true }).click();
    await expect(window.getByRole("heading", { name: "工作流", exact: true })).toBeVisible();
    await window.getByRole("button", { name: "从官方复制" }).click();
    await expect(window.getByText("Agent 实现", { exact: true })).toBeVisible();
    await window.getByRole("button", { name: "运行", exact: true }).click();
    await window.getByLabel("目标").fill("实现灯塔交互并完成后端审查");
    await window.getByLabel("读取范围").fill("specs");
    await window.getByLabel("修改范围").fill("specs/entities");
    await window.getByRole("button", { name: "开始运行" }).click();

    await expect(window.getByRole("button", { name: "批准并记录决策" })).toBeVisible({ timeout: 60000 });
    expect(requests.length).toBeGreaterThanOrEqual(2);
    await window.getByRole("button", { name: "批准并记录决策" }).click();
    await expect(window.locator(".workflow-run-status.wf-status-completed")).toBeVisible({ timeout: 30000 });

    const decision = await window.evaluate(async () => {
      const api = globalThis.window.specloom;
      const docs = await api.documents();
      const file = docs.find((item) => item.path.startsWith("specs/decisions/"));
      if (!file) return undefined;
      return (await api.readDocument(file.path, file.version)).content;
    });
    expect(decision).toContain("实现灯塔交互并完成后端审查");
    await window.screenshot({ path: ".local/workflow-run-completed.png", fullPage: true });
  } finally {
    await application.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(data, { recursive: true, force: true });
  }
});
