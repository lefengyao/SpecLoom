import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { McpConfigSchema, McpServerConfigSchema, ManagedMcpServerSchema, type ManagedMcpServer, type McpConfig, type McpConfigScope, type McpServerConfig } from "../../shared/mcp-config";
import { ProjectError } from "./errors";

function missing(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }
function same(left: string, right: string): boolean { return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right; }

/** Edits standard mcpServers JSON files without exposing secrets in the UI. */
export class McpConfigStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly userData: string, private readonly currentProject: () => string | undefined) {}
  async list(projectPath?: string): Promise<ManagedMcpServer[]> {
    const global = await this.readFile(path.join(this.userData, "mcp.json"));
    const project = projectPath ? await this.readProject(projectPath) : undefined;
    const result = new Map<string, ManagedMcpServer>();
    for (const [name, config] of Object.entries(global.mcpServers)) result.set(name, ManagedMcpServerSchema.parse({ name, scope: "global", config }));
    if (project) for (const [name, config] of Object.entries(project.mcpServers)) result.set(name, ManagedMcpServerSchema.parse({ name, scope: "project", config }));
    return [...result.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  async save(scope: McpConfigScope, projectPath: string | undefined, name: string, config: McpServerConfig): Promise<ManagedMcpServer[]> {
    return this.serial(async () => { const target = await this.target(scope, projectPath); const parsed = this.parseConfig(config); const value = await this.readFile(target); value.mcpServers[name] = parsed; await this.writeFile(target, value); return this.list(projectPath); });
  }
  async setEnabled(scope: McpConfigScope, projectPath: string | undefined, name: string, enabled: boolean): Promise<ManagedMcpServer[]> {
    return this.serial(async () => { const target = await this.target(scope, projectPath); const value = await this.readFile(target); const server = value.mcpServers[name]; if (!server) throw new ProjectError("FILE_NOT_FOUND", "MCP 服务不存在"); server.enabled = enabled; await this.writeFile(target, value); return this.list(projectPath); });
  }
  async remove(scope: McpConfigScope, projectPath: string | undefined, name: string): Promise<ManagedMcpServer[]> {
    return this.serial(async () => { const target = await this.target(scope, projectPath); const value = await this.readFile(target); delete value.mcpServers[name]; await this.writeFile(target, value); return this.list(projectPath); });
  }
  async test(config: McpServerConfig): Promise<{ ok: boolean; message: string }> {
    const parsed = this.parseConfig(config);
    if (parsed.url) {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 5000);
      try { const response = await fetch(parsed.url, { method: "HEAD", ...(parsed.headers ? { headers: parsed.headers } : {}), signal: controller.signal }); return { ok: response.ok, message: response.ok ? `HTTP ${response.status}` : `服务器返回 HTTP ${response.status}` }; } catch (error) { return { ok: false, message: error instanceof Error ? error.message.slice(0, 500) : "连接失败" }; } finally { clearTimeout(timer); }
    }
    return new Promise((resolve) => {
      const child = spawn(parsed.command!, [...(parsed.args ?? [])], { cwd: this.currentProject(), env: { ...process.env, ...(parsed.env ?? {}) }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = ""; let settled = false; const finish = (result: { ok: boolean; message: string }) => { if (settled) return; settled = true; clearTimeout(timer); child.kill(); resolve(result); }; const timer = setTimeout(() => finish({ ok: false, message: "命令启动超时" }), 5000);
      child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-500); });
      child.once("error", (error) => finish({ ok: false, message: error.message.slice(0, 500) }));
      child.once("spawn", () => finish({ ok: true, message: "命令已启动" }));
      child.once("close", (code) => { if (code !== 0) finish({ ok: false, message: stderr.trim() || `进程退出码 ${code ?? "未知"}` }); });
    });
  }
  private parseConfig(config: McpServerConfig): McpServerConfig { const parsed = McpServerConfigSchema.safeParse(config); if (!parsed.success) throw new ProjectError("VALIDATION_FAILED", "MCP 服务配置无效"); return parsed.data; }
  private async target(scope: McpConfigScope, projectPath?: string): Promise<string> {
    if (scope === "global") return path.join(this.userData, "mcp.json");
    const current = this.currentProject(); if (!projectPath || !current || !same(path.resolve(projectPath), path.resolve(current))) throw new ProjectError("INVALID_PROJECT", "只能编辑当前项目的 MCP 配置");
    return path.join(current, ".specloom", "mcp.json");
  }
  private async readProject(projectPath: string): Promise<McpConfig> { if (!same(path.resolve(projectPath), path.resolve(this.currentProject() ?? ""))) throw new ProjectError("INVALID_PROJECT", "只能读取当前项目的 MCP 配置"); return this.readFile(path.join(projectPath, ".specloom", "mcp.json")); }
  private async readFile(file: string): Promise<McpConfig> { try { const stats = await lstat(file); if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 262144) throw new ProjectError("VALIDATION_FAILED", "MCP 配置文件无效"); return McpConfigSchema.parse(JSON.parse(await readFile(file, "utf8"))); } catch (error) { if (missing(error)) return { mcpServers: {} }; if (error instanceof ProjectError) throw error; throw new ProjectError("VALIDATION_FAILED", "MCP 配置文件无效"); } }
  private async writeFile(file: string, value: McpConfig): Promise<void> { await mkdir(path.dirname(file), { recursive: true }); const temporary = `${file}.tmp`; await writeFile(temporary, `${JSON.stringify(McpConfigSchema.parse(value), null, 2)}\n`, "utf8"); await rename(temporary, file); }
  private async serial<T>(operation: () => Promise<T>): Promise<T> { const run = this.queue.then(operation); this.queue = run.catch(() => undefined); return run; }
}
