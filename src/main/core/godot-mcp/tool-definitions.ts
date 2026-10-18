import { z } from "zod";

const empty = z.object({}).strict();

const outputLog = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  direction: z.enum(["older", "newer"]).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  levels: z.array(z.enum(["ERROR", "WARNING", "INFO", "DEBUG", "UNKNOWN"])).max(5).optional(),
}).strict();

const sceneTree = z.object({
  max_depth: z.number().int().min(0).max(64).optional().default(15),
}).strict();

const nodePath = z.string().max(4096)
  .refine(value => !value.includes(".."), "Node path cannot contain traversal")
  .refine(value => !value.startsWith("/") && !/^[A-Za-z]:/.test(value), "Node path must be relative");

const nodeProperties = z.object({
  path: nodePath,
  properties: z.array(z.string().min(1).max(128)).max(128).optional(),
}).strict();

export const godotMcpToolDefinitions = [
  { name: "get_diagnostics", description: "读取 Godot MCP 桥接与插件诊断状态；离线时也会返回连接恢复指引。", route: "mcp/diagnostics", schema: empty },
  { name: "get_output_log", description: "分页读取 Godot 编辑器 Output 日志；游标继续读取同一份有限快照。", route: "editor/get_output_log", schema: outputLog },
  { name: "get_editor_screenshot", description: "读取 Godot 编辑器视口截图，不写入项目文件。", route: "editor/get_screenshot", schema: empty },
  { name: "get_game_screenshot", description: "读取正在运行的 Godot 游戏视口截图，不控制游戏。", route: "editor/get_game_screenshot", schema: empty },
  { name: "get_project_info", description: "读取 Godot 项目名称、引擎版本、视口和主场景等信息。", route: "project/get_info", schema: empty },
  { name: "get_scene_tree", description: "读取编辑器当前打开场景的节点树，不修改或保存场景。", route: "scene/get_tree", schema: sceneTree },
  { name: "get_game_scene_tree", description: "读取正在运行的游戏节点树，不控制游戏。", route: "runtime/get_scene_tree", schema: empty },
  { name: "get_game_node_properties", description: "读取运行中游戏某个节点的选定属性，不修改节点。", route: "runtime/get_node_properties", schema: nodeProperties },
] as const;

export type GodotMcpToolName = typeof godotMcpToolDefinitions[number]["name"];
export type GodotMcpToolDefinition = typeof godotMcpToolDefinitions[number];

export function getGodotMcpToolDefinition(name: string): GodotMcpToolDefinition | undefined {
  return godotMcpToolDefinitions.find(tool => tool.name === name);
}
