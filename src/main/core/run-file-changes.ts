import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { RunFileChange, RunFileChanges } from "../../shared/chat";
import type { AgentEvent } from "./agent-runtime";
import { DEFAULT_APPROVAL_MODE, type ApprovalMode, type ToolApprovalInput } from "../../shared/approvals";
import { isOutsideProject, toolApproval } from "./tools/approval-policy";
import { normalizeProjectPath } from "./path-policy";

// Deliberately independent of Git: an already dirty working tree is the baseline.
const excluded = new Set([".git", ".godot", ".specloom", ".codex", "node_modules", "dist", "build", "release", "coverage", ".next", ".nuxt", "out", "target", "vendor", "__pycache__", ".venv", "venv"]);
const coverageNote = "比较范围为项目文件及已确认的文件工具目标，排除内部、依赖、构建目录和链接；项目外命令效果未覆盖，工作区变化可能来自其他程序或用户。";
type State = string | null | undefined; // digest / absent / not safely inspected
interface Snapshot { files: Map<string, State>; complete: boolean; enumerated: boolean }
export interface RunFileChangeLimits { maxFiles: number; maxEntries: number; maxBytes: number; maxFileBytes: number; scanMs: number; toolMs: number; cancelMs: number; maxToolFiles: number }
const defaults: RunFileChangeLimits = { maxFiles: 4000, maxEntries: 12000, maxBytes: 32 * 1024 * 1024, maxFileBytes: 2 * 1024 * 1024, scanMs: 600, toolMs: 100, cancelMs: 80, maxToolFiles: 256 };
class InspectionLimit extends Error {}
class Budget {
  readonly deadline: number;
  bytes = 0;
  constructor(ms: number, readonly limits: RunFileChangeLimits) { this.deadline = performance.now() + ms; }
  check(): void { if (performance.now() >= this.deadline) throw new InspectionLimit("文件比较达到时间限制，清单可能不完整。"); }
  async wait<T>(operation: Promise<T>): Promise<T> {
    this.check(); let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new InspectionLimit("文件比较达到时间限制，清单可能不完整。")), Math.max(1, this.deadline - performance.now())); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
}
function missing(error: unknown): boolean { return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""); }
function operation(before: State, after: State): RunFileChange["operation"] | undefined {
  if (before === undefined || after === undefined || before === after) return;
  if (before === null) return "create"; if (after === null) return "delete"; return "modify";
}

