import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { DesktopController } from "../../src/main/desktop-controller";
import type { ModelVault } from "../../src/main/core/model-vault";
import { PreferencesStore } from "../../src/main/core/preferences";
import type { Preferences } from "../../src/shared/preferences";
import type { ProviderPublic, SessionModelPreference } from "../../src/shared/contracts";

const roots: string[] = [];
const controllers: DesktopController[] = [];
afterEach(async () => {
  await Promise.all(controllers.splice(0).map(controller => controller.sessions.cancelAll()));
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function setup(preferences: Partial<Preferences>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-model-fallback-")); roots.push(root);
  await new PreferencesStore(root).update(preferences);
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "收到" } }] }), { headers: { "Content-Type": "application/json" } });
  }));
  const providers: ProviderPublic[] = ["provider-a", "provider-b"].map(id => ({
    id, name: id, protocol: "openai", baseUrl: "http://model.test/v1", models: ["gpt-5", "o3"],
    modelSettings: { "gpt-5": { reasoning: "low" }, o3: { reasoning: "low" } }, hasKey: false, keyStorage: "none",
  }));
  const vault = { list: async () => [], resolveCredential: async () => undefined } as unknown as ModelVault;
  const providerVault = { list: async () => providers, get: async (id: string) => providers.find(provider => provider.id === id), resolveCredential: async () => undefined };
  // This instance deliberately starts without state(): preferences must work after a restart.
  const controller = new DesktopController(vault, root, path.resolve("skills"), providerVault as never);
  controllers.push(controller);
  return { controller, requests };
}

const defaultModel = { providerId: "provider-a", model: "gpt-5" };
const sessionModel: SessionModelPreference = { providerId: "provider-a", model: "o3", reasoning: "high" };

test.each([
  { title: "the global session model before the default model", session: sessionModel, explicit: undefined, expectedModel: "o3", expectedReasoning: "high" },
  { title: "global session reasoning when both selections use the same model", session: { ...sessionModel, model: "gpt-5" } as SessionModelPreference, explicit: undefined, expectedModel: "gpt-5", expectedReasoning: "high" },
  { title: "the default model when no session preference is saved", session: undefined, explicit: undefined, expectedModel: "gpt-5", expectedReasoning: "low" },
  { title: "an explicit session model before global selections", session: sessionModel, explicit: { ...defaultModel, reasoning: "medium" } as SessionModelPreference, expectedModel: "gpt-5", expectedReasoning: "medium" },
  { title: "the model default for an explicit inherit preference", session: sessionModel, explicit: { ...sessionModel, reasoning: "inherit" } as SessionModelPreference, expectedModel: "o3", expectedReasoning: "low" },
  { title: "an explicit off preference before global reasoning", session: sessionModel, explicit: { ...defaultModel, reasoning: "off" } as SessionModelPreference, expectedModel: "gpt-5", expectedReasoning: "minimal" },
])("sessions use $title", async ({ session, explicit, expectedModel, expectedReasoning }) => {
  const { controller, requests } = await setup({ defaultModel, ...(session ? { sessionModel: session } : {}) });
  const created = await controller.sessions.create("", "偏好检查");
  if (explicit) await controller.sessions.patch("", created.id, { model: explicit });
  await controller.sessions.send("", created.id, "你好");
  expect(requests[0]?.model).toBe(expectedModel);
  expect(requests[0]?.reasoning_effort).toBe(expectedReasoning);
});

test.each([
  { title: "restores saved reasoning without first reading state", selected: { providerId: "provider-a", model: "o3" }, expectedReasoning: "high" },
  { title: "does not transfer reasoning to another model", selected: defaultModel, expectedReasoning: "low" },
  { title: "does not transfer reasoning to another provider", selected: { providerId: "provider-b", model: "o3" }, expectedReasoning: "low" },
])("standalone chat $title", async ({ selected, expectedReasoning }) => {
  const { controller, requests } = await setup({ defaultModel, sessionModel });
  await controller.chat(selected, "你好");
  expect(requests[0]).toMatchObject({ model: selected.model, reasoning_effort: expectedReasoning });
});
