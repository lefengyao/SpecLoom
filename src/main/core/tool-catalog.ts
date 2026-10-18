import { z } from "zod";
import { TextPatchSchema, VersionTokenSchema } from "../../shared/contracts";
import { ProjectError } from "./errors";
import { godotMcpToolDefinitions, type GodotMcpToolName } from "./godot-mcp/tool-definitions";

const path = z.string().min(1).max(2_048);
const paths = z.array(path).max(256);
const empty = z.object({}).strict();
const guardedPath = { path, expectedVersion: VersionTokenSchema };

const definitions = [
  { name: "files.list_versions", description: "Discover file paths and current versions in the approved read scope. Select explicit paths or an optional prefix.",
    schema: z.object({ paths: paths.optional(), prefix: path.optional() }).strict() },
  { name: "files.read", description: "Read a file at the exact version returned by files.list_versions.", schema: z.object(guardedPath).strict() },
  { name: "files.write", description: "Stage complete file content using an exact expected version; absent creates a new file.",
    schema: z.object({ ...guardedPath, content: z.string().max(262_144) }).strict() },
  { name: "files.patch", description: "Stage an exact text replacement after reading the expected file version.",
    schema: z.object({ ...guardedPath, patch: TextPatchSchema.extend({ search: z.string().min(1).max(65_536), replace: z.string().max(65_536) }) }).strict() },
  { name: "bash.exec", description: "Run Bash inside the isolated project snapshot with approved read and write scope.",
    schema: z.object({ command: z.string().min(1).max(32_768), timeoutMs: z.number().int().min(1).max(120_000).optional() }).strict() },
  { name: "skills.list", description: "Discover project skills including specification and entity inspection skills with file version receipts.", schema: empty },
  { name: "skills.load", description: "Load a discovered skill at its expected version and read approved source paths through the skill.",
    schema: z.object({ id: z.string().min(1).max(256), expectedVersion: VersionTokenSchema, sourcePaths: paths.optional() }).strict() },
  { name: "godot.validate", description: "Run configured Godot validation against staged changes; optionally inspect an approved smoke scene.",
    schema: z.object({ smokeScene: path.optional() }).strict() },
  { name: "changes.preview", description: "Inspect staged changes, validation and the exact digest required for commit approval.", schema: empty },
  { name: "changes.commit", description: "Commit the exact preview digest only when the task has explicit approval.",
    schema: z.object({ digest: z.string().min(1).max(256) }).strict() },
] as const;

export type ToolName = typeof definitions[number]["name"] | GodotMcpToolName;
export interface ToolDefinition { name: ToolName; providerName: string; description: string; schema: z.ZodType }
export interface ProviderTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export interface ParsedToolCall { name: string; input: Record<string, unknown> }

export class ToolCatalog {
  private readonly tools: ToolDefinition[] = [
    ...definitions.map((tool) => ({ ...tool, providerName: tool.name.replaceAll(".", "_") })),
    ...godotMcpToolDefinitions.map((tool) => ({ ...tool, providerName: tool.name })),
  ];

  listTools(): ToolDefinition[] { return [...this.tools]; }

  getTool(name: string): ToolDefinition | undefined { return this.tools.find((tool) => tool.name === name); }

  providerTools(): ProviderTool[] {
    return this.tools.map((tool) => ({ type: "function", function: {
      name: tool.providerName, description: tool.description,
      parameters: z.toJSONSchema(tool.schema, { target: "draft-7" }) as Record<string, unknown>,
    } }));
  }

  parseCall(providerName: string, argumentsJson: string): ParsedToolCall {
    const tool = this.tools.find((candidate) => candidate.providerName === providerName);
    if (!tool) throw new ProjectError("MODEL_ERROR", "Unknown tool requested by the model.");
    if (argumentsJson.length > 524_288) throw new ProjectError("MODEL_ERROR", "Invalid tool arguments: input is too large.");
    let input: unknown;
    try { input = JSON.parse(argumentsJson); }
    catch { throw new ProjectError("MODEL_ERROR", "Invalid tool arguments: expected a JSON object."); }
    const result = tool.schema.safeParse(input);
    if (!result.success) throw new ProjectError("MODEL_ERROR", "Invalid tool arguments: schema validation failed.", {
      tool: tool.name, paths: result.error.issues.map((issue) => issue.path.map(String).join(".")).slice(0, 8),
    });
    return { name: tool.name, input: result.data as Record<string, unknown> };
  }
}

export const toolCatalog = new ToolCatalog();
export const listTools = () => toolCatalog.listTools();
export const getTool = (name: string) => toolCatalog.getTool(name);
