import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { ENTITY_LAYOUT_RELATIVE_PATH, validateEntityLayout, type EntityLayout } from "../../shared/entity-layout";
import { ProjectError } from "./errors";

/**
 * Editor-only layout sidecar. The path is fixed, so no renderer-supplied path
 * can escape the project. Writes are atomic (temp + rename).
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
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
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
    const directory = path.dirname(this.file);
    await mkdir(directory, { recursive: true });
    const temporary = this.file + ".tmp-" + randomUUID();
    try {
      await writeFile(temporary, JSON.stringify(normalized, null, 2) + "\n", "utf8");
      await rename(temporary, this.file);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw new ProjectError("INTERNAL_ERROR", "无法保存实体工作台布局", { path: ENTITY_LAYOUT_RELATIVE_PATH }, { cause: error });
    }
    return normalized;
  }
}
