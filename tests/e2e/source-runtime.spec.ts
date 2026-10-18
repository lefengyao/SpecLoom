import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchSourceElectron } from "./source-electron";

test("temporary Electron entrypoint opens and reloads the source renderer with its sandbox bridge", async () => {
  const userData = await mkdtemp(path.join(os.tmpdir(), "specloom-source-e2e-"));
  const app = await launchSourceElectron(userData);
  try {
    const window = await app.firstWindow();
    const errors: string[] = [];
    window.on("pageerror", (error) => errors.push(error.message));
    await expect(window.getByRole("heading", { name: "SpecLoom", exact: true })).toBeVisible();
    expect(window.url()).toBe(process.env.SPECLOOM_DEV_SERVER_URL);
    const paths = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, root: app.getAppPath(), userData: app.getPath("userData") }));
    expect(paths.packaged).toBe(false);
    expect(path.resolve(paths.root)).toBe(path.dirname(process.env.SPECLOOM_DEV_ENTRY_PATH!));
    expect(path.resolve(paths.userData)).toBe(path.resolve(userData));
    await window.reload();
    await expect(window.getByRole("button", { name: "创建示例项目", exact: true })).toBeEnabled();
    expect(await window.evaluate(() => ({ bridge: "specloom" in window, node: "require" in window }))).toEqual({ bridge: true, node: false });
    expect((await window.evaluate(() => globalThis.window.specloom.state())).tasks).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test("source restarts retain providers and recent projects, and project Skills do not require a chat snapshot", async () => {
  test.setTimeout(60000);
  const userData = await mkdtemp(path.join(os.tmpdir(), "specloom-profile-e2e-"));
  let app = await launchSourceElectron(userData);
  try {
    let window = await app.firstWindow();
    await expect(window.getByRole("button", { name: "创建示例项目", exact: true })).toBeEnabled();
    const encryptedFixture = await app.evaluate(({ safeStorage }) => safeStorage.encryptString("profile-restart-fixture").toString("base64"));
    const projectPath = await window.evaluate(async () => {
      const api = globalThis.window.specloom;
      await api.providers!.save({ id: "persistent-provider", name: "持久化供应商", protocol: "openai", baseUrl: "https://example.test/v1", models: ["fixture-model"] });
      return (await api.createExample()).project!.path;
    });
    await app.close();
    app = await launchSourceElectron(userData);
    window = await app.firstWindow();
    await expect(window.getByRole("button", { name: "创建示例项目", exact: true })).toBeEnabled();
    expect(await app.evaluate(({ safeStorage }, ciphertext) => safeStorage.decryptString(Buffer.from(ciphertext, "base64")) === "profile-restart-fixture", encryptedFixture)).toBe(true);
    const restored = await window.evaluate(() => globalThis.window.specloom.state());
    expect(restored.providers).toEqual([expect.objectContaining({ id: "persistent-provider", models: ["fixture-model"] })]);
    expect(restored.recent).toEqual([expect.objectContaining({ path: projectPath, exists: true })]);
    await window.getByTitle(`打开 ${projectPath}`, { exact: true }).click();
    await window.getByRole("button", { name: "Skills", exact: true }).click();
    await expect(window.locator(".capability-entry")).toHaveCount(8);
    expect(await window.evaluate(async () => {
      const api = globalThis.window.specloom;
      return (await api.sessions!.list((await api.state()).project!.path)).some(session => !!session.capabilities);
    })).toBe(false);
    await window.getByRole("button", { name: "MCP", exact: true }).click();
    await window.getByRole("tab", { name: "外部 MCP", exact: true }).click();
    await expect(window.getByLabel("服务名称", { exact: true })).toHaveCount(0);
    await window.getByRole("button", { name: "添加 MCP", exact: true }).click();
    await expect(window.getByLabel("服务名称", { exact: true })).toBeVisible();
    await window.getByRole("button", { name: "取消", exact: true }).click();
    await expect(window.getByLabel("服务名称", { exact: true })).toHaveCount(0);
    await window.getByRole("button", { name: "添加 MCP", exact: true }).click();
    await window.getByLabel("服务名称", { exact: true }).fill("fixture-mcp");
    await window.getByLabel("启动命令", { exact: true }).fill("node");
    await window.getByRole("button", { name: "保存 MCP 服务", exact: true }).click();
    await expect(window.getByLabel("服务名称", { exact: true })).toHaveCount(0);
    await expect(window.getByText("fixture-mcp", { exact: true })).toBeVisible();
    const sentinel = path.join(projectPath, "recent-removal-sentinel.txt");
    await writeFile(sentinel, "preserve project files", "utf8");
    await app.close();
    app = await launchSourceElectron(userData);
    window = await app.firstWindow();
    await window.getByRole("button", { name: "从列表移除 灯塔守望", exact: true }).click();
    await expect(window.getByTitle(`打开 ${projectPath}`, { exact: true })).toHaveCount(0);
    expect(await readFile(sentinel, "utf8")).toBe("preserve project files");
    const reopened = await window.evaluate(project => globalThis.window.specloom.openProject(project), projectPath);
    expect(reopened.recent).toEqual([expect.objectContaining({ path: projectPath, exists: true })]);
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});
