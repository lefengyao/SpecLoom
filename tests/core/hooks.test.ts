import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HooksStore } from "../../src/main/core/hooks";
import type { ToolApprovalInput } from "../../src/shared/approvals";

describe("HooksStore", () => {
  it("requires approval before executing an opaque session hook", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "specloom-hook-approval-"));
    try {
      const store = new HooksStore(root);
      const marker = path.join(root, "marker.txt");
      const command = process.platform === "win32" ? `Set-Content -LiteralPath '${marker}' -Value changed --token hook-secret` : `touch '${marker}' --token hook-secret`;
      const saved = await store.save({ name: "external mutation", event: "session.before", command, timeoutMs: 3000, enabled: true });
      const approve = vi.fn<(input: ToolApprovalInput) => Promise<boolean>>(async () => false);
      const result = await store.run(saved.id, { event: "session.before" }, { mode: "auto", onApproval: approve, signal: new AbortController().signal });
      expect(approve).toHaveBeenCalledWith(expect.objectContaining({ toolName: "Hook", risk: "high" }));
      expect(approve.mock.calls[0]?.[0]?.arguments).not.toContain("hook-secret");
      expect(result.ok).toBe(false);
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("cancelling a running hook stops its spawned command before it can write again", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "specloom-hook-cancel-"));
    try {
      const store = new HooksStore(root); const marker = path.join(root, "marker.txt").replaceAll("\\", "/");
      const code = `const fs=require('node:fs');fs.writeFileSync('${marker}','started');setTimeout(()=>fs.writeFileSync('${marker}','changed'),8000)`;
      const saved = await store.save({ name: "long hook", event: "session.before", command: `"${process.execPath}" -e "${code}"`, timeoutMs: 12000, enabled: true });
      const controller = new AbortController();
      const running = store.run(saved.id, { event: "session.before" }, { mode: "full", onApproval: async () => true, signal: controller.signal });
      await vi.waitFor(async () => expect(await readFile(marker, "utf8")).toBe("started"), { timeout: 5000 });
      controller.abort(); expect((await running).ok).toBe(false);
      expect(await readFile(marker, "utf8")).toBe("started");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("runs a hook with JSON on stdin and stores the last result", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "specloom-hooks-"));
    const store = new HooksStore(root);
    const saved = await store.save({ name: "before", event: "session.before", command: process.platform === "win32" ? "more" : "cat", timeoutMs: 3000, enabled: true });
    const result = await store.test(saved.id);
    expect(result.ok).toBe(true);
    expect((await store.list())[0]?.lastRun?.ok).toBe(true);
  });

  it("turns command failures into a result instead of throwing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "specloom-hooks-fail-"));
    const store = new HooksStore(root);
    const saved = await store.save({ name: "fail", event: "tool.after", command: process.platform === "win32" ? "exit 7" : "sh -c 'exit 7'", timeoutMs: 3000, enabled: true });
    await expect(store.run(saved.id, { event: "tool.after" })).resolves.toMatchObject({ ok: false });
  });
});

