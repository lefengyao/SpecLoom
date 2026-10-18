import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { FileStore } from "../../src/main/core/file-store";
import { ProjectMediaRegistry } from "../../src/main/project-media-registry";

const roots: string[] = [];
const registries: ProjectMediaRegistry[] = [];
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.from([0,0,0,13]), Buffer.from("IHDR"), Buffer.alloc(16, 1)]);
afterEach(async () => { await Promise.all(registries.splice(0).map((registry) => registry.close())); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(suffix: number) { const root = await mkdtemp(path.join(os.tmpdir(), "specloom-registry-media-")); roots.push(root); await writeFile(path.join(root, "image.png"), Buffer.concat([png, Buffer.from([suffix])])); return new FileStore(root); }
function registry() { const value = new ProjectMediaRegistry(); registries.push(value); return value; }

it("keeps leases bound to their selected stores, and closes a project server only after its last owner releases", async () => {
  const media = registry(), first = await fixture(1), second = await fixture(2);
  const owner = Symbol("window"), other = Symbol("other window");
  const a = await media.open(owner, first, "image.png");
  const b = await media.open(owner, second, "image.png");
  const shared = await media.open(other, first, "image.png");
  expect(Buffer.from(await (await fetch(a.url)).arrayBuffer()).at(-1)).toBe(1);
  expect(Buffer.from(await (await fetch(b.url)).arrayBuffer()).at(-1)).toBe(2);
  media.revokeOwner(owner);
  expect((await fetch(shared.url)).status).toBe(200);
  await expect(fetch(b.url)).rejects.toThrow();
  media.release(other, shared.id);
  await expect(fetch(shared.url)).rejects.toThrow();
  await media.close();
  await expect(media.open(owner, first, "image.png")).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
});

it("enforces four leases across stores and rejects an in-flight open after owner revocation", async () => {
  const media = registry(), store = await fixture(1), owner = Symbol("window");
  await Promise.all(Array.from({length: 4}, () => media.open(owner, store, "image.png")));
  await expect(media.open(owner, await fixture(2), "image.png")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  media.revokeOwner(owner);
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => { unblock = resolve; });
  const delayed = new FileStore(store.root, { fs: { open: async (...args) => { await gate; return fs.open(...args); } } });
  const pending = media.open(owner, delayed, "image.png");
  media.revokeOwner(owner); unblock();
  await expect(pending).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
  expect(await media.open(owner, store, "image.png")).toMatchObject({ kind: "image" });
});

it("awaits pending descriptor opens during shutdown and rejects their late capabilities", async () => {
  const media = registry(), store = await fixture(1);
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => { unblock = resolve; });
  const delayed = new FileStore(store.root, { fs: { open: async (...args) => { await gate; return fs.open(...args); } } });
  const pending = media.open(Symbol("closing window"), delayed, "image.png");
  let closed = false;
  const closing = media.close().then(() => { closed = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(closed).toBe(false);
  unblock();
  await expect(pending).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
  await closing;
  expect(closed).toBe(true);
});
