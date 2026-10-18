import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { SessionEvent } from "../shared/chat";
import type { HubRuntimeContext } from "../shared/hub-runtime";
import { DesktopController, type DesktopSharedServices } from "./desktop-controller";
import { ModelVault } from "./core/model-vault";
import { ProviderVault } from "./core/provider-vault";
import { PreferencesStore } from "./core/preferences";
import { RecentProjects } from "./core/recent-projects";
import { OfflineDocumentStore } from "./core/offline-documents";
import { HooksStore } from "./core/hooks";
import { SkillStore } from "./core/skill-store";
import { startMcpServer } from "./mcp-server";

const identity = (root: string) => process.platform === "win32" ? path.resolve(root).toLowerCase() : path.resolve(root);
type Backend = { controller: DesktopController; closeMcp(): Promise<void>; unsubscribe(): void };
type Entry = { key: string; refs: number; ready: Promise<Backend>; operations: Set<Promise<unknown>>; closing?: Promise<void> };
export interface HubWorkspaceLease { controller: DesktopController; entry: Entry; release(): Promise<void> }
type Observer = { session(event: SessionEvent): void; changed(channel: string, projectPath?: string): void };
const pools = new Map<string, HubWorkspaces>();

/** One service graph per module profile, one coherent controller per project. */
export class HubWorkspaces {
  private readonly entries = new Map<string, Entry>();
  private readonly observers = new Set<Observer>();
  private readonly windows = new Set<number>();
  private readonly shared: DesktopSharedServices;
  private readonly vault: ModelVault;
  private readonly providers: ProviderVault;
  private mutations: Promise<unknown> = Promise.resolve();

  private constructor(private readonly context: HubRuntimeContext, private readonly key: string) {
    const { dataDirectory, encryption } = context;
    this.vault = new ModelVault(dataDirectory, encryption);
    this.providers = new ProviderVault(dataDirectory, encryption);
    this.shared = { preferences: new PreferencesStore(dataDirectory), recentProjects: new RecentProjects(dataDirectory),
      offlineDocuments: new OfflineDocumentStore(dataDirectory), hooks: new HooksStore(dataDirectory), skills: new SkillStore(dataDirectory),
      godotMcpResourceRoot: path.join(context.moduleRoot, "resources", "godot-mcp"), chatAttachmentWorkerPath: path.join(context.moduleRoot, "runtime", "chat-attachment-worker.cjs") };
  }

  static forContext(context: HubRuntimeContext): HubWorkspaces {
    const key = identity(context.dataDirectory);
    let pool = pools.get(key);
    if (!pool) { pool = new HubWorkspaces(context, key); pools.set(key, pool); }
    return pool;
  }
  addWindow(): number { let slot = 1; while (this.windows.has(slot)) slot++; this.windows.add(slot); return slot; }
  removeWindow(slot: number): void {
    this.windows.delete(slot);
    if (!this.windows.size && !this.entries.size && pools.get(this.key) === this) pools.delete(this.key);
  }
  subscribe(observer: Observer): () => void { this.observers.add(observer); return () => this.observers.delete(observer); }
  changed(channel: string, projectPath?: string): void {
    for (const observer of this.observers) { try { observer.changed(channel, projectPath); } catch { /* Closed windows are disposable observers. */ } }
  }
  serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(action); this.mutations = result.catch(() => undefined); return result;
  }
  pin<T>(lease: HubWorkspaceLease, action: () => Promise<T>): Promise<T> {
    const result = Promise.resolve().then(action); lease.entry.operations.add(result);
    void result.finally(() => lease.entry.operations.delete(result)).catch(() => undefined); return result;
  }

  async acquire(root: string, example = false): Promise<HubWorkspaceLease> {
    const canonical = example ? `example:${randomUUID()}` : root ? await realpath(root) : "";
    const key = canonical ? identity(canonical) : "";
    let entry = this.entries.get(key);
    while (entry?.closing) { await entry.closing; entry = this.entries.get(key); }
    if (!entry) {
      entry = { key, refs: 0, operations: new Set(), ready: undefined! };
      const created = entry;
      this.entries.set(key, created);
      created.ready = this.initialize(canonical, example).then(backend => {
        if (example) {
          this.entries.delete(created.key);
          created.key = identity(backend.controller.currentCore().metadata.path);
          this.entries.set(created.key, created);
        }
        return backend;
      });
      void created.ready.catch(() => { if (this.entries.get(created.key) === created) this.entries.delete(created.key); });
    }
    const owned = entry; owned.refs++;
    let backend: Backend;
    try { backend = await owned.ready; } catch (error) { owned.refs--; throw error; }
    let released = false;
    return { controller: backend.controller, entry: owned, release: () => {
      if (released) return owned.closing ?? Promise.resolve(); released = true;
      if (--owned.refs > 0) return Promise.resolve();
      // Cancellation starts with the final window release, independently of pending sends.
      owned.closing = Promise.resolve().then(async () => {
        const results = await Promise.allSettled([backend.controller.shutdown(), backend.closeMcp(), ...owned.operations]);
        backend.unsubscribe();
        if (this.entries.get(owned.key) === owned) this.entries.delete(owned.key);
        const failed = results.find(result => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      });
      return owned.closing;
    } };
  }

  private async initialize(root: string, example: boolean): Promise<Backend> {
    const controller = new DesktopController(this.vault, this.context.dataDirectory, path.join(this.context.moduleRoot, "skills"), this.providers, this.shared);
    try {
      if (example) await controller.createExample(); else if (root) await controller.openProject(root);
      const mcp = await startMcpServer(() => controller.currentCore()); controller.mcp = { url: mcp.url, token: mcp.token };
      const unsubscribe = controller.sessions.subscribe(event => {
        for (const observer of this.observers) { try { observer.session(event); } catch { /* Other observers still receive this event. */ } }
      });
      return { controller, closeMcp: () => mcp.close(), unsubscribe };
    } catch (error) { await controller.shutdown().catch(() => undefined); throw error; }
  }
}
