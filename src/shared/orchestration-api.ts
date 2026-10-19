import type { VersionToken } from "./contracts";
import type { OrchestrationDefinition, OrchestrationRun } from "./orchestration";

/**
 * Serializable orchestration contracts shared by the main process, the
 * preload bridge, and the renderer.
 *
 * These are structural copies of the types owned by the orchestration store and
 * the orchestration run store. The stores keep their own definitions on
 * purpose: they are the source of truth for the on-disk records, while this
 * module is the only shape that may cross a process boundary. Nothing here may
 * import from the main process.
 */

/** One definition in the project orchestration list. */
export interface OrchestrationSummary {
  id: string;
  title: string;
  stepCount: number;
  /** Content version token of the YAML file that stores the definition. */
  fileVersion: VersionToken;
}

/** A loaded orchestration definition plus the token needed to write it back. */
export interface OrchestrationSource {
  definition: OrchestrationDefinition;
  /** Content version token of the YAML file, for later save/remove checks. */
  fileVersion: VersionToken;
  source: string;
}

export interface OrchestrationSaveResult {
  fileVersion: VersionToken;
}

/** One orchestration transition pushed to the renderer. */
export interface OrchestrationUpdate {
  /** Project root the run belongs to; the renderer compares it to its own. */
  projectPath: string;
  run: OrchestrationRun;
}
