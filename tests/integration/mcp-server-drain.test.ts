import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test, vi } from "vitest";
import { ProjectCore } from "../../src/main/core/project-core";
import { startMcpServer } from "../../src/main/mcp-server";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(fulfill => { resolve = fulfill; }); return { promise, resolve }; }
test("closing MCP stops admission and waits for admitted tools that ignore cancellation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-mcp-drain-"));
  const core = await ProjectCore.open(root);
  const entered = deferred(), release = deferred();
  const execute = vi.spyOn(core, "executeTool").mockImplementation(async () => {
    entered.resolve(); await release.promise;
    await writeFile(path.join(root, "finished.txt"), "old controller completed");
    return [];
  });
  const server = await startMcpServer(() => core);
  const client = new Client({ name: "drain", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${server.token}` } } });
  let closing: Promise<void> | undefined;
  try {
    await client.connect(transport as Parameters<Client["connect"]>[0]);
    const call = client.callTool({ name: "files.list_versions", arguments: { taskId: "fixture", paths: [] } }).catch(() => undefined);
    await entered.promise;
    let closed = false;
    closing = server.close().then(() => { closed = true; });
    await new Promise<void>(resolve => setTimeout(resolve, 30));
    expect(closed).toBe(false);
    const late = await fetch(server.url, { method: "POST", headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "files.list_versions", arguments: { taskId: "fixture", paths: [] } } }) }).catch(() => undefined);
    expect(late?.status ?? 0).not.toBe(200);
    expect(execute).toHaveBeenCalledOnce();
    release.resolve();
    await closing;
    await client.close();
    await call;
    expect(await readFile(path.join(root, "finished.txt"), "utf8")).toBe("old controller completed");
    await server.close();
  } finally {
    release.resolve();
    await closing?.catch(() => undefined);
    await client.close();
    await server.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
