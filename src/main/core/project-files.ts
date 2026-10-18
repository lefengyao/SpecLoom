import type { ProjectTextFile } from "../../shared/project-files";
import type { FileStore } from "./file-store";

/** One bounded descriptor read; ordinary previews never enumerate/hash the project first. */
export function readProjectText(store: FileStore, relative: string): Promise<ProjectTextFile> {
  return store.readCurrentText(relative);
}
