import { randomBytes } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import type { ProjectMediaLease } from "../shared/project-files";
import { ProjectError } from "./core/errors";
import type { FileStore } from "./core/file-store";
import { isProjectMediaCurrent, openProjectMedia, type ProjectMediaFile } from "./core/project-media";

interface LeaseRecord { owner: symbol; path: string; lease: ProjectMediaLease; streams: Set<ServerResponse> }
interface ByteRange { start: number; end: number }
let activeProjectMediaStreams = 0;
function parseRange(value: string | undefined, size: number): ByteRange | false | undefined {
  if (value === undefined) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return false;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return false;
  return { start, end: Math.min(end, size - 1) };
}

/** A capability URL serves one captured project's descriptors, never arbitrary HTTP paths. */
export class ProjectMediaServer {
  private readonly server: http.Server;
  private readonly leases = new Map<string, LeaseRecord>();
  private readonly ownerCounts = new Map<symbol, number>();
  private readonly ownerEpochs = new Map<symbol, number>();
  private readonly serving = new Set<Promise<void>>();
  private readonly openings = new Set<Promise<ProjectMediaLease>>();
  private listening: Promise<number> | undefined;
  private port: number | undefined;
  private closed = false;

  constructor(private readonly store: FileStore) {
    this.server = http.createServer((request, response) => {
      const serving = this.serve(request, response);
      this.serving.add(serving);
      void serving.then(() => this.serving.delete(serving), () => this.serving.delete(serving));
    });
    this.server.maxHeadersCount = 32;
    this.server.headersTimeout = 5_000;
    this.server.requestTimeout = 15_000;
    this.server.keepAliveTimeout = 1_000;
    this.server.on("clientError", (_error, socket) => socket.destroy());
  }

  open(owner: symbol, relative: string): Promise<ProjectMediaLease> {
    const opening = this.openLease(owner, relative);
    this.openings.add(opening);
    void opening.then(() => this.openings.delete(opening), () => this.openings.delete(opening));
    return opening;
  }

  private async openLease(owner: symbol, relative: string): Promise<ProjectMediaLease> {
    if (this.closed) throw new ProjectError("BACKEND_UNAVAILABLE", "Project media server is closed");
    if (typeof owner !== "symbol") throw new ProjectError("VALIDATION_FAILED", "A trusted media owner is required");
    const count = this.ownerCounts.get(owner) ?? 0;
    if (count >= 4) throw new ProjectError("VALIDATION_FAILED", "A window can hold at most four media previews");
    this.ownerCounts.set(owner, count + 1);
    const epoch = this.ownerEpochs.get(owner) ?? 0;
    let retained = false;
    try {
      const media = await openProjectMedia(this.store, relative);
      try {
        const port = await this.listen();
        if (this.closed || epoch !== (this.ownerEpochs.get(owner) ?? 0)) throw new ProjectError("BACKEND_UNAVAILABLE", "The media owner was closed");
        const id = randomBytes(32).toString("hex");
        const lease: ProjectMediaLease = { id, url: `http://127.0.0.1:${port}/media/${id}`, kind: media.kind, mimeType: media.mimeType, size: media.size, generation: media.generation };
        this.leases.set(id, { owner, path: media.path, lease, streams: new Set() });
        retained = true;
        return lease;
      } finally { await media.handle.close(); }
    } finally { if (!retained) this.decrementOwner(owner); }
  }

  release(owner: symbol, id: string): void {
    const record = this.leases.get(id);
    if (!record || record.owner !== owner) return;
    this.leases.delete(id);
    this.decrementOwner(owner);
    for (const response of record.streams) response.destroy();
  }

