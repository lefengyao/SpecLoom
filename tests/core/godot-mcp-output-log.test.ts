import { afterEach, describe, expect, it, vi } from "vitest";
import { LogSnapshotStore } from "../../src/main/core/godot-mcp/output-log";

afterEach(() => vi.useRealTimers());

describe("Godot MCP output-log snapshots", () => {
  it("pages one immutable snapshot and preserves the severity filter", () => {
    const store = new LogSnapshotStore();
    const snapshot = store.createSnapshot("[ERROR] first\n[INFO] second\n[ERROR] third");
    const first = store.latestPage(snapshot.id, { limit: 1, levels: ["ERROR"] });
    expect(first.records.map(record => record.text)).toEqual(["[ERROR] third"]);
    expect(first.older_cursor).toBeTruthy();
    const previous = store.pageFromCursor(first.older_cursor!, "older", { limit: 1 });
    expect(previous.records.map(record => record.text)).toEqual(["[ERROR] first"]);
  });

  it("expires cursors after ten minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-11T00:00:00Z"));
    const store = new LogSnapshotStore();
    const snapshot = store.createSnapshot("line 1\nline 2", false, Date.now());
    const page = store.latestPage(snapshot.id, { limit: 1 });
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    expect(() => store.pageFromCursor(page.older_cursor!, "older", { limit: 1 })).toThrow(/stale|expired/i);
  });
});
