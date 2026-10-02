import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { DesktopController } from "../../src/main/desktop-controller";
import type { ModelVault } from "../../src/main/core/model-vault";
import { ProjectCore } from "../../src/main/core/project-core";
import type { ModelProfile } from "../../src/shared/contracts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))); });
async function project() {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-controller-")); roots.push(root);
  await writeFile(path.join(root, "project.godot"), 'config_version=5\n[application]\nconfig/name="Controller test"\n');
  return root;
}
const profile: ModelProfile = { id: "mock", name: "Mock", provider: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "mock", approved: true, timeoutMs: 1000, maxToolRounds: 2 };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((fulfill) => { resolve = fulfill; }); return { promise, resolve }; }

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
  expect(run).toHaveBeenCalledWith("task", profile, "go", expect.any(AbortSignal));
  expect(controller.currentCore()).toBe(core);
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
