import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { _electron as electron, expect, test } from "@playwright/test";
import { developmentArguments } from "../../scripts/dev-runtime.mjs";
import { docxFixture } from "../helpers/chat-attachment-fixtures";

async function cleanupHubSmoke(userData: string) {
  const resolved = path.resolve(userData);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("specloom-hub-source-")) throw new Error("Unexpected Hub smoke cleanup target");
  await rm(resolved, { recursive: true, force: true });
}

test("real Hub module windows share project state while media leases and project selection remain isolated", async ({ browserName }, testInfo) => {
  test.setTimeout(120000);
  expect(browserName).toBe("chromium");
  const sourceRoot = process.env.SPECLOOM_DEV_APP_ROOT;
  const sourceEntry = process.env.SPECLOOM_DEV_ENTRY_PATH;
  const rendererUrl = process.env.SPECLOOM_DEV_SERVER_URL;
  if (!sourceRoot || !sourceEntry || !rendererUrl) throw new Error("Launch this source test through npm run test:e2e");
  const userData = await mkdtemp(path.join(os.tmpdir(), "specloom-hub-source-"));
  const moduleRoot = path.join(userData, "source-module");
  const project = path.join(userData, "first-project");
  const other = path.join(userData, "other-project");
  await Promise.all([mkdir(moduleRoot), mkdir(project), mkdir(other)]);
  const junction = process.platform === "win32" ? "junction" : "dir";
  await Promise.all([
    symlink(path.join(sourceRoot, "skills"), path.join(moduleRoot, "skills"), junction),
    symlink(path.join(sourceRoot, "resources"), path.join(moduleRoot, "resources"), junction),
    symlink(path.dirname(sourceEntry), path.join(moduleRoot, "runtime"), junction),
    symlink(path.join(sourceRoot, "node_modules"), path.join(moduleRoot, "node_modules"), junction),
    writeFile(path.join(project, "cover.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")),
    writeFile(path.join(project, "README.md"), "# Shared Hub project\nHub smoke README\n"),
    writeFile(path.join(project, ".gitignore"), ".godot/\n"),
    writeFile(path.join(other, "README.md"), "# Other Hub project\n"),
  ]);
  const entryPath = path.join(moduleRoot, "hub-smoke.cjs");
  await build({ absWorkingDir: sourceRoot, entryPoints: ["tests/e2e/hub-source-entry.ts"], outfile: entryPath, platform: "node", format: "cjs", target: "node24", bundle: true, packages: "external", logLevel: "warning" });
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, { SPECLOOM_USER_DATA_DIR: userData, SPECLOOM_HUB_SMOKE_MODULE_ROOT: moduleRoot, SPECLOOM_HUB_SMOKE_PRELOAD: path.join(path.dirname(sourceEntry), "preload.cjs") });
  const app = await electron.launch({ args: [...developmentArguments({ entryPath }, env), "--headless", "--disable-gpu"], cwd: sourceRoot, env });
  try {
    await expect.poll(() => app.windows().length).toBe(2);
    const [first, second] = app.windows();
    await Promise.all([first!, second!].map(window => expect(window.getByRole("main").getByRole("button", { name: "打开项目", exact: true })).toBeEnabled()));
    await first!.evaluate(root => globalThis.window.specloom.openProject(root), project);
    await second!.evaluate(root => globalThis.window.specloom.openProject(root), project);
    await Promise.all([first!, second!].map(async window => { await window.evaluate(() => localStorage.setItem("specloom.documents.tree", "open")); await window.reload(); }));
    const firstState = await first!.evaluate(() => globalThis.window.specloom.state());
    const secondState = await second!.evaluate(() => globalThis.window.specloom.state());
    expect(firstState.windowId).not.toBe(secondState.windowId);
    expect(firstState.project?.path).toBe(project);
    expect(secondState.project?.path).toBe(project);
    expect(secondState.mcp?.url).toBe(firstState.mcp?.url);
    const session = await first!.evaluate(async root => globalThis.window.specloom.sessions!.create(root, "Hub shared session"), project);
    await second!.evaluate(async ({ root, id }) => globalThis.window.specloom.sessions!.patch(root, id, { draft: "Shared Hub draft" }), { root: project, id: session.id });
    expect(await first!.evaluate(async ({ root, id }) => (await globalThis.window.specloom.sessions!.list(root)).find(item => item.id === id)?.draft, { root: project, id: session.id })).toBe("Shared Hub draft");
    for (const window of [first!, second!]) {
      await window.getByRole("button", { name: "项目文件", exact: true }).click();
      await window.getByRole("tree", { name: "项目树", exact: true }).getByRole("button", { name: "cover.png", exact: true }).click();
      await expect.poll(() => window.getByRole("img", { name: "cover.png", exact: true }).evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);
    }
    const firstUrl = await first!.getByRole("img", { name: "cover.png", exact: true }).getAttribute("src");
    const peerUrl = await second!.getByRole("img", { name: "cover.png", exact: true }).getAttribute("src");
    expect(firstUrl).not.toBe(peerUrl);
    expect((await fetch(firstUrl!)).status).toBe(200);
    expect((await fetch(peerUrl!)).status).toBe(200);
    await first!.getByRole("button", { name: "关于项目", exact: true }).click();
    await expect.poll(async () => (await fetch(firstUrl!)).status).toBe(404);
    expect((await fetch(peerUrl!)).status).toBe(200);
    await first!.locator(".about-document").filter({ has: first!.getByText("README.md", { exact: true }) }).getByRole("button", { name: "打开文件", exact: true }).click();
    await expect(first!.getByRole("textbox", { name: "项目文件内容", exact: true })).toHaveValue("# Shared Hub project\nHub smoke README\n");
    await app.evaluate(({ clipboard }) => { clipboard.clear(); clipboard.writeText("Hub native clipboard text"); });
    expect(await second!.evaluate(async root => (await globalThis.window.specloom.chatAttachments!.readClipboard(root)).text, project)).toBe("Hub native clipboard text");
    const prepared = await second!.evaluate(async ({ root, id, bytes }) => globalThis.window.specloom.chatAttachments!.prepare(root, id, crypto.randomUUID(), { name: "notes.docx", declaredMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: new Uint8Array(bytes) }), { root: project, id: session.id, bytes: Array.from(docxFixture("Hub source worker text")) });
    expect(prepared).toMatchObject({ kind: "document", name: "notes.docx", text: "Hub source worker text" });
    await first!.evaluate(root => globalThis.window.specloom.openProject(root), other);
    expect((await second!.evaluate(() => globalThis.window.specloom.state())).project?.path).toBe(project);
    expect((await fetch(peerUrl!)).status).toBe(200);
    await first!.close();
    await expect.poll(() => app.windows().length).toBe(1);
    expect((await fetch(peerUrl!)).status).toBe(200);
    expect(await second!.evaluate(async root => (await globalThis.window.specloom.sessions!.list(root)).length, project)).toBeGreaterThan(0);
    await second!.screenshot({ path: testInfo.outputPath("hub-project-media-peer-survives.png") });
    await expect(second!.locator(".error-notice")).toHaveCount(0);
    await app.evaluate(({ clipboard }) => clipboard.clear());
  } finally {
    await app.close();
    await cleanupHubSmoke(userData);
  }
});