/** Bounded, best-effort observations. Failures never replace the run's own outcome. */
export class RunFileChangeTracker {
  private readonly limits: RunFileChangeLimits;
  private before: Snapshot = { files: new Map(), complete: false, enumerated: false };
  private readonly notes = new Set<string>([coverageNote]);
  private incomplete = false;
  private ended = false;
  private toolBytes = 0;
  private readonly paths = new Map<string, string>();
  private readonly pending = new Map<string, { absolute: string; key: string; name: string; awaitingApproval: boolean; before: State }>();
  private readonly direct = new Map<string, { absolute: string; initial: State; confirmed: State; latest: State }>();
  constructor(private readonly root: string, private readonly runId: string, limits: Partial<RunFileChangeLimits> = {}, private readonly approvalMode: ApprovalMode = DEFAULT_APPROVAL_MODE) { this.limits = { ...defaults, ...limits }; }
  private note(message: string): void { this.incomplete = true; if (this.notes.size < 30) this.notes.add(message.slice(0, 1000)); }
  private key(absolute: string): string { const normalized = path.resolve(absolute).replaceAll("\\", "/"); const key = process.platform === "win32" ? normalized.toLowerCase() : normalized; if (!this.paths.has(key)) this.paths.set(key, absolute); return key; }
  private display(absolute: string): string {
    const relative = path.relative(this.root, absolute);
    return (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative) ? relative : absolute).replaceAll("\\", "/");
  }
  private excluded(absolute: string): boolean {
    const relative = path.relative(this.root, absolute);
    return relative.split(/[\\/]/).some(segment => excluded.has(segment.toLowerCase()) || segment.includes(".specloom-tmp-"));
  }
  private resolveToolTarget(target: string): string | undefined {
    try {
      const portable = target.replaceAll("\\", "/");
      // Device namespaces must never be probed as regular files, including in full mode.
      if (portable.startsWith("//?/") || portable.startsWith("//./")) throw new Error("Device namespace");
      if (!path.isAbsolute(target)) return path.resolve(this.root, normalizeProjectPath(target));
      const absolute = path.resolve(target);
      // Match ExternalFiles routing: absolute local paths use the project store; external paths use their volume store.
      const base = isOutsideProject(this.root, absolute) ? path.parse(absolute).root : this.root;
      normalizeProjectPath(path.relative(base, absolute));
      return absolute;
    } catch { this.note("部分写入工具路径不符合文件工具规范，未读取其内容。"); return; }
  }
  private async state(absolute: string, budget: Budget, inspectParents = false): Promise<State> {
    try {
      if (inspectParents) {
        const parsed = path.parse(absolute); let ancestor = parsed.root;
        for (const segment of absolute.slice(parsed.root.length).split(path.sep).slice(0, -1)) {
          ancestor = path.join(ancestor, segment);
          const stat = await budget.wait(lstat(ancestor));
          if (stat.isSymbolicLink() || !stat.isDirectory()) { this.note("部分工具目标经过链接或非目录，未读取其内容。"); return; }
        }
      }
      const stat = await budget.wait(lstat(absolute));
      if (stat.isSymbolicLink() || !stat.isFile()) return;
      if (stat.size > this.limits.maxFileBytes || budget.bytes + stat.size > this.limits.maxBytes) { this.note("文件比较达到单文件或总字节限制，部分内容未检查。"); return; }
      budget.bytes += stat.size;
      // Hash in fixed chunks, so growth during the read cannot bypass the byte limit.
      const handlePromise = open(absolute, "r");
      let handle: Awaited<typeof handlePromise>;
      try { handle = await budget.wait(handlePromise); } catch (error) { void handlePromise.then(value => value.close(), () => undefined); throw error; }
      try {
        const opened = await budget.wait(handle.stat());
        if (opened.ino !== stat.ino || opened.dev !== stat.dev || !opened.isFile()) { this.note("部分文件在比较期间被替换，未将其记为已确认变化。"); return; }
        const hash = createHash("sha256"); let readBytes = 0; const chunk = Buffer.alloc(64 * 1024);
        while (true) {
          const { bytesRead } = await budget.wait(handle.read(chunk, 0, Math.min(chunk.length, this.limits.maxFileBytes - readBytes + 1), null));
          if (!bytesRead) break;
          readBytes += bytesRead;
          if (readBytes > this.limits.maxFileBytes || readBytes > stat.size) { this.note("部分文件在比较期间增长，未完整检查。"); return; }
          hash.update(chunk.subarray(0, bytesRead));
        }
        const after = await budget.wait(handle.stat());
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) { this.note("部分文件在比较期间发生变化，未完整检查。"); return; }
        return hash.digest("hex");
      } finally { void handle.close().catch(() => undefined); }
    } catch (error) {
      if (missing(error)) return null;
      this.note(error instanceof InspectionLimit ? error.message : "部分文件无法读取，文件清单可能不完整。"); return;
    }
  }
  private async scan(ms: number): Promise<Snapshot> {
    const snapshot: Snapshot = { files: new Map(), complete: true, enumerated: true }; const budget = new Budget(ms, this.limits); let entries = 0;
    const visit = async (directory: string, depth: number): Promise<void> => {
      budget.check();
      if (depth > 64) throw new InspectionLimit("文件比较达到目录深度限制，清单可能不完整。");
      const stat = await budget.wait(lstat(directory));
      if (stat.isSymbolicLink() || !stat.isDirectory()) { snapshot.complete = false; snapshot.enumerated = false; this.note("工作区根目录或目录在比较期间变成链接，已跳过。"); return; }
      const opening = opendir(directory, { bufferSize: 32 }); let iterator: Awaited<typeof opening>;
      try { iterator = await budget.wait(opening); } catch (error) { void opening.then(value => value.close(), () => undefined); throw error; }
      let reading: Promise<Dirent<string> | null> | undefined;
      try {
        while (true) {
          reading = iterator.read();
          const entry = await budget.wait(reading); if (!entry) break;
          if (++entries > this.limits.maxEntries) throw new InspectionLimit("文件比较达到目录条目数量限制，清单可能不完整。");
          const absolute = path.join(directory, entry.name);
          if (excluded.has(entry.name.toLowerCase()) || entry.name.includes(".specloom-tmp-") || entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) await visit(absolute, depth + 1);
          else if (entry.isFile()) {
            if (snapshot.files.size >= this.limits.maxFiles) throw new InspectionLimit("文件比较达到文件数量限制，清单可能不完整。");
            if (toolApproval(this.approvalMode, this.root, "Read", { path: path.relative(this.root, absolute) })) {
              snapshot.files.set(this.key(absolute), undefined); snapshot.complete = false;
              this.note("部分敏感文件需要审批，工作区比较未读取其内容；已批准的文件工具变化单独确认。"); continue;
            }
            const state = await this.state(absolute, budget);
            snapshot.files.set(this.key(absolute), state);
            if (state === undefined) snapshot.complete = false;
          }
        }
      } finally { void (reading ?? Promise.resolve()).catch(() => undefined).then(() => iterator.close()).catch(() => undefined); }
    };
    try { await visit(this.root, 0); }
    catch (error) { snapshot.complete = false; snapshot.enumerated = false; this.note(error instanceof InspectionLimit ? error.message : "部分目录无法枚举，文件清单可能不完整。"); }
    return snapshot;
  }
  async start(): Promise<void> { this.before = await this.scan(this.limits.scanMs); }
  private eventKey(event: Extract<AgentEvent, { type: "tool-start" | "tool-result" }>): string { return event.toolEventId ?? `${event.round}:${event.streamIndex ?? event.toolCallId}`; }
  async observe(event: AgentEvent): Promise<void> {
    if (this.ended || event.type !== "tool-start" && event.type !== "tool-result") return;
    const eventKey = this.eventKey(event);
    if (event.type === "tool-start") {
      if (event.name !== "Write" && event.name !== "Edit") return;
      let target: unknown;
      try {
        const args: unknown = JSON.parse(event.arguments ?? "{}");
        if (!args || typeof args !== "object") return;
        const object = args as Record<string, unknown>;
        const input = object.ok === true && object.result && typeof object.result === "object" ? object.result as Record<string, unknown> : object;
        target = input.path;
      } catch { this.note("部分写入工具参数无法完整解析，已使用工作区比较补全。"); return; }
      if (typeof target !== "string" || !target || target.length > 4096 || target.includes("\0") || target.includes("[truncated]") || target.includes("[redacted]")) { this.note("部分写入工具路径不可用，已使用工作区比较补全。"); return; }
      const absolute = this.resolveToolTarget(target); if (!absolute) return;
      const key = this.key(absolute);
      if (this.excluded(absolute)) return;
      if (this.pending.size + this.direct.size >= this.limits.maxToolFiles && !this.direct.has(key)) { this.note("直接工具文件记录达到数量限制。"); return; }
      // tool-start precedes permission checks. Never inspect an external/sensitive target before consent.
      if (toolApproval(this.approvalMode, this.root, event.name, { path: absolute })) {
        this.pending.set(eventKey, { absolute, key, name: event.name, awaitingApproval: true, before: undefined }); return;
      }
      const budget = new Budget(this.limits.toolMs, { ...this.limits, maxBytes: Math.max(0, this.limits.maxBytes - this.toolBytes) });
      const before = await this.state(absolute, budget, true); this.toolBytes += budget.bytes;
      if (!this.ended) this.pending.set(eventKey, { absolute, key, name: event.name, awaitingApproval: false, before });
      return;
    }
    const pending = this.pending.get(eventKey); this.pending.delete(eventKey);
    if (!pending || !event.ok) return;
    if (pending.awaitingApproval) { this.note("部分外部或敏感文件未取得可核对的审批前值，未直接读取或归因。"); return; }
    const budget = new Budget(this.limits.toolMs, { ...this.limits, maxBytes: Math.max(0, this.limits.maxBytes - this.toolBytes) });
    const after = await this.state(pending.absolute, budget, true); this.toolBytes += budget.bytes;
    if (this.ended) return;
    const existing = this.direct.get(pending.key);
    if (existing && after !== undefined) existing.latest = after;
    if (!operation(pending.before, after)) return;
    const baseline = this.before.files.get(pending.key);
    const initial = existing ? existing.initial : baseline !== undefined ? baseline : !this.before.files.has(pending.key) && this.before.enumerated && this.display(pending.absolute) !== pending.absolute.replaceAll("\\", "/") ? null : pending.before;
    this.direct.set(pending.key, { absolute: pending.absolute, initial, confirmed: after, latest: after });
  }
  /** Called only after the original approval has been durably accepted, before tool dispatch resumes. */
  async approved(input: ToolApprovalInput): Promise<void> {
    if (this.ended || input.toolName !== "Write" && input.toolName !== "Edit") return;
    let target: unknown;
    try { target = (JSON.parse(input.arguments) as Record<string, unknown>).path; } catch { this.note("部分已批准工具路径无法核对，外部文件覆盖可能不完整。"); return; }
    if (typeof target !== "string") return;
    const absolute = this.resolveToolTarget(target); if (!absolute) return;
    const pending = [...this.pending.values()].find(item => item.awaitingApproval && item.name === input.toolName && item.key === this.key(absolute));
    if (!pending) {
      if (this.display(absolute) === absolute.replaceAll("\\", "/")) this.note("部分已批准的外部子工具目标缺少完整工具事件，未检查其文件变化。");
      return;
    }
    const budget = new Budget(this.limits.toolMs, { ...this.limits, maxBytes: Math.max(0, this.limits.maxBytes - this.toolBytes) });
    const before = await this.state(pending.absolute, budget, true); this.toolBytes += budget.bytes;
    if (!this.ended) { pending.before = before; pending.awaitingApproval = false; }
  }
  async finish(cancelled = false): Promise<RunFileChanges> {
    this.ended = true;
    if (cancelled) this.note("运行已停止；仅保留停止前确认的工具变化和停止时有界观测，覆盖可能不完整。");
    const after = await this.scan(cancelled ? this.limits.cancelMs : this.limits.scanMs);
    const files = new Map<string, RunFileChange>();
    const keys = new Set([...this.before.files.keys(), ...after.files.keys()]);
    for (const key of keys) {
      // A complete directory listing proves absence even when another file's content was not readable.
      const beforeState = this.before.files.has(key) ? this.before.files.get(key) : this.before.enumerated ? null : undefined;
      const afterState = after.files.has(key) ? after.files.get(key) : after.enumerated ? null : undefined;
      const change = operation(beforeState, afterState); if (!change) continue;
      const evidence = this.direct.get(key);
      files.set(key, { path: this.display(evidence?.absolute ?? this.paths.get(key) ?? key), operation: change, source: evidence && evidence.confirmed === afterState ? "tool" : "workspace" });
    }
    const externalBudget = new Budget(cancelled ? this.limits.cancelMs : this.limits.toolMs, this.limits);
    for (const [key, evidence] of this.direct) {
      const isLocal = this.display(evidence.absolute) !== evidence.absolute.replaceAll("\\", "/");
      let state = isLocal && after.files.has(key) ? after.files.get(key) : isLocal && after.enumerated ? null : undefined;
      if (!isLocal) state = await this.state(evidence.absolute, externalBudget, true);
      if (state === undefined) state = evidence.latest;
      const change = operation(evidence.initial, state);
      if (change) files.set(key, { path: this.display(evidence.absolute), operation: change, source: state === evidence.confirmed ? "tool" : "workspace" });
      else files.delete(key);
    }
    const sorted = [...files.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const bounded: RunFileChange[] = []; let bytes = 0;
    for (const file of sorted) {
      if (file.path.length > 4096) { this.note("部分文件路径超过清单长度限制，未展示。"); continue; }
      const size = Buffer.byteLength(JSON.stringify(file));
      if (bounded.length >= 256 || bytes + size > 48 * 1024) { this.note("文件清单达到持久化数量或大小限制，部分变化未展示。"); break; }
      bytes += size; bounded.push(file);
    }
    return { runId: this.runId, files: bounded, complete: this.before.complete && after.complete && !this.incomplete, notes: [...this.notes] };
  }
}
