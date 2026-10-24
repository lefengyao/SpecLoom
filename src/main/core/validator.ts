import type { ChangeEntry, SkillSource, ValidationCheck, ValidationDiagnostic, ValidationResult, VersionToken } from "../../shared/contracts";
import { FileStore } from "./file-store";
import { ProjectError } from "./errors";
import { TaskScope } from "./task-scope";
import { GODOT_IMAGE } from "./snapshot-runner";
import { runLocalGodot } from "./local-godot";
import type { ProcessExecutor } from "./docker-process";
import { godotDiagnostics } from "./validator-godot";
import { diagnostic, nonempty, parseSpec, projectBudgets, validateFields, validationPathIdentity, type ParsedSpec } from "./validator-markdown";
import { validateReferences } from "./validator-references";
import { ValidationSource } from "./validator-source";

export const GODOT_VALIDATION_IMAGE = GODOT_IMAGE;

export interface ValidatorSnapshotSession {
  runContainer(request: { image: string; entrypoint: string; args: string[]; timeoutMs?: number; signal?: AbortSignal; readOnlyWorkspace?: boolean }): Promise<{ stdout: string; stderr: string; exitCode: number; durationMs: number; command: string[] }>;
  /** Runs the same command with a locally installed Godot instead of Docker. */
  runLocalGodot?(request: { executable: string; args: string[]; timeoutMs?: number; signal?: AbortSignal }): Promise<{ stdout: string; stderr: string; exitCode: number; durationMs: number; command: string[] }>;
  dependencies(): Record<string, VersionToken>;
  dispose(): Promise<void>;
}
export interface ValidatorSnapshotRunner {
  create(scope: TaskScope, options?: { overlay?: ChangeEntry[]; extraReadPaths?: string[] }): Promise<ValidatorSnapshotSession>;
}
export interface ValidationOptions {
  taskId?: string;
  scope?: TaskScope;
  overlay?: ChangeEntry[];
  smokeScene?: string;
  signal?: AbortSignal;
  runGodot?: boolean;
  /** Direct-to-disk changes have no overlay; their paths still decide whether Godot can be skipped. */
  changedPaths?: string[];
  /** Manual material saves need specification references, without scanning generated/source directories. */
  specificationsOnly?: boolean;
}
export interface ValidationWithDependencies {
  result: ValidationResult;
  dependencies: Record<string, VersionToken>;
  sources: SkillSource[];
  inventory: string[];
}

export class Validator {
  constructor(private readonly store: FileStore, private readonly snapshotRunner?: ValidatorSnapshotRunner, private readonly options: { godotExecutable?: () => string; process?: ProcessExecutor } = {}) {}

  /** Markdown cannot affect Godot's importer, whether staged or written directly. */
  private static documentationOnly(paths: readonly string[]): boolean {
    return paths.length > 0 && paths.every((path) => path.replaceAll("\\", "/").toLowerCase().endsWith(".md"));
  }

  async validate(options: ValidationOptions = {}): Promise<ValidationResult> {
    return (await this.validateWithDependencies(options)).result;
  }

