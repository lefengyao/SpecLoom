import path from "node:path";
import { FileStore } from "../file-store";
import { ProjectError } from "../errors";
import { normalizeProjectPath } from "../path-policy";
import { WorkFiles } from "./files";
import { isOutsideProject } from "./approval-policy";

/** Uses ordinary guarded file stores without expanding the project store's scope. */
export class ExternalFiles {
  private readonly volumes = new Map<string, WorkFiles>();
  constructor(private readonly local: WorkFiles) {}

  private route(input: string): { files: WorkFiles; relative: string; outputPath?: string } {
    if (!path.isAbsolute(input)) return { files: this.local, relative: input };
    const absolute = path.resolve(input);
    if (!isOutsideProject(this.local.store.root, absolute)) return { files: this.local, relative: normalizeProjectPath(path.relative(this.local.store.root, absolute)) };
    const volume = path.parse(absolute).root;
    const relative = normalizeProjectPath(path.relative(volume, absolute));
    const segments = relative.replaceAll("\\", "/").toLowerCase().split("/");
    const runtimeIndex = segments.indexOf(".specloom");
    if (runtimeIndex >= 0 && segments[runtimeIndex + 1] !== "skills") throw new ProjectError("TASK_SCOPE_DENIED", "SpecLoom 运行时数据不能通过文件工具访问");
    let files = this.volumes.get(volume);
    if (!files) { files = new WorkFiles(new FileStore(volume, { maxTextBytes: this.local.store.maxTextBytes }), false); this.volumes.set(volume, files); }
    return { files, relative, outputPath: absolute };
  }

  private output(result: unknown, outputPath?: string): unknown {
    return outputPath && result && typeof result === "object" ? { ...result, path: outputPath } : result;
  }
  async read(input: Parameters<WorkFiles["read"]>[0]): Promise<unknown> {
    const route = this.route(input.path);
    return this.output(await route.files.read({ ...input, path: route.relative }), route.outputPath);
  }
  async write(input: string, content: string): Promise<unknown> {
    const route = this.route(input);
    return this.output(await route.files.write(route.relative, content), route.outputPath);
  }
  async edit(input: Parameters<WorkFiles["edit"]>[0]): Promise<unknown> {
    const route = this.route(input.path);
    return this.output(await route.files.edit({ ...input, path: route.relative }), route.outputPath);
  }
}
