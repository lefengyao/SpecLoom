import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { VersionToken } from "../../src/shared/contracts";
import type { WorkflowDefinition } from "../../src/shared/workflow";
import { FileStore } from "../../src/main/core/file-store";
import { ProjectError } from "../../src/main/core/errors";
import { loadOfficialWorkflow, OFFICIAL_WORKFLOW_RESOURCE } from "../../src/main/core/workflow-official";
import { MAX_WORKFLOW_ID_LENGTH, WORKFLOW_ID_PATTERN, WorkflowStore } from "../../src/main/core/workflow-store";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function root() {
  const value = await mkdtemp(path.join(os.tmpdir(), "specloom-workflows-"));
  roots.push(value);
  return value;
}

/** Six-node B workflow: context -> read agent -> write agent -> validation -> approval -> decision, with one reject edge. */
function validYaml(id = "wf_demo", title = "Demo"): string {
  return [
    "schemaVersion: 1",
    "id: " + id,
    "title: " + title,
    "description: demo",
    "version: 1",
    "inputs: []",
    "nodes:",
    "  - { id: context, type: context, label: Read, position: { x: 0, y: 0 }, config: {} }",
    "  - { id: plan, type: agent, label: Plan, position: { x: 1, y: 0 }, config: { access: read, prompt: Plan } }",
    "  - { id: write, type: agent, label: Write, position: { x: 2, y: 0 }, config: { access: write, prompt: Write } }",
    "  - { id: validate, type: validation, label: Validate, position: { x: 3, y: 0 }, config: {} }",
    "  - { id: review, type: approval, label: Review, position: { x: 4, y: 0 }, config: {} }",
    "  - { id: decide, type: decision, label: Decide, position: { x: 5, y: 0 }, config: { directory: specs/decisions } }",
    "edges:",
    "  - { id: e1, from: context, to: plan, on: success }",
    "  - { id: e2, from: plan, to: write, on: success }",
    "  - { id: e3, from: write, to: validate, on: success }",
    "  - { id: e4, from: validate, to: review, on: success }",
    "  - { id: e5, from: review, to: decide, on: success }",
    "  - { id: e6, from: review, to: write, on: reject }",
    "settings: { maxImplementAttempts: 3 }",
  ].join("\n");
}

async function project(): Promise<WorkflowStore> {
  return new WorkflowStore(new FileStore(await root()));
}

