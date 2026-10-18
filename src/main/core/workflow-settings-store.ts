import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { WorkflowSettingsSchema, type WorkflowSettings } from "../../shared/orchestration";
import { ProjectError } from "./errors";

/** Fixed project-relative path of the editor-only workflow settings file. */
export const WORKFLOW_SETTINGS_RELATIVE_PATH = ".specloom/editor/workflow-settings.json";

/** What a missing, corrupt, or schema-invalid settings file resolves to. */
export function emptyWorkflowSettings(): WorkflowSettings {
  return { schemaVersion: 1 };
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function formatIssues(error: { issues: { path: PropertyKey[]; message: string }[] }): string[] {
  return error.issues.map((issue) => {
    const at = issue.path.length > 0 ? issue.path.map((part) => String(part)).join(".") : "(root)";
    return at + ": " + issue.message;
  });
}

/**
 * Project-level workflow defaults stored in one fixed JSON sidecar.
 *
 * The path is fixed, so no renderer-supplied path can escape the project. The
 * file is editor state: a missing, corrupt, or schema-invalid file reads as
 * empty settings instead of making the project unreadable, and writes are
 * atomic (temp + rename) so a crash cannot leave a half-written file.
 */
export class WorkflowSettingsStore {
  private readonly file: string;

  constructor(root: string) {
    this.file = path.join(path.resolve(root), ...WORKFLOW_SETTINGS_RELATIVE_PATH.split("/"));
  }

  async read(): Promise<WorkflowSettings> {
    let content: string;
    try {
      content = await readFile(this.file, "utf8");
    } catch (error) {
      if (isMissing(error)) return emptyWorkflowSettings();
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content) as unknown;
    } catch {
      return emptyWorkflowSettings();
    }

    const result = WorkflowSettingsSchema.safeParse(parsed);
    return result.success ? result.data : emptyWorkflowSettings();
  }

  /** Validate, then atomically replace the sidecar. Rejects with ProjectError. */
  async save(settings: WorkflowSettings): Promise<WorkflowSettings> {
    const result = WorkflowSettingsSchema.safeParse(settings);
    if (!result.success) {
      const issues = formatIssues(result.error);
      throw new ProjectError(
        "VALIDATION_FAILED",
        "Invalid workflow settings: " + issues.join("; "),
        { path: WORKFLOW_SETTINGS_RELATIVE_PATH, issues },
      );
    }

    const normalized = result.data;
    const directory = path.dirname(this.file);
    const temporary = this.file + ".tmp-" + randomUUID();
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(temporary, JSON.stringify(normalized, null, 2) + "\n", "utf8");
      await rename(temporary, this.file);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw new ProjectError(
        "INTERNAL_ERROR",
        "无法保存工作流默认设置",
        { path: WORKFLOW_SETTINGS_RELATIVE_PATH },
        { cause: error },
      );
    }
    return normalized;
  }

  /** Remove the project override, restoring the global (official) default. */
  clearDefault(): Promise<WorkflowSettings> {
    return this.save(emptyWorkflowSettings());
  }
}
