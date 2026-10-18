import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { loadOfficialWorkflow } from "../../src/main/core/workflow-official";
import { WorkflowValidationError } from "../../src/shared/workflow";

const RESOURCE_RELATIVE = path.join("resources", "workflows", "official-development-review.yaml");
/** Title of the shipped resource; the staged copy must differ from it. */
const REAL_TITLE = "官方开发审查";
/** Marker title of the staged copy, so a cwd fallback cannot pass the branch tests. */
const STAGED_TITLE = "临时副本";
const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "specloom-official-workflow-"));
  temporaryRoots.push(root);
  return root;
}

/**
 * Stage a valid copy of the real resource under a temporary root, with a distinct title.
 *
 * The copy is byte-different from the real resource on purpose: if a resolution
 * branch were dropped, the loader would fall back to cwd and return REAL_TITLE,
 * so asserting STAGED_TITLE is what makes the branch tests discriminating.
 */
async function stageOfficialResource(root: string, relative = RESOURCE_RELATIVE): Promise<string> {
  const source = await readFile(path.join(process.cwd(), RESOURCE_RELATIVE), "utf8");
  const variant = source.replace("title: " + REAL_TITLE, "title: " + STAGED_TITLE);
  if (variant.includes("title: " + REAL_TITLE) || !variant.includes("title: " + STAGED_TITLE)) {
    throw new Error("staged official workflow copy did not receive the marker title");
  }
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, variant);
  return target;
}

/** Load through a root expected to fail and return the typed validation error. */
async function loadFailure(root: string): Promise<WorkflowValidationError> {
  try {
    await loadOfficialWorkflow(root);
  } catch (error) {
    if (error instanceof WorkflowValidationError) return error;
    throw error;
  }
  throw new Error("expected loadOfficialWorkflow to reject");
}

afterAll(async () => {
  for (const root of temporaryRoots) {
    const safe = path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith("specloom-official-workflow-");
    if (!safe) continue;
    await rm(root, { recursive: true, force: true });
  }
});

describe("official workflow", () => {
  test("loads the six-node development review from the real resource", async () => {
    const workflow = await loadOfficialWorkflow();
    expect(workflow.id).toBe("wf_official_development_review");
    expect(workflow.nodes.map((node) => node.type)).toEqual(["context", "agent", "agent", "validation", "approval", "decision"]);
    expect(workflow.nodes.filter((node) => node.type === "agent" && node.config.access === "write")).toHaveLength(1);
  });

  test("declares the documented inputs, agents, reject edge and attempt budget", async () => {
    const workflow = await loadOfficialWorkflow();

    expect(workflow.inputs.map(({ key, type, required }) => ({ key, type, required }))).toEqual([
      { key: "goal", type: "string", required: true },
      { key: "readPaths", type: "paths", required: true },
      { key: "writePaths", type: "paths", required: true },
      { key: "model", type: "model", required: false },
    ]);

    const agents = workflow.nodes.flatMap((node) => (node.type === "agent" ? [node] : []));
    expect(agents.map((agent) => agent.config.access)).toEqual(["read", "write"]);
    expect(agents.every((agent) => agent.config.prompt.trim().length > 0)).toBe(true);

    expect(workflow.edges).toContainEqual({ id: "e6", from: "review", to: "implement", on: "reject" });
    expect(workflow.edges.filter((edge) => edge.on === "reject")).toHaveLength(1);
    expect(workflow.settings.maxImplementAttempts).toBe(3);
  });

  test("reports a readable error when the official resource is missing", async () => {
    const root = await temporaryRoot();
    const error = await loadFailure(root);

    expect(error).toBeInstanceOf(WorkflowValidationError);
    expect(error.name).toBe("WorkflowValidationError");
    expect(error.message).toContain("official workflow resource");
    expect(error.message).toContain(RESOURCE_RELATIVE);
    expect(error.issues).toEqual([error.message]);
  });

  test("wraps malformed YAML in WorkflowValidationError", async () => {
    const root = await temporaryRoot();
    const target = path.join(root, RESOURCE_RELATIVE);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "schemaVersion: 1\nnodes: [unclosed\n");

    const error = await loadFailure(root);
    expect(error).toBeInstanceOf(WorkflowValidationError);
    expect(error.name).toBe("WorkflowValidationError");
    expect(error.message).toContain("not valid YAML");
    expect(error.message).toContain(RESOURCE_RELATIVE);
    expect(error.issues).toEqual([error.message]);
  });

  test("finds the resource through SPECLOOM_DEV_APP_ROOT without an explicit root", async () => {
    const root = await temporaryRoot();
    await stageOfficialResource(root);
    const previous = process.env.SPECLOOM_DEV_APP_ROOT;
    process.env.SPECLOOM_DEV_APP_ROOT = root;
    try {
      const workflow = await loadOfficialWorkflow();
      expect(workflow.title).toBe(STAGED_TITLE);
      expect(workflow.id).toBe("wf_official_development_review");
    } finally {
      if (previous === undefined) delete process.env.SPECLOOM_DEV_APP_ROOT;
      else process.env.SPECLOOM_DEV_APP_ROOT = previous;
    }
  });

  test("finds the packaged extraResources layout under process.resourcesPath", async () => {
    const root = await temporaryRoot();
    await stageOfficialResource(root, path.join("workflows", "official-development-review.yaml"));
    const previousDevRoot = process.env.SPECLOOM_DEV_APP_ROOT;
    const previousResourcesPath = Object.getOwnPropertyDescriptor(process, "resourcesPath");
    delete process.env.SPECLOOM_DEV_APP_ROOT;
    Object.defineProperty(process, "resourcesPath", { value: root, configurable: true });
    try {
      const workflow = await loadOfficialWorkflow();
      expect(workflow.title).toBe(STAGED_TITLE);
      expect(workflow.id).toBe("wf_official_development_review");
    } finally {
      if (previousDevRoot === undefined) delete process.env.SPECLOOM_DEV_APP_ROOT;
      else process.env.SPECLOOM_DEV_APP_ROOT = previousDevRoot;
      if (previousResourcesPath) Object.defineProperty(process, "resourcesPath", previousResourcesPath);
      else Reflect.deleteProperty(process, "resourcesPath");
    }
  });
});
