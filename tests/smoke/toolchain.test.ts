import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { electronBuildOptions } from "../../scripts/electron-build.mjs";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("Electron toolchain", () => {
  it("builds a CommonJS entrypoint and a self-contained sandbox preload", async () => {
    const result = await build({
      ...electronBuildOptions,
      sourcemap: false,
      write: false,
    });
    const outputs = result.outputFiles ?? [];
    const preload = outputs.find((file) => path.basename(file.path) === "preload.cjs");
    expect(outputs.map((file) => path.basename(file.path)).sort()).toEqual(["main.cjs", "preload.cjs"]);

    const exposed = new Map<string, unknown>();
    vm.runInNewContext(preload?.text ?? "", {
      require(id: string) {
        expect(id).toBe("electron");
        return { contextBridge: { exposeInMainWorld: (key: string, value: unknown) => exposed.set(key, value) } };
      },
    });
    expect(exposed.has("specloom")).toBe(true);
    expect(Object.isFrozen(exposed.get("specloom"))).toBe(true);

    const metadata = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8")) as { main: string };
    expect(outputs.some((file) => file.path === path.join(projectRoot, metadata.main))).toBe(true);
  });

  it("keeps packaged output separate from Vite and Electron compiled output", async () => {
    const config = parse(await readFile(path.join(projectRoot, "electron-builder.yml"), "utf8")) as {
      directories: { output: string };
      files: string[];
    };
    expect(config.directories.output).toBe("release");
    expect(config.files).toEqual(expect.arrayContaining(["dist/main/**", "dist/renderer/**"]));
  });
});
