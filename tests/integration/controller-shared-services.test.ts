import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { DesktopController, type DesktopSharedServices } from "../../src/main/desktop-controller";
import type { ModelVault } from "../../src/main/core/model-vault";
import type { ProviderVault } from "../../src/main/core/provider-vault";
import { PreferencesStore } from "../../src/main/core/preferences";
import { RecentProjects } from "../../src/main/core/recent-projects";
import { OfflineDocumentStore } from "../../src/main/core/offline-documents";
import { HooksStore } from "../../src/main/core/hooks";
import { SkillStore } from "../../src/main/core/skill-store";
import type { ModelProfile } from "../../src/shared/contracts";

const roots: string[] = [];
const controllers: DesktopController[] = [];
afterEach(async () => {
  await Promise.all(controllers.splice(0).map(controller => controller.shutdown()));
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-shared-services-")); roots.push(root);
  await writeFile(path.join(root, "project.godot"), 'config_version=5\n[application]\nconfig/name="Shared services"\n');
  const shared: DesktopSharedServices = {
    preferences: new PreferencesStore(root), recentProjects: new RecentProjects(root),
    offlineDocuments: new OfflineDocumentStore(root), hooks: new HooksStore(root), skills: new SkillStore(root),
  };
  const profile: ModelProfile = { id: "fixture", name: "Fixture", provider: "openai-compatible", baseUrl: "http://model.test/v1", model: "mock", approved: true, timeoutMs: 5000 };
  const vault = { list: async () => [], get: async () => profile, resolveCredential: async () => undefined } as unknown as ModelVault;
  const providers = { list: async () => [], remove: async () => [] } as unknown as ProviderVault;
  const left = new DesktopController(vault, root, path.resolve("skills"), providers, shared);
  const right = new DesktopController(vault, root, path.resolve("skills"), providers, shared);
  controllers.push(left, right);
  return { root, shared, left, right };
}

test("controllers reuse the supplied application stores and see peer preference updates", async () => {
  const { shared, left, right } = await fixture();
  expect(left.offlineDocuments).toBe(shared.offlineDocuments);
  expect(right.hooks).toBe(shared.hooks);
  expect(left.skills).toBe(shared.skills);
  await right.state();
  await left.updatePreferences({ customInstructions: "shared update" });
  expect((await right.state()).preferences.customInstructions).toBe("shared update");
});

test("an open core reads operator instructions changed by another controller", async () => {
  const { root, left, right } = await fixture();
  await left.updatePreferences({ customInstructions: "old instructions" });
  await left.openProject(root);
  await right.updatePreferences({ customInstructions: "new instructions" });
  let system = "";
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
    system = body.messages.find(message => message.role === "system")?.content ?? "";
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "done" } }] }), { headers: { "Content-Type": "application/json" } });
  }));
  await left.chat("fixture", "hello");
  expect(system).toContain("new instructions");
  expect(system).not.toContain("old instructions");
});

test("provider removal clears model references selected by another controller", async () => {
  const { shared, left, right } = await fixture();
  await left.state();
  await right.setDefaultModel({ providerId: "removed", model: "mock" });
  await right.setSessionModel({ providerId: "removed", model: "mock", reasoning: "high" });
  await left.removeProvider("removed");
  expect((await shared.preferences.get()).defaultModel).toBeUndefined();
  expect((await shared.preferences.get()).sessionModel).toBeUndefined();
});

test("provider removal preserves a peer's newer selection of another provider", async () => {
  const { shared, left, right } = await fixture();
  await left.setDefaultModel({ providerId: "removed", model: "mock" });
  await right.setDefaultModel({ providerId: "retained", model: "mock" });
  await left.removeProvider("removed");
  expect((await shared.preferences.get()).defaultModel).toEqual({ providerId: "retained", model: "mock" });
});

test.each(["runs", "chatRuns", "sessions", "opening", "materialWrites"] as const)("busy includes the %s transition reservation", async source => {
  const { left } = await fixture();
  expect(left.busy).toBe(false);
  const internal = left as unknown as { runs: Map<string, AbortController>; chatRuns: Map<string, AbortController>; opening: boolean; materialWrites: number };
  if (source === "runs" || source === "chatRuns") internal[source].set("fixture", new AbortController());
  else if (source === "sessions") vi.spyOn(left.sessions, "running", "get").mockReturnValue(true);
  else if (source === "opening") internal.opening = true;
  else internal.materialWrites = 1;
  expect(left.busy).toBe(true);
  if (source === "runs" || source === "chatRuns") internal[source].clear();
  else if (source === "sessions") vi.restoreAllMocks();
  else if (source === "opening") internal.opening = false;
  else internal.materialWrites = 0;
  expect(left.busy).toBe(false);
});
