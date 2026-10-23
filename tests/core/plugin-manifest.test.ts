import { expect, test } from "vitest";
import { PLUGIN_API_VERSION, PluginManifestSchema, pluginPageId } from "../../src/shared/plugins";

test("accepts API v2 native pages and command-only plugins", () => {
  expect(PLUGIN_API_VERSION).toBe(2);
  const manifest = PluginManifestSchema.parse({
    id: "specloom-git", name: "Git", version: "0.1.0", apiVersion: 2,
    main: "main/index.mjs",
    nativePages: [{ id: "git", title: "Git", icon: "git-branch" }],
  });
  expect(manifest.nativePages?.[0]?.id).toBe("git");
  expect(pluginPageId("specloom-git", "git")).toBe("plugin:specloom-git:git");
  expect(PluginManifestSchema.parse({ id: "x", name: "X", version: "1", apiVersion: 2, main: "main/index.mjs" }).nativePages).toBeUndefined();
});

test("rejects old API version, HTML pages, and unsafe paths", () => {
  const base = { id: "x", name: "X", version: "1", apiVersion: 2, main: "main/index.mjs" };
  expect(() => PluginManifestSchema.parse({ ...base, apiVersion: 1 })).toThrow();
  expect(() => PluginManifestSchema.parse({ ...base, contributes: { pages: [{ id: "x", title: "X", entry: "index.html" }] } })).toThrow();
  expect(() => PluginManifestSchema.parse({ ...base, main: "../evil.mjs" })).toThrow();
  expect(() => PluginManifestSchema.parse({ ...base, nativePages: [{ id: "x", title: "X" }, { id: "x", title: "Y" }] })).toThrow();
});
