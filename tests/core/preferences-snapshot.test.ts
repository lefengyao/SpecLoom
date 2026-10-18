import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { PreferencesStore } from "../../src/main/core/preferences";
import { defaultPreferences } from "../../src/shared/preferences";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
test("the synchronous preference snapshot follows loaded and committed updates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-preference-snapshot-")); roots.push(root);
  await writeFile(path.join(root, "preferences.json"), JSON.stringify({ customInstructions: "stored" }));
  const preferences = new PreferencesStore(root);
  expect(preferences.snapshot).toEqual(defaultPreferences);
  await preferences.get();
  expect(preferences.snapshot.customInstructions).toBe("stored");
  await preferences.update({ customInstructions: "updated" });
  expect(preferences.snapshot.customInstructions).toBe("updated");
});