describe("workflow store", () => {
  test("lists, saves with version checks, reads, and removes project workflows", async () => {
    const dir = await root();
    const store = new WorkflowStore(new FileStore(dir));
    await store.save("wf_demo", validYaml(), "absent");
    const listed = await store.list();
    expect(listed.some((item) => item.id === "wf_demo")).toBe(true);
    await expect(store.save("wf_demo", "changed", "absent")).rejects.toThrow();
    const current = await store.read("wf_demo");
    await store.remove("wf_demo", current.fileVersion);
    expect((await store.list()).some((item) => item.id === "wf_demo")).toBe(false);
  });

  test("round trips the definition through save, read and a summary", async () => {
    const store = await project();
    const source = validYaml();
    const saved = await store.save("wf_demo", source, "absent");

    const read = await store.read("wf_demo");
    expect(read.definition.id).toBe("wf_demo");
    expect(read.definition.nodes).toHaveLength(6);
    expect(read.fileVersion).toBe(saved.fileVersion);
    expect(read.source).toBe(source);

    expect(await store.list()).toEqual([
      { id: "wf_demo", title: "Demo", nodeCount: 6, writeCount: 1, definitionVersion: 1, fileVersion: saved.fileVersion },
    ]);
  });

  test("rejects invalid YAML and invalid B definitions with VALIDATION_FAILED without writing", async () => {
    const store = await project();
    await expect(store.save("wf_broken", "schemaVersion: 1\nnodes: [unclosed\n", "absent")).rejects.toMatchObject({
      name: "ProjectError",
      code: "VALIDATION_FAILED",
    });
    const invalidDefinition = validYaml("wf_invalid").replace("type: approval", "type: validation");
    await expect(store.save("wf_invalid", invalidDefinition, "absent")).rejects.toMatchObject({
      name: "ProjectError",
      code: "VALIDATION_FAILED",
    });

    expect(await store.list()).toEqual([]);
    await expect(store.read("wf_broken")).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
    await expect(store.read("wf_invalid")).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
  });

  test("fails list fast with details.path naming the offending file instead of skipping it", async () => {
    const dir = await root();
    const store = new WorkflowStore(new FileStore(dir));
    await store.save("wf_demo", validYaml(), "absent");
    await new FileStore(dir).write("specs/workflows/wf_broken.yaml", "schemaVersion: 1\nnodes: [unclosed\n", "absent");

    let failure: ProjectError | undefined;
    try {
      await store.list();
    } catch (error) {
      if (error instanceof ProjectError) failure = error;
      else throw error;
    }

    expect(failure).toBeDefined();
    expect(failure?.code).toBe("VALIDATION_FAILED");
    expect(failure?.message).toContain("specs/workflows/wf_broken.yaml");
    expect(failure?.details).toMatchObject({ path: "specs/workflows/wf_broken.yaml" });

    // The error carries the version token of the readable-but-invalid file, so the
    // recovery path never needs read(id) (which validates and rejects it again) or
    // a second FileStore handle.
    const brokenVersion = failure?.details?.fileVersion;
    expect(brokenVersion).toBeTypeOf("string");
    expect(brokenVersion).toMatch(/^sha256:[a-f0-9]{64}$/);

    await store.remove("wf_broken", brokenVersion as VersionToken);
    expect((await store.list()).map((item) => item.id)).toEqual(["wf_demo"]);
  });

  test("rejects stale version tokens with VERSION_CONFLICT and keeps the stored definition", async () => {
    const store = await project();
    const first = await store.save("wf_demo", validYaml("wf_demo", "First"), "absent");
    expect(first.fileVersion).not.toBe("absent");

    await expect(store.save("wf_demo", validYaml("wf_demo", "Stale"), "sha256:" + "0".repeat(64))).rejects.toMatchObject({
      name: "ProjectError",
      code: "VERSION_CONFLICT",
    });
    await expect(store.save("wf_demo", validYaml("wf_demo", "Absent"), "absent")).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
    });

    expect((await store.read("wf_demo")).definition.title).toBe("First");
    expect((await store.read("wf_demo")).fileVersion).toBe(first.fileVersion);
  });

  test("refuses to remove with a stale version token and keeps the stored definition", async () => {
    const store = await project();
    const first = await store.save("wf_demo", validYaml("wf_demo", "First"), "absent");
    const second = await store.save("wf_demo", validYaml("wf_demo", "Second"), first.fileVersion);
    expect(second.fileVersion).not.toBe(first.fileVersion);

    await expect(store.remove("wf_demo", first.fileVersion)).rejects.toMatchObject({
      name: "ProjectError",
      code: "VERSION_CONFLICT",
    });

    const current = await store.read("wf_demo");
    expect(current.definition.title).toBe("Second");
    expect(current.fileVersion).toBe(second.fileVersion);
  });

  test("rejects uppercase, traversal, extension and leading-digit ids before touching the project", async () => {
    const store = await project();
    const invalidIds = ["../escape", "WF_DEMO", "wf.demo", "wf-demo", "wf_demo.yaml", "specs/workflows/wf", "1wf"];

    for (const id of invalidIds) {
      await expect(store.read(id)).rejects.toMatchObject({ name: "ProjectError", code: "VALIDATION_FAILED" });
      await expect(store.save(id, validYaml(), "absent")).rejects.toMatchObject({ name: "ProjectError", code: "VALIDATION_FAILED" });
      await expect(store.remove(id, "absent")).rejects.toMatchObject({ name: "ProjectError", code: "VALIDATION_FAILED" });
      await expect(store.copyOfficial(id)).rejects.toMatchObject({ name: "ProjectError", code: "VALIDATION_FAILED" });
    }

    expect(await store.list()).toEqual([]);
  });

  test("rejects a 121-character id with VALIDATION_FAILED instead of a filesystem error", async () => {
    const store = await project();
    const tooLong = "a".repeat(MAX_WORKFLOW_ID_LENGTH + 1);
    expect(tooLong).toHaveLength(121);

    await expect(store.read(tooLong)).rejects.toMatchObject({ name: "ProjectError", code: "VALIDATION_FAILED" });
    await expect(store.save(tooLong, validYaml(), "absent")).rejects.toMatchObject({ name: "ProjectError", code: "VALIDATION_FAILED" });
    await expect(store.remove(tooLong, "absent")).rejects.toMatchObject({ name: "ProjectError", code: "VALIDATION_FAILED" });
    await expect(store.copyOfficial(tooLong)).rejects.toMatchObject({ name: "ProjectError", code: "VALIDATION_FAILED" });

    expect(await store.list()).toEqual([]);
  });

  test("exports the shared 120-character id pattern boundary", () => {
    const maxLength = "a".repeat(MAX_WORKFLOW_ID_LENGTH);
    expect(MAX_WORKFLOW_ID_LENGTH).toBe(120);
    expect(WORKFLOW_ID_PATTERN.test("a")).toBe(true);
    expect(WORKFLOW_ID_PATTERN.test(maxLength)).toBe(true);
    expect(WORKFLOW_ID_PATTERN.test("a_" + "b".repeat(118))).toBe(true);
    expect(WORKFLOW_ID_PATTERN.test(maxLength + "a")).toBe(false);
    expect(WORKFLOW_ID_PATTERN.test("1" + "a".repeat(119))).toBe(false);
    expect(WORKFLOW_ID_PATTERN.test("A" + "a".repeat(119))).toBe(false);
    expect(WORKFLOW_ID_PATTERN.test("a-b")).toBe(false);
  });

  test("copies the official workflow under the target id and refuses an existing target", async () => {
    const store = await project();
    const official = await loadOfficialWorkflow();

    const copied = await store.copyOfficial("wf_official_copy");
    expect(copied.id).toBe("wf_official_copy");
    expect(copied.fileVersion).not.toBe("absent");

    const read = await store.read("wf_official_copy");
    expect(read.definition.id).toBe("wf_official_copy");
    expect(read.definition.title).toBe(official.title);
    expect(read.definition.nodes).toHaveLength(official.nodes.length);
    expect(read.fileVersion).toBe(copied.fileVersion);
    expect(read.source).toContain("id: wf_official_copy");

    expect(await store.list()).toEqual([
      {
        id: "wf_official_copy",
        title: official.title,
        nodeCount: official.nodes.length,
        writeCount: 1,
        definitionVersion: official.version,
        fileVersion: copied.fileVersion,
      },
    ]);

    await expect(store.copyOfficial("wf_official_copy")).rejects.toMatchObject({
      name: "ProjectError",
      code: "VERSION_CONFLICT",
    });
    expect((await store.read("wf_official_copy")).definition.title).toBe(official.title);
  });

  test("attributes an official loader failure to the app resource, not the target file", async () => {
    const dir = await root();
    const store = new WorkflowStore(new FileStore(dir), async () => {
      throw new Error("bundled resource is missing");
    });

    let failure: ProjectError | undefined;
    try {
      await store.copyOfficial("wf_official_copy");
    } catch (error) {
      if (error instanceof ProjectError) failure = error;
      else throw error;
    }

    expect(failure).toBeDefined();
    expect(failure?.code).toBe("VALIDATION_FAILED");
    expect(failure?.message).toContain(OFFICIAL_WORKFLOW_RESOURCE);
    expect(failure?.message).not.toContain("wf_official_copy");
    expect(failure?.message).not.toContain("specs/workflows");
    expect(failure?.details).toMatchObject({ resource: OFFICIAL_WORKFLOW_RESOURCE, origin: "official-workflow" });
    expect(failure?.details).not.toMatchObject({ path: "specs/workflows/wf_official_copy.yaml" });
    expect(await store.list()).toEqual([]);
  });

  test("attributes an invalid official definition to the app resource with a distinct message", async () => {
    const dir = await root();
    const store = new WorkflowStore(new FileStore(dir), async () => undefined as unknown as WorkflowDefinition);

    let failure: ProjectError | undefined;
    try {
      await store.copyOfficial("wf_official_copy");
    } catch (error) {
      if (error instanceof ProjectError) failure = error;
      else throw error;
    }

    expect(failure).toBeDefined();
    expect(failure?.message).toContain(OFFICIAL_WORKFLOW_RESOURCE);
    expect(failure?.message).toContain("produced an invalid workflow definition for copy");
    expect(failure?.message).not.toContain("wf_official_copy");
    expect(failure?.details).toMatchObject({ resource: OFFICIAL_WORKFLOW_RESOURCE, origin: "official-workflow" });
    expect(await store.list()).toEqual([]);
  });
});
