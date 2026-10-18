import path from "node:path";
import { parse, stringify } from "yaml";
import type { VersionToken } from "../../shared/contracts";
import { WorkflowValidationError, validateWorkflowDefinition, type WorkflowDefinition } from "../../shared/workflow";
import { ProjectError } from "./errors";
import type { FileStore } from "./file-store";
import { loadOfficialWorkflow, OFFICIAL_WORKFLOW_RESOURCE } from "./workflow-official";

/** Project-relative directory that owns every editable workflow definition. */
export const WORKFLOW_DIRECTORY = "specs/workflows";
/**
 * Workflow ids are file ids: a lowercase letter followed by up to 119 lowercase
 * letters, digits, or underscores, for a hard maximum of 120 characters.
 */
export const WORKFLOW_ID_PATTERN = /^[a-z][a-z0-9_]{0,119}$/;
/** Hard id length cap, matching WORKFLOW_ID_PATTERN and the shared definition schema. */
export const MAX_WORKFLOW_ID_LENGTH = 120;
const WORKFLOW_SUFFIX = ".yaml";

export interface WorkflowSummary {
  id: string;
  title: string;
  nodeCount: number;
  writeCount: number;
  /** Numeric version stored inside the definition document. */
  definitionVersion: number;
  /** Content version token of the YAML file that stores the definition. */
  fileVersion: VersionToken;
}

export interface WorkflowSource {
  definition: WorkflowDefinition;
  /** Content version token of the YAML file, for later save/remove checks. */
  fileVersion: VersionToken;
  source: string;
}

export interface WorkflowSaveResult {
  fileVersion: VersionToken;
}

export interface WorkflowCopyResult {
  id: string;
  fileVersion: VersionToken;
}

/** Loads the bundled official workflow; injectable for tests. */
export type OfficialWorkflowLoader = () => Promise<WorkflowDefinition>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validationError(relative: string, message: string): ProjectError {
  return new ProjectError("VALIDATION_FAILED", "Invalid workflow definition at " + relative + ": " + message, { path: relative });
}

/**
 * App-resource failure. The message and details identify the bundled official
 * workflow, never the target project file the caller asked to create.
 */
function officialResourceError(message: string, cause: unknown): ProjectError {
  return new ProjectError(
    "VALIDATION_FAILED",
    "Official workflow resource " + OFFICIAL_WORKFLOW_RESOURCE + " " + message,
    { resource: OFFICIAL_WORKFLOW_RESOURCE, origin: "official-workflow" },
    { cause },
  );
}

function unreadableWorkflowError(relative: string, error: unknown): ProjectError {
  const code = error instanceof ProjectError ? error.code : "INTERNAL_ERROR";
  const details = error instanceof ProjectError && error.details ? { ...error.details, path: relative } : { path: relative };
  return new ProjectError(code, "Workflow definition at " + relative + " is unreadable: " + messageOf(error), details, { cause: error });
}

function assertWorkflowId(id: string, relative: string): void {
  if (typeof id !== "string" || id.length > MAX_WORKFLOW_ID_LENGTH || !WORKFLOW_ID_PATTERN.test(id)) {
    throw new ProjectError("VALIDATION_FAILED", "Invalid workflow id: " + JSON.stringify(String(id)), { path: relative });
  }
}

/** Resolve the only writable path for an id, rejecting traversal and extensions up front. */
function workflowPath(id: string): string {
  const relative = WORKFLOW_DIRECTORY + "/" + id + WORKFLOW_SUFFIX;
  assertWorkflowId(id, relative);
  return relative;
}

function parseDefinition(source: string, relative: string, expectedId: string): WorkflowDefinition {
  let parsed: unknown;
  try {
    parsed = parse(source, { uniqueKeys: true });
  } catch (error) {
    throw validationError(relative, "not valid YAML: " + messageOf(error));
  }

  let definition: WorkflowDefinition;
  try {
    definition = validateWorkflowDefinition(parsed);
  } catch (error) {
    const message = error instanceof WorkflowValidationError ? error.message : messageOf(error);
    throw validationError(relative, message);
  }

  if (definition.id !== expectedId) {
    throw validationError(relative, "declares id \"" + definition.id + "\" instead of \"" + expectedId + "\"");
  }
  return definition;
}

