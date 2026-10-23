import { appendFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { UsageStore } from "../../src/main/core/usage-store";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const record = (at: number) => ({ at, workspaceId: "E:\\project", sessionId: "s1", providerId: "p", providerName: "P", model: "m", promptTokens: 10, completionTokens: 5, cachedTokens: 2, cacheWriteTokens: 0, status: "completed" as const, usageSource: "actual" as const });

test("appends records and skips a damaged line", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-usage-")); roots.push(root);
  const store = new UsageStore(root);
  await store.append(record(1));
  await appendFile(path.join(root, "usage.jsonl"), "{not json}\n", "utf8");
  await store.append(record(2));
  expect((await store.list()).map((item) => item.at)).toEqual([1, 2]);
});

test("serializes concurrent appends", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-usage-")); roots.push(root);
  const store = new UsageStore(root);
  await Promise.all(Array.from({ length: 25 }, (_, index) => store.append(record(index))));
  expect((await store.list()).length).toBe(25);
});
