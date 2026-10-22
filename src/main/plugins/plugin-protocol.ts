import { readFile } from "node:fs/promises";
import path from "node:path";
import { protocol } from "electron";
import type { PluginManager } from "../core/plugins/plugin-manager";

export const PLUGIN_SCHEME = "specloom-plugin";

/** Must run before app.whenReady(). */
export function registerPluginScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: PLUGIN_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
}

export function pluginPageUrl(pluginId: string, pageId: string): string {
  return `${PLUGIN_SCHEME}://${pluginId}/${pageId}/`;
}

export function registerPluginProtocol(manager: PluginManager): void {
  protocol.handle(PLUGIN_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      const pluginId = url.hostname;
      const segments = url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
      const pageId = segments[0];
      if (!pluginId || !pageId) return new Response("Not found", { status: 404 });
      const asset = segments.slice(1).join("/");
      const file = asset ? await manager.resolvePageAsset(pluginId, pageId, asset) : await manager.resolvePage(pluginId, pageId);
      const body = await readFile(file);
      return new Response(body, { headers: { "content-type": mediaType(file), "cache-control": "no-store" } });
    } catch {
      return new Response("Plugin page unavailable", { status: 404 });
    }
  });
}

function mediaType(file: string): string {
  switch (path.extname(file).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": case ".mjs": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    default: return "application/octet-stream";
  }
}
