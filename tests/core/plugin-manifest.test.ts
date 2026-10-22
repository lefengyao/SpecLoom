import { expect, test } from "vitest";
import { PluginManifestSchema, pluginPageId } from "../../src/shared/plugins";

test("accepts a declared plugin page", () => {
  const manifest = PluginManifestSchema.parse({
    id: "specloom-git", name: "Git", version: "0.1.0", apiVersion: 1,
    main: "main/index.mjs",
    contributes: { pages: [{ id: "git", title: "Git", entry: "renderer/index.html" }] },
    permissions: ["git:read"],
  });
  expect(manifest.contributes?.pages?.[0]?.id).toBe("git");
  expect(pluginPageId("specloom-git", "git")).toBe("plugin:specloom-git:git");
});

test("rejects traversal and absolute entries", () => {
  const base = { id: "x", name: "X", version: "0.1.0", apiVersion: 1, main: "main/index.mjs" };
  expect(() => PluginManifestSchema.parse({ ...base, main: "../evil.mjs" })).toThrow();
  expect(() => PluginManifestSchema.parse({ ...base, main: "/tmp/evil.mjs" })).toThrow();
});
