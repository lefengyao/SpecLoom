import { describe, expect, it } from "vitest";
import { ToolCatalog } from "../../src/main/core/tool-catalog";

const version = `sha256:${"a".repeat(64)}`;

describe("ToolCatalog", () => {
  it("publishes bounded provider schemas with reversible canonical names", () => {
    const catalog = new ToolCatalog();
    const tools = catalog.providerTools();
    expect(tools).toHaveLength(10);
    expect(tools.map((tool) => tool.function.name)).toContain("files_list_versions");
    for (const tool of tools) {
      expect(tool.function.name).toMatch(/^[a-zA-Z0-9_-]+$/);
      expect(tool.function.parameters).toMatchObject({ type: "object", additionalProperties: false });
    }
    const read = tools.find((tool) => tool.function.name === "files_read")!;
    expect(read.function.parameters.required).toEqual(["path", "expectedVersion"]);
    expect(catalog.parseCall("files_read", JSON.stringify({ path: "specs/game.md", expectedVersion: version })))
      .toEqual({ name: "files.read", input: { path: "specs/game.md", expectedVersion: version } });
  });

  it("rejects unknown aliases, missing versions, malformed JSON and extra arguments", () => {
    const catalog = new ToolCatalog();
    expect(() => catalog.parseCall("files.read", "{}")).toThrow("Unknown tool");
    expect(() => catalog.parseCall("files_read", '{"path":"x"}')).toThrow("Invalid tool arguments");
    expect(() => catalog.parseCall("files_read", "{")).toThrow("Invalid tool arguments");
    expect(() => catalog.parseCall("skills_list", '{"taskId":"other"}')).toThrow("Invalid tool arguments");
    expect(() => catalog.parseCall("bash_exec", JSON.stringify({ command: "x".repeat(32_769) })))
      .toThrow("Invalid tool arguments");
  });

  it("requires skill receipt versions and a preview digest for commit", () => {
    const catalog = new ToolCatalog();
    expect(catalog.parseCall("skills_load", JSON.stringify({ id: "specs", expectedVersion: version, sourcePaths: ["specs"] })).name)
      .toBe("skills.load");
    expect(() => catalog.parseCall("skills_load", '{"id":"specs"}')).toThrow();
    expect(() => catalog.parseCall("changes_commit", "{}")).toThrow();
    expect(catalog.parseCall("changes_commit", '{"digest":"abc"}')).toEqual({ name: "changes.commit", input: { digest: "abc" } });
  });

  it("uses the existing exact text patch contract", () => {
    const catalog = new ToolCatalog();
    const input = { path: "specs/game.md", expectedVersion: version, patch: { search: "old", replace: "new" } };
    expect(catalog.parseCall("files_patch", JSON.stringify(input))).toEqual({ name: "files.patch", input });
    expect(() => catalog.parseCall("files_patch", JSON.stringify({ ...input, patch: { search: "", replace: "new" } }))).toThrow();
  });
});
