import type { ProjectMediaLease } from "../shared/project-files";
import { ProjectError } from "./core/errors";
import type { FileStore } from "./core/file-store";
import { ProjectMediaServer } from "./project-media-server";

interface ProjectMediaEntry { server: ProjectMediaServer; count: number }
/** Servers retain the concrete store selected by the trusted caller, across UI project changes. */
export class ProjectMediaRegistry {
  private readonly servers = new Map<FileStore, ProjectMediaEntry>();
  private readonly leases = new Map<string, { owner: symbol; store: FileStore; entry: ProjectMediaEntry }>();
  private readonly closing = new Set<Promise<void>>();
  private readonly ownerCounts = new Map<symbol, number>();
  private readonly ownerEpochs = new Map<symbol, number>();
  private closed = false;

  async open(owner: symbol, store: FileStore, relative: string): Promise<ProjectMediaLease> {
    if (this.closed) throw new ProjectError("BACKEND_UNAVAILABLE", "Project media registry is closed");
    const count = this.ownerCounts.get(owner) ?? 0;
    if (count >= 4) throw new ProjectError("VALIDATION_FAILED", "A window can hold at most four media previews");
    this.ownerCounts.set(owner, count + 1);
    const epoch = this.ownerEpochs.get(owner) ?? 0;
    let entry = this.servers.get(store);
    if (!entry) { entry = { server: new ProjectMediaServer(store), count: 0 }; this.servers.set(store, entry); }
    entry.count++;
    let retained = false;
    try {
      const lease = await entry.server.open(owner, relative);
      if (this.closed || epoch !== (this.ownerEpochs.get(owner) ?? 0)) { entry.server.release(owner, lease.id); throw new ProjectError("BACKEND_UNAVAILABLE", "The media owner was closed"); }
      this.leases.set(lease.id, { owner, store, entry });
      retained = true;
      return lease;
    } finally { if (!retained) { this.decrementOwner(owner); entry.count--; this.retireUnused(store, entry); } }
  }

  release(owner: symbol, id: string): void {
    const lease = this.leases.get(id);
    if (!lease || lease.owner !== owner) return;
    this.leases.delete(id);
    this.decrementOwner(owner);
    lease.entry.server.release(owner, id);
    lease.entry.count--;
    this.retireUnused(lease.store, lease.entry);
  }

  revokeOwner(owner: symbol): void {
    this.ownerEpochs.set(owner, (this.ownerEpochs.get(owner) ?? 0) + 1);
    for (const [id, lease] of this.leases) if (lease.owner === owner) this.release(owner, id);
    for (const entry of this.servers.values()) entry.server.revokeOwner(owner);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.leases.clear(); this.ownerCounts.clear();
    await Promise.all([...this.servers.values()].map((entry) => entry.server.close()).concat([...this.closing]));
    this.servers.clear();
  }

  private retireUnused(store: FileStore, entry: ProjectMediaEntry): void {
    if (entry.count !== 0 || this.servers.get(store) !== entry) return;
    this.servers.delete(store);
    const closing = entry.server.close();
    this.closing.add(closing);
    void closing.then(() => this.closing.delete(closing), () => this.closing.delete(closing));
  }

  private decrementOwner(owner: symbol): void {
    const count = (this.ownerCounts.get(owner) ?? 1) - 1;
    if (count > 0) this.ownerCounts.set(owner, count); else this.ownerCounts.delete(owner);
  }
}
