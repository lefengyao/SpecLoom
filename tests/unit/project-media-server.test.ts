import { mkdir, mkdtemp, open, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileStore } from "../../src/main/core/file-store";
import { ProjectMediaServer } from "../../src/main/project-media-server";

const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.from([0,0,0,13]), Buffer.from("IHDR"), Buffer.from([0,0,0,1,0,0,0,1]), Buffer.alloc(80, 42)]);
const video = Buffer.concat([Buffer.from([0,0,0,24]), Buffer.from("ftypisom"), Buffer.alloc(12), Buffer.from(Array.from({length: 128}, (_, index) => index))]);
let root: string;
let server: ProjectMediaServer;
const owner = Symbol("window");
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "specloom-http-media-")); await writeFile(path.join(root, "image.PNG"), png); await writeFile(path.join(root, "clip.mp4"), video); server = new ProjectMediaServer(new FileStore(root)); });
afterEach(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
function request(url: string, options: http.RequestOptions = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; bytes: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (response) => { const chunks: Buffer[] = []; response.on("data", (chunk: Buffer) => chunks.push(chunk)); response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, bytes: Buffer.concat(chunks) })); response.on("error", reject); });
    req.on("error", reject); req.end();
  });
}

describe("project-bound loopback media", () => {
  it("serves real descriptor bytes, HEAD and byte ranges without pre-hashing videos", async () => {
    const store = new FileStore(root);
    vi.spyOn(store, "listVersion").mockRejectedValue(new Error("must not hash media"));
    await server.close(); server = new ProjectMediaServer(store);
    const lease = await server.open(owner, "clip.mp4");
    expect(lease).toMatchObject({ kind: "video", mimeType: "video/mp4", size: video.length });
    expect(new URL(lease.url).hostname).toBe("127.0.0.1");
    expect(new URL(lease.url).pathname).toMatch(/[a-f0-9]{64}$/);
    expect((await request(lease.url)).bytes).toEqual(video);
    const head = await request(lease.url, { method: "HEAD" });
    expect(head).toMatchObject({ status: 200, bytes: Buffer.alloc(0) });
    expect(head.headers["content-length"]).toBe(String(video.length));
    for (const [range, start, end] of [["bytes=8-23",8,23], ["bytes=24-",24,video.length-1], ["bytes=-17",video.length-17,video.length-1]] as const) {
      const response = await request(lease.url, { headers: { Range: range } });
      expect(response.status).toBe(206);
      expect(response.headers["content-range"]).toBe(`bytes ${start}-${end}/${video.length}`);
      expect(response.bytes).toEqual(video.subarray(start, end + 1));
    }
    for (const range of ["bytes=9999-", "bytes=10-2", "bytes=0-1,3-4", "bytes=-0", "items=0-1"]) {
      const response = await request(lease.url, { headers: { Range: range } });
      expect(response.status).toBe(416); expect(response.headers["content-range"]).toBe(`bytes */${video.length}`);
    }
  });

  it("requires the precise host, unguessable token and read methods, without broad CORS", async () => {
    const lease = await server.open(owner, "image.PNG");
    expect((await request(lease.url)).headers["access-control-allow-origin"]).toBeUndefined();
    expect((await request(lease.url, { headers: { Host: "localhost" } })).status).toBe(403);
    expect((await request(lease.url, { method: "POST" })).status).toBe(405);
    expect((await request(lease.url.replace(/[a-f0-9]{64}$/, "0".repeat(64)))).status).toBe(404);
    server.release(Symbol("another window"), lease.id);
    expect((await request(lease.url)).status).toBe(200);
    server.release(owner, lease.id);
    expect((await request(lease.url)).status).toBe(404);
  });

  it("serves SVG only as an isolated image MIME with scripts and external resources disabled", async () => {
    await writeFile(path.join(root, "icon.svg"), '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1"/></svg>');
    const lease = await server.open(owner, "icon.svg");
    const response = await request(lease.url);
    expect(response.headers["content-type"]).toBe("image/svg+xml");
    expect(response.headers["content-security-policy"]).toContain("sandbox");
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    await writeFile(path.join(root, "html.svg"), '<html><svg></svg></html>');
    await expect(server.open(owner, "html.svg")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("invalidates changed and deleted generations and revokes an owner's leases", async () => {
    const lease = await server.open(owner, "image.PNG");
    await writeFile(path.join(root, "image.PNG"), Buffer.concat([png, Buffer.from([1])]));
    expect((await request(lease.url)).status).toBe(410);
    const next = await server.open(owner, "image.PNG");
    expect(next.generation).not.toBe(lease.generation);
    await unlink(path.join(root, "image.PNG"));
    expect((await request(next.url)).status).toBe(410);
    const clip = await server.open(owner, "clip.mp4"); server.revokeOwner(owner);
    expect((await request(clip.url)).status).toBe(404);
  });

  it("rejects path escapes, runtime files, junctions, forged images and image size overflow", async () => {
    await writeFile(path.join(root, "fake.png"), "not an image");
    const large = await open(path.join(root, "large.png"), "w"); await large.write(png); await large.truncate(32 * 1024 * 1024 + 1); await large.close();
    await mkdir(path.join(root, ".specloom")); await writeFile(path.join(root, ".specloom/project.yaml"), "secret");
    for (const relative of ["../image.PNG", "C:\\image.PNG", "\\\\server\\share\\image.PNG", "clip.mp4:secret"]) await expect(server.open(owner, relative)).rejects.toMatchObject({ code: "PATH_ESCAPE" });
    await expect(server.open(owner, ".specloom/project.yaml")).rejects.toMatchObject({ code: "TASK_SCOPE_DENIED" });
    await expect(server.open(owner, "fake.png")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(server.open(owner, "large.png")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const outside = await mkdtemp(path.join(os.tmpdir(), "specloom-outside-media-"));
    try { await writeFile(path.join(outside, "image.png"), png); await symlink(outside, path.join(root, "linked"), "junction"); await expect(server.open(owner, "linked/image.png")).rejects.toMatchObject({ code: "PATH_ESCAPE" }); }
    finally { await rm(path.join(root, "linked"), { force: true }); await rm(outside, { recursive: true, force: true }); }
  });

  it("limits concurrent pending leases per owner and frees capacity after release", async () => {
    const leases = await Promise.all(Array.from({length: 4}, () => server.open(owner, "image.PNG")));
    await expect(server.open(owner, "image.PNG")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    server.release(owner, leases[0]!.id);
    expect(await server.open(owner, "image.PNG")).toMatchObject({ kind: "image" });
    expect(await server.open(Symbol("another window"), "image.PNG")).toMatchObject({ kind: "image" });
  });

  it("caps real backpressured streams at eight and closes their descriptors on shutdown", async () => {
    const handle = await open(path.join(root, "long.mp4"), "w");
    await handle.write(video); await handle.truncate(64 * 1024 * 1024); await handle.close();
    const first = Symbol("first window"), second = Symbol("second window");
    const leases = await Promise.all(Array.from({ length: 8 }, (_, index) => server.open(index < 4 ? first : second, "long.mp4")));
    const paused: { req: http.ClientRequest; response: http.IncomingMessage }[] = [];
    try {
      for (const lease of leases) await new Promise<void>((resolve, reject) => {
        const req = http.get(lease.url, (response) => { response.pause(); response.on("error", () => undefined); paused.push({ req, response }); resolve(); }); req.on("error", reject);
      });
      expect((await request(leases[0]!.url)).status).toBe(503);
      await server.close();
      // In particular, Windows permits removal only after all streaming descriptors are released.
      await unlink(path.join(root, "long.mp4"));
    } finally { for (const { req, response } of paused) { response.destroy(); req.destroy(); } }
  });
});
