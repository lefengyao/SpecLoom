import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DesktopSessions } from "../../src/main/desktop-sessions";
import { ProjectCore } from "../../src/main/core/project-core";
import type { ChatSession } from "../../src/shared/chat";

const roots: string[] = [];
const sessionsToClose: DesktopSessions[] = [];
afterEach(async () => {
  await Promise.all(sessionsToClose.splice(0).map(sessions => sessions.cancelAll()));
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const profile = { id: "model", name: "Fixture", provider: "openai-compatible" as const, model: "fixture", baseUrl: "http://localhost:9999/v1", approved: true, timeoutMs: 5000 };
async function fixture(credential?: string) {
  const root = await mkdtemp(path.join(tmpdir(), "specloom-session-approval-")); roots.push(root);
  const external = await mkdtemp(path.join(tmpdir(), "specloom-external-approval-")); roots.push(external);
  const core = await ProjectCore.open(root);
  const sessions = new DesktopSessions(root, () => core, async () => profile, async () => "", async () => credential);
  sessionsToClose.push(sessions);
  return { root, external, sessions, session: await sessions.create(root) };
}
function response(message: unknown) { return new Response(JSON.stringify({ choices: [{ message }] }), { headers: { "content-type": "application/json" } }); }
function tool(name: string, input: unknown) { return { role: "assistant", content: null, tool_calls: [{ id: `${name}-call`, type: "function", function: { name, arguments: JSON.stringify(input) } }] }; }
function approvals(session: ChatSession) { return session.items.filter(item => item.kind === "approval"); }
async function pending(sessions: DesktopSessions, root: string, id: string) {
  let result: ChatSession | undefined;
  await vi.waitFor(async () => {
    result = (await sessions.list(root)).find(session => session.id === id);
    expect(result?.status).toBe("waiting");
    expect(result && approvals(result).find(item => item.status === "waiting")).toBeDefined();
  }, { timeout: 5000 });
  return approvals(result!).find(item => item.status === "waiting")!;
}

test("session approval blocks external writes, resumes once and locks mode during a run", async () => {
  const { root, external, sessions, session } = await fixture();
  const target = path.join(external, "approved.txt"); let count = 0;
  vi.stubGlobal("fetch", vi.fn(async () => response(++count === 1 ? tool("Write", { path: target, content: "approved" }) : { role: "assistant", content: "done" })));
  const run = sessions.send(root, session.id, "write external file");
  const request = await pending(sessions, root, session.id);
  await expect(readFile(target, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  await expect(sessions.patch(root, session.id, { approvalMode: "full" })).rejects.toThrow(/停止|运行/);
  await sessions.approve(root, session.id, request.request.runId, request.request.id, true);
  const result = await run;
  expect(result.status).toBe("completed");
  expect(await readFile(target, "utf8")).toBe("approved");
  expect(approvals(result)).toMatchObject([{ status: "approved" }]);
  await expect(sessions.approve(root, session.id, request.request.runId, request.request.id, true)).resolves.toMatchObject({ status: "completed" });
  await expect(sessions.approve(root, session.id, request.request.runId, request.request.id, false)).rejects.toThrow();
  expect(count).toBe(2);
});

test("children inherit approval policy and a rejection reaches the model without executing", async () => {
  const { root, external, sessions, session } = await fixture();
  await sessions.patch(root, session.id, { approvalMode: "ask" });
  const target = path.join(external, "denied.txt"); const bodies: { messages: { role: string; content: string }[] }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const next = [tool("ToolSearch", { query: "Agent" }), tool("Agent", { prompt: "child", title: "child" }), tool("Write", { path: target, content: "denied" }), { role: "assistant", content: "child handled denial" }, { role: "assistant", content: "done" }][bodies.length - 1];
    return response(next);
  }));
  const run = sessions.send(root, session.id, "delegate external write");
  const request = await pending(sessions, root, session.id);
  expect(request.request.toolName).toBe("Write");
  await sessions.approve(root, session.id, request.request.runId, request.request.id, false);
  const result = await run;
  expect(result.status).toBe("completed");
  expect(approvals(result)).toMatchObject([{ status: "denied" }]);
  expect(bodies[3]!.messages.some(message => message.role === "tool" && /批准|拒绝|denied/i.test(message.content))).toBe(true);
  await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
});

test("full access skips approval and cancellation cannot grant a stale pending action", async () => {
  const { root, external, sessions, session } = await fixture();
  const target = path.join(external, "full.txt"); let count = 0;
  vi.stubGlobal("fetch", vi.fn(async () => response(++count % 2 === 1 ? tool("Write", { path: target, content: "full" }) : { role: "assistant", content: "done" })));
  await sessions.patch(root, session.id, { approvalMode: "full" });
  const completed = await sessions.send(root, session.id, "full access");
  expect(approvals(completed)).toEqual([]);
  expect(await readFile(target, "utf8")).toBe("full");
  await sessions.patch(root, session.id, { approvalMode: "ask" });
  const cancelledTarget = path.join(external, "cancelled.txt"); count = 0;
  vi.stubGlobal("fetch", vi.fn(async () => response(tool("Write", { path: cancelledTarget, content: "cancelled" }))));
  const outcome = sessions.send(root, session.id, "cancel action").catch(error => error);
  const request = await pending(sessions, root, session.id);
  await sessions.cancel(root, session.id); await outcome;
  expect((await sessions.list(root)).find(item => item.id === session.id)?.status).toBe("cancelled");
  await expect(sessions.approve(root, session.id, request.request.runId, request.request.id, true)).rejects.toThrow();
  await expect(readFile(cancelledTarget)).rejects.toMatchObject({ code: "ENOENT" });
});

test("approval details never expose the configured model credential", async () => {
  const secret = "fixture-provider-secret-4397";
  const { root, external, sessions, session } = await fixture(secret); let count = 0;
  vi.stubGlobal("fetch", vi.fn(async () => response(++count === 1 ? tool("Write", { path: path.join(external, "secret.txt"), content: secret }) : { role: "assistant", content: "done" })));
  const run = sessions.send(root, session.id, "check redaction");
  const request = await pending(sessions, root, session.id);
  expect(request.request.arguments).not.toContain(secret);
  await sessions.approve(root, session.id, request.request.runId, request.request.id, false);
  await run;
});
