import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

export type DirectFileOperation = "create" | "update" | "delete";

const ignored = new Set([".git", ".godot", ".specloom", "node_modules", "dist", "release"]);

/** Metadata-only inventory used to report what a direct shell command touched. */
export async function scanProjectFiles(root: string): Promise<Map<string, { size: number; mtimeMs: number }>> {
  const files = new Map<string, { size: number; mtimeMs: number }>();
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      if (ignored.has(entry.name.toLowerCase()) || entry.name.includes(".specloom-tmp-")) continue;
      const relative = path.posix.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { await visit(relative); continue; }
      if (!entry.isFile()) continue;
      const stats = await lstat(path.join(root, relative));
      files.set(relative, { size: stats.size, mtimeMs: stats.mtimeMs });
    }
  };
  await visit("");
  return files;
}

export function diffProjectFiles(
  before: Map<string, { size: number; mtimeMs: number }>,
  after: Map<string, { size: number; mtimeMs: number }>,
): Record<string, DirectFileOperation> {
  const changes: Record<string, DirectFileOperation> = {};
  for (const [file, stats] of after) {
    const previous = before.get(file);
    if (!previous) changes[file] = "create";
    else if (previous.size !== stats.size || previous.mtimeMs !== stats.mtimeMs) changes[file] = "update";
  }
  for (const file of before.keys()) if (!after.has(file)) changes[file] = "delete";
  return changes;
}
