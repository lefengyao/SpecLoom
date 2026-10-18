import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RecentProject } from "../../shared/desktop-api";

interface StoredRecentProject {
  path: string;
  name: string;
  openedAt: string;
}

const fileName = "recent-projects.json";
const defaultLimit = 10;

function identity(target: string): string {
  const resolved = path.resolve(target);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Remembers the projects opened from this installation. The list lives in the app
 * user-data directory, never inside a project, so it can never touch project data.
 */
export class RecentProjects {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly directory: string, private readonly limit = defaultLimit) {}

  private get file(): string { return path.join(this.directory, fileName); }

  /** Reads the stored list, tagging entries whose directory disappeared in the meantime. */
  async list(): Promise<RecentProject[]> {
    const stored = await this.read();
    return Promise.all(stored.map(async (entry) => ({ ...entry, exists: await this.isDirectory(entry.path) })));
  }

  /** Moves a project to the front of the list, keeping at most `limit` entries. */
  remember(project: { path: string; name: string }): Promise<void> {
    return this.mutate(async () => {
      const resolved = path.resolve(project.path);
      const key = identity(resolved);
      const stored = (await this.read()).filter((entry) => identity(entry.path) !== key);
      stored.unshift({ path: resolved, name: project.name, openedAt: new Date().toISOString() });
      await this.write(stored.slice(0, this.limit));
    });
  }

  forget(target: string): Promise<void> {
    return this.mutate(async () => {
      const key = identity(target);
      await this.write((await this.read()).filter((entry) => identity(entry.path) !== key));
    });
  }

  private mutate(operation: () => Promise<void>): Promise<void> {
    const run = this.queue.then(operation);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async isDirectory(target: string): Promise<boolean> {
    try { return (await stat(target)).isDirectory(); } catch { return false; }
  }

  private async read(): Promise<StoredRecentProject[]> {
    let raw: string;
    try { raw = await readFile(this.file, "utf8"); } catch { return []; }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((entry): entry is StoredRecentProject => {
        const candidate = entry as Partial<StoredRecentProject> | null;
        return !!candidate && typeof candidate.path === "string" && candidate.path.length > 0 && typeof candidate.name === "string" && typeof candidate.openedAt === "string";
      }).slice(0, this.limit);
    } catch { return []; }
  }

  private async write(entries: StoredRecentProject[]): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
    await rename(temporary, this.file);
  }
}
