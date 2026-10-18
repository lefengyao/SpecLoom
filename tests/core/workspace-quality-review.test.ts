import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { CapabilitiesSchema } from "../../src/shared/chat";
import { DesktopSessions } from "../../src/main/desktop-sessions";
import { FileStore } from "../../src/main/core/file-store";
import type { ProjectCore } from "../../src/main/core/project-core";
import { SessionStore } from "../../src/main/core/session-store";
import { WorkspaceCatalog } from "../../src/main/core/tools/catalog";
import { WorkspaceMcp } from "../../src/main/core/tools/mcp-client";
import { WorkspaceTools } from "../../src/main/core/tools/workspace-tools";

const roots: string[] = [];
const mcpClients: WorkspaceMcp[] = [];
const desktopSessions: DesktopSessions[] = [];
async function fixture(mode: "partial-failure" | "cursor-cycle" | "long-name" | "oversized-inventory" | "delayed-page") {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-quality-review-"));
  roots.push(root);
  const sdk = (file: string) => pathToFileURL(path.resolve(`node_modules/@modelcontextprotocol/sdk/dist/esm/${file}`)).href;
  await writeFile(path.join(root, "server.mjs"), `
import { Server } from ${JSON.stringify(sdk("server/index.js"))};
import { StdioServerTransport } from ${JSON.stringify(sdk("server/stdio.js"))};
import { ListToolsRequestSchema } from ${JSON.stringify(sdk("types.js"))};
import { writeFile } from "node:fs/promises";
const server = new Server({ name: "quality fixture", version: "1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async ({ params }) => {
  if (${JSON.stringify(mode)} === "cursor-cycle") return { tools: [], nextCursor: "repeat" };
  if (${JSON.stringify(mode)} === "long-name") return { tools: [{ name: "read_project_documentation_with_citations_and_references", inputSchema: { type: "object" } }] };
  if (${JSON.stringify(mode)} === "oversized-inventory") return { tools: Array.from({ length: 512 }, (_, i) => ({ name: "fixture_" + i, inputSchema: { type: "object" } })) };
  if (${JSON.stringify(mode)} === "delayed-page") {
    await writeFile(${JSON.stringify(path.join(root, "list-started"))}, "ready");
    await new Promise(resolve => setTimeout(resolve, 500));
    return { tools: [{ name: "delayed", inputSchema: { type: "object" } }] };
  }
  if (params?.cursor) throw new Error("deliberate second-page failure");
  return { tools: [{ name: "first_page", description: "fixture", inputSchema: { type: "object" } }], nextCursor: "second" };
});
await server.connect(new StdioServerTransport());
`);
  await writeFile(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [path.join(root, "server.mjs")] } } }));
  const mcp = new WorkspaceMcp(new FileStore(root));
  mcpClients.push(mcp);
  return { root, mcp, catalog: new WorkspaceCatalog() };
}
afterEach(async () => {
  await Promise.all(mcpClients.splice(0).map((client) => client.close()));
  for (const sessions of desktopSessions.splice(0)) sessions.cancelAll();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workspace quality regressions", () => {
  it("rolls back all tool registration when a later MCP discovery page fails", async () => {
    const { mcp, catalog } = await fixture("partial-failure");
    expect(await mcp.discover(catalog)).toMatchObject([{ name: "fixture", status: "error", tools: [] }]);
    expect(catalog.all().filter((tool) => tool.name.startsWith("mcp_"))).toEqual([]);
  });

  it("terminates MCP discovery on a repeated pagination cursor", async () => {
    const { mcp, catalog } = await fixture("cursor-cycle");
    const controller = new AbortController();
    const discovery = mcp.discover(catalog, controller.signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timed = new Promise<"timed-out">((resolve) => { timer = setTimeout(() => resolve("timed-out"), 3_000); });
      const result = await Promise.race([discovery, timed]);
      expect(result).not.toBe("timed-out");
      expect(result).toMatchObject([{ name: "fixture", status: "error", tools: [] }]);
    } finally { if (timer) clearTimeout(timer); controller.abort(); await discovery.catch(() => undefined); }
  });

  it("bounds generated MCP identifiers to the provider function-name limit", async () => {
    const { mcp, catalog } = await fixture("long-name");
    const discovered = await mcp.discover(catalog);
    expect(discovered).toMatchObject([{ name: "fixture", status: "connected" }]);
    const [tool] = discovered[0]!.tools;
    expect(tool!.length).toBeLessThanOrEqual(64);
    expect(catalog.search(tool!)[0]?.name).toBe(tool);
  });

  it("keeps a large MCP inventory inside the persisted capability schema", async () => {
    const { root } = await fixture("oversized-inventory");
    const tools = new WorkspaceTools(root, "large inventory");
    try { expect(CapabilitiesSchema.safeParse(await tools.capabilities()).success).toBe(true); }
    finally { await tools.close(); }
  });

  it("does not publish MCP connections after close races with discovery", async () => {
    const { root, mcp, catalog } = await fixture("delayed-page");
    const discovery = mcp.discover(catalog);
    // Shutdown intentionally rejects discovery; observe it before awaiting close.
    void discovery.catch(() => undefined);
    try {
      let ready = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        if (await readFile(path.join(root, "list-started"), "utf8").catch(() => "")) { ready = true; break; }
        await delay(10);
      }
      expect(ready).toBe(true);
      await mcp.close();
      await discovery.catch(() => undefined);
      expect(catalog.all().filter((tool) => tool.name.startsWith("mcp_"))).toEqual([]);
    } finally { await discovery.catch(() => undefined); await mcp.close(); }
  });

  it("bounds loaded provider definitions while preserving initial tools", () => {
    const catalog = new WorkspaceCatalog();
    for (let i = 0; i < 150; i++) catalog.add({ name: `fixture_${i}`, description: "fixture", schema: z.object({}).strict() });
    for (let i = 0; i < 150; i++) catalog.search(`fixture_${i}`);
    const names = catalog.providerTools().map((tool) => tool.function.name);
    expect(names).toContain("Read");
    // Desktop runtime adds AskUserQuestion and ask_user outside the catalog.
    expect(names.length + 2).toBeLessThanOrEqual(128);
  });

  it("shares one toolbox when an unloaded session is acquired concurrently", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "specloom-quality-review-"));
    roots.push(root);
    const store = await SessionStore.open(root);
    const session = await store.create("concurrent acquisition");
    const core = { metadata: { path: root }, listTasks: () => [] } as unknown as ProjectCore;
    const sessions = new DesktopSessions(root, () => core, async () => { throw new Error("unused profile"); }, async () => "", async () => undefined);
    desktopSessions.push(sessions);
    // Concurrent public capability initialization paths meet in this shared method.
    const accessor = sessions as unknown as { toolbox(projectPath: string, sessionId: string): Promise<WorkspaceTools> };
    const [first, second] = await Promise.all([accessor.toolbox(root, session.id), accessor.toolbox(root, session.id)]);
    try { expect(first).toBe(second); }
    finally { await Promise.all([first.close(), second.close()]); }
  });
});
