import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiagnosticsLogStore } from "../../src/main/core/diagnostics-log";

const diagnosticId = "9c1c7c73-ec83-41bb-8e1f-6d4770039f56";

describe("DiagnosticsLogStore", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "specloom-diagnostics-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("serializes concurrent correlated events and exports only validated metadata", async () => {
    const store = new DiagnosticsLogStore(root, { now: () => new Date("2026-10-10T10:00:00.000Z") });
    await Promise.all([
      store.record({ type: "request_started", diagnosticId, attempt: 1, protocol: "openai", providerId: "p1", modelId: "m1" }),
      store.record({ type: "stream_read_error", diagnosticId, attempt: 1, protocol: "openai", errorCategory: "response_stream_error", causeCode: "UND_ERR_SOCKET" }),
    ]);
    const result = await store.list({ diagnosticId });
    expect(result.events.map(event => event.type)).toEqual(["request_started", "stream_read_error"]);
    const exportPath = path.join(root, "export.jsonl");
    await store.exportTo(exportPath);
    const exported = await readFile(exportPath, "utf8");
    expect(exported).toContain("UND_ERR_SOCKET");
    expect(exported).not.toContain("prompt");
    expect((await store.summary()).events).toBe(2);
  });

  it("rotates files, removes expired and oldest over-budget data, and clears all logs", async () => {
    let now = new Date("2026-10-10T10:00:00.000Z");
    const store = new DiagnosticsLogStore(root, { now: () => now, maxFileBytes: 360, maxBytes: 600, retentionMs: 30 * 86400000 });
    for (let index = 0; index < 7; index++) {
      await store.record({ type: "request_started", diagnosticId, attempt: 1, protocol: "openai", modelId: `model-${index}` });
      now = new Date(now.getTime() + 1000);
    }
    const names = await readdir(path.join(root, "logs"));
    expect(names.length).toBeGreaterThan(1);
    expect((await store.summary()).bytes).toBeLessThanOrEqual(600);

    now = new Date("2026-12-01T10:00:00.000Z");
    expect(await store.clearExpired()).toBeGreaterThan(0);
    expect((await store.summary()).events).toBe(0);
    await store.record({ type: "request_started", diagnosticId, attempt: 1, protocol: "openai" });
    expect(await store.clearAll()).toBe(1);
    expect((await store.summary()).files).toBe(0);
  });

  it("skips malformed rows and counts them as read issues", async () => {
    const store = new DiagnosticsLogStore(root);
    await store.record({ type: "request_started", diagnosticId, attempt: 1, protocol: "openai" });
    const file = path.join(root, "logs", (await readdir(path.join(root, "logs")))[0]!);
    await writeFile(file, `${await readFile(file, "utf8")}not-json\n`);
    const result = await store.list({});
    expect(result.events).toHaveLength(1);
    expect(result.readIssues).toBe(1);
  });
});
