import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { PreferencesStore } from "../../src/main/core/preferences";
import {
  customInstructionsLimit,
  defaultPreferences,
  PreferencesPatchSchema,
  normalizePreferences,
} from "../../src/shared/preferences";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const pngAvatar = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=";

test("ships the official paper theme and loom accent as defaults", () => {
  expect(defaultPreferences.theme).toBe("paper");
  expect(defaultPreferences.accent).toBe("loom");
});

test("persists independent avatars, keeps old preferences compatible, and resets one avatar", async () => {
  const root = await directory();
  const store = new PreferencesStore(root);
  expect(normalizePreferences(defaultPreferences)).toEqual(defaultPreferences);
  await store.update({ userAvatar: pngAvatar, assistantAvatar: pngAvatar });
  expect(await new PreferencesStore(root).get()).toMatchObject({ userAvatar: pngAvatar, assistantAvatar: pngAvatar });
  await store.update({ userAvatar: "" });
  expect(await new PreferencesStore(root).get()).toMatchObject({ userAvatar: "", assistantAvatar: pngAvatar });
});

test("rejects SVG, forged raster MIME, malformed base64 and oversized avatar patches", () => {
  expect(PreferencesPatchSchema.safeParse({ userAvatar: pngAvatar }).success).toBe(true);
  expect(PreferencesPatchSchema.safeParse({ assistantAvatar: "" }).success).toBe(true);
  for (const avatar of [
    "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
    "data:image/png;base64,PHN2Zz48L3N2Zz4=",
    "data:image/png;base64,!!!!",
    "data:image/png;base64," + Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(262_144)]).toString("base64"),
  ]) expect(PreferencesPatchSchema.safeParse({ userAvatar: avatar }).success).toBe(false);
  expect(normalizePreferences({ ...defaultPreferences, userAvatar: "data:image/png;base64,PHN2Zz48L3N2Zz4=", assistantAvatar: pngAvatar })).toEqual({ ...defaultPreferences, assistantAvatar: pngAvatar });
});

async function directory() {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-preferences-"));
  roots.push(root);
  return root;
}

describe("application preferences", () => {
  test("starts from the defaults when nothing was stored yet", async () => {
    const root = await directory();
    expect(await new PreferencesStore(root).get()).toEqual(defaultPreferences);
  });

  test("merges a partial update and writes it back", async () => {
    const root = await directory();
    const store = new PreferencesStore(root);
    await store.update({ theme: "dark" });
    const next = await store.update({ accent: "rose", customInstructions: "回答先给结论。" });
    expect(next).toEqual({
      ...defaultPreferences,
      theme: "dark",
      accent: "rose",
      customInstructions: "回答先给结论。",
    });
    expect(
      JSON.parse(await readFile(path.join(root, "preferences.json"), "utf8")),
    ).toEqual(next);
    expect(await store.get()).toEqual(next);
  });

  test("falls back to defaults instead of failing on a corrupt or hostile file", async () => {
    const root = await directory();
    const store = new PreferencesStore(root);
    await writeFile(path.join(root, "preferences.json"), "{ not json", "utf8");
    expect(await store.get()).toEqual(defaultPreferences);

    await writeFile(
      path.join(root, "preferences.json"),
      JSON.stringify({
        theme: "neon",
        accent: 9,
        style: null,
        completionSound: "yes",
        customInstructions: 42,
      }),
      "utf8",
    );
    expect(await store.get()).toEqual(defaultPreferences);
  });

  test("keeps valid fields while repairing the invalid ones", async () => {
    const root = await directory();
    await writeFile(
      path.join(root, "preferences.json"),
      JSON.stringify({
        theme: "light",
        accent: "violet",
        style: "compact",
        completionSound: false,
        customInstructions: "  只改最小范围  ",
      }),
      "utf8",
    );
    expect(await new PreferencesStore(root).get()).toEqual({
      theme: "light",
      accent: "violet",
      style: "compact",
      completionSound: false,
      customInstructions: "  只改最小范围  ",
      hideAgentDetails: defaultPreferences.hideAgentDetails,
      showOutputRate: defaultPreferences.showOutputRate,
      showFirstTokenLatency: defaultPreferences.showFirstTokenLatency,
      showThinkingDuration: defaultPreferences.showThinkingDuration,
      agentTemperature: defaultPreferences.agentTemperature,
      godotPath: defaultPreferences.godotPath,
      externalEditorPath: defaultPreferences.externalEditorPath,
    });
  });

  test("clamps an oversized custom prompt to the supported length", async () => {
    const root = await directory();
    const store = new PreferencesStore(root);
    const saved = await store.update({
      customInstructions: "字".repeat(customInstructionsLimit + 500),
    });
    expect(saved.customInstructions).toHaveLength(customInstructionsLimit);
  });

  test("writes only inside its own directory", async () => {
    const root = await directory();
    await new PreferencesStore(root).update({ theme: "dark" });
    expect(
      JSON.parse(await readFile(path.join(root, "preferences.json"), "utf8")),
    ).toMatchObject({ theme: "dark" });
  });

  test("keeps both patches when two updates are issued in the same tick", async () => {
    // Regression: an unserialized read-modify-write dropped one of two rapid edits,
    // which a user would see as "I changed it but it snapped back".
    const root = await directory();
    const store = new PreferencesStore(root);
    const [first, second] = await Promise.all([
      store.update({ accent: "indigo" }),
      store.update({ style: "compact" }),
    ]);
    expect(first).toMatchObject({ accent: "indigo" });
    expect(second).toMatchObject({ accent: "indigo", style: "compact" });
    const onDisk = JSON.parse(
      await readFile(path.join(root, "preferences.json"), "utf8"),
    );
    expect(onDisk).toMatchObject({ accent: "indigo", style: "compact" });
    expect(await store.get()).toEqual(onDisk);
  });

  test("persists the default model and session reasoning preference across store instances", async () => {
    const root = await directory();
    const store = new PreferencesStore(root);
    await store.update({
      defaultModel: { providerId: "provider-a", model: "gpt-5" },
      sessionModel: { providerId: "provider-a", model: "gpt-5", reasoning: "high" },
    });
    expect(await new PreferencesStore(root).get()).toMatchObject({
      defaultModel: { providerId: "provider-a", model: "gpt-5" },
      sessionModel: { providerId: "provider-a", model: "gpt-5", reasoning: "high" },
    });
  });

  test("drops malformed model selections while preserving ordinary preferences", async () => {
    const root = await directory();
    await writeFile(path.join(root, "preferences.json"), JSON.stringify({
      ...defaultPreferences,
      theme: "dark",
      defaultModel: { providerId: "", model: "" },
      sessionModel: { providerId: "provider-a", model: "gpt-5", reasoning: "turbo" },
    }), "utf8");
    expect(await new PreferencesStore(root).get()).toMatchObject({ theme: "dark" });
    expect(await new PreferencesStore(root).get()).not.toHaveProperty("defaultModel");
    expect(await new PreferencesStore(root).get()).not.toHaveProperty("sessionModel");
  });
});
