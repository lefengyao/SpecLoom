import { describe, expect, it } from "vitest";
import { godotMcpToolDefinitions } from "../../src/main/core/godot-mcp/tool-definitions";
import { WorkspaceCatalog } from "../../src/main/core/tools/catalog";

const expectedRoutes = {
  get_diagnostics: "mcp/diagnostics",
  get_output_log: "editor/get_output_log",
  get_editor_screenshot: "editor/get_screenshot",
  get_game_screenshot: "editor/get_game_screenshot",
  get_project_info: "project/get_info",
  get_scene_tree: "scene/get_tree",
  get_game_scene_tree: "runtime/get_scene_tree",
  get_game_node_properties: "runtime/get_node_properties",
} as const;

describe("Godot MCP read-only tool contract", () => {
  it("contains exactly the approved tools and routes", () => {
    expect(Object.fromEntries(godotMcpToolDefinitions.map(tool => [tool.name, tool.route])))
      .toEqual(expectedRoutes);
  });

  it("bounds output-log pagination and severity filters", () => {
    const schema = godotMcpToolDefinitions.find(tool => tool.name === "get_output_log")!.schema;
    expect(schema.safeParse({ limit: 500, levels: ["ERROR", "WARNING"] }).success).toBe(true);
    expect(schema.safeParse({ limit: 501 }).success).toBe(false);
    expect(schema.safeParse({ cursor: "" }).success).toBe(false);
    expect(schema.safeParse({ levels: ["ERROR", "FATAL"] }).success).toBe(false);
  });

  it("bounds scene-tree depth and defaults it to fifteen", () => {
    const schema = godotMcpToolDefinitions.find(tool => tool.name === "get_scene_tree")!.schema;
    expect(schema.parse({})).toEqual({ max_depth: 15 });
    expect(schema.safeParse({ max_depth: 64 }).success).toBe(true);
    expect(schema.safeParse({ max_depth: 65 }).success).toBe(false);
  });

  it("accepts only relative node paths without traversal", () => {
    const schema = godotMcpToolDefinitions.find(tool => tool.name === "get_game_node_properties")!.schema;
    expect(schema.safeParse({ path: "Player/Sprite2D", properties: ["position"] }).success).toBe(true);
    expect(schema.safeParse({ path: "../outside" }).success).toBe(false);
    expect(schema.safeParse({ path: "/root/Player" }).success).toBe(false);
    expect(schema.safeParse({ path: "x".repeat(4097) }).success).toBe(false);
  });

  it("requires empty screenshot arguments and omits retired screenshot tools", () => {
    const screenshot = godotMcpToolDefinitions.find(tool => tool.name === "get_game_screenshot")!.schema;
    expect(screenshot.safeParse({}).success).toBe(true);
    expect(screenshot.safeParse({ timeoutMs: 5000 }).success).toBe(false);

    const catalog = new WorkspaceCatalog();
    expect(catalog.all().map(tool => tool.name)).not.toContain("GodotScreenshot");
    expect(catalog.all().map(tool => tool.name)).not.toContain("GodotPluginInstall");
    catalog.addGodotMcpTools();
    expect(catalog.all().filter(tool => tool.name in expectedRoutes).map(tool => tool.name).sort())
      .toEqual(Object.keys(expectedRoutes).sort());
  });
});