  async validateWithDependencies(options: ValidationOptions = {}): Promise<ValidationWithDependencies> {
    options.signal?.throwIfAborted();
    const startedAt = new Date().toISOString();
    const source = await ValidationSource.create(this.store, options.overlay, options.scope, options.specificationsOnly ? "specs" : undefined);
    const diagnostics: ValidationDiagnostic[] = [];
    const specs: ParsedSpec[] = [];
    const specPaths = source.paths.filter((relative) => {
      const identity = validationPathIdentity(relative);
      return relative.toLowerCase().endsWith(".md") && (
        identity.startsWith("specs/entities/") || identity.startsWith("specs/components/") || identity.startsWith("specs/tasks/")
        || identity.startsWith("specs/settings/") || identity.startsWith("specs/maps/") || identity.startsWith("specs/ui/")
        || identity.startsWith("specs/systems/") || identity.startsWith("specs/features/") || identity.startsWith("specs/decisions/")
        || identity.startsWith("specs/decision_trees/")
        || /^specs\/[^/]+\.md$/i.test(identity)
      );
    });
    for (const required of ["specs/project.md", "specs/outline.md"]) if (!specPaths.some((relative) => validationPathIdentity(relative) === required)) {
      await source.version(required);
      diagnostics.push(diagnostic(required, "SPEC_NOT_FOUND", "Required project specification does not exist"));
    }
    for (const relative of specPaths) {
      options.signal?.throwIfAborted();
      const content = await source.read(relative);
      if (content === undefined) continue;
      // Decision notes written before the decision schema are plain Markdown; leave them alone.
      if (validationPathIdentity(relative).startsWith("specs/decisions/") && !/^\uFEFF?---[ \t]*\r?\n/.test(content)) continue;
      const spec = parseSpec(relative, content, diagnostics);
      if (spec) { validateFields(spec, diagnostics); specs.push(spec); }
    }
    await validateReferences(specs, source, diagnostics);
    const budgets = projectBudgets(specs.find((spec) => validationPathIdentity(spec.path) === "specs/project.md"), diagnostics);
    for (const entry of options.overlay ?? []) {
      if (entry.operation === "delete") continue;
      const relative = this.store.normalizePath(entry.path);
      const content = entry.nextContent!;
      if (relative.toLowerCase().endsWith(".gd")) {
        const lineCount = content === "" ? 0 : content.replace(/\r?\n$/, "").split(/\r?\n/).length;
        if (lineCount > budgets.maxScriptLines) diagnostics.push(diagnostic(relative, "SCRIPT_LINE_BUDGET_EXCEEDED", `Script has ${lineCount} lines; limit is ${budgets.maxScriptLines}`));
      } else if (relative.toLowerCase().endsWith(".tscn")) {
        const nodeCount = content.split(/\r?\n/).filter((line) => /^\s*\[node(?:\s|\])/.test(line)).length;
        if (nodeCount > budgets.maxSceneNodes) diagnostics.push(diagnostic(relative, "SCENE_NODE_BUDGET_EXCEEDED", `Scene has ${nodeCount} nodes; limit is ${budgets.maxSceneNodes}`));
      }
    }
    const checks: ValidationCheck[] = [{ id: "specifications", name: "Specifications and references", status: diagnostics.some((item) => item.severity === "error") ? "fail" : "pass", stdout: "", stderr: "" }];
    const taskSpec = specs.find((spec) => validationPathIdentity(spec.path).startsWith("specs/tasks/") && spec.data.id === options.taskId);
    const changedPaths = options.overlay?.length ? options.overlay.map((entry) => entry.path) : options.changedPaths ?? [];
    const docsOnly = Validator.documentationOnly(changedPaths);
    // A task-spec smoke scene is a project-level check; documentation cannot affect it.
    const requestedSmoke = options.smokeScene ?? (nonempty(taskSpec?.data.smokeScene) ? taskSpec.data.smokeScene : undefined);
    const smoke = options.smokeScene !== undefined ? options.smokeScene : docsOnly ? undefined : requestedSmoke;
    if (options.runGodot === true || (options.runGodot !== false && !docsOnly)) await this.validateGodot(options, source, checks, diagnostics, smoke);
    diagnostics.sort((a, b) => {
      const left = `${a.path ?? ""}:${a.code ?? ""}:${a.message}`;
      const right = `${b.path ?? ""}:${b.code ?? ""}:${b.message}`;
      return left < right ? -1 : left > right ? 1 : 0;
    });
    const status = checks.some((check) => check.status === "fail") || diagnostics.some((item) => item.severity === "error") ? "fail" : checks.some((check) => check.status === "skipped") ? "skipped" : "pass";
    const result: ValidationResult = { ...(options.taskId === undefined ? {} : { taskId: options.taskId }), status, checks, diagnostics, startedAt, finishedAt: new Date().toISOString() };
    const dependencies = Object.fromEntries(Object.entries(source.dependencies).sort(([a], [b]) => a.localeCompare(b)));
    return { result, dependencies, sources: Object.entries(dependencies).map(([path, version]) => ({ path, version })), inventory: source.inventory };
  }

