import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { VersionToken } from "../../src/shared/contracts";
import { FileStore } from "../../src/main/core/file-store";
import { ProjectError } from "../../src/main/core/errors";
import {
  MAX_ORCHESTRATION_ID_LENGTH,
  ORCHESTRATION_DIRECTORY,
  OrchestrationStore,
  stringifyOrchestration,
} from "../../src/main/core/orchestration-store";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), "specloom-orchestrations-"));
  roots.push(value);
  return value;
}

async function project(): Promise<OrchestrationStore> {
  return new OrchestrationStore(new FileStore(await root()));
}

/** Three-step linear orchestration exercising every approval value. */
function validYaml(id = "orch_release", title = "Release"): string {
  return [
    "schemaVersion: 1",
    "id: " + id,
    "title: " + title,
    "description: release checks",
    "steps:",
    "  - id: s1",
    "    workflowId: wf_official_development_review",
    "    approval: inherit",
    "  - id: s2",
    "    workflowId: wf_custom_release",
    "    approval: always",
    "  - id: s3",
    "    workflowId: wf_custom_notes",
    "    approval: auto",
  ].join("\n");
}

async function failureOf(run: () => Promise<unknown>): Promise<ProjectError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ProjectError) return error;
    throw error;
  }
  throw new Error("expected the call to reject with a ProjectError");
}

