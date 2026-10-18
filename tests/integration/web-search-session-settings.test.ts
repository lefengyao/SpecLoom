import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { SessionStore } from "../../src/main/core/session-store";
import { digestBytes } from "../../src/main/core/store-fs";
import { ChatSessionSchema, SessionPatchSchema } from "../../src/shared/chat";

const modes = ["off", "auto", "native", "free", "self-hosted"] as const;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-web-search-settings-")); roots.push(root);
  return { root, store: await SessionStore.open(root) };
}

test("new sessions and legacy records default to disabled web search", async () => {
  const { root, store } = await fixture(); const session = await store.create();
  expect(session).toHaveProperty("webSearchMode", "off");
  const target = path.join(root, ".specloom", "history", "sessions", `${digestBytes(session.id).slice(7)}.json`);
  const raw = JSON.parse(await readFile(target, "utf8")); delete raw.webSearchMode;
  await writeFile(target, JSON.stringify(raw));
  expect((await SessionStore.open(root)).get(session.id)).toHaveProperty("webSearchMode", "off");
});

test.each(modes)("persists and exports the %s search mode across restart and import", async webSearchMode => {
  const { root, store } = await fixture(); const session = await store.create();
  expect(SessionPatchSchema.safeParse({ webSearchMode }).success).toBe(true);
  const updated = await store.patch(session.id, { webSearchMode });
  expect(updated).toHaveProperty("webSearchMode", webSearchMode);
  expect(ChatSessionSchema.safeParse(updated).success).toBe(true);
  const reopened = await SessionStore.open(root);
  expect(reopened.get(session.id)).toHaveProperty("webSearchMode", webSearchMode);
  const imported = await reopened.import(reopened.export(session.id));
  expect(imported).toHaveProperty("webSearchMode", webSearchMode);
  expect(imported.id).not.toBe(session.id);
});

test("rejects unknown search modes without changing the saved setting", async () => {
  const { store } = await fixture(); const session = await store.create();
  await expect(store.patch(session.id, { webSearchMode: "remote" } as never)).rejects.toThrow();
  expect(store.get(session.id)).toHaveProperty("webSearchMode", "off");
});

test.each(["running", "waiting"] as const)("locks the search mode for a %s session", async status => {
  const { store } = await fixture(); const session = await store.create();
  await store.update(session.id, record => { record.status = status; });
  await expect(store.patch(session.id, { webSearchMode: "free" })).rejects.toThrow(/停止|运行/);
  expect(store.get(session.id)).toHaveProperty("webSearchMode", "off");
});