  private async validateGodot(options: ValidationOptions, source: ValidationSource, checks: ValidationCheck[], diagnostics: ValidationDiagnostic[], smoke?: string): Promise<void> {
    let pending = { id: "godot-import", name: "Godot headless import" };
    if (!(await this.store.listVersion("project.godot")).exists) {
      checks.push({ ...pending, status: "skipped", stdout: "", stderr: "Not a Godot project: project.godot is absent" });
      return;
    }
    const localGodot = this.options.godotExecutable?.().trim() ?? "";
    const unavailable = (message = localGodot
      ? "The configured Godot executable is unavailable"
      : "Docker with the pinned Godot image is unavailable") => {
      checks.push({ ...pending, status: "skipped", stdout: "", stderr: message });
      diagnostics.push({ path: "project.godot", code: "GODOT_NOT_FOUND", severity: "warning", message: localGodot
        ? "Configured Godot executable is unavailable"
        : "Godot validation requires either a configured Godot executable or Docker with the pinned image" });
    };
    if (!this.snapshotRunner && !(localGodot && (options.overlay?.length ?? 0) === 0)) { unavailable(); return; }
    const base = options.scope?.describe();
    const scope = new TaskScope({ id: base?.id ?? options.taskId ?? options.overlay?.[0]?.sourceTaskId ?? "validation", title: "Validation snapshot", readPaths: ["*"], writePaths: base?.writePaths ?? (options.overlay ?? []).map((entry) => entry.path), allowDelete: base?.allowDelete ?? (options.overlay ?? []).some((entry) => entry.operation === "delete"), mode: "manual" });
    const direct = localGodot !== "" && (options.overlay?.length ?? 0) === 0;
    let session: ValidatorSnapshotSession | undefined;
    let runDirect: ((args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number; durationMs: number; command: string[] }>) | undefined;
    try {
      if (direct) {
        runDirect = (args) => runLocalGodot(localGodot, args, {
          cwd: this.store.root,
          timeoutMs: 300_000,
          maxOutputBytes: 1024 * 1024,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(this.options.process === undefined ? {} : { process: this.options.process }),
        });
      } else {
        if (!this.snapshotRunner) { unavailable(); return; }
        session = await this.snapshotRunner.create(scope, { ...(options.overlay === undefined ? {} : { overlay: options.overlay }) });
        for (const [relative, version] of Object.entries(session.dependencies())) {
          const existing = source.dependencies[relative];
          if (existing !== undefined && existing !== version) throw new ProjectError("VERSION_CONFLICT", "Project sources changed while validation snapshot was created", { path: relative });
          source.dependencies[relative] = version;
        }
      }
      const localRunner = !direct && localGodot ? session?.runLocalGodot?.bind(session) : undefined;
      const execute = async (id: string, name: string, args: string[]): Promise<boolean> => {
        pending = { id, name };
        const execution = runDirect
          ? await runDirect(args)
          : localRunner
            ? await localRunner({ executable: localGodot, args, timeoutMs: 300_000, ...(options.signal === undefined ? {} : { signal: options.signal }) })
            : await session!.runContainer({ image: GODOT_VALIDATION_IMAGE, entrypoint: "godot", args, timeoutMs: 300_000, readOnlyWorkspace: false, ...(options.signal === undefined ? {} : { signal: options.signal }) });
        const parsed = godotDiagnostics(`${execution.stdout}\n${execution.stderr}`);
        diagnostics.push(...parsed);
        const failed = execution.exitCode !== 0 || parsed.length > 0;
        checks.push({ id, name, status: failed ? "fail" : "pass", ...execution });
        if (execution.exitCode !== 0 && !parsed.length) diagnostics.push(diagnostic("project.godot", "GODOT_COMMAND_FAILED", `${name} exited with code ${execution.exitCode}`));
        return !failed;
      };
      if (!await execute("godot-import", "Godot headless import", ["--headless", "--path", "/workspace", "--editor", "--quit"])) return;
      if (smoke !== undefined) {
        let relative: string;
        try { relative = this.store.normalizePath(smoke.replace(/^res:\/\//, "")); } catch { diagnostics.push(diagnostic("project.godot", "SMOKE_SCENE_INVALID", "Smoke scene must be a safe project path")); return; }
        if (!relative.toLowerCase().endsWith(".tscn") || !await source.exists(relative)) { diagnostics.push(diagnostic(relative, "SMOKE_SCENE_NOT_FOUND", "Smoke scene must reference an existing .tscn file")); return; }
        await execute("godot-smoke", "Godot scene smoke", ["--headless", "--path", "/workspace", "--scene", `res://${relative}`, "--quit-after", "120"]);
      }
    } catch (error) {
      if (error instanceof ProjectError && error.code === "BACKEND_UNAVAILABLE") { unavailable(); return; }
      if (error instanceof ProjectError && error.code === "VERSION_CONFLICT") throw error;
      if (options.signal?.aborted) throw error;
      const details = error instanceof ProjectError ? error.details : undefined;
      checks.push({ ...pending, status: "fail", stdout: typeof details?.stdout === "string" ? details.stdout : "", stderr: typeof details?.stderr === "string" ? details.stderr : error instanceof Error ? error.message : "Godot validation failed", ...(typeof details?.exitCode === "number" ? { exitCode: details.exitCode } : {}), ...(typeof details?.durationMs === "number" ? { durationMs: details.durationMs } : {}) });
      diagnostics.push(diagnostic("project.godot", "GODOT_COMMAND_FAILED", `${pending.name} snapshot command could not complete`));
    } finally { await session?.dispose(); }
  }
}
