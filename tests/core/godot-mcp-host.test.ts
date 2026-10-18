import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GodotMcpHostRegistry } from "../../src/main/core/godot-mcp/host-registry";
import type { GodotMcpBridge } from "../../src/main/core/godot-mcp/bridge";

let root: string;
let registry: GodotMcpHostRegistry | undefined;

afterEach(async () => {
  await registry?.closeAll(); registry = undefined;
  if (root) await rm(root, { recursive: true, force: true });
});

describe("GodotMcpHostRegistry", () => {
  it("reuses a project host across calls and isolates different project roots", async () => {
    root = await mkdtemp(path.join(tmpdir(), "specloom-godot-host-"));
    const second = await mkdtemp(path.join(tmpdir(), "specloom-godot-host-"));
    const createBridge = vi.fn(() => ({
      start: vi.fn(async () => 6505),
      close: vi.fn(async () => undefined),
    } as unknown as GodotMcpBridge));
    registry = new GodotMcpHostRegistry({ createBridge });

    const firstHost = registry.forProject(root);
    expect(registry.forProject(path.resolve(root))).toBe(firstHost);
    expect(registry.forProject(second)).not.toBe(firstHost);
    expect(createBridge).toHaveBeenCalledTimes(2);
    await rm(second, { recursive: true, force: true });
  });

  it("returns diagnostics while offline and rejects other disconnected tools quickly", async () => {
    root = await mkdtemp(path.join(tmpdir(), "specloom-godot-host-"));
    registry = new GodotMcpHostRegistry({ bridgeOptions: { basePort: 0 } });
    await expect(registry.call(root, "get_diagnostics", {})).resolves.toMatchObject({ bridge: { connected: false } });
    await expect(registry.call(root, "get_project_info", {})).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
  });
});
