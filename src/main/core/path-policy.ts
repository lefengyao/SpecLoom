import path from "node:path";
import { ProjectError } from "./errors";
import { isReservedProjectPath } from "./project-layout";
import { hasCode, type StoreFileSystem } from "./store-fs";

export function normalizeProjectPath(input: string, internal = false): string {
  const portable = input.replaceAll("\\", "/");
  const segments = portable.split("/");
  if (!portable || portable.startsWith("/") || /[:\0]/.test(portable) || segments.includes("..")
    || segments.some((segment) => /[. ]$/.test(segment) && segment !== ".")
    || segments.some((segment) => /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(segment))) {
    throw new ProjectError("PATH_ESCAPE", "Only relative project paths without traversal or device names are allowed", { path: input });
  }
  const normalized = path.posix.normalize(portable).replace(/\/$/, "");
  if (normalized === ".") throw new ProjectError("PATH_ESCAPE", "A file or directory path is required");
  if (normalized.split("/").some((segment) => [".git", ".godot"].includes(segment.toLowerCase()))
    || (!internal && isReservedProjectPath(normalized))) {
    throw new ProjectError("TASK_SCOPE_DENIED", "This path is reserved for project runtime data", { path: normalized });
  }
  return normalized;
}

export class PathPolicy {
  readonly root: string;
  constructor(root: string, private readonly fs: StoreFileSystem) { this.root = path.resolve(root); }

  async validateRoot(): Promise<string> {
    await this.assertSafe(this.root);
    if (!(await this.fs.lstat(this.root)).isDirectory()) throw new ProjectError("INVALID_PROJECT", "Project root must be a directory");
    return this.fs.realpath(this.root);
  }

  async resolve(relative: string, internal = false): Promise<string> {
    const normalized = normalizeProjectPath(relative, internal);
    await this.validateRoot();
    const target = path.join(this.root, normalized);
    await this.assertSafe(target, true);
    return target;
  }

  async assertSafe(target: string, allowMissing = false): Promise<void> {
    const parsed = path.parse(target);
    let current = parsed.root;
    for (const segment of ["", ...target.slice(parsed.root.length).split(path.sep)]) {
      if (segment) current = path.join(current, segment);
      try {
        const stats = await this.fs.lstat(current);
        if (stats.isSymbolicLink()) throw new ProjectError("PATH_ESCAPE", "Symbolic links and junctions are not allowed", { path: current });
        const resolved = await this.fs.realpath(current);
        const equal = process.platform === "win32" ? resolved.toLowerCase() === current.toLowerCase() : resolved === current;
        if (!equal) throw new ProjectError("PATH_ESCAPE", "Reparse points are not allowed", { path: current });
      } catch (error) {
        if (allowMissing && hasCode(error, "ENOENT")) return;
        if (hasCode(error, "ENOENT")) throw new ProjectError("INVALID_PROJECT", "Project root does not exist");
        throw error;
      }
    }
  }

  async ensureParent(target: string): Promise<void> {
    const relative = path.relative(this.root, path.dirname(target));
    let current = this.root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      await this.assertSafe(current, true);
      try { await this.fs.mkdir(current); } catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
      await this.assertSafe(current);
      if (!(await this.fs.lstat(current)).isDirectory()) throw new ProjectError("INVALID_PROJECT", "A parent path is not a directory");
    }
  }
}
