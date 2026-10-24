import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { McpCredentialStore } from "../../src/main/core/mcp-credentials";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-mcp-credentials-"));
  roots.push(root);
  return { root, store: new McpCredentialStore(root) };
}

test("keeps a stable token and port per key and rotates only that key", async () => {
  const { root, store } = await fixture();
  const first = { token: "a".repeat(64), port: 43123 };
  const second = { token: "b".repeat(64), port: 43124 };
  await store.remember("project-a", first);
  await store.remember("project-b", second);

  expect(await new McpCredentialStore(root).get("project-a")).toEqual(first);
  const rotated = await store.rotate("project-a");
  expect(rotated.token).toMatch(/^[a-f0-9]{64}$/);
  expect(rotated.token).not.toBe(first.token);
  expect(rotated.port).toBe(first.port);
  expect(await store.get("project-b")).toEqual(second);
});

test("ignores a corrupt credentials file instead of breaking MCP startup", async () => {
  const { root, store } = await fixture();
  await writeFile(path.join(root, "mcp-credentials.json"), "{not json");
  expect(await store.get("project-a")).toBeUndefined();
  const credential = await store.rotate("project-a");
  expect(await store.get("project-a")).toEqual(credential);
});
