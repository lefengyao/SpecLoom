import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { DesktopController } from "../../src/main/desktop-controller";
import type { ModelVault } from "../../src/main/core/model-vault";
import { ProjectCore } from "../../src/main/core/project-core";
import type { ModelProfile, ProviderPublic } from "../../src/shared/contracts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))); });
async function project() {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-controller-")); roots.push(root);
  await writeFile(path.join(root, "project.godot"), 'config_version=5\n[application]\nconfig/name="Controller test"\n');
  return root;
}
const profile: ModelProfile = { id: "mock", name: "Mock", provider: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "mock", approved: true, timeoutMs: 1000, maxToolRounds: 2 };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((fulfill) => { resolve = fulfill; }); return { promise, resolve }; }

test("binds manual saves to a project and waits for writes before switching", async () => {
  const a = await project(), b = await project();
  const vault = { list: async () => [] } as unknown as ModelVault;
  const controller = new DesktopController(vault, a, path.resolve("skills"));
  await controller.openProject(a);
  const core = controller.currentCore();
  const saved = deferred<{ path: string; content: string; version: "absent" }>();
  vi.spyOn(core, "saveDocument").mockReturnValue(saved.promise);
  await expect(controller.saveDocument(b, "specs/outline.md", "wrong", "absent")).rejects.toMatchObject({ code: "INVALID_PROJECT" });
  const pending = controller.saveDocument(core.metadata.path, "specs/outline.md", "saved", "absent");
  await expect(controller.openProject(b)).rejects.toMatchObject({ code: "MODEL_ERROR" });
  saved.resolve({ path: "specs/outline.md", content: "saved", version: "absent" });
  await pending;
  await controller.openProject(b);
});

test("remembers an opened project for the home list and can forget it again", async () => {
  const root = await project();
  const vault = { list: async () => [], get: async () => profile } as unknown as ModelVault;
  const controller = new DesktopController(vault, root, path.resolve("skills"));
  expect((await controller.state()).recent).toEqual([]);
  await controller.openProject(root);
  const [entry] = (await controller.state()).recent;
  expect(entry).toMatchObject({ name: "Controller test", exists: true });
  expect(entry!.path).toBe(await realpath(root));
  await controller.forgetProject(entry!.path);
  expect((await controller.state()).recent).toEqual([]);
});

test("reserves the current project before asynchronous credential lookup", async () => {
  const a = await project(), b = await project();
  const key = deferred<ModelProfile>();
  const vault = { list: async () => [], get: () => key.promise } as unknown as ModelVault;
  const controller = new DesktopController(vault, a, path.resolve("skills"));
  await controller.openProject(a);
  const core = controller.currentCore();
  const run = vi.spyOn(core, "agentMessage").mockResolvedValue({ summary: "complete", toolCalls: 0, rounds: 0, messages: [] });
  const pending = controller.agent("task", "mock", "go");
  await expect(controller.openProject(b)).rejects.toMatchObject({ code: "MODEL_ERROR" });
  key.resolve(profile);
  await pending;
  expect(run).toHaveBeenCalledWith("task", { ...profile, temperature: 0.7 }, "go", expect.any(AbortSignal));
  expect(controller.currentCore()).toBe(core);
});

test("runs a standalone chat without creating a task scope", async () => {
  const root = await project();
  const vault = { list: async () => [], get: async () => profile } as unknown as ModelVault;
  const controller = new DesktopController(vault, root, path.resolve("skills"));
  await controller.openProject(root);
  const core = controller.currentCore();
  const run = vi.spyOn(core, "chatMessage").mockResolvedValue({ summary: "chat reply", toolCalls: 0, rounds: 0, messages: [] });

  await expect(controller.chat("mock", "hello", [{ role: "user", content: "previous" }])).resolves.toEqual({ summary: "chat reply", toolCalls: 0 });
  expect(run).toHaveBeenCalledWith({ ...profile, temperature: 0.7 }, "hello", [{ role: "user", content: "previous" }], expect.any(AbortSignal));
  expect((await controller.state()).tasks).toEqual([]);
});

