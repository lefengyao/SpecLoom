import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceTools } from "../../src/main/core/tools/workspace-tools";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });

describe("Downstream MCP passthrough", () => {
  it("discovers a configured server and executes its tools through ToolSearch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "specloom-passthrough-"));
    cleanup.push(() => rm(root, { force: true, recursive: true }));
    await writeFile(path.join(root, "project.godot"), "config_version=5\n");
    await mkdir(path.join(root, ".specloom"));
    const fixture = fileURLToPath(new URL("../fixtures/mcp-selftest-server.mjs", import.meta.url));
    await writeFile(path.join(root, ".specloom", "mcp.json"), JSON.stringify({
      mcpServers: { selftest: { command: process.execPath, args: [fixture] } },
    }));

    const tools = new WorkspaceTools(root, "passthrough");
    tools.setPermissions("full");
    cleanup.push(() => tools.close());
    const capabilities = await tools.capabilities();
    expect(capabilities.mcp).toContainEqual(expect.objectContaining({ name: "selftest", status: "connected" }));

    const search = await tools.execute("ToolSearch", { query: "MCP" }) as { tools: { name: string }[] };
    const forwarded = search.tools.find((tool) => tool.name.startsWith("mcp_selftest_echo_"));
    expect(forwarded).toBeDefined();

    const result = await tools.execute(forwarded!.name, { text: "hi" }) as { content: { type: string; text: string }[] };
    expect(result.content[0]).toEqual({ type: "text", text: "echo:hi" });
  }, 30_000);
});
