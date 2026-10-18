import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  normalizePreferences,
  type Preferences,
} from "../../shared/preferences";

const fileName = "preferences.json";

/**
 * Reads and writes the application preferences. The file lives in the app
 * user-data directory, never inside a project, so it can never touch project data.
 * The value is cached in memory after the first read; a corrupt or hand-edited file
 * degrades to defaults instead of failing.
 */
export class PreferencesStore {
  private cached?: Preferences;
  private pending?: Promise<Preferences>;
  /** Serializes read-modify-write cycles so two rapid updates never lose one. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly directory: string) {}

  private get file(): string {
    return path.join(this.directory, fileName);
  }

  /** Latest loaded or committed values for synchronous consumers such as core prompts. */
  get snapshot(): Preferences { return this.cached ?? normalizePreferences(undefined); }

  async get(): Promise<Preferences> {
    if (this.cached) return this.cached;
    this.pending ??= this.read();
    this.cached = await this.pending;
    return this.cached;
  }

  /** Merges a partial update, normalizes it, and persists the result atomically. */
  async update(patch: Partial<Preferences>): Promise<Preferences> {
    // Chain onto the previous cycle: without this, two updates issued in the same
    // tick both read the pre-update value and the later write silently drops the
    // earlier patch (a lost update the user would see as a setting not sticking).
    const run = this.queue.then(async () => {
      const next = normalizePreferences({ ...(await this.get()), ...patch });
      await this.write(next);
      this.cached = next;
      return next;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async read(): Promise<Preferences> {
    try {
      return normalizePreferences(
        JSON.parse(await readFile(this.file, "utf8")),
      );
    } catch {
      return normalizePreferences(undefined);
    }
  }

  private async write(value: Preferences): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, this.file);
  }
}
