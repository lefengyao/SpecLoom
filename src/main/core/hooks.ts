import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { HookDefinitionInputSchema, HookDefinitionSchema, type HookDefinition, type HookDefinitionInput, type HookRunResult } from "../../shared/hooks";
import { ProjectError } from "./errors";
import type { ApprovalMode, ToolApprovalInput } from "../../shared/approvals";
import { approvalArguments } from "./tools/approval-policy";

interface StoredHooks { hooks: HookDefinition[] }
async function stopHook(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") await new Promise<void>(resolve => {
    const kill = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    kill.once("error", () => { child.kill(); resolve(); }); kill.once("close", () => resolve());
  });
  else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
}

export class HooksStore {
  private readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(userData: string) { this.file = path.join(userData, "hooks.json"); }
  async list(): Promise<HookDefinition[]> { return structuredClone((await this.read()).hooks); }
  async save(input: HookDefinitionInput): Promise<HookDefinition> {
    const parsed = HookDefinitionInputSchema.safeParse({ ...input, timeoutMs: input.timeoutMs ?? 30_000 });
    if (!parsed.success) throw new ProjectError("VALIDATION_FAILED", "Hook 参数无效");
    return this.serial(async () => { const stored = await this.read(); const now = new Date().toISOString(); const existing = parsed.data.id ? stored.hooks.find((hook) => hook.id === parsed.data.id) : undefined; const next: HookDefinition = { ...parsed.data, id: existing?.id ?? randomUUID(), updatedAt: now, ...(existing?.lastRun ? { lastRun: existing.lastRun } : {}) }; const index = stored.hooks.findIndex((hook) => hook.id === next.id); if (index >= 0) stored.hooks[index] = next; else stored.hooks.push(next); await this.write(stored); return structuredClone(next); });
  }
  async remove(id: string): Promise<void> { await this.serial(async () => { const stored = await this.read(); stored.hooks = stored.hooks.filter((hook) => hook.id !== id); await this.write(stored); }); }
  async setEnabled(id: string, enabled: boolean): Promise<HookDefinition> { return this.serial(async () => { const stored = await this.read(); const hook = stored.hooks.find((candidate) => candidate.id === id); if (!hook) throw new ProjectError("FILE_NOT_FOUND", "Hook 不存在"); hook.enabled = enabled; hook.updatedAt = new Date().toISOString(); await this.write(stored); return structuredClone(hook); }); }
  async test(id: string): Promise<HookRunResult> { return this.run(id, { event: "test", projectPath: "", sessionId: "" }); }
  async run(id: string, payload: Record<string, unknown>, permissions?: { mode: ApprovalMode; onApproval: (input: ToolApprovalInput) => Promise<boolean>; signal: AbortSignal }): Promise<HookRunResult> {
    const stored = await this.read(); const hook = stored.hooks.find((candidate) => candidate.id === id); if (!hook) throw new ProjectError("FILE_NOT_FOUND", "Hook 不存在");
    if (!hook.enabled && payload.event !== "test") return { ok: true, message: "Hook 已停用", at: new Date().toISOString() };
    permissions?.signal.throwIfAborted();
    if (permissions && permissions.mode !== "full") {
      const approved = await permissions.onApproval({ toolName: "Hook", arguments: approvalArguments({ command: hook.command }), reason: `Hook ${hook.name} 将执行宿主脚本，可能访问网络或修改电脑文件`, risk: "high" });
      permissions.signal.throwIfAborted();
      if (!approved) return { ok: false, message: "Hook 执行已拒绝", at: new Date().toISOString() };
    }
    const started = new Date().toISOString();
    const result = await new Promise<HookRunResult>((resolve) => {
      const child = spawn(hook.command, { shell: hook.shell || true, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
      let stdout = ""; let stderr = ""; let settled = false;
      const abort = () => { void stopHook(child).then(() => finish({ ok: false, message: "Hook 已停止", at: started })); };
      const finish = (value: HookRunResult) => { if (settled) return; settled = true; clearTimeout(timer); permissions?.signal.removeEventListener("abort", abort); resolve(value); };
      const timer = setTimeout(() => { void stopHook(child).then(() => finish({ ok: false, message: "Hook 执行超时", at: started })); }, hook.timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => { stdout = `${stdout}${chunk.toString("utf8")}`.slice(-4000); });
      child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4000); });
      child.once("error", (error) => finish({ ok: false, message: error.message.slice(0, 2000), at: started }));
      child.once("close", (code) => finish(code === 0 ? { ok: true, message: stdout.trim().slice(0, 2000) || "Hook 执行完成", at: started, exitCode: 0 } : { ok: false, message: (stderr.trim() || stdout.trim() || `Hook 退出码 ${code ?? "未知"}`).slice(0, 2000), at: started, ...(code === null ? {} : { exitCode: code }) }));
      child.stdin.end(JSON.stringify(payload));
      permissions?.signal.addEventListener("abort", abort, { once: true });
      if (permissions?.signal.aborted) abort();
    });
    await this.serial(async () => { const current = await this.read(); const hook = current.hooks.find((candidate) => candidate.id === id); if (!hook) return; hook.lastRun = { ok: result.ok, at: result.at, message: result.message }; hook.updatedAt = new Date().toISOString(); await this.write(current); });
    return result;
  }
  private async read(): Promise<StoredHooks> { try { const parsed = JSON.parse(await readFile(this.file, "utf8")) as unknown; const hooks = (parsed as { hooks?: unknown })?.hooks; return { hooks: Array.isArray(hooks) ? hooks.flatMap((value) => { const checked = HookDefinitionSchema.safeParse(value); return checked.success ? [checked.data] : []; }) : [] }; } catch { return { hooks: [] }; } }
  private async write(stored: StoredHooks): Promise<void> { await mkdir(path.dirname(this.file), { recursive: true }); const temporary = `${this.file}.tmp`; await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, "utf8"); await rename(temporary, this.file); }
  private async serial<T>(operation: () => Promise<T>): Promise<T> { const run = this.queue.then(operation); this.queue = run.catch(() => undefined); return run; }
}

