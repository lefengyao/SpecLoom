import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { WorkflowValidationError, validateWorkflowDefinition, type WorkflowDefinition } from "../../shared/workflow";

/** The one official workflow shipped with the app. */
export const OFFICIAL_WORKFLOW_FILE = "official-development-review.yaml";

/** Resource path of the official workflow relative to an application root. */
export const OFFICIAL_WORKFLOW_RESOURCE = path.join("resources", "workflows", OFFICIAL_WORKFLOW_FILE);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolve the official workflow resource.
 *
 * Order:
 * 1. an explicit root, used by tests (it is authoritative, even when the file is missing);
 * 2. SPECLOOM_DEV_APP_ROOT, when it holds the source-tree resource;
 * 3. process.resourcesPath, for packaged apps (extraResources layout);
 * 4. process.cwd(), for the source tree and tests.
 *
 * The canonical location is <root>/resources/workflows/official-development-review.yaml.
 * electron-builder copies resources/workflows to <resourcesPath>/workflows, so that
 * packaged layout is accepted as well.
 */
export function resolveOfficialWorkflowResource(root?: string): string {
  if (root !== undefined) return path.resolve(root, OFFICIAL_WORKFLOW_RESOURCE);

  const candidates: string[] = [];
  const developmentRoot = process.env.SPECLOOM_DEV_APP_ROOT;
  if (typeof developmentRoot === "string" && developmentRoot.length > 0) {
    candidates.push(path.resolve(developmentRoot, OFFICIAL_WORKFLOW_RESOURCE));
  }
  const resourcesPath: unknown = Reflect.get(process, "resourcesPath");
  if (typeof resourcesPath === "string" && resourcesPath.length > 0) {
    candidates.push(path.join(resourcesPath, OFFICIAL_WORKFLOW_RESOURCE));
    candidates.push(path.join(resourcesPath, "workflows", OFFICIAL_WORKFLOW_FILE));
  }

  const bundled = candidates.find((candidate) => existsSync(candidate));
  return bundled ?? path.resolve(process.cwd(), OFFICIAL_WORKFLOW_RESOURCE);
}

/**
 * Load and validate the official workflow definition.
 *
 * Read and YAML parse failures are wrapped in WorkflowValidationError with the
 * same message as its single issue, so callers only ever have to handle the
 * single readable validation contract and the issues invariant matches B rules.
 */
export async function loadOfficialWorkflow(root?: string): Promise<WorkflowDefinition> {
  const resource = resolveOfficialWorkflowResource(root);

  let source: string;
  try {
    source = await readFile(resource, "utf8");
  } catch (error) {
    const message = "official workflow resource is missing or unreadable: " + resource + " (" + errorMessage(error) + ")";
    throw new WorkflowValidationError(message, [message]);
  }

  let parsed: unknown;
  try {
    parsed = parse(source);
  } catch (error) {
    const message = "official workflow resource is not valid YAML: " + resource + " (" + errorMessage(error) + ")";
    throw new WorkflowValidationError(message, [message]);
  }

  return validateWorkflowDefinition(parsed);
}
