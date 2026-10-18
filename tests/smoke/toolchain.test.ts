import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createDevelopmentRuntime, developmentEnvironment, developmentArguments, installedProfileDirectory } from "../../scripts/dev-runtime.mjs";
import { ChatAttachmentService } from "../../src/main/core/chat-attachments";
import { docxFixture } from "../helpers/chat-attachment-fixtures";
import { randomUUID } from "node:crypto";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("Electron toolchain", () => {
  it("reads the host Windows profile when a desktop package redirects Roaming into its own cache", () => {
    const directory = "C:\\Users\\user\\AppData\\Roaming\\specloom";
    const hostDirectory = "\\\\localhost\\C$\\Users\\user\\AppData\\Roaming\\specloom";
    expect(installedProfileDirectory(directory, "win32", candidate => candidate === hostDirectory)).toBe(hostDirectory);
    expect(installedProfileDirectory(directory, "win32", () => false)).toBe(directory);
    expect(installedProfileDirectory(hostDirectory, "win32", () => true)).toBe(hostDirectory);
    expect(installedProfileDirectory("/home/user/.config/specloom", "linux", () => true)).toBe("/home/user/.config/specloom");
  });
  it("shares the installed app's profile across temporary source entrypoints and preserves explicit isolation", () => {
    const base = { APPDATA: path.join(os.tmpdir(), "profile-test"), XDG_CONFIG_HOME: path.join(os.tmpdir(), "profile-test") };
    const first = developmentEnvironment({ entryPath: path.join(os.tmpdir(), "source-a/main.cjs"), rendererUrl: "http://localhost:1234" }, base);
    const next = developmentEnvironment({ entryPath: path.join(os.tmpdir(), "source-b/main.cjs"), rendererUrl: "http://localhost:5678" }, base);
    const profileRoot = process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support") : base.APPDATA;
    expect(first.SPECLOOM_USER_DATA_DIR).toBe(path.join(profileRoot, "specloom"));
    expect(next.SPECLOOM_USER_DATA_DIR).toBe(first.SPECLOOM_USER_DATA_DIR);
    expect(developmentArguments({ entryPath: "temporary/main.cjs" }, first)).toEqual(["temporary/main.cjs", `--user-data-dir=${first.SPECLOOM_USER_DATA_DIR}`]);
    const isolated = path.join(os.tmpdir(), "isolated-spec-profile");
    expect(developmentEnvironment({ entryPath: "test/main.cjs", rendererUrl: "http://localhost:1234" }, { ...base, SPECLOOM_USER_DATA_DIR: isolated }).SPECLOOM_USER_DATA_DIR).toBe(isolated);
  });
  it("runs desktop E2E directly from source without invoking production builds", async () => {
    const metadata = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(metadata.scripts["test:e2e"]).toBe("node scripts/test-e2e.mjs");
    const developmentScript = await readFile(path.join(projectRoot, "scripts/dev.mjs"), "utf8");
    expect(developmentScript).toContain("./dev-runtime.mjs");
    expect(developmentScript).toContain("developmentArguments(runtime, environment)");
    expect(developmentScript).not.toContain("./electron-build.mjs");
  });

  it("serves source and transpiles an isolated sandbox preload in temporary storage, then removes it", async () => {
    const runtime = await createDevelopmentRuntime();
    try {
      expect(path.relative(os.tmpdir(), runtime.directory)).not.toMatch(/^\.\./);
      const fromProject = path.relative(projectRoot, runtime.directory);
      expect(path.isAbsolute(fromProject) || fromProject.startsWith("..")).toBe(true);
      expect(path.basename(runtime.entryPath)).toBe("main.cjs");
      await expect(access(runtime.entryPath)).resolves.toBeUndefined();
      const workerPath = path.join(path.dirname(runtime.entryPath), "chat-attachment-worker.cjs");
      await expect(access(workerPath)).resolves.toBeUndefined();
      const attachments = new ChatAttachmentService({ workerPath });
      try {
        await expect(attachments.prepare(Symbol("source-runtime"), "project/session", randomUUID(), { name: "source.docx", bytes: docxFixture("Source runtime document") })).resolves.toMatchObject({ kind: "document", text: "Source runtime document" });
      } finally { attachments.close(); }
      await expect(access(path.join(runtime.directory, "node_modules/zod/package.json"))).resolves.toBeUndefined();
      const renderer = await fetch(runtime.rendererUrl);
      expect(renderer.ok).toBe(true);
      expect(await renderer.text()).toContain("/main.tsx");
      const environment = developmentEnvironment(runtime, { ELECTRON_RUN_AS_NODE: "1" });
      expect(environment.ELECTRON_RUN_AS_NODE).toBeUndefined();
      expect(environment.SPECLOOM_DEV_APP_ROOT).toBe(path.resolve(projectRoot));
      expect(environment.NODE_PATH).toContain(path.join(projectRoot, "node_modules"));

      const preload = await readFile(path.join(path.dirname(runtime.entryPath), "preload.cjs"), "utf8");
      const exposed = new Map<string, unknown>();
      const calls: unknown[][] = [];
      let reply: unknown = { ok: true, data: { message: "发现 2 个模型" } };
      vm.runInNewContext(preload, {
        require(id: string) {
          expect(id).toBe("electron");
          return { contextBridge: { exposeInMainWorld: (key: string, value: unknown) => exposed.set(key, value) },
            ipcRenderer: { invoke: async (...args: unknown[]) => { calls.push(args); return reply; } } };
        },
      });
      expect(exposed.has("specloom")).toBe(true);
      expect(Object.isFrozen(exposed.get("specloom"))).toBe(true);
      const api = exposed.get("specloom") as { providers: { test: (id: string) => Promise<{ ok: boolean; message: string }> } };
      expect(await api.providers.test("provider")).toEqual({ ok: true, message: "连接成功，发现 2 个模型" });
      expect(calls).toEqual([["specloom:invoke", "discoverProviderModels", { id: "provider" }]]);
      reply = { ok: false, error: { code: "MODEL_ERROR", message: "Provider model discovery failed with HTTP 401." } };
      expect(await api.providers.test("provider")).toEqual({ ok: false, message: "Provider model discovery failed with HTTP 401." });
    } finally {
      await runtime.close();
    }
    await expect(access(runtime.directory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(projectRoot, "node_modules/zod/package.json"))).resolves.toBeUndefined();
    await expect(fetch(runtime.rendererUrl)).rejects.toThrow();
  });

  it("keeps packaged output separate from Vite and Electron compiled output", async () => {
    const config = parse(await readFile(path.join(projectRoot, "electron-builder.yml"), "utf8")) as {
      directories: { output: string };
      files: string[];
      extraResources?: { from: string; to: string }[];
    };
    expect(config.directories.output).toBe("release/${version}");
    expect(config.files).toEqual(expect.arrayContaining(["dist/main/**", "dist/renderer/**"]));
    expect(config.extraResources).toEqual(expect.arrayContaining([expect.objectContaining({ from: "resources/godot-mcp", to: "godot-mcp" })]));
  });
});
