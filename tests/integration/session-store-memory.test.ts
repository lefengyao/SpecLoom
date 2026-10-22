import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { SessionStore } from "../../src/main/core/session-store";

test("mutate changes memory without writing until checkpoint", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-session-memory-"));
  try {
    const store = await SessionStore.open(root);
    const session = await store.create("memory");

    const updated = await store.mutate(session.id, (record) => {
      record.status = "running";
      record.items.push({
        id: `${session.id}:reply`,
        kind: "message",
        role: "assistant",
        content: "partial",
        partial: true,
      });
      record.seq++;
    });

    expect(updated.status).toBe("running");
    expect(updated.items.find((item) => item.id === `${session.id}:reply`)).toMatchObject({
      kind: "message",
      role: "assistant",
      content: "partial",
      partial: true,
    });

    const beforeCheckpoint = await SessionStore.open(root);
    expect(beforeCheckpoint.get(session.id).items.some((item) => item.id === `${session.id}:reply`)).toBe(false);

    await store.checkpoint(session.id);

    const afterCheckpoint = await SessionStore.open(root);
    expect(afterCheckpoint.get(session.id).items.find((item) => item.id === `${session.id}:reply`)).toMatchObject({
      kind: "message",
      role: "assistant",
      content: "partial",
      partial: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkpoint validates the in-memory record before persisting", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-session-memory-validation-"));
  try {
    const store = await SessionStore.open(root);
    const session = await store.create("memory");

    await store.mutate(session.id, (record) => {
      record.items.push({ id: "broken", kind: "message" } as never);
    });

    await expect(store.checkpoint(session.id)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
