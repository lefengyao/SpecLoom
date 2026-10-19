import path from "node:path";
import { parse, stringify } from "yaml";
import { ZodError } from "zod";
import type { VersionToken } from "../../shared/contracts";
import {
  ORCHESTRATION_ID_PATTERN,
  OrchestrationDefinitionSchema,
  type OrchestrationDefinition,
} from "../../shared/orchestration";
import { ProjectError } from "./errors";
import type { FileStore } from "./file-store";

/** Project-relative directory that owns every editable orchestration definition. */
export const ORCHESTRATION_DIRECTORY = "specs/orchestrations";
/** Hard id length cap, matching ORCHESTRATION_ID_PATTERN and the shared definition schema. */
export const MAX_ORCHESTRATION_ID_LENGTH = 120;
const ORCHESTRATION_SUFFIX = ".yaml";

export interface OrchestrationSummary {
  id: string;
  title: string;
  stepCount: number;
  /** Content version token of the YAML file that stores the definition. */
  fileVersion: VersionToken;
}

export interface OrchestrationSource {
  definition: OrchestrationDefinition;
  /** Content version token of the YAML file, for later save/remove checks. */
  fileVersion: VersionToken;
  source: string;
}

export interface OrchestrationSaveResult {
  fileVersion: VersionToken;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validationError(relative: string, message: string): ProjectError {
  return new ProjectError(
    "VALIDATION_FAILED",
    "Invalid orchestration definition at " + relative + ": " + message,
    { path: relative },
  );
}

function unreadableOrchestrationError(relative: string, error: unknown): ProjectError {
  const code = error instanceof ProjectError ? error.code : "INTERNAL_ERROR";
  const details = error instanceof ProjectError && error.details ? { ...error.details, path: relative } : { path: relative };
  return new ProjectError(
    code,
    "Orchestration definition at " + relative + " is unreadable: " + messageOf(error),
    details,
    { cause: error },
  );
}

function formatZodIssues(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const at = issue.path.length > 0 ? issue.path.map((part) => String(part)).join(".") : "(root)";
      return at + ": " + issue.message;
    })
    .join("; ");
}

function assertOrchestrationId(id: string, relative: string): void {
  if (typeof id !== "string" || id.length > MAX_ORCHESTRATION_ID_LENGTH || !ORCHESTRATION_ID_PATTERN.test(id)) {
    throw new ProjectError("VALIDATION_FAILED", "Invalid orchestration id: " + JSON.stringify(String(id)), { path: relative });
  }
}

/** Resolve the only writable path for an id, rejecting traversal and extensions up front. */
function orchestrationPath(id: string): string {
  const relative = ORCHESTRATION_DIRECTORY + "/" + id + ORCHESTRATION_SUFFIX;
  assertOrchestrationId(id, relative);
  return relative;
}

function parseDefinition(source: string, relative: string, expectedId: string): OrchestrationDefinition {
  let parsed: unknown;
  try {
    parsed = parse(source, { uniqueKeys: true });
  } catch (error) {
    throw validationError(relative, "not valid YAML: " + messageOf(error));
  }

  let definition: OrchestrationDefinition;
  try {
    definition = OrchestrationDefinitionSchema.parse(parsed);
  } catch (error) {
    throw validationError(relative, error instanceof ZodError ? formatZodIssues(error) : messageOf(error));
  }

  if (definition.id !== expectedId) {
    throw validationError(relative, "declares id \"" + definition.id + "\" instead of \"" + expectedId + "\"");
  }
  return definition;
}

/**
 * Canonical YAML for a definition built in code, such as a temporary queue the
 * user saves as a project orchestration. The result is validated again by save().
 */
export function stringifyOrchestration(definition: OrchestrationDefinition): string {
  return stringify(OrchestrationDefinitionSchema.parse(definition), { lineWidth: 0 });
}

/**
 * Stores sequential orchestration definitions as project YAML under
 * specs/orchestrations/<id>.yaml.
 *
 * The store owns id/path validation and definition validation; FileStore owns
 * version tokens, locking, and directory creation. Steps only reference
 * workflows by id, so a missing workflow is a run-time error, not a save-time
 * one. No Electron imports belong here.
 */
export class OrchestrationStore {
  constructor(private readonly files: FileStore) {}

  /**
   * Summaries of every direct specs/orchestrations/*.yaml file, sorted by path.
   *
   * Fail-fast contract: one invalid, unreadable, or misnamed top-level YAML file
   * rejects the entire call with a ProjectError whose details.path names that
   * file. A partial list would hide a definition the user still has to fix.
   * When the file was readable but its definition was rejected, the error also
   * carries details.fileVersion, so a caller can remove the bad file without
   * reading it again (read(id) validates and would reject it again).
   */
  async list(): Promise<OrchestrationSummary[]> {
    const files = await this.files.listFiles(ORCHESTRATION_DIRECTORY);
    const summaries: OrchestrationSummary[] = [];
    for (const file of files) {
      if (path.posix.dirname(file.path) !== ORCHESTRATION_DIRECTORY) continue;
      const name = path.posix.basename(file.path);
      if (!name.endsWith(ORCHESTRATION_SUFFIX)) continue;
      const id = name.slice(0, -ORCHESTRATION_SUFFIX.length);
      assertOrchestrationId(id, file.path);

      let current;
      try {
        current = await this.files.readCurrentText(file.path);
      } catch (error) {
        throw unreadableOrchestrationError(file.path, error);
      }

      let definition: OrchestrationDefinition;
      try {
        definition = parseDefinition(current.content, file.path, id);
      } catch (error) {
        if (!(error instanceof ProjectError)) throw error;
        throw new ProjectError(
          error.code,
          error.message,
          { ...(error.details ?? {}), fileVersion: current.version },
          { cause: error },
        );
      }

      summaries.push({
        id,
        title: definition.title,
        stepCount: definition.steps.length,
        fileVersion: current.version,
      });
    }
    return summaries;
  }

  async read(id: string): Promise<OrchestrationSource> {
    const relative = orchestrationPath(id);
    const current = await this.files.readCurrentText(relative);
    return {
      definition: parseDefinition(current.content, relative, id),
      fileVersion: current.version,
      source: current.content,
    };
  }

  async save(id: string, content: string, expectedVersion: VersionToken): Promise<OrchestrationSaveResult> {
    const relative = orchestrationPath(id);
    parseDefinition(content, relative, id);
    const written = await this.files.write(relative, content, expectedVersion);
    return { fileVersion: written.version };
  }

  /** Remove a definition, requiring the version token the caller edited against. */
  async remove(id: string, expectedVersion: VersionToken): Promise<void> {
    const relative = orchestrationPath(id);
    await this.files.remove(relative, expectedVersion);
  }
}
