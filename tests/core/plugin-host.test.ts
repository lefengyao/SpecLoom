import path from "node:path";
import { expect, test } from "vitest";
import { PluginHost } from "../../src/main/plugins/plugin-host";

const root = path.resolve("tests/fixtures/plugin-child");
const childPath = path.resolve("resources/plugin-host-child.mjs");
const logDir = path.resolve("tests/.tmp/plugin-logs");

test("starts, invokes commands, and stops a plugin child", async () => {
  const host = new PluginHost({
    pluginId: "fixture-child", version: "1.0.0", root, entry: "main/index.mjs",
    childPath, logDir, requestTimeoutMs: 5000,
    onRequest: async (method, params) => {
      if (method === "storage.get") return null;
      if (method === "storage.set") return true;
      if (method === "storage.delete") return true;
      throw new Error("unknown host method: " + method + " " + JSON.stringify(params));
    },
  });
  try {
    const commands = await host.start();
    expect(commands).toContain("echo");
    await expect(host.request("invoke", { command: "echo", input: { value: 1 }, projectPath: "E:\\p" }, 5000)).resolves.toMatchObject({ echo: { value: 1 } });
    await expect(host.request("invoke", { command: "fail" }, 5000)).rejects.toThrow("fixture failure");
  } finally { await host.stop(); }
});
