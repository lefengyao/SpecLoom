import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { DesktopSessions } from "../../src/main/desktop-sessions";
import { ProjectCore } from "../../src/main/core/project-core";
import { gitQueryEnvironment } from "../../src/main/core/git-query";

const roots: string[] = [];
const hosts: DesktopSessions[] = [];
afterEach(async () => { await Promise.all(hosts.splice(0).map(host => host.cancelAll())); vi.unstubAllGlobals(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const profile = { id: "context-test", name: "Context", provider: "openai-compatible" as const, model: "fixture", baseUrl: "http://model.test/v1", approved: true, timeoutMs: 10_000 };
async function project() { const root = await mkdtemp(path.join(os.tmpdir(), "specloom-context-chat-")); roots.push(root); await writeFile(path.join(root, "README.md"), "# Existing project"); return { root, core: await ProjectCore.open(root) }; }
function capture() {
  const systems: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as { messages: { role: string; content: string }[] };
    systems.push(request.messages.find(message => message.role === "system")?.content ?? "");
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "收到。" } }] }), { headers: { "content-type": "application/json" } });
  }));
  return systems;
}
test("modern sessions inject project facts on actual chats, suggest init once, and refresh after Git changes", async () => {
  const { root, core } = await project(); const systems = capture();
  const host = new DesktopSessions(root, () => core, async () => profile, async () => "operator context", async () => undefined); hosts.push(host);
  const session = await host.create(root); await host.list(root);
  expect(systems).toHaveLength(0);
  await host.send(root, session.id, "你好");
  expect(systems[0]).toContain('"state":"not-repository"'); expect(systems[0]).toContain('"path":"README.md"');
  expect(systems[0]).toContain("建议用户使用 git init"); expect(systems[0]).toContain("operator context");
  await host.send(root, session.id, "继续"); expect(systems[1]).not.toContain("建议用户使用 git init");
  execFileSync("git", ["init", "-b", "main"], { cwd: root, env: gitQueryEnvironment(), windowsHide: true, stdio: "pipe" });
  await host.send(root, session.id, "现在分支是什么"); expect(systems[2]).toContain('"kind":"unborn","name":"main"');
  await host.cancelAll();
  const reopened = new DesktopSessions(root, () => core, async () => profile, async () => "", async () => undefined); hosts.push(reopened);
  await reopened.send(root, session.id, "重启后继续"); expect(systems[3]).not.toContain("建议用户使用 git init");
});
test("legacy task and compatible chat use runtime facts without changing scope or requiring the updated skill", async () => {
  const { core } = await project(); const systems = capture();
  const scope = { id: "limited", title: "limited", readPaths: ["specs/**"], writePaths: [], mode: "manual" as const, allowDelete: false };
  await core.createTask(scope); await core.agentMessage(scope.id, profile, "你好");
  expect(systems[0]).toContain('"state":"not-repository"'); expect(systems[0]).toContain('"readPaths":["specs/**"],"writePaths":[]');
  expect(systems[0]).toContain("legacy changes.commit requires the exact reviewed digest");
  const first = await core.chatMessage(profile, "你好");
  expect(systems[1]).toContain("建议用户使用 git init");
  await core.chatMessage(profile, "继续", first.messages.filter(message => message.role !== "system")); expect(systems[2]).not.toContain("建议用户使用 git init");
});