test("forwards saved global instructions to newly created sessions", async () => {
  const root = await project();
  const requests: Array<{ messages: { role: string; content: string }[] }> = [];
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] });
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "收到" } }] }), { headers: { "Content-Type": "application/json" } });
  }));
  try {
    const vault = { list: async () => [], get: async () => profile, resolveCredential: async () => undefined } as unknown as ModelVault;
    const provider: ProviderPublic = {
      id: "fixture-provider", name: "Fixture", protocol: "openai", baseUrl: "http://localhost:11434/v1",
      models: ["mock"], modelSettings: { mock: { maxToolRounds: 2 } }, hasKey: false, keyStorage: "none",
    };
    const providerVault = { list: async () => [provider], get: async () => provider, resolveCredential: async () => undefined };
    const controller = new DesktopController(vault, root, path.resolve("skills"), providerVault as never);
    await controller.setDefaultModel({ providerId: provider.id, model: "mock" });
    await controller.updatePreferences({ customInstructions: "第一版全局要求" });
    const first = await controller.sessions.create("", "第一轮");
    await controller.sessions.send("", first.id, "你好");
    expect(requests[0]?.messages[0]?.content).toContain("第一版全局要求");

    await controller.updatePreferences({ customInstructions: "第二版全局要求" });
    const second = await controller.sessions.create("", "第二轮");
    await controller.sessions.send("", second.id, "继续");
    expect(requests[1]?.messages[0]?.content).toContain("第二版全局要求");
    expect(requests[1]?.messages[0]?.content).not.toContain("第一版全局要求");
  } finally {
    vi.unstubAllGlobals();
  }
});

test("rejects agent starts and concurrent switches throughout project opening", async () => {
  const a = await project(), b = await project();
  const vault = { list: async () => [], get: async () => profile } as unknown as ModelVault;
  const controller = new DesktopController(vault, a, path.resolve("skills"));
  await controller.openProject(a);
  const next = await ProjectCore.open(b);
  const opening = deferred<ProjectCore>();
  const entered = deferred<void>();
  vi.spyOn(ProjectCore, "open").mockImplementation(() => { entered.resolve(); return opening.promise; });
  const transition = controller.openProject(b);
  await entered.promise;
  await expect(controller.agent("task", "mock", "go")).rejects.toMatchObject({ code: "MODEL_ERROR" });
  await expect(controller.openProject(a)).rejects.toMatchObject({ code: "MODEL_ERROR" });
  opening.resolve(next);
  await transition;
  expect(controller.currentCore()).toBe(next);
});

test("persists default and session model selections across controller instances", async () => {
  const root = await project();
  const vault = { list: async () => [], get: async () => profile } as unknown as ModelVault;
  const controller = new DesktopController(vault, root, path.resolve("skills"));
  await controller.setDefaultModel({ providerId: "provider-a", model: "gpt-5" });
  await controller.setSessionModel({ providerId: "provider-a", model: "gpt-5", reasoning: "high" });
  expect(await controller.state()).toMatchObject({
    defaultModel: { providerId: "provider-a", model: "gpt-5" },
    sessionModel: { providerId: "provider-a", model: "gpt-5", reasoning: "high" },
  });
  const reopened = new DesktopController(vault, root, path.resolve("skills"));
  expect(await reopened.state()).toMatchObject({
    defaultModel: { providerId: "provider-a", model: "gpt-5" },
    sessionModel: { providerId: "provider-a", model: "gpt-5", reasoning: "high" },
  });
});

test("passes a session reasoning override into the provider runtime profile", async () => {
  const root = await project();
  const vault = { list: async () => [], get: async () => profile } as unknown as ModelVault;
  const provider: ProviderPublic = {
    id: "provider-a", name: "Provider A", protocol: "openai", baseUrl: "http://localhost:1234/v1",
    models: ["gpt-5"], modelSettings: { "gpt-5": { reasoning: "low", reasoningSupport: true, maxToolRounds: 20 } },
    hasKey: false, keyStorage: "none",
  };
  const providerVault = { list: async () => [provider], get: async () => provider, resolveCredential: async () => undefined };
  const controller = new DesktopController(vault, root, path.resolve("skills"), providerVault as never);
  await controller.openProject(root);
  await controller.setSessionModel({ providerId: provider.id, model: "gpt-5", reasoning: "high" });
  const core = controller.currentCore();
  const run = vi.spyOn(core, "agentMessage").mockResolvedValue({ summary: "complete", toolCalls: 0, rounds: 0, messages: [] });
  await controller.agent("task", { providerId: provider.id, model: "gpt-5" }, "go");
  expect(run.mock.calls[0]?.[1]).toMatchObject({ reasoning: "high", reasoningSupport: true, providerId: provider.id, model: "gpt-5" });
  expect(run.mock.calls[0]?.[1]).not.toHaveProperty("maxToolRounds");
});

test("does not turn provider storage errors into an empty provider list", async () => {
  const root = await project();
  const vault = { list: async () => [], get: async () => profile } as unknown as ModelVault;
  const providerError = Object.assign(new Error("provider vault is invalid"), { code: "MODEL_ERROR" });
  const providerVault = { list: async () => { throw providerError; }, get: async () => undefined, resolveCredential: async () => undefined };
  const controller = new DesktopController(vault, root, path.resolve("skills"), providerVault as never);

  await expect(controller.state()).rejects.toBe(providerError);
});