function countWriteAgents(definition: WorkflowDefinition): number {
  return definition.nodes.filter((node) => node.type === "agent" && node.config.access === "write").length;
}

/**
 * Stores workflow definitions as project YAML under specs/workflows/<id>.yaml.
 *
 * The store owns id/path validation and definition validation; FileStore owns
 * version tokens, locking, and directory creation. No Electron imports belong here.
 */
export class WorkflowStore {
  constructor(
    private readonly files: FileStore,
    private readonly officialLoader: OfficialWorkflowLoader = loadOfficialWorkflow,
  ) {}

  /**
   * Summaries of every direct specs/workflows/*.yaml file, sorted by path.
   *
   * Fail-fast contract: one invalid, unreadable, or misnamed top-level YAML file
   * rejects the entire call with a ProjectError whose details.path names that
   * file (malformed and misnamed definitions use VALIDATION_FAILED). This method
   * never silently skips a bad file, because a partial list would hide a
   * definition the user still needs to fix.
   * When the file was readable but its definition was rejected (malformed
   * content, or a declared id that does not match the file name), the error also
   * carries details.fileVersion, so a caller can delete that file without
   * reading it again: remove(id, details.fileVersion), then list() again.
   * read(id) intentionally validates the definition and rejects the same invalid
   * file, so it cannot be used to inspect it. An unreadable file yields no token.
   */
  async list(): Promise<WorkflowSummary[]> {
    const files = await this.files.listFiles(WORKFLOW_DIRECTORY);
    const summaries: WorkflowSummary[] = [];
    for (const file of files) {
      if (path.posix.dirname(file.path) !== WORKFLOW_DIRECTORY) continue;
      const name = path.posix.basename(file.path);
      if (!name.endsWith(WORKFLOW_SUFFIX)) continue;
      const id = name.slice(0, -WORKFLOW_SUFFIX.length);
      assertWorkflowId(id, file.path);
      let current;
      try {
        current = await this.files.readCurrentText(file.path);
      } catch (error) {
        throw unreadableWorkflowError(file.path, error);
      }
      let definition: WorkflowDefinition;
      try {
        definition = parseDefinition(current.content, file.path, id);
      } catch (error) {
        if (!(error instanceof ProjectError)) throw error;
        // The file was readable, so expose its token: read(id) would re-reject the
        // same invalid definition, leaving remove(id, details.fileVersion) as the
        // only way to recover without a second handle on the file.
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
        nodeCount: definition.nodes.length,
        writeCount: countWriteAgents(definition),
        definitionVersion: definition.version,
        fileVersion: current.version,
      });
    }
    return summaries;
  }

  async read(id: string): Promise<WorkflowSource> {
    const relative = workflowPath(id);
    const current = await this.files.readCurrentText(relative);
    return { definition: parseDefinition(current.content, relative, id), fileVersion: current.version, source: current.content };
  }

  async save(id: string, content: string, expectedVersion: VersionToken): Promise<WorkflowSaveResult> {
    const relative = workflowPath(id);
    parseDefinition(content, relative, id);
    const written = await this.files.write(relative, content, expectedVersion);
    return { fileVersion: written.version };
  }

  /** Remove a definition, requiring the version token the caller edited against. */
  async remove(id: string, expectedVersion: VersionToken): Promise<void> {
    const relative = workflowPath(id);
    await this.files.remove(relative, expectedVersion);
  }

  /** Copy the read-only official workflow under a new project id, preserving its title. */
  async copyOfficial(targetId: string): Promise<WorkflowCopyResult> {
    const relative = workflowPath(targetId);

    let official: WorkflowDefinition;
    try {
      official = await this.officialLoader();
    } catch (error) {
      throw officialResourceError("cannot be loaded: " + messageOf(error), error);
    }

    let definition: WorkflowDefinition;
    try {
      definition = validateWorkflowDefinition({ ...official, id: targetId });
    } catch (error) {
      const message = error instanceof WorkflowValidationError ? error.message : messageOf(error);
      throw officialResourceError("produced an invalid workflow definition for copy: " + message, error);
    }

    const content = stringify(definition, { lineWidth: 0 });
    const written = await this.files.write(relative, content, "absent");
    return { id: targetId, fileVersion: written.version };
  }
}
