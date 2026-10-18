import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectCore } from "../../src/main/core/project-core";
import { startMcpServer } from "../../src/main/mcp-server";
import type { ChangeReview } from "../../src/shared/desktop-api";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-mcp-"));
  cleanup.push(() => rm(root, { force: true, recursive: true }));
  await writeFile(path.join(root, "project.godot"), 'config_version=5\n[application]\nconfig/name="MCP fixture"\n');
  const core = await ProjectCore.open(root);
  cleanup.push(() => core.close());
  await core.createTask({ id: "approved", title: "MCP task", readPaths: ["*"], writePaths: ["specs/**"], mode: "manual", allowDelete: false });
  const server = await startMcpServer(() => core);
  cleanup.push(() => server.close());
  return { root, core, server };
}
async function clientFor(server: { url: string; token: string }) {
  const client = new Client({ name: "acceptance", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${server.token}` } } });
  await client.connect(transport as Parameters<Client["connect"]>[0]);
  cleanup.push(() => client.close());
  return client;
}
function output(result: Awaited<ReturnType<Client["callTool"]>>) {
  const contents = result.content as { type: string; text: string }[];
  return JSON.parse(contents[0]!.text) as Record<string, unknown>;
}

describe("Authenticated loopback MCP", () => {
  it("rejects missing auth, foreign origins, host spoofing and large requests", async () => {
    const { server } = await fixture();
    expect((await fetch(server.url, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await fetch(server.url, { method: "POST", headers: { Authorization: `Bearer ${server.token}`, Origin: "https://example.com" }, body: "{}" })).status).toBe(403);
    const spoofedStatus = await new Promise<number | undefined>((resolve, reject) => {
      const operation = request(server.url, { method: "POST", headers: { Authorization: `Bearer ${server.token}`, Host: "evil.example" } }, (response) => { response.resume(); resolve(response.statusCode); });
      operation.on("error", reject); operation.end("{}");
    });
    expect(spoofedStatus).toBe(403);
    expect((await fetch(server.url, { method: "POST", headers: { Authorization: `Bearer ${server.token}` }, body: "x".repeat(1_048_577) })).status).toBe(413);
  });
  it("shares task scopes, staged changes and UI approval with the same core", async () => {
    const { server, core, root } = await fixture();
    const client = await clientFor(server);
    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === "files.list_versions")).toBe(true);
    const versions = output(await client.callTool({ name: "files.list_versions", arguments: { taskId: "approved", paths: ["specs/new.md"] } })) as unknown as { path: string; version: string }[];
    expect(versions[0]!.version).toBe("absent");
    const denied = await client.callTool({ name: "files.write", arguments: { taskId: "unknown", path: "specs/new.md", expectedVersion: "absent", content: "hello" } });
    expect(denied.isError).toBe(true);
    await client.callTool({ name: "files.write", arguments: { taskId: "approved", path: "specs/new.md", expectedVersion: "absent", content: "hello" } });
    const review = output(await client.callTool({ name: "changes.preview", arguments: { taskId: "approved" } })) as unknown as ChangeReview;
    expect(review.changeSet.digest).toBe((await core.previewChanges("approved")).changeSet.digest);
    const commit = await client.callTool({ name: "changes.commit", arguments: { taskId: "approved", digest: review.changeSet.digest } });
    expect(output(commit)).toMatchObject({ code: "APPROVAL_REQUIRED" });
    await core.approveChanges("approved", review.changeSet.digest);
    expect(await readFile(path.join(root, "specs/new.md"), "utf8")).toBe("hello");
  });
  it("publishes the eight Godot tools and returns screenshots as MCP image blocks", async () => {
    const { server, core } = await fixture();
    const client = await clientFor(server);
    const listed = await client.listTools();
    const expected = ["get_diagnostics", "get_output_log", "get_editor_screenshot", "get_game_screenshot", "get_project_info", "get_scene_tree", "get_game_scene_tree", "get_game_node_properties"];
    expect(listed.tools.map(tool => tool.name).filter(name => expected.includes(name)).sort()).toEqual(expected.sort());
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jzGQAAAAASUVORK5CYII=";
    vi.spyOn(core, "executeTool").mockImplementation(async (_taskId, name) => name.includes("screenshot")
      ? { mimeType: "image/png", base64: png, width: 1, height: 1 }
      : { name, ok: true });
    const textResult = await client.callTool({ name: "get_project_info", arguments: { taskId: "approved" } });
    expect(textResult.content).toContainEqual({ type: "text", text: JSON.stringify({ name: "get_project_info", ok: true }) });
    for (const name of ["get_editor_screenshot", "get_game_screenshot"]) {
      const result = await client.callTool({ name, arguments: { taskId: "approved" } });
      const content = result.content as { type: string; mimeType?: string; data?: string; text?: string }[];
      expect(content).toContainEqual({ type: "image", mimeType: "image/png", data: png });
      const metadata = content.find(item => item.type === "text");
      expect(metadata).toMatchObject({ text: JSON.stringify({ mimeType: "image/png", width: 1, height: 1 }) });
      expect(JSON.stringify(metadata)).not.toContain(png);
    }
  });
  it("cannot approve or broaden scope and rejects stale external edits at UI commit", async () => {
    const { server, core, root } = await fixture();
    const client = await clientFor(server);
    const bad = await client.callTool({ name: "files.write", arguments: { taskId: "approved", path: "scripts/unauthorized.gd", expectedVersion: "absent", content: "extends Node" } });
    expect(output(bad)).toMatchObject({ code: "TASK_SCOPE_DENIED" });
    await client.callTool({ name: "files.write", arguments: { taskId: "approved", path: "specs/new.md", expectedVersion: "absent", content: "agent" } });
    const review = await core.previewChanges("approved");
    await writeFile(path.join(root, "specs/new.md"), "developer");
    await expect(core.approveChanges("approved", review.changeSet.digest)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(await readFile(path.join(root, "specs/new.md"), "utf8")).toBe("developer");
  });
});
