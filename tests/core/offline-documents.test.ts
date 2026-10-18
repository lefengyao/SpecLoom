import { mkdtemp, writeFile, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OfflineDocumentStore } from "../../src/main/core/offline-documents";

describe("OfflineDocumentStore", () => {
  it("imports versions separately and persists the selected version and enabled state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "specloom-docs-"));
    const source = path.join(root, "guide.md");
    await writeFile(source, "v1", "utf8");
    const store = new OfflineDocumentStore(path.join(root, "user"));
    const first = await store.importFiles([source], "Guide", "1.0.0", false);
    await writeFile(source, "v2", "utf8");
    const second = await store.importFiles([source], "Guide", "2.0.0", true);
    expect(second.id).toBe(first.id);
    expect(second.versions).toHaveLength(2);
    expect(second.activeVersionId).toBe(first.versions[0]?.id);
    const enabled = await store.setEnabled(first.id, true);
    expect(enabled.enabled).toBe(true);
    const read = await store.read(first.id, second.versions[1]!.id, "guide.md");
    expect(read.content).toBe("v2");
    const reopened = new OfflineDocumentStore(path.join(root, "user"));
    expect((await reopened.list())[0]?.enabled).toBe(true);
  });

  it("imports a directory with safe relative paths and rejects traversal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "specloom-docs-dir-"));
    const source = path.join(root, "src");
    await mkdir(path.join(source, "nested"), { recursive: true });
    await writeFile(path.join(source, "nested", "readme.txt"), "hello", "utf8");
    const store = new OfflineDocumentStore(path.join(root, "user"));
    const bundle = await store.importDirectory(source, "Docs", "1", true);
    expect(bundle.versions[0]?.files[0]?.path).toBe("nested/readme.txt");
    await expect(store.read(bundle.id, bundle.versions[0]!.id, "../secret")).rejects.toMatchObject({ code: "PATH_ESCAPE" });
  });

  it("does not expose a candidate bundle while its index write is pending", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "specloom-docs-cow-"));
    const source = path.join(root, "guide.md");
    await writeFile(source, "v1", "utf8");
    const store = new OfflineDocumentStore(path.join(root, "user"));
    const internals = store as unknown as {
      writeIndex: (index: unknown) => Promise<void>;
    };
    const originalWriteIndex = internals.writeIndex.bind(store);
    let entered!: () => void;
    let release!: () => void;
    const writeEntered = new Promise<void>((resolve) => { entered = resolve; });
    const writeRelease = new Promise<void>((resolve) => { release = resolve; });
    internals.writeIndex = async (index) => {
      entered();
      await writeRelease;
      return originalWriteIndex(index);
    };
    const pending = store.importFiles([source], "Guide", "1", true);
    await writeEntered;
    try {
      expect(await store.list()).toEqual([]);
    } finally {
      release();
    }
    await expect(pending).resolves.toMatchObject({ name: "Guide", versions: [{ label: "1" }] });
    expect((await store.list())[0]?.versions).toHaveLength(1);
  });

  it("keeps the cached and persisted index unchanged when an import index write fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "specloom-docs-cow-index-"));
    const source = path.join(root, "guide.md");
    await writeFile(source, "v1", "utf8");
    const store = new OfflineDocumentStore(path.join(root, "user"));
    const first = await store.importFiles([source], "Guide", "1", true);
    const indexPath = path.join(store.root, "index.json");
    const persisted = await readFile(indexPath);
    await rm(indexPath);
    await mkdir(indexPath);
    await writeFile(source, "v2", "utf8");
    await expect(store.importFiles([source], "Guide", "2", true)).rejects.toBeTruthy();
    await rm(indexPath, { recursive: true, force: true });
    await writeFile(indexPath, persisted);
    expect((await store.list())[0]?.versions.map((item) => item.label)).toEqual(["1"]);
    const reopened = new OfflineDocumentStore(path.join(root, "user"));
    expect((await reopened.list())[0]?.versions.map((item) => item.label)).toEqual(["1"]);
    expect((await reopened.list())[0]?.id).toBe(first.id);
  });

  it("does not mutate cached state when enable or remove persistence fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "specloom-docs-cow-state-"));
    const source = path.join(root, "guide.md");
    await writeFile(source, "v1", "utf8");
    const store = new OfflineDocumentStore(path.join(root, "user"));
    const bundle = await store.importFiles([source], "Guide", "1", true);
    const blockedRoot = path.join(root, "blocked-root");
    await writeFile(blockedRoot, "not a directory", "utf8");
    const internals = store as unknown as { root: string };
    const originalRoot = store.root;
    internals.root = blockedRoot;
    await expect(store.setEnabled(bundle.id, false)).rejects.toBeTruthy();
    expect((await store.list())[0]?.enabled).toBe(true);
    await expect(store.remove(bundle.id)).rejects.toBeTruthy();
    internals.root = originalRoot;
    const reopened = new OfflineDocumentStore(path.join(root, "user"));
    expect((await reopened.list())[0]?.id).toBe(bundle.id);
    expect((await reopened.list())[0]?.enabled).toBe(true);
    const read = await reopened.read(bundle.id, bundle.versions[0]!.id, "guide.md");
    expect(read.content).toBe("v1");
  });

  it("does not mutate the active version when version persistence fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "specloom-docs-cow-version-"));
    const source = path.join(root, "guide.md");
    await writeFile(source, "v1", "utf8");
    const store = new OfflineDocumentStore(path.join(root, "user"));
    const first = await store.importFiles([source], "Guide", "1", true);
    await writeFile(source, "v2", "utf8");
    const second = await store.importFiles([source], "Guide", "2", true);
    const blockedRoot = path.join(root, "blocked-root");
    await writeFile(blockedRoot, "not a directory", "utf8");
    const internals = store as unknown as { root: string };
    const originalRoot = store.root;
    internals.root = blockedRoot;
    await expect(store.setVersion(first.id, second.versions[1]!.id)).rejects.toBeTruthy();
    expect((await store.list())[0]?.activeVersionId).toBe(first.versions[0]?.id);
    internals.root = originalRoot;
    const reopened = new OfflineDocumentStore(path.join(root, "user"));
    expect((await reopened.list())[0]?.activeVersionId).toBe(first.versions[0]?.id);
  });
});

