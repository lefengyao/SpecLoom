import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { version } from "../../package.json";
import type { McpConnection } from "../shared/desktop-api";
import { serializeError } from "./core/errors";
import type { ProjectCore } from "./core/project-core";
import { toolCatalog } from "./core/tool-catalog";

export interface LocalMcpServer extends McpConnection { close(): Promise<void> }

export async function startMcpServer(core: () => ProjectCore): Promise<LocalMcpServer> {
  const token = randomBytes(32).toString("hex");
  let port = 0;
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
      server = new McpServer({ name: "specloom", version });
      for (const tool of toolCatalog.listTools()) {
        const schema = tool.schema as z.ZodObject;
        server.registerTool(tool.name, { description: tool.description, inputSchema: schema.extend({ taskId: z.string().min(1).max(256) }) }, async (arguments_, extra) => {
          const { taskId, ...input } = arguments_ as { taskId: string } & Record<string, unknown>;
          try {
            if (closing) throw new Error("Server is closing");
            const operation = core().executeTool(taskId, tool.name, input, extra.signal);
            pendingTools.add(operation);
            try {
              const result = await operation;
              const image = mcpImageResult(result);
              if (image) return { content: [
                { type: "image" as const, data: image.base64, mimeType: "image/png" },
                { type: "text" as const, text: JSON.stringify({ mimeType: "image/png", width: image.width, height: image.height }) },
              ] };
              return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
            } finally { pendingTools.delete(operation); }
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

  await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", () => { http.off("error", reject); resolve(); }); });
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
      })();
      return closePromise;
    },
  };
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
