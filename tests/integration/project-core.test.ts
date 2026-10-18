import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileReadResult, FileVersion, ModelProfile } from "../../src/shared/contracts";
import { ProjectCore, type ProjectCoreOptions } from "../../src/main/core/project-core";
import { SnapshotRunner } from "../../src/main/core/snapshot-runner";

const roots: string[] = [];
async function fixture(options: ProjectCoreOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-core-"));
  roots.push(root);
  await writeFile(path.join(root, "project.godot"), 'config_version=5\n[application]\nconfig/name="Core Test"\n');
  const core = await ProjectCore.open(root, { bundledSkillsDirectory: path.resolve("skills"), validator: {
    validateWithDependencies: async () => ({ result: { status: "pass" as const, checks: [], diagnostics: [] }, dependencies: {}, sources: [], inventory: (await core.store.listFiles()).map((file) => file.path) }),
  }, ...options });
  const task = await core.createTask({ id: "task", title: "Create hero", readPaths: ["*"], writePaths: ["specs/**", "scripts/**"], allowDelete: false, mode: "manual" });
  return { root, core, taskId: task.id };
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const tool = (core: ProjectCore, name: string, input: Record<string, unknown>) => core.executeTool("task", name, input);
async function read(core: ProjectCore, relative: string) {
  const [file] = await tool(core, "files.list_versions", { paths: [relative] }) as FileVersion[];
  return await tool(core, "files.read", { path: relative, expectedVersion: file!.version }) as FileReadResult;
}

describe("ProjectCore shared project authority", () => {
  it("exposes the real project tree, including empty specification folders", async () => {
    const { core } = await fixture();
    const entries = await core.projectTree();
    expect(entries).toContainEqual({ path: "project.godot", kind: "file" });
    expect(entries).toContainEqual({ path: "specs/entities/maps", kind: "directory" });
    expect(entries).toContainEqual({ path: "specs/project.md", kind: "file" });
    expect(entries).not.toContainEqual(expect.objectContaining({ path: ".specloom/project.yaml" }));
  });

  it("reports retained startup snapshots while allowing project work", async () => {
    const issue = { code: "COMMAND_FAILED", message: "Snapshot retained after container cleanup failed", path: "private-snapshot" };
    const recover = vi.spyOn(SnapshotRunner.prototype, "recoverAbandoned").mockResolvedValue([issue]);
    try {
      const { core } = await fixture();
      expect(recover).toHaveBeenCalledOnce();
      expect(core.recoveryIssues).toEqual([issue]);
      expect(core.listTasks()).toHaveLength(1);
    } finally { recover.mockRestore(); }
  });
  it("continues a failed model run after restart with its goal and completed tools but fresh read authority", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const { core, root } = await fixture({ fetch, resolveCredential: async () => "fixture-secret" });
    const file = await core.store.listVersion("specs/project.md");
    const completion = (message: Record<string, unknown>) => new Response(JSON.stringify({ choices: [{ message }] }), { headers: { "Content-Type": "application/json" } });
    fetch.mockResolvedValueOnce(completion({ role: "assistant", content: null, tool_calls: [
      { id: "read", type: "function", function: { name: "files_read", arguments: JSON.stringify({ path: file.path, expectedVersion: file.version }) } },
      { id: "write", type: "function", function: { name: "files_write", arguments: JSON.stringify({ path: "scripts/hero.gd", expectedVersion: "absent", content: "extends Node\n" }) } },
    ] })).mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    const profile: ModelProfile = { id: "fixture", name: "Fixture", provider: "openai-compatible", baseUrl: "http://127.0.0.1:12345/v1", model: "fixture", approved: true, timeoutMs: 5000, maxToolRounds: 4 };
    await expect(core.agentMessage("task", profile, "Create a hero without combat using fixture-secret")).rejects.toMatchObject({ code: "MODEL_ERROR" });
    const reopened = await ProjectCore.open(root, { fetch });
    expect(reopened.listTasks()[0]!.conversation?.[0]?.content).toBe("Create a hero without combat using [redacted]");
    expect((await reopened.previewChanges("task")).changeSet.entries).toHaveLength(1);
    await expect(tool(reopened, "files.write", { path: file.path, expectedVersion: file.version, content: "unread" })).rejects.toMatchObject({ code: "READ_REQUIRED" });
    fetch.mockResolvedValueOnce(completion({ role: "assistant", content: "The staged hero is ready for review." }));
    await reopened.agentMessage("task", profile, "Continue");
    const continuation = JSON.parse(fetch.mock.calls[2]![1]!.body as string) as { messages: { role: string; content: string | null; tool_call_id?: string }[] };
    expect(continuation.messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id)).toEqual(["read", "write"]);
    expect(JSON.stringify(continuation.messages)).toContain("scripts/hero.gd");
    expect(JSON.stringify(continuation.messages)).not.toContain("fixture-secret");
    expect(continuation.messages.at(-1)).toMatchObject({ role: "user", content: "Continue" });
  });
  it("requires an actual task read and UI approval before changing existing files", async () => {
    const { core, root } = await fixture();
    const [file] = await tool(core, "files.list_versions", { paths: ["specs/project.md"] }) as FileVersion[];
    await expect(tool(core, "files.write", { path: file!.path, expectedVersion: file!.version, content: "changed" })).rejects.toMatchObject({ code: "READ_REQUIRED" });
    const original = await read(core, file!.path);
    await tool(core, "files.write", { path: file!.path, expectedVersion: original.version, content: "changed" });
    const review = await core.previewChanges("task");
    expect(review.before[file!.path]).toBe(original.content);
    expect(await readFile(path.join(root, file!.path), "utf8")).toBe(original.content);
    await expect(tool(core, "changes.commit", { digest: review.changeSet.digest })).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    await core.approveChanges("task", review.changeSet.digest);
    expect(await readFile(path.join(root, file!.path), "utf8")).toBe("changed");
  });
  it("uses overlay versions and patches staged content while preserving the original baseline", async () => {
    const { core } = await fixture();
    const file = await read(core, "specs/outline.md");
    await tool(core, "files.write", { path: file.path, expectedVersion: file.version, content: "first draft" });
    const overlay = await read(core, file.path);
    expect(overlay.content).toBe("first draft");
    expect(overlay.version).not.toBe(file.version);
    await tool(core, "files.patch", { path: file.path, expectedVersion: overlay.version, patch: { search: "first", replace: "second" } });
    const review = await core.previewChanges("task");
    expect(review.changeSet.entries[0]).toMatchObject({ expectedVersion: file.version, nextContent: "second draft" });
    await expect(core.approveChanges("task", "old-digest")).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
  });
  it("rejects all staged outputs after an external output or input edit", async () => {
    const { core, root } = await fixture();
    await read(core, "specs/project.md");
    await tool(core, "files.write", { path: "scripts/hero.gd", expectedVersion: "absent", content: "extends Node\n" });
    await tool(core, "files.write", { path: "scripts/other.gd", expectedVersion: "absent", content: "extends Node\n" });
    const review = await core.previewChanges("task");
    await writeFile(path.join(root, "specs/project.md"), "developer edit");
    await expect(core.approveChanges("task", review.changeSet.digest)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    await expect(readFile(path.join(root, "scripts/hero.gd"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("binds loaded Skills and referenced specifications to the final commit", async () => {
    const { core, root } = await fixture();
    const skills = await tool(core, "skills.list", {}) as { id: string; version: string }[];
    const skill = skills.find((skill) => skill.id === "project-context")!;
    await tool(core, "skills.load", { id: skill.id, expectedVersion: skill.version });
    await tool(core, "files.write", { path: "scripts/hero.gd", expectedVersion: "absent", content: "extends Node\n" });
    const review = await core.previewChanges("task");
    expect(review.changeSet.dependencies).toHaveProperty(".specloom/skills/project-context/SKILL.md");
    await writeFile(path.join(root, ".specloom/skills/project-context/SKILL.md"), "new procedure");
    await expect(core.approveChanges("task", review.changeSet.digest)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });

  it("issues Skill write receipts only after loading its instructions", async () => {
    const { core } = await fixture();
    await core.createTask({ id: "skill-edit", title: "Skill editing", readPaths: ["*"], writePaths: [".specloom/skills/**"], mode: "manual", allowDelete: false });
    const skills = await core.executeTool("skill-edit", "skills.list", {}) as { id: string; path: string; version: string }[];
    const skill = skills.find((skill) => skill.id === "entity-authoring")!;
    const write = { path: skill.path, expectedVersion: skill.version, content: "revised skill" };
    await expect(core.executeTool("skill-edit", "files.write", write)).rejects.toMatchObject({ code: "READ_REQUIRED" });
    await core.executeTool("skill-edit", "skills.load", { id: skill.id, expectedVersion: skill.version });
    await core.executeTool("skill-edit", "files.write", write);
  });
  it("persists validation results and denies automatic commit until current validation passes", async () => {
    const { core, root } = await fixture();
    await core.createTask({ id: "auto", title: "Validated output", readPaths: ["*"], writePaths: ["scripts/**"], allowDelete: false, mode: "auto" });
    await core.executeTool("auto", "files.write", { path: "scripts/hero.gd", expectedVersion: "absent", content: "extends Node\n" });
    let review = await core.previewChanges("auto");
    await expect(core.executeTool("auto", "changes.commit", { digest: review.changeSet.digest })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await core.validate("auto");
    expect((await readdir(path.join(root, ".specloom/history/validations"))).length).toBe(1);
    review = await core.previewChanges("auto");
    await core.executeTool("auto", "changes.commit", { digest: review.changeSet.digest });
    expect(await readFile(path.join(root, "scripts/hero.gd"), "utf8")).toBe("extends Node\n");
  });
  it("restores staged drafts without restoring approval or read receipts", async () => {
    const { core, root } = await fixture();
    const file = await read(core, "specs/outline.md");
    await tool(core, "files.write", { path: file.path, expectedVersion: file.version, content: "draft" });
    const reopened = await ProjectCore.open(root);
    const review = await reopened.previewChanges("task");
    expect(review.changeSet.entries).toHaveLength(1);
    expect(review.approved).toBe(false);
    const [overlay] = await tool(reopened, "files.list_versions", { paths: [file.path] }) as FileVersion[];
    await expect(tool(reopened, "files.write", { path: file.path, expectedVersion: overlay!.version, content: "unread" })).rejects.toMatchObject({ code: "READ_REQUIRED" });
  });

  it("preserves completed history and validates the real project after commit", async () => {
    const { core, root } = await fixture();
    await tool(core, "files.write", { path: "scripts/hero.gd", expectedVersion: "absent", content: "extends Node\n" });
    const review = await core.previewChanges("task");
    await core.approveChanges("task", review.changeSet.digest);
    expect((await core.validate("task")).status).toBe("pass");
    const reopened = await ProjectCore.open(root);
    expect(reopened.listTasks()[0]!.status).toBe("applied");
    expect((await reopened.previewChanges("task")).changeSet.digest).toBe(review.changeSet.digest);
    expect((await reopened.previewChanges("task")).validation?.status).toBe("pass");
    await expect(reopened.approveChanges("task", review.changeSet.digest)).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
  });

  it("removes a completed task history record from memory and disk", async () => {
    const { core, root, taskId } = await fixture();
    await core.rejectChanges(taskId);
    const history = path.join(root, ".specloom/history/tasks");
    expect((await readdir(history)).length).toBe(1);

    await core.removeTask(taskId);

    expect(core.listTasks()).toEqual([]);
    expect(await readdir(history)).toEqual([]);
    const reopened = await ProjectCore.open(root);
    expect(reopened.listTasks()).toEqual([]);
  });

  it("invalidates validation when the source inventory gains a new file", async () => {
    const { core, root } = await fixture();
    await tool(core, "files.write", { path: "scripts/hero.gd", expectedVersion: "absent", content: "extends Node\n" });
    await core.validate("task");
    const review = await core.previewChanges("task");
    await writeFile(path.join(root, "specs/extra.md"), "external");
    await expect(core.approveChanges("task", review.changeSet.digest)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });

  it("checks validation inventory after entering the shared commit mutex", async () => {
    const { core, root } = await fixture();
    await tool(core, "files.write", { path: "scripts/hero.gd", expectedVersion: "absent", content: "extends Node\n" });
    await core.validate("task");
    const review = await core.previewChanges("task");
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const blocker = core.store.withLock(async () => { entered(); await barrier; await writeFile(path.join(root, "specs/concurrent.md"), "new specification"); });
    await enteredPromise;
    let queued!: () => void;
    const queuedPromise = new Promise<void>((resolve) => { queued = resolve; });
    const original = core.store.withLock.bind(core.store);
    vi.spyOn(core.store, "withLock").mockImplementation((action) => { queued(); return original(action); });
    const commit = core.approveChanges("task", review.changeSet.digest);
    const rejection = expect(commit).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    await queuedPromise;
    release();
    await blocker;
    await rejection;
  });

  it("recovers completed status from the durable journal when final task persistence fails", async () => {
    const { core, root } = await fixture();
    await tool(core, "files.write", { path: "scripts/hero.gd", expectedVersion: "absent", content: "extends Node\n" });
    const review = await core.previewChanges("task");
    const original = core.store.fs.rename;
    core.store.fs.rename = async (from, to) => {
      if (String(to).includes(`${path.sep}tasks${path.sep}`)) throw new Error("Interrupted task persistence");
      return original(from, to);
    };
    await expect(core.approveChanges("task", review.changeSet.digest)).rejects.toThrow("Interrupted task persistence");
    expect(await readFile(path.join(root, "scripts/hero.gd"), "utf8")).toBe("extends Node\n");
    const reopened = await ProjectCore.open(root);
    expect(reopened.listTasks()[0]!.status).toBe("applied");
    expect((await reopened.previewChanges("task")).changeSet.digest).toBe(review.changeSet.digest);
  });

  it("bounds completed history separately from active task capacity across restarts", async () => {
    const { core, root } = await fixture();
    for (let index = 0; index < 128; index++) {
      const task = await core.createTask({ id: `completed-${index}`, title: "Complete", readPaths: ["*"], writePaths: [], mode: "manual", allowDelete: false });
      await core.rejectChanges(task.id);
    }
    const reopened = await ProjectCore.open(root);
    await expect(reopened.createTask({ id: "next", title: "Continue", readPaths: ["*"], writePaths: ["scripts/**"], mode: "manual", allowDelete: false })).resolves.toMatchObject({ id: "next" });
  }, 60000);

  it("does not restore validation authority for an active automatic draft", async () => {
    const { core, root } = await fixture();
    await core.createTask({ id: "auto-draft", title: "Revalidate after restart", readPaths: ["*"], writePaths: ["scripts/**"], mode: "auto", allowDelete: false });
    await core.executeTool("auto-draft", "files.write", { path: "scripts/hero.gd", expectedVersion: "absent", content: "extends Node\n" });
    await core.validate("auto-draft");
    const reopened = await ProjectCore.open(root);
    const preview = await reopened.previewChanges("auto-draft");
    expect(preview.validation).toBeUndefined();
    await expect(reopened.executeTool("auto-draft", "changes.commit", { digest: preview.changeSet.digest })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
