import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { parseMaterial } from "../../src/shared/project-materials";
import { launchSourceElectron } from "./source-electron";

test("agent material creation, component values and pictures persist and refresh the open editor without losing drafts", async () => {
  test.setTimeout(120000);
  const data = await mkdtemp(path.join(os.tmpdir(), "specloom-material-agent-e2e-"));
  const project = path.join(data, "game"); await mkdir(path.join(project, "art"), { recursive: true });
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMw2pL3HwAExAJUkjHOGQAAAABJRU5ErkJggg==";
  await writeFile(path.join(project, "art/hero.png"), Buffer.from(png, "base64"));
  const rounds = new Map<string, number>();
  let updateWaiting = false; let releaseUpdate = () => {};
  const failures: string[] = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += String(chunk);
    try {
      const payload = JSON.parse(body) as { tools: { function: { name: string } }[]; messages: { role: string; content: string }[] };
      const prompt = payload.messages.filter(message => message.role === "user").at(-1)!.content;
      const round = rounds.get(prompt) ?? 0; rounds.set(prompt, round + 1);
      const previous = JSON.parse(payload.messages.filter(message => message.role === "tool").at(-1)?.content ?? "{}") as { ok?: boolean; result?: { version: string } };
      if (round > 0 && previous.ok !== true) failures.push(JSON.stringify(previous));
      let name = ""; let input: Record<string, unknown> = {};
      if (prompt === "创建资料") {
        switch (round) {
          case 0: name = "ToolSearch"; input = { query: "MaterialCreate MaterialBindComponent MaterialSetImage MaterialUpdate" }; break;
          case 1: name = "MaterialCreate"; input = { category: "component", id: "health", title: "生命值", properties: { fields: [{ key: "current", type: "number", default: 100 }] } }; break;
          case 2: name = "MaterialCreate"; input = { category: "entity", id: "hero", title: "智能体主角", properties: { group: "角色" } }; break;
          case 3: name = "MaterialBindComponent"; input = { path: "specs/entities/hero.md", expectedVersion: previous.result!.version, componentPath: "specs/components/health.md", values: { current: 90 } }; break;
          case 4: name = "MaterialSetImage"; input = { path: "specs/entities/hero.md", expectedVersion: previous.result!.version, sourcePath: "art/hero.png" }; break;
        }
      } else if (round === 0) { name = "MaterialRead"; input = { path: "specs/entities/hero.md" }; }
      else if (round === 1) {
        name = "MaterialUpdate"; input = { path: "specs/entities/hero.md", expectedVersion: previous.result!.version, changes: { title: prompt === "干净更新" ? "智能体更新" : "智能体再次更新" } };
        updateWaiting = true; await new Promise<void>(resolve => { releaseUpdate = resolve; }); updateWaiting = false;
      }
      if (name && !payload.tools.some(tool => tool.function.name === name)) failures.push(`工具未发现：${name}`);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: name ? { role: "assistant", content: null, tool_calls: [{ id: `${prompt}-${round}`, type: "function", function: { name, arguments: JSON.stringify(input) } }] } : { role: "assistant", content: "资料操作完成" } }] }));
    } catch (error) { failures.push(String(error)); response.writeHead(500); response.end("fixture failed"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const app = await launchSourceElectron(data);
  try {
    const window = await app.firstWindow(); const errors: string[] = []; window.on("pageerror", error => errors.push(error.message));
    window.on("dialog", dialog => { void dialog.accept().catch(() => undefined); });
    await expect(window.getByRole("button", { name: "创建示例项目" })).toBeEnabled({ timeout: 20000 });
    await window.evaluate(async ({ root, port }) => {
      const api = globalThis.window.specloom; await api.openProject(root);
      await api.saveProvider!({ id: "fixture", name: "资料验收", protocol: "openai", baseUrl: `http://127.0.0.1:${port}/v1`, models: ["fixture"], modelSettings: { fixture: { maxToolRounds: 10 } } });
      await api.setDefaultModel!({ providerId: "fixture", model: "fixture" });
    }, { root: project, port: (server.address() as AddressInfo).port });
    await window.reload();
    const sessionId = await window.evaluate(async root => (await globalThis.window.specloom.sessions!.create(root)).id, project);
    const created = await window.evaluate(async ({ root, id }) => globalThis.window.specloom.sessions!.send(root, id, "创建资料"), { root: project, id: sessionId });
    expect(created.status).toBe("completed");
    await window.getByRole("button", { name: "实体", exact: true }).click();
    await window.getByRole("button", { name: "查看 智能体主角" }).click();
    await expect(window.getByLabel("生命值 · current", { exact: true })).toHaveValue("90");
    await expect(window.getByLabel("分组", { exact: true })).toHaveValue("角色");
    await expect(window.locator(".material-image-preview img")).toBeVisible();
    for (const prompt of ["干净更新", "草稿更新"]) {
      if (prompt === "草稿更新") await window.getByLabel("名称", { exact: true }).fill("本地草稿");
      const pending = window.evaluate(async ({ root, id, prompt }) => globalThis.window.specloom.sessions!.send(root, id, prompt), { root: project, id: sessionId, prompt });
      await expect.poll(() => updateWaiting, { timeout: 20000 }).toBe(true);
      releaseUpdate(); expect((await pending).status).toBe("completed");
      await expect(window.getByLabel("名称", { exact: true })).toHaveValue(prompt === "干净更新" ? "智能体更新" : "本地草稿");
    }
    const validity = await window.locator("#material-edit-form").evaluate(form => [...(form as HTMLFormElement).elements].filter(element => "validity" in element && !(element as HTMLInputElement).validity.valid).map(element => ({ name: element.getAttribute("aria-label") ?? element.getAttribute("name"), tag: element.tagName, value: (element as HTMLInputElement).value, message: (element as HTMLInputElement).validationMessage })));
    expect(validity).toEqual([]);
    await window.getByRole("button", { name: "保存资料", exact: true }).click();
    await expect(window.getByRole("alert")).toBeVisible();
    await expect(window.getByText("VERSION_CONFLICT", { exact: true })).toBeVisible();
    expect(parseMaterial(await readFile(path.join(project, "specs/entities/hero.md"), "utf8"))?.data.title).toBe("智能体再次更新");
    expect((await window.evaluate(() => globalThis.window.specloom.state())).tasks).toEqual([]);
    expect(failures).toEqual([]); expect(errors).toEqual([]);
    await window.getByRole("button", { name: "重新读取", exact: true }).click();
    await window.getByRole("dialog", { name: "重新读取资料" }).getByRole("button", { name: "丢弃修改并重新读取", exact: true }).click();
    await expect(window.getByLabel("名称", { exact: true })).toHaveValue("智能体再次更新");
    await window.reload(); await window.getByRole("button", { name: "实体", exact: true }).click();
    await expect(window.getByRole("button", { name: "查看 智能体再次更新" })).toBeVisible();
  } finally { releaseUpdate(); await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => undefined); await app.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(data, { force: true, recursive: true }); }
});
