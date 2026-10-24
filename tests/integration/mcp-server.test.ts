import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectCore } from "../../src/main/core/project-core";
import { OfflineDocumentStore } from "../../src/main/core/offline-documents";
import { WorkspaceTools } from "../../src/main/core/tools/workspace-tools";
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
  it("writes MCP file changes directly while keeping task scopes enforced", async () => {
    const { server, core, root } = await fixture();
    const client = await clientFor(server);
    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === "files.list_versions")).toBe(true);
    const versions = output(await client.callTool({ name: "files.list_versions", arguments: { taskId: "approved", paths: ["specs/new.md"] } })) as unknown as { path: string; version: string }[];
    expect(versions[0]!.version).toBe("absent");
    const denied = await client.callTool({ name: "files.write", arguments: { taskId: "unknown", path: "specs/new.md", expectedVersion: "absent", content: "hello" } });
    expect(denied.isError).toBe(true);
    await client.callTool({ name: "files.write", arguments: { taskId: "approved", path: "specs/new.md", expectedVersion: "absent", content: "hello" } });
    expect(await readFile(path.join(root, "specs/new.md"), "utf8")).toBe("hello");
    const review = output(await client.callTool({ name: "changes.preview", arguments: { taskId: "approved" } })) as unknown as ChangeReview;
    expect(review.changeSet.entries).toEqual([]);
    expect(review.changeSet.digest).toBe((await core.previewChanges("approved")).changeSet.digest);
    const commit = await client.callTool({ name: "changes.commit", arguments: { taskId: "approved", digest: review.changeSet.digest } });
    expect(output(commit)).toMatchObject({ status: "applied" });
  });
  it("loads a project skill without an explicit version", async () => {
    const { server, root } = await fixture();
    await mkdir(path.join(root, ".specloom", "skills", "guide"), { recursive: true });
    await writeFile(path.join(root, ".specloom", "skills", "guide", "SKILL.md"), "---\nid: guide\nname: Guide\npurpose: Test skill\nallowedSources:\n  - specs/**\n---\n\n# Guide\n\nDo the thing.\n");
    const client = await clientFor(server);
    const listed = output(await client.callTool({ name: "skills.list", arguments: { taskId: "approved" } })) as unknown as { id: string; version: string }[];
    expect(listed).toContainEqual(expect.objectContaining({ id: "guide" }));
    const loaded = output(await client.callTool({ name: "skills.load", arguments: { taskId: "approved", id: "guide" } }));
    expect(loaded).toMatchObject({ id: "guide", name: "Guide" });
    expect(String(loaded.instructions)).toContain("Do the thing.");
  });

  it("exposes built-in offline document tools to external clients", async () => {
    const { core } = await fixture();
    const userData = await mkdtemp(path.join(os.tmpdir(), "specloom-mcp-offline-"));
    cleanup.push(() => rm(userData, { force: true, recursive: true }));
    const store = new OfflineDocumentStore(userData);
    const source = path.join(userData, "guide.txt");
    const second = path.join(userData, "guide-2.txt");
    await writeFile(source, "offline content");
    await writeFile(second, "second page");
    const bundle = await store.importFiles([source, second], "Guide", "1", true);
    const server = await startMcpServer(() => core, { offlineDocuments: store });
    cleanup.push(() => server.close());
    const client = await clientFor(server);
    const listed = await client.callTool({ name: "OfflineDocsList", arguments: {} });
    expect(output(listed)).toContainEqual(expect.objectContaining({ id: bundle.id, name: "Guide" }));
    const page = output(await client.callTool({ name: "OfflineDocsList", arguments: { bundleId: bundle.id, limit: 1 } })) as unknown as { versions: { files: unknown[]; fileCount: number; nextOffset?: number }[] }[];
    expect(page[0]!.versions[0]!.files).toHaveLength(1);
    expect(page[0]!.versions[0]!.fileCount).toBe(2);
    expect(page[0]!.versions[0]!.nextOffset).toBe(1);
    const file = bundle.versions[0]!.files.find((candidate) => candidate.path.endsWith("guide.txt"))!;
    const read = output(await client.callTool({ name: "OfflineDocsRead", arguments: { bundleId: bundle.id, path: file.path } })) as { content?: string };
    expect(read.content).toContain("offline content");
  });

  it("shares the in-app workspace tool catalog and external MCP tools with clients", async () => {
    const { core } = await fixture();
    const execute = vi.fn(async () => ({ ok: true }));
    const external = {
      capabilities: vi.fn(async () => ({ tools: [], skills: [], mcp: [], plugins: [] })),
      catalog: { all: () => [
        { name: "mcp_docs_search_abcd1234", description: "Search connected docs", schema: {}, parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } },
        { name: "Glob", description: "Find files", schema: z.object({ pattern: z.string().min(1) }).strict() },
      ] },
      execute,
      close: vi.fn(async () => undefined),
    } as unknown as WorkspaceTools;
    const server = await startMcpServer(() => core, { externalTools: () => external });
    cleanup.push(() => server.close());
    const instructions = await core.mcpInstructions();
    expect(instructions).toContain("SpecLoom");
    expect(instructions).toContain("files.list_versions");
    expect(instructions).toContain("MaterialsList");
    expect(instructions).toContain("borrowed access");
    expect(instructions).not.toContain("Monitor poll");

    const client = await clientFor(server);
    expect(client.getInstructions()).toBeTruthy();
    const listed = await client.listTools();
    const proxied = listed.tools.find((tool) => tool.name === "mcp_docs_search_abcd1234");
    expect(proxied?.inputSchema).toMatchObject({ type: "object", properties: { query: { type: "string" } }, required: ["query"] });
    const glob = listed.tools.find((tool) => tool.name === "Glob");
    expect(glob?.inputSchema).toMatchObject({ type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] });
    const result = await client.callTool({ name: "mcp_docs_search_abcd1234", arguments: { query: "x" } });
    expect(output(result)).toMatchObject({ ok: true });
    expect(execute).toHaveBeenCalledWith("mcp_docs_search_abcd1234", { query: "x" }, expect.anything());
    const globResult = await client.callTool({ name: "Glob", arguments: { pattern: "**/*.md", taskId: "approved" } });
    expect(output(globResult)).toMatchObject({ ok: true });
    expect(execute).toHaveBeenCalledWith("Glob", { pattern: "**/*.md" }, expect.anything());
  });

  it("exposes the same workspace tool catalog the in-app agent uses", async () => {
    const { core, root } = await fixture();
    const tools = new WorkspaceTools(root, "mcp-parity");
    tools.setPermissions("full");
    cleanup.push(() => tools.close());
    const server = await startMcpServer(() => core, { externalTools: () => tools });
    cleanup.push(() => server.close());
    const client = await clientFor(server);
    const listed = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "Monitor", "Skill", "ToolSearch", "MaterialsList", "MaterialCreate", "TaskCreate", "TaskUpdate", "TaskList", "memory", "code_execution", "screenshot"]) {
      expect(listed).toContain(name);
    }
    const created = output(await client.callTool({ name: "TaskCreate", arguments: { title: "parity check" } }));
    expect(created).toMatchObject({ title: "parity check", status: "pending" });
    const tasks = output(await client.callTool({ name: "TaskList", arguments: {} }));
    expect(tasks).toContainEqual(expect.objectContaining({ title: "parity check" }));
  });

  it("rediscovers downstream servers after the MCP config changes", async () => {
    const { core } = await fixture();
    let revision = 0;
    let catalog: { name: string; description: string; schema: z.ZodType }[] = [];
    const refresh = vi.fn(async () => {
      catalog = [{ name: "mcp_late_echo_abcd1234", description: "Late server", schema: z.object({ text: z.string() }) }];
      return { tools: [], skills: [], mcp: [], plugins: [] };
    });
    const external = {
      capabilities: vi.fn(async () => ({ tools: [], skills: [], mcp: [], plugins: [] })),
      catalog: { all: () => catalog },
      execute: vi.fn(async () => ({ ok: true })),
      refresh,
      close: vi.fn(async () => undefined),
    } as unknown as WorkspaceTools;
    const server = await startMcpServer(() => core, { externalTools: () => external, configRevision: () => revision });
    cleanup.push(() => server.close());
    const client = await clientFor(server);
    expect((await client.listTools()).tools.some((tool) => tool.name === "mcp_late_echo_abcd1234")).toBe(false);
    revision = 1;
    expect((await client.listTools()).tools.some((tool) => tool.name === "mcp_late_echo_abcd1234")).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
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
  it("enforces task scopes and never rewrites external edits", async () => {
    const { server, core, root } = await fixture();
    const client = await clientFor(server);
    const bad = await client.callTool({ name: "files.write", arguments: { taskId: "approved", path: "scripts/unauthorized.gd", expectedVersion: "absent", content: "extends Node" } });
    expect(output(bad)).toMatchObject({ code: "TASK_SCOPE_DENIED" });
    await client.callTool({ name: "files.write", arguments: { taskId: "approved", path: "specs/new.md", expectedVersion: "absent", content: "agent" } });
    expect(await readFile(path.join(root, "specs/new.md"), "utf8")).toBe("agent");
    const review = await core.previewChanges("approved");
    expect(review.changeSet.entries).toEqual([]);
    await writeFile(path.join(root, "specs/new.md"), "developer");
    await expect(core.approveChanges("approved", review.changeSet.digest)).resolves.toMatchObject({ status: "applied" });
    expect(await readFile(path.join(root, "specs/new.md"), "utf8")).toBe("developer");
  });
});