  revokeOwner(owner: symbol): void {
    this.ownerEpochs.set(owner, (this.ownerEpochs.get(owner) ?? 0) + 1);
    for (const [id, record] of this.leases) if (record.owner === owner) this.release(owner, id);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const [id, record] of this.leases) this.release(record.owner, id);
    await Promise.allSettled([...this.openings]);
    if (!this.listening) return;
    try { await this.listening; } catch { return; }
    await new Promise<void>((resolve) => { this.server.close(() => resolve()); this.server.closeAllConnections(); });
    await Promise.allSettled([...this.serving]);
  }

  private decrementOwner(owner: symbol): void {
    const count = (this.ownerCounts.get(owner) ?? 1) - 1;
    if (count > 0) this.ownerCounts.set(owner, count); else this.ownerCounts.delete(owner);
  }

  private listen(): Promise<number> {
    if (this.closed) return Promise.reject(new ProjectError("BACKEND_UNAVAILABLE", "Project media server is closed"));
    this.listening ??= new Promise<number>((resolve, reject) => {
      const failed = (error: Error) => reject(error);
      this.server.once("error", failed);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", failed);
        const address = this.server.address();
        if (!address || typeof address === "string") { reject(new Error("Missing loopback media address")); return; }
        this.port = address.port;
        resolve(address.port);
      });
    });
    return this.listening;
  }

  private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const end = (status: number) => { response.writeHead(status, { "Cache-Control": "no-store", "Content-Length": "0", "X-Content-Type-Options": "nosniff" }); response.end(); };
    if (this.closed || request.headers.host !== `127.0.0.1:${this.port}`) { end(403); return; }
    if (request.method !== "GET" && request.method !== "HEAD") { response.setHeader("Allow", "GET, HEAD"); end(405); return; }
    const match = /^\/media\/([a-f0-9]{64})$/.exec(request.url ?? "");
    const record = match ? this.leases.get(match[1]!) : undefined;
    if (!record) { end(404); return; }
    if (activeProjectMediaStreams >= 8) { end(503); return; }
    activeProjectMediaStreams++;
    record.streams.add(response);
    let media: Awaited<ReturnType<typeof openProjectMedia>> | undefined;
    try {
      try { media = await openProjectMedia(this.store, record.path); }
      catch { record.streams.delete(response); this.release(record.owner, record.lease.id); if (!response.destroyed) end(410); return; }
      if (this.leases.get(record.lease.id) !== record || response.destroyed) return;
      if (media.generation !== record.lease.generation) {
        // Retire the stale capability before a newly opened descriptor can send changed bytes.
        record.streams.delete(response);
        this.release(record.owner, record.lease.id);
        end(410);
        return;
      }
      const range = parseRange(request.headers.range, media.size);
      response.setHeader("Accept-Ranges", "bytes");
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      if (range === false) { response.setHeader("Content-Range", `bytes */${media.size}`); end(416); return; }
      const start = range?.start ?? 0;
      const last = range?.end ?? media.size - 1;
      response.setHeader("Content-Type", media.mimeType);
      // SVG stays a sandboxed image subresource, including if its capability URL is opened directly.
      if (media.mimeType === "image/svg+xml") response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      response.setHeader("Content-Length", last - start + 1);
      response.setHeader("ETag", `"${media.generation}"`);
      if (range) response.setHeader("Content-Range", `bytes ${start}-${last}/${media.size}`);
      response.writeHead(range ? 206 : 200);
      if (request.method === "HEAD") { response.end(); return; }
      // FileHandle.createReadStream preserves this verified descriptor and pipeline applies backpressure.
      await pipeline(media.handle.createReadStream({ start, end: last, autoClose: false }), (chunks) => this.guardChunks(chunks, media!, record), response);
    } catch {
      if (!response.headersSent && !response.destroyed) end(500); else response.destroy();
    } finally {
      record.streams.delete(response);
      activeProjectMediaStreams--;
      await media?.handle.close().catch(() => undefined);
    }
  }

  private async *guardChunks(chunks: AsyncIterable<Buffer>, media: ProjectMediaFile, record: LeaseRecord): AsyncGenerator<Buffer> {
    for await (const chunk of chunks) {
      if (this.leases.get(record.lease.id) !== record || !(await isProjectMediaCurrent(this.store, media))) {
        this.release(record.owner, record.lease.id);
        throw new ProjectError("VERSION_CONFLICT", "Project media changed during streaming");
      }
      yield chunk;
    }
  }
}
