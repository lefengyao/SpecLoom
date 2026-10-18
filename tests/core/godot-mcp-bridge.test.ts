import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { GodotMcpBridge } from "../../src/main/core/godot-mcp/bridge";

let root: string;
let bridge: GodotMcpBridge | undefined;
let editor: WebSocket | undefined;

async function waitForMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for WebSocket message")), 1000);
    socket.once("message", data => { clearTimeout(timeout); resolve(JSON.parse(data.toString())); });
  });
}

async function connectEditor(overrides: Record<string, unknown> = {}) {
  editor = new WebSocket(`ws://127.0.0.1:${bridge!.getPort()}`);
  const helloPromise = waitForMessage(editor);
  await new Promise<void>((resolve, reject) => {
    editor!.once("open", resolve);
    editor!.once("error", reject);
  });
  const hello = await helloPromise;
  editor.send(JSON.stringify({ jsonrpc: "2.0", method: "client_hello", params: {
    projectPath: root, serviceId: "specloom", ...overrides,
  } }));
  return hello;
}

afterEach(async () => {
  editor?.close(); editor = undefined;
  await bridge?.close(); bridge = undefined;
  if (root) await rm(root, { recursive: true, force: true });
});

describe("GodotMcpBridge", () => {
  it("requires a matching service handshake and forwards only allowlisted JSON-RPC routes", async () => {
    root = await mkdtemp(path.join(tmpdir(), "specloom-godot-bridge-"));
    bridge = new GodotMcpBridge(root, { basePort: 0 });
    await bridge.start();

    const hello = await connectEditor();
    expect(hello).toMatchObject({ method: "server_hello", params: { projectPath: root, serviceId: "specloom" } });
    await expect(bridge.waitUntilConnected(500)).resolves.toBe(true);

    const response = bridge.call("mcp/diagnostics", {});
    const request = await waitForMessage(editor!);
    expect(request).toMatchObject({ jsonrpc: "2.0", method: "mcp/diagnostics", params: {} });
    editor!.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { success: true } }));
    await expect(response).resolves.toEqual({ success: true });
    expect(() => bridge!.call("project/delete", {})).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it("rejects an acknowledgement for another project or service", async () => {
    root = await mkdtemp(path.join(tmpdir(), "specloom-godot-bridge-"));
    bridge = new GodotMcpBridge(root, { basePort: 0 });
    await bridge.start();
    editor = new WebSocket(`ws://127.0.0.1:${bridge.getPort()}`);
    const hello = waitForMessage(editor);
    await new Promise<void>((resolve, reject) => { editor!.once("open", resolve); editor!.once("error", reject); });
    await hello;
    editor.send(JSON.stringify({ jsonrpc: "2.0", method: "client_hello", params: { projectPath: `${root}-other`, serviceId: "other" } }));
    await new Promise<void>(resolve => editor!.once("close", () => resolve()));
    expect(bridge.isConnected()).toBe(false);
  });

  it("times out requests and removes aborted pending requests", async () => {
    root = await mkdtemp(path.join(tmpdir(), "specloom-godot-bridge-"));
    bridge = new GodotMcpBridge(root, { basePort: 0, requestTimeoutMs: 30 });
    await bridge.start();
    await connectEditor();
    await expect(bridge.waitUntilConnected(500)).resolves.toBe(true);
    const unanswered = bridge.call("mcp/diagnostics", {});
    await waitForMessage(editor!);
    await expect(unanswered).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
    expect(bridge.pendingCount()).toBe(0);

    const controller = new AbortController();
    const aborted = bridge.call("mcp/diagnostics", {}, controller.signal);
    await waitForMessage(editor!);
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    expect(bridge.pendingCount()).toBe(0);
  });

  it("closes oversized frames without leaving the editor connected", async () => {
    root = await mkdtemp(path.join(tmpdir(), "specloom-godot-bridge-"));
    bridge = new GodotMcpBridge(root, { basePort: 0, maxMessageBytes: 1024 });
    await bridge.start();
    await connectEditor();
    editor!.send("x".repeat(2048));
    await new Promise<void>(resolve => editor!.once("close", () => resolve()));
    expect(bridge.isConnected()).toBe(false);
  });
});
