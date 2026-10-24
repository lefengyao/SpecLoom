import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { ENTITY_LAYOUT_RELATIVE_PATH, validateEntityLayout, type EntityLayout } from "../../shared/entity-layout";
import { ProjectError } from "./errors";

/**
 * Saves for one sidecar are serialized across store instances: the renderer can
 * request several saves in a burst, and overlapping renames onto the same file
 * fail intermittently on Windows (EPERM/EBUSY).
 */
const saveQueues = new Map<string, Promise<void>>();

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** Replace the sidecar, retrying the Windows rename locks that antivirus and indexers cause. */
async function replaceFile(temporary: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temporary, target);
      return;
    } catch (error) {
      const code = errorCode(error);
      const transient = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (!transient || attempt >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 30 * (attempt + 1)));
    }
  }
}

/**
 * Editor-only layout sidecar. The path is fixed, so no renderer-supplied path
 * can escape the project. Writes are atomic (temp + rename) and serialized.
 */
export class EntityLayoutStore {
  private readonly file: string;

  constructor(root: string) {
    this.file = path.join(path.resolve(root), ...ENTITY_LAYOUT_RELATIVE_PATH.split("/"));
  }

  async read(): Promise<EntityLayout> {
    let content: string;
    try {
      content = await readFile(this.file, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return {};
      throw error;
    }
    try {
      return validateEntityLayout(JSON.parse(content) as unknown);
    } catch {
      // The sidecar is editor state: a corrupt file must not make the project
      // unreadable. The next successful drag overwrites it.
      return {};
    }
  }

  async save(layout: EntityLayout): Promise<EntityLayout> {
    const normalized = validateEntityLayout(layout);
    return this.enqueue(async () => {
      const directory = path.dirname(this.file);
      const temporary = this.file + ".tmp-" + randomUUID();
      try {
        await mkdir(directory, { recursive: true });
        await writeFile(temporary, JSON.stringify(normalized, null, 2) + "\n", "utf8");
        await replaceFile(temporary, this.file);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw new ProjectError("INTERNAL_ERROR", `无法保存实体工作台布局（${errorCode(error) ?? "写入失败"}）`, { path: ENTITY_LAYOUT_RELATIVE_PATH }, { cause: error });
      }
      return normalized;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = saveQueues.get(this.file) ?? Promise.resolve();
    // Run whether or not the previous save succeeded; one failure must not wedge the queue.
    const run = previous.then(operation, operation);
    const tail = run.then(() => undefined, () => undefined);
    saveQueues.set(this.file, tail);
    void tail.then(() => { if (saveQueues.get(this.file) === tail) saveQueues.delete(this.file); });
    return run;
  }
}
