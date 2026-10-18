import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { DesktopSessions } from "../../src/main/desktop-sessions";
import { ProjectCore } from "../../src/main/core/project-core";
import type { SessionRuns } from "../../src/main/core/session-runs";
import type { WorkspaceTools } from "../../src/main/core/tools/workspace-tools";
import type { RuntimeModelProfile } from "../../src/main/core/model-config";

const roots: string[] = [];
const allSessions: DesktopSessions[] = [];
afterEach(async () => {
  await Promise.all(allSessions.splice(0).map(sessions => sessions.shutdown()));
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
function deferred() { let resolve!: () => void; const promise = new Promise<void>(fulfill => { resolve = fulfill; }); return { promise, resolve }; }
const profile: RuntimeModelProfile = { id: "fixture", name: "Fixture", provider: "openai-compatible", protocol: "openai", baseUrl: "http://model.test/v1", model: "mock", approved: true, timeoutMs: 5000 };
async function fixture(getProfile: () => Promise<RuntimeModelProfile> = async () => profile) {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-session-reservation-")); roots.push(root);
  const core = await ProjectCore.open(root);
  const sessions = new DesktopSessions(root, () => core, getProfile, async () => "", async () => undefined);
  allSessions.push(sessions);
  const session = await sessions.create(root);
  await vi.waitFor(async () => expect((await sessions.list(root))[0]?.capabilities).toBeDefined());
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "done" } }] }), { headers: { "Content-Type": "application/json" } })));
  const internals = sessions as unknown as { stopCapabilities(projectPath: string, id: string): Promise<void>; workspaces: Map<string, Promise<SessionRuns>>; toolboxes: Map<string, Promise<WorkspaceTools>> };
  return { root, sessions, session, internals, runs: await internals.workspaces.get(root)! };
}

test("deletion reserves a session while awaited capability shutdown is pending", async () => {
  const { root, sessions, session, internals, runs } = await fixture();
  const entered = deferred(), release = deferred();
  vi.spyOn(internals, "stopCapabilities").mockImplementation(async () => { entered.resolve(); await release.promise; });
  const removing = sessions.remove(root, session.id);
  try {
    await entered.promise;
    expect(sessions.running).toBe(true);
    await expect(sessions.send(root, session.id, "race deletion")).rejects.toMatchObject({ code: "MODEL_ERROR" });
  } finally { release.resolve(); await removing; }
  expect(runs.store.list()).toEqual([]);
});

test("approval changes reserve a session until its previous toolbox is closed", async () => {
  const { root, sessions, session, internals } = await fixture();
  const entered = deferred(), release = deferred();
  const toolbox = await internals.toolboxes.get(`${root}\0${session.id}`)!;
  const close = toolbox.close.bind(toolbox);
  vi.spyOn(toolbox, "close").mockImplementation(async () => { entered.resolve(); await release.promise; await close(); });
  const patching = sessions.patch(root, session.id, { approvalMode: "full" });
  try {
    await entered.promise;
    await expect(sessions.send(root, session.id, "race permissions")).rejects.toMatchObject({ code: "MODEL_ERROR" });
  } finally { release.resolve(); await patching; }
  await expect(sessions.send(root, session.id, "after permissions")).resolves.toMatchObject({ status: "completed", approvalMode: "full" });
});

test("archive mutation reserves a session before its store write completes", async () => {
  const { root, sessions, session, runs } = await fixture();
  const entered = deferred(), release = deferred();
  const patch = runs.store.patch.bind(runs.store);
  vi.spyOn(runs.store, "patch").mockImplementation(async (...args) => { entered.resolve(); await release.promise; return patch(...args); });
  const patching = sessions.patch(root, session.id, { archived: true });
  try {
    await entered.promise;
    await expect(sessions.send(root, session.id, "race archive")).rejects.toMatchObject({ code: "MODEL_ERROR" });
  } finally { release.resolve(); await patching; }
});

test("a failed mutation releases the reservation for a later send", async () => {
  const { root, sessions, session, runs } = await fixture();
  vi.spyOn(runs.store, "patch").mockRejectedValueOnce(new Error("disk unavailable"));
  await expect(sessions.patch(root, session.id, { archived: true })).rejects.toThrow("disk unavailable");
  await expect(sessions.send(root, session.id, "after failure")).resolves.toMatchObject({ status: "completed" });
});

test("guidance and cancellation can operate during a reserved send", async () => {
  const { root, sessions, session } = await fixture();
  const requested = deferred();
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_url, init) => {
    requested.resolve();
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
  }));
  const sending = sessions.send(root, session.id, "wait for guidance");
  const rejected = expect(sending).rejects.toThrow();
  await requested.promise;
  const current = (await sessions.list(root)).find(candidate => candidate.id === session.id)!;
  await expect(sessions.guide(root, session.id, current.runId!, "guidance", "new direction")).resolves.toMatchObject({ id: session.id });
  await sessions.cancel(root, session.id);
  await rejected;
});

test("shutdown completes while a cancelled send is still awaiting its model", async () => {
  const entered = deferred(), release = deferred();
  const { root, sessions, session } = await fixture(async () => { entered.resolve(); await release.promise; return profile; });
  const sending = sessions.send(root, session.id, "slow model lookup").catch(() => undefined);
  await entered.promise;
  let closed = false;
  const closing = sessions.shutdown().then(() => { closed = true; });
  try {
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 1000 });
  } finally { release.resolve(); await sending; await closing; }
});

test("a cancelled model lookup cannot reconfigure the newer run's shared toolbox", async () => {
  const entered = deferred(), release = deferred(), resumed = deferred(); let lookups = 0;
  const { root, sessions, session, internals, runs } = await fixture(async () => {
    if (++lookups === 1) { entered.resolve(); await release.promise; resumed.resolve(); }
    return profile;
  });
  const tools = await internals.toolboxes.get(`${root}\0${session.id}`)!;
  const permissions = vi.spyOn(tools, "setPermissions"), webSearch = vi.spyOn(tools, "setWebSearch"), delegate = vi.spyOn(tools, "setDelegate"), refresh = vi.spyOn(tools, "refresh");
  const first = sessions.send(root, session.id, "delayed old setup").catch(error => error);
  await entered.promise; await sessions.cancel(root, session.id); await first;
  const requested = deferred(); let finish!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => { requested.resolve(); return new Promise<Response>(resolve => { finish = resolve; }); }));
  const second = sessions.send(root, session.id, "new active setup");
  try {
    await requested.promise;
    permissions.mockClear(); webSearch.mockClear(); delegate.mockClear(); refresh.mockClear();
    const before = runs.store.get(session.id);
    release.resolve(); await resumed.promise; await new Promise<void>(resolve => setImmediate(resolve));
    expect(permissions).not.toHaveBeenCalled(); expect(webSearch).not.toHaveBeenCalled(); expect(delegate).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
    expect(runs.store.get(session.id)).toEqual(before);
  } finally {
    release.resolve(); finish(new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "new run done" } }] }), { headers: { "Content-Type": "application/json" } }));
    await second;
  }
});
