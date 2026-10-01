import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type ChangeEntry } from "../../src/shared/contracts";
import { FileStore } from "../../src/main/core/file-store";
import { StagedChangeSet } from "../../src/main/core/change-set";
import { ChangeJournal } from "../../src/main/core/change-journal";

const roots: string[] = [];
async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-changes-"));
  roots.push(root);
  return root;
}
const entry = (path: string, nextContent: string, expectedVersion: ChangeEntry["expectedVersion"] = "absent"): ChangeEntry => ({ path, operation: expectedVersion === "absent" ? "create" : "update", expectedVersion, nextContent, sourceTaskId: "task", sourceTool: "write" });
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("staged change sets", () => {
  it("stages creates, updates and deletes without mutating live files", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "update.md"), "old");
    await writeFile(path.join(root, "delete.md"), "delete");
    const store = new FileStore(root);
    const changes = new StagedChangeSet(store, { taskId: "task" });
    changes.stage(entry("create.md", "created"));
    changes.stage(entry("update.md", "updated", (await store.listVersion("update.md")).version));
    changes.stage({ ...entry("delete.md", "", (await store.listVersion("delete.md")).version), operation: "delete", nextContent: undefined });
    expect(await readFile(path.join(root, "update.md"), "utf8")).toBe("old");
    expect(await readFile(path.join(root, "delete.md"), "utf8")).toBe("delete");
    expect((await store.listVersion("create.md")).exists).toBe(false);
    const result = await changes.commit(changes.preview().digest);
    expect(result.status).toBe("applied");
    expect(await readFile(path.join(root, "update.md"), "utf8")).toBe("updated");
    expect((await store.listVersion("delete.md")).exists).toBe(false);
    expect(await readFile(path.join(root, "create.md"), "utf8")).toBe("created");
  });

  it("returns immutable independent previews and invalidates old digests", async () => {
    const changes = new StagedChangeSet(new FileStore(await fixture()), { taskId: "task" });
    changes.stage(entry("a.md", "first"));
    const preview = changes.preview();
    expect(Object.isFrozen(preview)).toBe(true);
    expect(Object.isFrozen(preview.entries)).toBe(true);
    changes.stage(entry("a.md", "second"));
    expect(preview.entries[0]?.nextContent).toBe("first");
    await expect(changes.commit(preview.digest)).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    changes.addDependency("dependency.md", "absent");
    expect(changes.preview().digest).not.toBe(preview.digest);
  });

  it("retains each baseline and rejects incompatible restaging/dependencies", async () => {
    const changes = new StagedChangeSet(new FileStore(await fixture()), { taskId: "task" });
    changes.stage(entry("./a.md", "first"));
    expect(() => changes.stage(entry("a.md", "second", `sha256:${"0".repeat(64)}`))).toThrowError();
    changes.addDependency("a.md", "absent");
    expect(() => changes.addDependency("a.md", `sha256:${"0".repeat(64)}`)).toThrowError();
    expect(changes.preview().entries).toHaveLength(1);
  });

  it("preflights all output versions before writing any path", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "a.md"), "old");
    await writeFile(path.join(root, "b.md"), "old");
    const store = new FileStore(root);
    const changes = new StagedChangeSet(store, { taskId: "task" });
    changes.stage(entry("a.md", "ours", (await store.listVersion("a.md")).version));
    changes.stage(entry("b.md", "ours", (await store.listVersion("b.md")).version));
    await writeFile(path.join(root, "b.md"), "external");
    await expect(changes.commit(changes.preview().digest)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(await readFile(path.join(root, "a.md"), "utf8")).toBe("old");
    expect(changes.preview().status).toBe("conflicted");
  });

  it("refuses stale dependencies even when output versions still match", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "input.md"), "read");
    const store = new FileStore(root);
    const changes = new StagedChangeSet(store, { taskId: "task" });
    changes.stage(entry("output.md", "ours"));
    changes.addDependency("input.md", (await store.listVersion("input.md")).version);
    await writeFile(path.join(root, "input.md"), "external");
    await expect(changes.commit(changes.preview().digest)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect((await store.listVersion("output.md")).exists).toBe(false);
  });

  it("serializes competing change sets on a shared root", async () => {
    const root = await fixture();
    const sets = [new StagedChangeSet(new FileStore(root), { taskId: "one" }), new StagedChangeSet(new FileStore(root), { taskId: "two" })];
    sets.forEach((changes, index) => changes.stage(entry("a.md", String(index))));
    const results = await Promise.allSettled(sets.map((changes) => changes.commit(changes.preview().digest)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });

  it.runIf(process.platform === "win32")("treats Windows case aliases as one baseline and dependency", async () => {
    const root = await fixture();
    const changes = new StagedChangeSet(new FileStore(root), { taskId: "task" });
    changes.stage(entry("A.md", "first"));
    changes.stage(entry("a.md", "second"));
    expect(changes.preview().entries).toHaveLength(1);
    changes.addDependency("a.MD", "absent");
    expect(() => changes.addDependency("A.md", `sha256:${"0".repeat(64)}`)).toThrow();
    await changes.commit(changes.preview().digest);
    expect(await readFile(path.join(root, "a.md"), "utf8")).toBe("second");
  });

  it("validation binds to its digest, restaging invalidates it and terminal sets reject changes", async () => {
    const changes = new StagedChangeSet(new FileStore(await fixture()), { taskId: "task" });
    changes.stage(entry("a.md", "first"));
    expect(changes.markValidated(changes.preview().digest).status).toBe("validated");
    changes.stage(entry("a.md", "second"));
    expect(changes.preview().status).toBe("staged");
    expect(changes.reject().status).toBe("rejected");
    expect(() => changes.stage(entry("a.md", "third"))).toThrow();
    await expect(changes.commit(changes.preview().digest)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(new StagedChangeSet(new FileStore(await fixture()), { taskId: "task" }).commit("unknown")).rejects.toThrow();
  });

  it("rejects reserved staging paths and invalid change set identifiers", async () => {
    const store = new FileStore(await fixture());
    const changes = new StagedChangeSet(store, { taskId: "task" });
    expect(() => changes.stage(entry(".specloom/history/changes/unsafe.json", "unsafe"))).toThrow();
    expect(() => new StagedChangeSet(store, { taskId: "task", id: "../outside" })).toThrow();
  });

  it("rejects oversized aggregate journal serialization before preparing history", async () => {
    const root = await fixture();
    const store = new FileStore(root);
    const preimage = "\u0001".repeat(store.maxTextBytes);
    const nextContent = "\u0002".repeat(store.maxTextBytes);
    const entries: ChangeEntry[] = [];
    for (let index = 0; index < 6; index++) {
      const relative = `file-${index}.md`;
      await writeFile(path.join(root, relative), preimage);
      entries.push(entry(relative, nextContent, (await store.listVersion(relative)).version));
    }
    await expect(new ChangeJournal(store).prepare("oversized", "task", "digest", entries).then(() => undefined)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await readdir(root)).sort()).toEqual(entries.map((value) => value.path));
    for (const value of entries) expect(await readFile(path.join(root, value.path), "utf8")).toBe(preimage);
  });

  it("bounds journal writes by serialized UTF-8 bytes before creating any file", async () => {
    const root = await fixture();
    const journal = new ChangeJournal(new FileStore(root));
    await expect(journal.write({
      schemaVersion: 1, id: "oversized", taskId: "task", digest: "\u00e9".repeat(32 * 1024 * 1024),
      status: "committing", createdAt: new Date().toISOString(), operations: [], recoveryConflicts: [],
    })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await readdir(root)).toEqual([]);
  });

  it("preserves immutable audit history when another change set reuses an ID", async () => {
    const root = await fixture();
    const store = new FileStore(root);
    const first = new StagedChangeSet(store, { taskId: "task", id: "reused" });
    first.stage(entry("a.md", "first"));
    await first.commit(first.preview().digest);
    const historyPath = path.join(root, ".specloom/history/changes/reused.json");
    const originalHistory = await readFile(historyPath, "utf8");
    const second = new StagedChangeSet(store, { taskId: "another-task", id: first.id });
    second.stage(entry("a.md", "second", (await store.listVersion("a.md")).version));
    await expect(second.commit(second.preview().digest)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(await readFile(path.join(root, "a.md"), "utf8")).toBe("first");
    expect(await readFile(historyPath, "utf8")).toBe(originalHistory);
    expect(await StagedChangeSet.inspectHistory(store)).toMatchObject([{ id: first.id, status: "applied" }]);
  });

  it("persists preimages and rolls back a midway failure", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "a.md"), "old");
    await writeFile(path.join(root, "b.md"), "old");
    const store = new FileStore(root, { fs: { rename: async (source, destination) => {
      if (destination === path.join(root, "b.md")) throw new Error("injected failure");
      await fs.rename(source, destination);
    } } });
    const changes = new StagedChangeSet(store, { taskId: "task" });
    for (const file of ["a.md", "b.md"]) changes.stage(entry(file, "ours", (await store.listVersion(file)).version));
    await expect(changes.commit(changes.preview().digest)).rejects.toThrow("injected failure");
    expect(await readFile(path.join(root, "a.md"), "utf8")).toBe("old");
    expect(changes.preview().status).toBe("failed");
    const history = await StagedChangeSet.inspectHistory(store);
    expect(history[0]).toMatchObject({ status: "failed", operations: [{ preimage: "old" }, { preimage: "old" }] });
  });

  it("preserves external edits during rollback and reports recovery conflicts", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "a.md"), "old");
    await writeFile(path.join(root, "b.md"), "old");
    const store = new FileStore(root, { fs: { rename: async (source, destination) => {
      if (destination === path.join(root, "b.md")) {
        await writeFile(path.join(root, "a.md"), "external");
        throw new Error("injected failure");
      }
      await fs.rename(source, destination);
    } } });
    const changes = new StagedChangeSet(store, { taskId: "task" });
    for (const file of ["a.md", "b.md"]) changes.stage(entry(file, "ours", (await store.listVersion(file)).version));
    await expect(changes.commit(changes.preview().digest)).rejects.toThrow();
    expect(await readFile(path.join(root, "a.md"), "utf8")).toBe("external");
    expect(changes.preview().status).toBe("recovery-conflict");
    expect((await StagedChangeSet.recover(new FileStore(root)))[0]?.status).toBe("recovery-conflict");
    expect(await readFile(path.join(root, "a.md"), "utf8")).toBe("external");
  });

  it("recovers an interrupted committing journal after restart", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "a.md"), "old");
    const store = new FileStore(root);
    const changes = new StagedChangeSet(store, { taskId: "task" });
    changes.stage(entry("a.md", "ours", (await store.listVersion("a.md")).version));
    await changes.commit(changes.preview().digest);
    const historyDirectory = path.join(root, ".specloom/history/changes");
    const historyPath = path.join(historyDirectory, (await readdir(historyDirectory))[0]!);
    const journal = JSON.parse(await readFile(historyPath, "utf8")) as { status: string; operations: { state: string }[] };
    journal.status = "committing";
    journal.operations[0]!.state = "applying";
    await writeFile(historyPath, JSON.stringify(journal));
    expect((await StagedChangeSet.recover(new FileStore(root)))[0]?.status).toBe("failed");
    expect(await readFile(path.join(root, "a.md"), "utf8")).toBe("old");
  });

  it("refuses journal corruption before touching a live file", async () => {
    const root = await fixture();
    const store = new FileStore(root);
    const changes = new StagedChangeSet(store, { taskId: "task" });
    changes.stage(entry("a.md", "ours"));
    await changes.commit(changes.preview().digest);
    const directory = path.join(root, ".specloom/history/changes");
    const filename = path.join(directory, (await readdir(directory))[0]!);
    const journal = JSON.parse(await readFile(filename, "utf8")) as { status: string; operations: { preimage: string | null }[] };
    journal.status = "committing";
    journal.operations[0]!.preimage = "forged";
    await writeFile(filename, JSON.stringify(journal));
    await expect(StagedChangeSet.recover(new FileStore(root))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await readFile(path.join(root, "a.md"), "utf8")).toBe("ours");
  });
});
