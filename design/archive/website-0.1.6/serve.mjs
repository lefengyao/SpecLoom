import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = normalize(join(fileURLToPath(new URL("..", import.meta.url)))).replace(/[\\/]+$/, "");
const port = Number(process.env.PORT || 59843);
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".exe": "application/octet-stream",
  ".zip": "application/zip",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    if (pathname === "/") {
      response.writeHead(302, { location: "/website/" });
      response.end();
      return;
    }

    const relative = pathname.replace(/^\/+/, "");
    let target = normalize(join(root, relative));
    if (target !== root && !target.startsWith(root + sep)) {
      response.writeHead(403);
      response.end("forbidden");
      return;
    }

    let info = await stat(target);
    if (info.isDirectory()) {
      target = join(target, "index.html");
      info = await stat(target);
    }
    if (!info.isFile()) throw new Error("not a file");

    const body = await readFile(target);
    response.writeHead(200, {
      "content-type": types[extname(target).toLowerCase()] ?? "application/octet-stream",
      "content-length": body.byteLength,
      "cache-control": "no-store",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end(request.method === "HEAD" ? undefined : "not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log("SpecLoom website: http://127.0.0.1:" + port + "/website/");
});
