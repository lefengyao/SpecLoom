import { PassThrough } from "node:stream";
import { expect, test } from "vitest";
import { PluginRpc, PluginRpcError } from "../../src/main/plugins/plugin-rpc";

test("round-trips requests and responses", async () => {
  const hostIn = new PassThrough(); const hostOut = new PassThrough();
  const childIn = new PassThrough(); const childOut = new PassThrough();
  hostOut.pipe(childIn); childOut.pipe(hostIn);
  const host = new PluginRpc(hostIn, hostOut, async (method) => method === "storage.get" ? { value: "x" } : ({ ok: true }));
  const child = new PluginRpc(childIn, childOut, async (method, params) => {
    if (method === "echo") return params;
    throw new Error("unknown");
  });
  await expect(host.request("echo", { value: 1 }, 1000)).resolves.toEqual({ value: 1 });
  await expect(child.request("storage.get", { key: "k" }, 1000)).resolves.toEqual({ value: "x" });
  host.close(); child.close();
});

test("maps child errors and request timeouts", async () => {
  const hostIn = new PassThrough(); const hostOut = new PassThrough();
  const childIn = new PassThrough(); const childOut = new PassThrough();
  hostOut.pipe(childIn); childOut.pipe(hostIn);
  const host = new PluginRpc(hostIn, hostOut, async () => undefined);
  const child = new PluginRpc(childIn, childOut, async (method) => {
    if (method === "fail") throw new PluginRpcError("COMMAND_FAILED", "boom");
    return undefined;
  });
  await expect(host.request("fail", undefined, 1000)).rejects.toMatchObject({ code: "COMMAND_FAILED", message: "boom" });
  const silent = new PluginRpc(new PassThrough(), new PassThrough(), async () => undefined);
  await expect(silent.request("never", undefined, 10)).rejects.toMatchObject({ code: "TIMEOUT" });
  host.close(); child.close(); silent.close();
});
