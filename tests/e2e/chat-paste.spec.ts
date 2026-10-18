import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { docxFixture, pdfFixture } from "../helpers/chat-attachment-fixtures";
import { launchSourceElectron } from "./source-electron";

test("native screenshot and copied TXT PDF DOCX paste send actual content through the source bridge", async () => {
  test.setTimeout(180000);
  const profile = await mkdtemp(path.join(os.tmpdir(), "specloom-paste-"));
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("specloom-paste-")) throw new Error("Unexpected test cleanup path");
  const requests: { messages: { role: string; content: unknown }[] }[] = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += String(chunk);
    requests.push(JSON.parse(body));
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: `已接收附件${requests.length}` } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const app = await launchSourceElectron(profile);
  let previousText = "";
  try {
    // Preserve clipboard text and restore it on exit; fixture writes are confined to this explicit test.
    previousText = await app.evaluate(({ clipboard }) => clipboard.readText());
    const page = await app.firstWindow();
    page.on("pageerror", error => console.log("paste-page-error", error.message));
    await page.getByRole("button", { name: "创建示例项目", exact: true }).click();
    await expect(page.getByRole("heading", { name: "灯塔守望", exact: true })).toBeVisible();
    await page.evaluate(async port => {
      const api = window.specloom;
      await api.providers!.save({ id: "paste-fixture", name: "Clipboard fixture", protocol: "openai", baseUrl: `http://127.0.0.1:${port}/v1`, models: ["vision-fixture"], modelSettings: { "vision-fixture": { vision: true } } });
      await api.setDefaultModel!({ providerId: "paste-fixture", model: "vision-fixture" });
    }, (server.address() as AddressInfo).port);
    await page.reload();
    await page.getByRole("button", { name: "新建会话", exact: true }).first().click();
    const composer = page.getByLabel("任务消息");
    await expect(composer).toBeEnabled();
    await app.evaluate(({ clipboard, nativeImage }) => {
      clipboard.clear();
      clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")));
    });
    await composer.focus(); await composer.press("Control+V");
    await expect(page.getByRole("button", { name: /移除附件/ })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect.poll(() => requests.length, { timeout: 30000 }).toBe(1);
    const imageUser = [...requests[0]!.messages].reverse().find(message => message.role === "user")!;
    expect(imageUser.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "image_url", image_url: expect.objectContaining({ url: expect.stringMatching(/^data:image\/png;base64,/) }) })]));
    await expect(page.getByText("已接收附件1", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "停止", exact: true })).toHaveCount(0);

    const fixtures = [
      { name: "notes.txt", bytes: Buffer.from("Clipboard TXT 实际正文"), expected: "Clipboard TXT 实际正文", context: false },
      { name: "reference.pdf", bytes: pdfFixture("Clipboard PDF actual text"), expected: "Clipboard PDF actual text", context: true },
      { name: "design.docx", bytes: docxFixture("Clipboard DOCX 实际正文"), expected: "Clipboard DOCX 实际正文", context: false },
    ];
    for (const [index, fixture] of fixtures.entries()) {
      const file = path.join(profile, fixture.name); await writeFile(file, fixture.bytes);
      await app.evaluate(({ clipboard, nativeImage }, copiedFile) => {
        clipboard.clear();
        // Include a preview bitmap: native file contents must take precedence on right-click paste.
        clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")));
        clipboard.writeBuffer("FileNameW", Buffer.from(copiedFile + "\0", "utf16le"));
      }, file);
      if (fixture.context) {
        await composer.click({ button: "right" });
        await page.getByRole("menuitem", { name: /^粘贴/ }).click();
      } else { await composer.focus(); await composer.press("Control+V"); }
      await expect(page.getByRole("button", { name: `移除附件 ${fixture.name}`, exact: true })).toBeVisible().catch(async error => {
        console.log("paste-failure", fixture.name, await page.locator("body").innerText());
        console.log("clipboard-formats", await app.evaluate(({ clipboard }) => clipboard.availableFormats()));
        throw error;
      });
      await expect(page.getByRole("button", { name: /移除附件/ })).toHaveCount(1);
      await expect(page.getByRole("button", { name: "发送", exact: true })).toBeEnabled({ timeout: 20000 });
      await page.getByRole("button", { name: "发送", exact: true }).click();
      await expect.poll(() => requests.length, { timeout: 30000 }).toBe(index + 2);
      const user = [...requests[index + 1]!.messages].reverse().find(message => message.role === "user")!;
      expect(user.content).toContain(fixture.expected);
      expect(String(user.content).split(fixture.expected)).toHaveLength(2);
      await expect(page.getByText(`已接收附件${index + 2}`, { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "停止", exact: true })).toHaveCount(0);
    }
    await app.evaluate(({ clipboard }) => { clipboard.clear(); clipboard.writeText("替换"); });
    await composer.fill("前原文后");
    await composer.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(1, 3));
    await composer.press("Control+V");
    await expect(composer).toHaveValue("前替换后");
  } finally {
    await app.evaluate(({ clipboard }, text) => { clipboard.clear(); clipboard.writeText(text); }, previousText).catch(() => undefined);
    await app.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(profile, { recursive: true, force: true });
  }
});
