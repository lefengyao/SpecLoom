import { describe, expect, it, vi } from "vitest";
import { DesktopSessions } from "../../src/main/desktop-sessions";
import type { SessionRuns } from "../../src/main/core/session-runs";
import type { ProjectCore } from "../../src/main/core/project-core";

describe("session shutdown during workspace initialization", () => {
  it("prevents a pending send from registering a live run after shutdown starts", async () => {
    const core = { metadata: { path: "/fixture" } } as ProjectCore;
    const sessions = new DesktopSessions("/data", () => core, async () => { throw new Error("must not request a model"); }, async () => "", async () => undefined);
    let initialized!: (runs: SessionRuns) => void;
    const pending = new Promise<SessionRuns>((resolve) => { initialized = resolve; });
    const workspaces = (sessions as unknown as { workspaces: Map<string, Promise<SessionRuns>> }).workspaces;
    workspaces.set("/fixture", pending);
    const send = vi.fn();
    const cancelAll = vi.fn(async () => undefined);
    const sending = sessions.send("/fixture", "session", "delayed initialization");
    const rejected = expect(sending).rejects.toMatchObject({ code: "MODEL_ERROR", message: "SpecLoom 正在关闭" });
    const closing = sessions.shutdown();
    initialized({ send, cancelAll } as unknown as SessionRuns);
    await Promise.all([rejected, closing]);
    expect(send).not.toHaveBeenCalled();
    expect(cancelAll).toHaveBeenCalledOnce();
    await expect(sessions.send("/fixture", "session", "late invocation")).rejects.toThrow("正在关闭");
  });
});