describe("orchestration store", () => {
  test("round trips a saved orchestration through save, read and a summary", async () => {
    const dir = await root();
    const store = new OrchestrationStore(new FileStore(dir));
    const source = validYaml();

    const saved = await store.save("orch_release", source, "absent");
    expect(saved.fileVersion).not.toBe("absent");
    expect(ORCHESTRATION_DIRECTORY).toBe("specs/orchestrations");
    expect(await readFile(path.join(dir, "specs", "orchestrations", "orch_release.yaml"), "utf8")).toBe(source);

    const read = await store.read("orch_release");
    expect(read.definition.id).toBe("orch_release");
    expect(read.definition.title).toBe("Release");
    expect(read.definition.steps.map((step) => step.id)).toEqual(["s1", "s2", "s3"]);
    expect(read.definition.steps.map((step) => step.workflowId)).toEqual([
      "wf_official_development_review",
      "wf_custom_release",
      "wf_custom_notes",
    ]);
    expect(read.definition.steps.map((step) => step.approval)).toEqual(["inherit", "always", "auto"]);
    expect(read.fileVersion).toBe(saved.fileVersion);
    expect(read.source).toBe(source);

    expect(await store.list()).toEqual([
      { id: "orch_release", title: "Release", stepCount: 3, fileVersion: saved.fileVersion },
    ]);
  });

  test("lists only direct yaml orchestration files in path order", async () => {
    const dir = await root();
    const store = new OrchestrationStore(new FileStore(dir));
    const files = new FileStore(dir);
    await store.save("orch_b", validYaml("orch_b", "Second"), "absent");
    await store.save("orch_a", validYaml("orch_a", "First"), "absent");
    await files.write(ORCHESTRATION_DIRECTORY + "/notes.txt", "ignored", "absent");
    await files.write(ORCHESTRATION_DIRECTORY + "/orch_c.yml", validYaml("orch_c", "Yml"), "absent");
    await files.write(ORCHESTRATION_DIRECTORY + "/archive/orch_nested.yaml", validYaml("orch_nested", "Nested"), "absent");

    expect((await store.list()).map((item) => item.id)).toEqual(["orch_a", "orch_b"]);
  });

  test("rejects invalid YAML, invalid definitions and duplicate step ids with VALIDATION_FAILED and a path", async () => {
    const store = await project();
    const pathOf = (id: string): string => ORCHESTRATION_DIRECTORY + "/" + id + ".yaml";

    const broken = await failureOf(() => store.save("orch_broken", "schemaVersion: 1\nsteps: [unclosed\n", "absent"));
    expect(broken.code).toBe("VALIDATION_FAILED");
    expect(broken.message).toContain("specs/orchestrations/orch_broken.yaml");
    expect(broken.details).toMatchObject({ path: pathOf("orch_broken") });

    const emptySteps = ["schemaVersion: 1", "id: orch_empty", "title: Empty", "steps: []"].join("\n");
    const empty = await failureOf(() => store.save("orch_empty", emptySteps, "absent"));
    expect(empty.code).toBe("VALIDATION_FAILED");
    expect(empty.message).toContain("at least one step");
    expect(empty.details).toMatchObject({ path: pathOf("orch_empty") });

    const duplicateSource = validYaml("orch_duplicate").replace("  - id: s3", "  - id: s1");
    const duplicate = await failureOf(() => store.save("orch_duplicate", duplicateSource, "absent"));
    expect(duplicate.code).toBe("VALIDATION_FAILED");
    expect(duplicate.message).toContain("duplicate step id: s1");
    expect(duplicate.message).toContain("steps.2.id");
    expect(duplicate.details).toMatchObject({ path: pathOf("orch_duplicate") });

    expect(await store.list()).toEqual([]);
    await expect(store.read("orch_broken")).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
  });

  test("rejects a definition whose declared id does not match the file name", async () => {
    const dir = await root();
    const store = new OrchestrationStore(new FileStore(dir));

    const mismatch = await failureOf(() => store.save("orch_release", validYaml("orch_other"), "absent"));
    expect(mismatch.code).toBe("VALIDATION_FAILED");
    expect(mismatch.message).toContain('declares id "orch_other" instead of "orch_release"');
    expect(mismatch.details).toMatchObject({ path: "specs/orchestrations/orch_release.yaml" });
    expect(await store.list()).toEqual([]);

    await new FileStore(dir).write("specs/orchestrations/orch_misnamed.yaml", validYaml("orch_other"), "absent");
    const readFailure = await failureOf(() => store.read("orch_misnamed"));
    expect(readFailure.code).toBe("VALIDATION_FAILED");
    expect(readFailure.details).toMatchObject({ path: "specs/orchestrations/orch_misnamed.yaml" });
  });

  test("fails list fast with details.path and a fileVersion that can remove the invalid file", async () => {
    const dir = await root();
    const store = new OrchestrationStore(new FileStore(dir));
    await store.save("orch_good", validYaml("orch_good", "Good"), "absent");
    await new FileStore(dir).write("specs/orchestrations/orch_broken.yaml", "schemaVersion: 1\nsteps: [unclosed\n", "absent");

    const failure = await failureOf(() => store.list());
    expect(failure.code).toBe("VALIDATION_FAILED");
    expect(failure.message).toContain("specs/orchestrations/orch_broken.yaml");
    expect(failure.details).toMatchObject({ path: "specs/orchestrations/orch_broken.yaml" });
    const version = failure.details?.fileVersion;
    expect(version).toMatch(/^sha256:[a-f0-9]{64}$/);

    await store.remove("orch_broken", version as VersionToken);
    expect((await store.list()).map((item) => item.id)).toEqual(["orch_good"]);
  });

  test("rejects a file whose name is not a valid orchestration id", async () => {
    const dir = await root();
    const store = new OrchestrationStore(new FileStore(dir));
    await new FileStore(dir).write("specs/orchestrations/ORCH_UPPER.yaml", validYaml("ORCH_UPPER"), "absent");

    const failure = await failureOf(() => store.list());
    expect(failure.code).toBe("VALIDATION_FAILED");
    expect(failure.details).toMatchObject({ path: "specs/orchestrations/ORCH_UPPER.yaml" });
  });

  test("rejects stale version tokens with VERSION_CONFLICT and keeps the stored definition", async () => {
    const store = await project();
    const first = await store.save("orch_release", validYaml("orch_release", "First"), "absent");

    await expect(
      store.save("orch_release", validYaml("orch_release", "Stale"), "sha256:" + "0".repeat(64)),
    ).rejects.toMatchObject({ name: "ProjectError", code: "VERSION_CONFLICT" });
    await expect(store.save("orch_release", validYaml("orch_release", "Absent"), "absent")).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
    });

    const current = await store.read("orch_release");
    expect(current.definition.title).toBe("First");
    expect(current.fileVersion).toBe(first.fileVersion);
  });

  test("requires the current version token to remove an orchestration", async () => {
    const store = await project();
    const first = await store.save("orch_release", validYaml("orch_release", "First"), "absent");
    const second = await store.save("orch_release", validYaml("orch_release", "Second"), first.fileVersion);
    expect(second.fileVersion).not.toBe(first.fileVersion);

    await expect(store.remove("orch_release", first.fileVersion)).rejects.toMatchObject({
      name: "ProjectError",
      code: "VERSION_CONFLICT",
    });
    expect((await store.read("orch_release")).definition.title).toBe("Second");

    await store.remove("orch_release", second.fileVersion);
    expect(await store.list()).toEqual([]);
    await expect(store.read("orch_release")).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
  });

  test("rejects traversal, uppercase, extension and leading-digit ids before touching the project", async () => {
    const store = await project();
    const invalidIds = [
      "../escape",
      "ORCH_RELEASE",
      "orch.release",
      "orch-release",
      "orch_release.yaml",
      "specs/orchestrations/orch",
      "1orch",
      "orch/../../escape",
    ];

    for (const id of invalidIds) {
      await expect(store.read(id)).rejects.toMatchObject({ name: "ProjectError", code: "VALIDATION_FAILED" });
      await expect(store.save(id, validYaml(), "absent")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      await expect(store.remove(id, "absent")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }

    const rejected = await failureOf(() => store.save("../escape", validYaml(), "absent"));
    expect(rejected.details).toMatchObject({ path: "specs/orchestrations/../escape.yaml" });
    expect(await store.list()).toEqual([]);
  });

  test("rejects a 121-character id with VALIDATION_FAILED instead of a filesystem error", async () => {
    const store = await project();
    const tooLong = "a".repeat(MAX_ORCHESTRATION_ID_LENGTH + 1);
    expect(tooLong).toHaveLength(121);

    await expect(store.read(tooLong)).rejects.toMatchObject({ name: "ProjectError", code: "VALIDATION_FAILED" });
    await expect(store.save(tooLong, validYaml(), "absent")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(store.remove(tooLong, "absent")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    expect(await store.list()).toEqual([]);
  });

  test("serializes a definition to canonical yaml that the store accepts", async () => {
    const store = await project();
    const content = stringifyOrchestration({
      schemaVersion: 1,
      id: "orch_generated",
      title: "Generated",
      description: "",
      steps: [
        { id: "s1", workflowId: "wf_official_development_review", approval: "inherit" },
        { id: "s2", workflowId: "wf_custom_release", approval: "always" },
      ],
    });

    const saved = await store.save("orch_generated", content, "absent");
    const read = await store.read("orch_generated");
    expect(read.definition.steps).toHaveLength(2);
    expect(read.definition.steps[1]).toMatchObject({ id: "s2", workflowId: "wf_custom_release", approval: "always" });
    expect(read.fileVersion).toBe(saved.fileVersion);
    expect(read.source).toBe(content);
    expect(await store.list()).toEqual([
      { id: "orch_generated", title: "Generated", stepCount: 2, fileVersion: saved.fileVersion },
    ]);
  });
});
