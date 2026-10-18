import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { DesktopSessions } from "../../src/main/desktop-sessions";
import { ProjectCore } from "../../src/main/core/project-core";
import type { WorkspaceTools } from "../../src/main/core/tools/workspace-tools";

const roots: string[] = []; const opened: DesktopSessions[] = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(sessions => sessions.shutdown())); vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-web-session-")); roots.push(root);
  const core = await ProjectCore.open(root);
  const sessions = new DesktopSessions(root, () => core, async () => ({ id: "mock", name: "Mock", provider: "openai-compatible", protocol: "openai", model: "mock", baseUrl: "http://model.test/v1", approved: true, timeoutMs: 5000 }), async () => "", async () => undefined);
  opened.push(sessions); const session = await sessions.create(root);
  await vi.waitFor(async () => expect((await sessions.list(root))[0]?.capabilities).toBeDefined());
  return { root, sessions, session };
}
const completion = (content: string) => Response.json({ choices: [{ message: { role: "assistant", content } }] });
const call = (name: string, input: object, id = name) => Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(input) } }] } }] });

test("switching modes refreshes cached tool inventories without making network requests", async () => {
  const { root, sessions, session } = await fixture(); const fetcher = vi.fn<typeof fetch>(async () => completion("done")); vi.stubGlobal("fetch", fetcher);
  expect(session.webSearchMode).toBe("off");
  await sessions.patch(root, session.id, { webSearchMode: "free" });
  await vi.waitFor(async () => expect((await sessions.list(root))[0]!.capabilities?.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(["web_search", "web_extract"])));
  await sessions.patch(root, session.id, { webSearchMode: "native" });
  await vi.waitFor(async () => {
    const names = (await sessions.list(root))[0]!.capabilities?.tools.map(tool => tool.name) ?? [];
    expect(names).toContain("web_search"); expect(names).not.toContain("web_extract");
  });
  await sessions.patch(root, session.id, { webSearchMode: "off" });
  await vi.waitFor(async () => expect((await sessions.list(root))[0]!.capabilities?.tools.some(tool => tool.name.startsWith("web_"))).toBe(false));
  expect(fetcher).not.toHaveBeenCalled();
});

test("changing a search mode reserves the session until its cached toolbox closes", async () => {
  const { root, sessions, session } = await fixture();
  const internals = sessions as unknown as { toolboxes: Map<string, Promise<WorkspaceTools>> };
  const toolbox = await internals.toolboxes.get(`${root}\0${session.id}`)!;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); const close = toolbox.close.bind(toolbox);
  const closing = vi.spyOn(toolbox, "close").mockImplementation(async () => { await gate; await close(); });
  const patching = sessions.patch(root, session.id, { webSearchMode: "free" });
  try {
    await vi.waitFor(() => expect(closing).toHaveBeenCalled());
    await expect(sessions.send(root, session.id, "race mode mutation")).rejects.toMatchObject({ code: "MODEL_ERROR" });
  } finally { release(); await patching; }
});

test("parent and delegated agents inherit the enabled search mode and citation guidance", async () => {
  const { root, sessions, session } = await fixture(); await sessions.patch(root, session.id, { webSearchMode: "free", approvalMode: "full" });
  let parentRound = 0, childRound = 0, searches = 0;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).includes("api.anysearch.com")) { searches++; return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ results: [{ url: "https://example.com/guide", title: "Guide", snippet: "Evidence" }] }) }] } }); }
    const body = JSON.parse(String(init?.body)) as { tools: { function: { name: string } }[]; messages: { role: string; content: string | null }[] };
    expect(body.tools.map(tool => tool.function.name)).toEqual(expect.arrayContaining(["web_search", "web_extract"]));
    expect(body.messages.find(message => message.role === "system")?.content).toContain("Web search mode: free");
    if (body.messages.some(message => message.role === "user" && message.content === "child research")) return childRound++ === 0 ? call("web_search", { query: "Godot" }) : completion("Child evidence https://example.com/guide");
    if (parentRound++ === 0) return call("ToolSearch", { query: "Agent" });
    if (parentRound === 2) return call("Agent", { prompt: "child research" });
    return completion("Research complete: https://example.com/guide");
  });
  vi.stubGlobal("fetch", fetcher);
  await expect(sessions.send(root, session.id, "delegate research")).resolves.toMatchObject({ status: "completed", webSearchMode: "free" });
  expect(searches).toBe(1); expect(childRound).toBe(2); expect(parentRound).toBe(3);
});
