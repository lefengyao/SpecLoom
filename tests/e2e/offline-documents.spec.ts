import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { IpcMainInvokeEvent } from "electron";
import { launchSourceElectron } from "./source-electron";

for (const navigateDuringImport of [false, true]) {
  test(navigateDuringImport
    ? "directory import completion refreshes the page reopened while the import was pending"
    : "directory import shows its version without switching pages", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "specloom-docs-e2e-"));
    const source = path.join(root, "source");
    await mkdir(path.join(source, "nested"), { recursive: true });
    await writeFile(path.join(source, "guide.md"), "Godot guide", "utf8");
    await writeFile(path.join(source, "nested", "reference.md"), "Godot reference", "utf8");
    const app = await launchSourceElectron(path.join(root, "user"));
    try {
      const window = await app.firstWindow();
      const errors: string[] = [];
      window.on("pageerror", (error) => errors.push(error.message));
      await window.getByRole("button", { name: "创建示例项目", exact: true }).click();
      await window.getByRole("button", { name: "离线文档", exact: true }).click();
      await expect(window.getByText("还没有导入离线文档。", { exact: true })).toBeVisible();
      // Only replace the native picker; copying, persistence and the preload bridge are real.
      await app.evaluate(({ dialog }, directory) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
      }, source);
      if (navigateDuringImport) {
        // Hold the import at the IPC boundary while leaving and reopening the retained view.
        await app.evaluate(({ ipcMain }) => {
          const bridge = ipcMain as typeof ipcMain & {
            _invokeHandlers: Map<string, (event: IpcMainInvokeEvent, operation: unknown, payload: unknown) => Promise<unknown>>;
            releaseDocumentImport?: () => void;
          };
          const original = bridge._invokeHandlers.get("specloom:invoke")!;
          ipcMain.removeHandler("specloom:invoke");
          ipcMain.handle("specloom:invoke", async (event, operation: unknown, payload: unknown) => {
            if (operation === "offlineDocumentsImportDirectory") {
              await new Promise<void>((resolve) => { bridge.releaseDocumentImport = resolve; });
            }
            return original(event, operation, payload);
          });
        });
      }
      await window.getByLabel("文档包名称", { exact: true }).fill("Godot 文档");
      await window.getByLabel("版本号", { exact: true }).fill("4.7.1");
      await window.getByRole("button", { name: "选择目录", exact: true }).click();
      if (navigateDuringImport) {
        await expect(window.getByRole("status")).toHaveText("正在导入文档，请稍候…");
        await expect.poll(() => app.evaluate(({ ipcMain }) =>
          typeof (ipcMain as typeof ipcMain & { releaseDocumentImport?: () => void }).releaseDocumentImport
        )).toBe("function");
        await window.getByRole("button", { name: "Hooks", exact: true }).click();
        await window.getByRole("button", { name: "离线文档", exact: true }).click();
        await expect(window.getByRole("status")).toHaveText("正在导入文档，请稍候…");
        await expect(window.getByRole("button", { name: "选择目录", exact: true })).toBeDisabled();
        await app.evaluate(({ ipcMain }) => {
          (ipcMain as typeof ipcMain & { releaseDocumentImport?: () => void }).releaseDocumentImport!();
        });
      }
      await expect(window.getByText("1 个版本 · 当前版本：4.7.1", { exact: true })).toBeVisible();
      await expect(window.getByText("2 个文件 · 26 B", { exact: true })).toBeVisible();
      await expect(window.getByRole("button", { name: "离线文档", exact: true })).toHaveAttribute("aria-current", "page");
      expect(await window.evaluate(async () => {
        const docs = globalThis.window.specloom.offlineDocuments!;
        const [bundle] = await docs.list();
        return (await docs.read(bundle!.id, undefined, "nested/reference.md")).content;
      })).toBe("Godot reference");
      expect(errors).toEqual([]);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
