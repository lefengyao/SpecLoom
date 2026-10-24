import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { version } from "../../package.json";
import type { McpConnection } from "../shared/desktop-api";
import { VersionTokenSchema } from "../shared/contracts";
import { ProjectError, serializeError } from "./core/errors";
import type { ProjectCore } from "./core/project-core";
import type { OfflineDocumentStore } from "./core/offline-documents";
import type { WorkspaceTools } from "./core/tools/workspace-tools";
import { OfflineDocumentReadOptionsSchema } from "../shared/offline-documents";
import { toolCatalog } from "./core/tool-catalog";

export interface LocalMcpServer extends McpConnection { close(): Promise<void> }

export interface McpServerOptions {
  /** Reuse the project's stored token so clients keep working across restarts. */
  token?: string;
  /** Preferred loopback port; falls back to an ephemeral port when it is taken. */
  port?: number;
  /** Built-in offline documentation tools are global to this installation. */
  offlineDocuments?: OfflineDocumentStore;
  /** Workspace tools whose connected external MCP servers are re-exposed here. */
  externalTools?: (root: string) => WorkspaceTools | Promise<WorkspaceTools>;
  /** Changes whenever the MCP server configuration is edited. */
  configRevision?: () => number;
}

export async function startMcpServer(core: () => ProjectCore, options: McpServerOptions = {}): Promise<LocalMcpServer> {
  const token = options.token && /^[a-f0-9]{64}$/i.test(options.token) ? options.token : randomBytes(32).toString("hex");
  let port = 0;
  let instructionCache: { path: string; text: string } | undefined;
  let externalCache: { path: string; revision: number; tools: WorkspaceTools; ready: Promise<void> } | undefined;
  const instructionsFor = async (): Promise<string | undefined> => {
    let current: ProjectCore;
    try { current = core(); } catch { return undefined; }
    if (instructionCache?.path !== current.metadata.path) {
      try { instructionCache = { path: current.metadata.path, text: await current.mcpInstructions() }; }
      catch { return undefined; }
    }
    return instructionCache.text;
  };
  const externalFor = async (): Promise<WorkspaceTools | undefined> => {
    if (!options.externalTools) return undefined;
    let root: string;
    try { root = core().metadata.path; } catch { return undefined; }
    const revision = options.configRevision?.() ?? 0;
    if (externalCache && externalCache.path === root && externalCache.revision !== revision) {
      // A newly added or edited downstream server must appear without restarting the client.
      externalCache.revision = revision;
      externalCache.ready = externalCache.tools.refresh().then(() => undefined, () => undefined);
    }
    if (externalCache?.path !== root) {
      await externalCache?.tools.close().catch(() => undefined);
      try {
        const tools = await options.externalTools(root);
        externalCache = { path: root, revision, tools, ready: tools.capabilities().then(() => undefined, () => undefined) };
      } catch { return undefined; }
    }
    await externalCache.ready;
    return externalCache.tools;
  };
  let active = 0;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const pendingTools = new Set<Promise<unknown>>();
  const connections = new Set<StreamableHTTPServerTransport>();
  const http = createServer((request, response) => {
    void handle(request, response).catch(() => { if (!response.headersSent) respond(response, 500, "Request failed"); else response.destroy(); });
  });
  http.requestTimeout = 150_000;
  http.headersTimeout = 10_000;
  http.maxHeadersCount = 64;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (closing) { respond(response, 503, "Server is closing"); return; }
    const host = request.headers.host;
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!host || !allowedHosts.includes(host)) { respond(response, 403, "Invalid Host"); return; }
    const origin = request.headers.origin;
    if (origin !== undefined && !allowedHosts.map((value) => `http://${value}`).includes(origin)) { respond(response, 403, "Invalid Origin"); return; }
    const authorization = request.headers.authorization;
    const expected = Buffer.from(`Bearer ${token}`);
    const actual = Buffer.from(authorization ?? "");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { respond(response, 401, "Authentication required"); return; }
    if (request.url !== "/mcp") { respond(response, 404, "Not found"); return; }
    if (request.method !== "POST") { respond(response, 405, "POST required"); return; }
    if (active >= 8) { respond(response, 429, "Too many active requests"); return; }
    if (Number(request.headers["content-length"] ?? 0) > 1_048_576) { respond(response, 413, "Request too large"); return; }
    active++;
    let transport: StreamableHTTPServerTransport | undefined;
    let server: McpServer | undefined;
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        bytes += buffer.length;
        if (bytes > 1_048_576) { respond(response, 413, "Request too large"); return; }
        chunks.push(buffer);
      }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { respond(response, 400, "Invalid JSON"); return; }
      if (closing) { respond(response, 503, "Server is closing"); return; }
      const instructions = await instructionsFor();
      const externalTools = await externalFor();
      server = new McpServer({ name: "specloom", version }, instructions ? { instructions } : {});
      const offlineTools = options.offlineDocuments ? [
        { name: "OfflineDocsList", description: "列出已启用离线文档包、当前版本和文件索引。默认每个版本返回前 200 个文件；用 bundleId/offset/limit 分页，fileCount 与 nextOffset 指示总页数。", schema: z.object({ bundleId: z.string().uuid().optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(500).optional() }).strict() },
        { name: "OfflineDocsRead", description: "分页读取已启用离线文档中的一个文本文件；二进制文件只返回元数据。", schema: z.object({ bundleId: z.string().uuid(), versionId: z.string().uuid().optional(), path: z.string().min(1).max(2048), ...OfflineDocumentReadOptionsSchema.shape }).strict() },
      ] : [];
      const coreTools: McpToolSpec[] = [
        ...toolCatalog.listTools().map((tool) => ({ ...tool, workspace: false,
          // External clients may omit the skill version; the handler resolves the current one.
          schema: tool.name === "skills.load"
            ? z.object({
              taskId: z.string().min(1).max(256),
              id: z.string().min(1).max(256),
              expectedVersion: VersionTokenSchema.optional(),
              sourcePaths: z.array(z.string().min(1).max(2048)).max(64).optional(),
            }).strict()
            : (tool.schema as z.ZodObject).extend({ taskId: z.string().min(1).max(256) }) })),
        ...offlineTools.map((tool) => ({ ...tool, workspace: false,
          schema: (tool.schema as z.ZodObject).extend({ taskId: z.string().min(1).max(256).optional() }) })),
      ];
      const known = new Set(coreTools.map((tool) => tool.name));
      // The in-app agent and external agents share one workspace catalog; names already served by
      // a task-scoped core tool stay bound to that implementation.
      const workspaceTools: McpToolSpec[] = (externalTools?.catalog.all() ?? []).filter((tool) => !known.has(tool.name)).map((tool) => ({
        name: tool.name,
        description: tool.description,
        schema: workspaceSchema(tool),
        workspace: true,
      }));
      const tools = [...coreTools, ...workspaceTools];
      const render = (result: unknown) => {
        const image = mcpImageResult(result);
        if (image) return { content: [
          { type: "image" as const, data: image.base64, mimeType: "image/png" },
          { type: "text" as const, text: JSON.stringify({ mimeType: "image/png", width: image.width, height: image.height }) },
        ] };
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      };
      for (const tool of tools) {
        server.registerTool(tool.name, { description: tool.description, inputSchema: tool.schema }, async (arguments_, extra) => {
          const { taskId, ...input } = arguments_ as { taskId?: string } & Record<string, unknown>;
          try {
            if (closing) throw new Error("Server is closing");
            if (tool.workspace && externalTools) {
              const operation = externalTools.execute(tool.name, input, extra.signal);
              pendingTools.add(operation);
              try {
                const result = await operation;
                // ToolSearch is the discovery entry point; show which downstream servers connected or failed.
                if (tool.name === "ToolSearch") {
                  const capabilities = await externalTools.capabilities().catch(() => undefined);
                  return render({ ...(result as { tools?: unknown }), mcpServers: capabilities?.mcp ?? [] });
                }
                return render(result);
              } finally { pendingTools.delete(operation); }
            }
            if (tool.name === "OfflineDocsList" && options.offlineDocuments) {
              const offset = Number(input.offset ?? 0);
              const limit = Number(input.limit ?? 200);
              const enabled = await options.offlineDocuments.listEnabled();
              const bundles = (input.bundleId === undefined ? enabled : enabled.filter((bundle) => bundle.id === String(input.bundleId))).map((bundle) => ({
                ...bundle,
                versions: bundle.versions.map((version) => ({
                  ...version,
                  files: version.files.slice(offset, offset + limit),
                  fileCount: version.files.length,
                  ...(version.files.length > offset + limit ? { nextOffset: offset + limit } : {}),
                })),
              }));
              return { content: [{ type: "text" as const, text: JSON.stringify(bundles) }] };
            }
            if (tool.name === "OfflineDocsRead" && options.offlineDocuments) {
              const result = await options.offlineDocuments.read(
                String(input.bundleId),
                input.versionId === undefined ? undefined : String(input.versionId),
                String(input.path),
                { offset: Number(input.offset ?? 0), limit: Number(input.limit ?? 6000) },
              );
              return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
            }
            let args = input;
            if (tool.name === "skills.load" && args.expectedVersion === undefined) {
              const skills = await core().executeTool(String(taskId), "skills.list", {}, extra.signal, { direct: true }) as { id?: unknown; version?: unknown }[];
              const skill = Array.isArray(skills) ? skills.find((item) => item.id === args.id) : undefined;
              if (typeof skill?.version !== "string") throw new ProjectError("FILE_NOT_FOUND", "Skill 不存在，请先调用 skills.list");
              args = { ...args, expectedVersion: skill.version };
            }
            const operation = core().executeTool(String(taskId), tool.name, args, extra.signal, { direct: true });
            pendingTools.add(operation);
            try { return render(await operation); }
            finally { pendingTools.delete(operation); }
          } catch (error) { return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(serializeError(error)) }] }; }
        });
      }
      transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      connections.add(transport);
      // SDK optional callbacks predate exactOptionalPropertyTypes; the concrete transport satisfies them at runtime.
      await server.connect(transport as Parameters<McpServer["connect"]>[0]);
      await transport.handleRequest(request, response, body);
    } finally {
      active--;
      if (transport) { connections.delete(transport); await transport.close(); }
      await server?.close();
    }
  }

  const listen = (preferred: number) => new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => { http.off("listening", onListening); reject(error); };
    const onListening = () => { http.off("error", onError); resolve(); };
    http.once("error", onError);
    http.once("listening", onListening);
    http.listen(preferred, "127.0.0.1");
  });
  const listenPreferred = async (preferred: number): Promise<void> => {
    // A restart can race the previous instance's shutdown; keep the stored port when it frees up.
    for (let attempt = 0; ; attempt++) {
      try { await listen(preferred); return; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt >= 19) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  };
  if (options.port === undefined) await listen(0);
  else {
    try { await listenPreferred(options.port); }
    catch (error) {
      // A stored port can be taken by another process; keep the token, move the port.
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") await listen(0);
      else throw error;
    }
  }
  port = (http.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`, token,
    close: () => {
      closing = true;
      closePromise ??= (async () => {
        const stopped = new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
        const disconnected = Promise.allSettled([...connections].map((connection) => connection.close()));
        http.closeAllConnections();
        // Disconnecting a transport aborts its signal, but tools may still be finishing writes.
        await Promise.all([stopped, disconnected, Promise.allSettled([...pendingTools])]);
        await externalCache?.tools.close().catch(() => undefined);
        externalCache = undefined;
      })();
      return closePromise;
    },
  };
}

interface McpToolSpec { name: string; description: string; schema: z.ZodType; workspace: boolean }

/** Advertise the external server's own input schema so agents can call it correctly. */
function externalSchema(parameters?: Record<string, unknown>): z.ZodType {
  if (!parameters) return z.object({}).catchall(z.unknown());
  try { return z.fromJSONSchema(parameters as Parameters<typeof z.fromJSONSchema>[0]); }
  catch { return z.object({}).catchall(z.unknown()); }
}

/** Workspace tools keep their own arguments; taskId stays accepted for callers that always send one. */
function workspaceSchema(tool: { schema: z.ZodType; parameters?: Record<string, unknown> }): z.ZodType {
  const base = tool.parameters ? externalSchema(tool.parameters) : tool.schema;
  try { return (base as unknown as z.ZodObject).extend({ taskId: z.string().min(1).max(256).optional() }); }
  catch { return base; }
}

function respond(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify({ error: message }));
}

function mcpImageResult(value: unknown): { base64: string; width: number; height: number } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const image = value as Record<string, unknown>;
  if (image.mimeType !== "image/png" || typeof image.base64 !== "string" || !image.base64 || image.base64.length > 11_184_812
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(image.base64)
      || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height)
      || Number(image.width) < 1 || Number(image.height) < 1 || Number(image.width) > 32768 || Number(image.height) > 32768
      || Number(image.width) * Number(image.height) > 100_000_000) return undefined;
  return { base64: image.base64, width: Number(image.width), height: Number(image.height) };
}
