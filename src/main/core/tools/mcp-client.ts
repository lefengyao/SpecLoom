import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { FileStore } from "../file-store";
import { ProjectError } from "../errors";
import type { SessionCapabilities } from "../../../shared/chat";
import type { WorkspaceCatalog } from "./catalog";
import { version } from "../../../../package.json";
import { McpConfigSchema } from "../../../shared/mcp-config";

interface Connection { client: Client; originalName: string }
export class WorkspaceMcp {
  private readonly clients = new Set<Client>();
  private lifetime = new AbortController();
  private generation = 0;
  private readonly tools = new Map<string, Connection>();
  constructor(private readonly files: FileStore, private readonly globalConfigPath?: string) {}
  async discover(catalog: WorkspaceCatalog, signal?: AbortSignal, approveConnection?: (name: string, server: z.infer<typeof McpConfigSchema>["mcpServers"][string]) => Promise<void>): Promise<SessionCapabilities["mcp"]> {
    const generation = this.generation;
    const activeSignal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    let config: z.infer<typeof McpConfigSchema> = { mcpServers: {} };
    for (const relative of [".specloom/mcp.json", ".mcp.json"]) {
      const file = await this.files.policy.resolve(relative, true);
      try {
        const stat = await this.files.fs.lstat(file); if (stat.size > 262144) throw new Error("MCP 配置超过 256KB");
        const local = McpConfigSchema.parse(JSON.parse(await readFile(file, "utf8"))); config = { mcpServers: { ...config.mcpServers, ...local.mcpServers } }; break;
      } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; return [{ name: relative, status: "error", tools: [], error: "MCP 配置无效，请检查 mcpServers、command/url、args/env/headers" }]; }
    }
    if (this.globalConfigPath) {
      try { const stat = await this.files.fs.lstat(this.globalConfigPath); if (stat.size > 262144) throw new Error("MCP 配置超过 256KB"); const global = McpConfigSchema.parse(JSON.parse(await readFile(this.globalConfigPath, "utf8"))); config = { mcpServers: { ...global.mcpServers, ...config.mcpServers } }; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return [{ name: "global:mcp.json", status: "error", tools: [], error: "全局 MCP 配置无效" }]; }
    }
    if (!Object.keys(config.mcpServers).length) return [];
    const entries = Object.entries(config.mcpServers); if (entries.length > 64) throw new ProjectError("VALIDATION_FAILED", "MCP 服务器超过 64 个");
    const result: SessionCapabilities["mcp"] = [];
    // Each server is isolated: a failed server cannot remove the built-in tools.
    for (const [name, server] of entries) {
      activeSignal.throwIfAborted(); if (server.enabled === false) { result.push({ name, status: "disabled", tools: [] }); continue; }
      try { await approveConnection?.(name, server); activeSignal.throwIfAborted(); }
      catch (error) {
        activeSignal.throwIfAborted();
        result.push({ name, status: "error", tools: [], error: error instanceof ProjectError && error.code === "APPROVAL_REQUIRED" ? "MCP 连接需要审批，请在会话运行中批准连接" : "MCP 连接未获批准" });
        continue;
      }
      const client = new Client({ name: "SpecLoom", version });
      this.clients.add(client);
      try {
        if (server.url) {
          const url = new URL(server.url); if (!["http:", "https:"].includes(url.protocol)) throw new Error("Invalid protocol");
          // SDK declares optional sessionId as `string | undefined`; wire transport is valid.
          const transport = new StreamableHTTPClientTransport(url, { requestInit: { ...(server.headers ? { headers: server.headers } : {}) } });
          await client.connect(transport as Transport, { timeout: 30000, signal: activeSignal });
        } else if (server.command) {
          const env = Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => pair[1] !== undefined));
          await client.connect(new StdioClientTransport({ command: server.command, args: server.args ?? [], env: { ...env, ...server.env }, cwd: this.files.root, stderr: "ignore" }), { timeout: 30000, signal: activeSignal });
        } else throw new Error("Missing command or URL");
        const names: string[] = []; const definitions: Parameters<WorkspaceCatalog["add"]>[0][] = []; const originals = new Map<string, string>(); const cursors = new Set<string>(); let pages = 0; let cursor: string | undefined;
        do {
          if (++pages > 64 || (cursor && cursors.has(cursor))) throw new Error("MCP pagination did not terminate");
          if (cursor) cursors.add(cursor);
          const listed = await client.listTools(cursor ? { cursor } : {}, { timeout: 30000, signal: activeSignal });
          for (const tool of listed.tools) {
            if (names.length >= 512) throw new Error("Too many tools");
            const prefix = name.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 16); const suffix = createHash("sha256").update(`${name}/${tool.name}`).digest("hex").slice(0, 8);
            const providerName = `mcp_${prefix}_${tool.name.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 34)}_${suffix}`;
            if (originals.has(providerName)) throw new Error("Duplicate MCP tool");
            if (JSON.stringify(tool.inputSchema).length > 65536) throw new Error("Oversized tool schema");
            originals.set(providerName, tool.name); names.push(providerName);
            definitions.push({ name: providerName, description: `MCP ${name} / ${tool.name}: ${tool.description ?? ""}`.slice(0, 2000), schema: z.record(z.string(), z.unknown()), parameters: tool.inputSchema as Record<string, unknown> });
          } cursor = listed.nextCursor;
        } while (cursor);
        activeSignal.throwIfAborted(); if (generation !== this.generation) throw new Error("MCP lifecycle changed");
        for (const definition of definitions) { this.tools.set(definition.name, { client, originalName: originals.get(definition.name)! }); catalog.add(definition); }
        result.push({ name, status: "connected", tools: names });
      } catch { await client.close().catch(() => undefined); this.clients.delete(client); activeSignal.throwIfAborted(); result.push({ name, status: "error", tools: [], error: "MCP 连接或工具发现失败，请检查服务器地址、命令和认证配置" }); }
    }
    return result;
  }
  has(name: string): boolean { return this.tools.has(name); }
  async call(name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const connection = this.tools.get(name); if (!connection) throw new ProjectError("MODEL_ERROR", "MCP 工具尚未发现");
    const result = await connection.client.callTool({ name: connection.originalName, arguments: input }, undefined, { timeout: 600000, ...(signal ? { signal } : {}) });
    if (result.isError) throw new ProjectError("COMMAND_FAILED", JSON.stringify(result.content).slice(0, 2000));
    return result;
  }
  async close(): Promise<void> { this.generation++; this.lifetime.abort(); this.lifetime = new AbortController(); const clients = [...this.clients]; this.clients.clear(); this.tools.clear(); await Promise.allSettled(clients.map(c => c.close())); }
}
