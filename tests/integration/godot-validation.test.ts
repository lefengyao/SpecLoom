import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChangeEntry } from "../../src/shared/contracts";
import { FileStore } from "../../src/main/core/file-store";
import { ProjectLayout } from "../../src/main/core/project-layout";
import { GODOT_IMAGE, SnapshotRunner } from "../../src/main/core/snapshot-runner";
import { TaskScope } from "../../src/main/core/task-scope";
import { Validator } from "../../src/main/core/validator";
import { dockerPrerequisites } from "./docker-prerequisites";

const prerequisites = await dockerPrerequisites("godot-validation", [GODOT_IMAGE]);
const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-godot-validation-"));
  roots.push(root);
  await cp(path.resolve("tests/fixtures/godot-minimal"), root, { recursive: true });
  await new ProjectLayout().initialize(root);
  const store = new FileStore(root);
  return { root, store, validator: new Validator(store, new SnapshotRunner(store)) };
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe.skipIf(!prerequisites.available)("real isolated Godot validation", () => {
  it("imports and smoke-runs the minimal project without creating host engine cache", async () => {
    const { root, validator } = await fixture();
    const { result, dependencies } = await validator.validateWithDependencies({ smokeScene: "res://main.tscn" });
    expect(result.status, JSON.stringify(result)).toBe("pass");
    expect(result.checks.map((check) => check.status)).toEqual(["pass", "pass", "pass"]);
    expect(result.checks[2]!.stdout).toContain("SPECLOOM_SMOKE_OK");
    expect(dependencies["main.gd"]).toMatch(/^sha256:/);
    await expect(readFile(path.join(root, ".godot/global_script_class_cache.cfg"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 150000);

  it("rejects an invalid staged GDScript and preserves the actual source", async () => {
    const { root, store, validator } = await fixture();
    const current = await store.listVersion("main.gd");
    const before = await readFile(path.join(root, "main.gd"), "utf8");
    const scope = new TaskScope({ id: "bad-script", title: "Invalid script", readPaths: ["*"], writePaths: ["main.gd"], allowDelete: false, mode: "manual" });
    const overlay: ChangeEntry[] = [{ path: "main.gd", operation: "update", expectedVersion: current.version, nextContent: "extends Node\nfunc _ready(:\n    pass\n", sourceTaskId: "bad-script", sourceTool: "test" }];
    const result = await validator.validate({ taskId: "bad-script", scope, overlay });
    expect(result.status).toBe("fail");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "GODOT_SCRIPT_ERROR", path: "main.gd" }));
    expect(await readFile(path.join(root, "main.gd"), "utf8")).toBe(before);
  }, 90000);
});
