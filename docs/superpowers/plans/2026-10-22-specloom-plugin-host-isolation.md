# SpecLoom 插件宿主隔离 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把插件主代码迁到独立子进程，通过 JSONL RPC 调用命令；删除任意 HTML 页面通道，把 Git 页面迁成宿主原生 React 页面。

**Architecture:** `PluginManager` 为每个启用插件创建一个 `PluginHost`。Host 用 `ELECTRON_RUN_AS_NODE=1` 启动 `resources/plugin-host-child.mjs`，stdin/stdout 只传输 JSONL RPC，stderr 写插件日志。Child 加载插件入口、调用 activate/deactivate、注册命令；宿主负责超时、大小限制、storage 和错误映射。Renderer 只通过 preload `plugins.invoke` 调用命令，Git UI 在宿主 React 中实现。

**Tech Stack:** Electron 41、Node 24、TypeScript、React 19、Zod、Vitest、esbuild（仅主进程构建）。

---

## File Map

**Create**

- `src/main/plugins/plugin-rpc.ts` — JSONL RPC 编解码、请求超时、5 MiB 上限。
- `src/main/plugins/plugin-host.ts` — 单插件子进程宿主。
- `resources/plugin-host-child.mjs` — 子进程入口；加载插件并处理协议。
- `src/renderer/GitView.tsx` — Git 原生页面。
- `src/renderer/git.css` — Git 原生页面样式（从插件页面样式迁移）。
- `tests/core/plugin-rpc.test.ts` — RPC 单元测试。
- `tests/core/plugin-host.test.ts` — 子进程生命周期测试。
- `tests/fixtures/plugin-child/plugin.json`、`main/index.mjs` — 测试插件。
- `tests/renderer/GitView.test.tsx` — Git 页面命令调用测试。

**Modify**

- `src/shared/plugins.ts` — API v2、`nativePages`、移除页面 schema。
- `src/main/core/plugins/plugin-manager.ts` — 改为 host 生命周期，删除 `import()` / `resolvePage`。
- `src/shared/desktop-api.ts` — 删除 `pageUrl`，保留 list/set/invoke/install/uninstall/reveal。
- `src/main/ipc.ts` — 删除 protocol 相关导入/注册；保持现有 plugin 操作。
- `src/main/preload.ts` — 删除 `pageUrl`。
- `src/main/main.ts` — 删除 `registerPluginScheme` / `registerPluginProtocol`；传入 childPath。
- `src/renderer/App.tsx` — 使用 `nativePages`，渲染 `GitView`，删除 `PluginPageHost`。
- `src/renderer/SpecLoomPluginsPanel.tsx` — 显示 `nativePages` 数量。
- `resources/plugins/specloom-git/plugin.json` — `apiVersion: 2`、`nativePages`、移除 `contributes.pages`。
- `resources/plugins/specloom-git/main/index.mjs` — 只保留命令，不引用页面。
- `electron-builder.yml` — 打包 `resources/plugin-host-child.mjs`。
- `tests/core/plugin-manifest.test.ts`、`tests/core/plugin-manager.test.ts`、`tests/core/git-plugin.test.ts` — 适配 v2 与 child host。

**Delete**

- `src/main/plugins/plugin-protocol.ts`
- `src/renderer/PluginPageHost.tsx`
- `resources/plugins/specloom-git/renderer/index.html`
- `resources/plugins/specloom-git/renderer/app.js`
- `resources/plugins/specloom-git/renderer/style.css`
- `PluginPageHost` 相关 CSS（`src/renderer/plugins.css` 中 `.plugin-page-host` 等规则）

---

## Task 1: 定义插件 API v2

**Files:**
- Modify: `src/shared/plugins.ts`
- Modify: `tests/core/plugin-manifest.test.ts`
- Test: `tests/core/plugin-manifest.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/core/plugin-manifest.test.ts` 替换为：

```ts
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
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npx vitest run tests/core/plugin-manifest.test.ts`
Expected: FAIL，因为 `PLUGIN_API_VERSION` 仍为 1，`nativePages` 不存在。

- [ ] **Step 3: 实现 schema**

`src/shared/plugins.ts` 改为：

```ts
import { z } from "zod";

export const PLUGIN_API_VERSION = 2;

const relativePath = (value: string): boolean => {
  if (!value || value.length > 512 || value.includes("\\") || value.startsWith("/") || /^[a-zA-Z]:/.test(value)) return false;
  return value.split("/").every((segment) => segment && segment !== "." && segment !== ".." && !/[\u0000-\u001f]/u.test(segment));
};
const RelativePathSchema = z.string().min(1).max(512).refine(relativePath, "Expected a safe relative path");
const PluginIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u, "Expected a lowercase plugin id");

export const PluginNativePageSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,31}$/u),
  title: z.string().min(1).max(80),
  icon: z.string().max(40).optional(),
}).strict();
export type PluginNativePage = z.infer<typeof PluginNativePageSchema>;

export const PluginManifestSchema = z.object({
  id: PluginIdSchema,
  name: z.string().min(1).max(80),
  version: z.string().min(1).max(40),
  apiVersion: z.number().int().positive(),
  description: z.string().max(500).optional(),
  author: z.string().max(120).optional(),
  official: z.boolean().optional(),
  enabledByDefault: z.boolean().optional(),
  main: RelativePathSchema,
  nativePages: z.array(PluginNativePageSchema).max(32).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.apiVersion !== PLUGIN_API_VERSION) ctx.addIssue({ code: "custom", path: ["apiVersion"], message: "Unsupported plugin API version" });
  const ids = new Set<string>();
  for (const page of value.nativePages ?? []) {
    if (ids.has(page.id)) ctx.addIssue({ code: "custom", path: ["nativePages"], message: "Duplicate native page id" });
    ids.add(page.id);
  }
});
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export const PluginSummarySchema = z.object({
  id: PluginIdSchema,
  name: z.string(),
  version: z.string(),
  description: z.string().optional(),
  author: z.string().optional(),
  official: z.boolean(),
  source: z.enum(["builtin", "user"]),
  enabled: z.boolean(),
  status: z.enum(["ready", "disabled", "error"]),
  error: z.string().optional(),
  nativePages: z.array(PluginNativePageSchema),
}).strict();
export type PluginSummary = z.infer<typeof PluginSummarySchema>;

export const PluginInventorySchema = z.object({ plugins: z.array(PluginSummarySchema), trusted: z.literal(true) }).strict();
export type PluginInventory = z.infer<typeof PluginInventorySchema>;

export function pluginPageId(pluginId: string, pageId: string): string {
  return `plugin:${pluginId}:${pageId}`;
}
```

说明：`PluginCommandRequestSchema`、`parsePluginPageId` 当前没有调用方，删除；保留 `pluginPageId` 给导航。

- [ ] **Step 4: 运行测试**

Run: `npx vitest run tests/core/plugin-manifest.test.ts`
Expected: PASS（2 tests）。

- [ ] **Step 5: 提交**

```bash
git add src/shared/plugins.ts tests/core/plugin-manifest.test.ts
git commit -m "feat(plugins): define API v2 native page contract"
```

---

## Task 2: JSONL RPC

**Files:**
- Create: `src/main/plugins/plugin-rpc.ts`
- Create: `tests/core/plugin-rpc.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { PassThrough } from "node:stream";
import { expect, test } from "vitest";
import { PluginRpc, PluginRpcError } from "../../src/main/plugins/plugin-rpc";

test("round-trips requests and responses", async () => {
  const hostIn = new PassThrough(); const hostOut = new PassThrough();
  const childIn = new PassThrough(); const childOut = new PassThrough();
  hostOut.pipe(childIn); childOut.pipe(hostIn);
  const host = new PluginRpc(hostIn, hostOut, async () => ({ ok: true }));
  const child = new PluginRpc(childIn, childOut, async (method, params) => {
    if (method === "echo") return params;
    if (method === "storage.get") return { value: "x" };
    throw new Error("unknown");
  });
  await expect(host.request("echo", { value: 1 }, 1000)).resolves.toEqual({ value: 1 });
  await expect(child.request("storage.get", { key: "k" }, 1000)).resolves.toEqual({ value: "x" });
  host.close(); child.close();
});

test("maps child errors and request timeouts", async () => {
  const hostIn = new PassThrough(); const hostOut = new PassThrough();
  const child = new PluginRpc(hostIn, hostOut, async (method) => { if (method === "fail") throw new PluginRpcError("COMMAND_FAILED", "boom"); });
  await expect(child.request("fail", undefined, 1000)).rejects.toMatchObject({ code: "COMMAND_FAILED", message: "boom" });
  await expect(child.request("never", undefined, 10)).rejects.toMatchObject({ code: "TIMEOUT" });
  child.close();
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npx vitest run tests/core/plugin-rpc.test.ts`
Expected: FAIL，找不到模块。

- [ ] **Step 3: 实现 PluginRpc**

```ts
import type { Readable, Writable } from "node:stream";

export const MAX_RPC_BYTES = 5 * 1024 * 1024;

export class PluginRpcError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "PluginRpcError"; }
}
interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; }
interface RpcMessage { id?: string; method?: string; params?: unknown; ok?: boolean; result?: unknown; error?: { code?: string; message?: string }; }
type RequestHandler = (method: string, params: unknown) => Promise<unknown>;

export class PluginRpc {
  private buffer = "";
  private sequence = 0;
  private readonly pending = new Map<string, Pending>();
  private closed?: Error;
  constructor(private readonly input: Readable, private readonly output: Writable, private readonly onRequest: RequestHandler, private readonly onFailure?: (error: Error) => void) {
    input.on("data", (chunk: Buffer) => this.receive(chunk));
    input.on("error", (error) => this.fail(error));
  }
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(this.closed);
    const id = `r${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new PluginRpcError("TIMEOUT", `Plugin request timed out: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error as Error); }
    });
  }
  close(error = new PluginRpcError("CLOSED", "Plugin RPC closed")): void {
    if (this.closed) return;
    this.closed = error;
    for (const [id, item] of this.pending) { clearTimeout(item.timer); item.reject(error); this.pending.delete(id); }
  }
  private receive(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer += chunk.toString("utf8");
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_RPC_BYTES * 2) { this.fail(new PluginRpcError("LIMIT_EXCEEDED", "Plugin RPC buffer exceeded limit")); return; }
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_RPC_BYTES) { this.fail(new PluginRpcError("LIMIT_EXCEEDED", "Plugin RPC message exceeded limit")); return; }
      let message: RpcMessage;
      try { message = JSON.parse(line) as RpcMessage; } catch { this.onFailure?.(new PluginRpcError("PROTOCOL_ERROR", "Plugin wrote invalid JSON")); continue; }
      if (message.method) { void this.dispatch(message); continue; }
      if (!message.id) { this.onFailure?.(new PluginRpcError("PROTOCOL_ERROR", "Plugin response has no id")); continue; }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new PluginRpcError(message.error?.code ?? "PLUGIN_ERROR", message.error?.message ?? "Plugin request failed"));
    }
  }
  private async dispatch(message: RpcMessage): Promise<void> {
    const id = message.id!;
    try { this.write({ id, ok: true, result: await this.onRequest(message.method!, message.params) }); }
    catch (error) { const failure = error instanceof PluginRpcError ? error : new PluginRpcError("PLUGIN_ERROR", error instanceof Error ? error.message : String(error)); this.write({ id, ok: false, error: { code: failure.code, message: failure.message } }); }
  }
  private write(message: RpcMessage): void {
    if (this.closed) throw this.closed;
    const line = JSON.stringify(message) + "\n";
    if (Buffer.byteLength(line, "utf8") > MAX_RPC_BYTES) throw new PluginRpcError("LIMIT_EXCEEDED", "Plugin RPC message exceeded limit");
    if (!this.output.write(line)) return;
  }
  private fail(error: Error): void { this.close(error); this.onFailure?.(error); }
}
```

- [ ] **Step 4: 运行测试**

Run: `npx vitest run tests/core/plugin-rpc.test.ts`
Expected: PASS（2 tests）。

- [ ] **Step 5: 提交**

```bash
git add src/main/plugins/plugin-rpc.ts tests/core/plugin-rpc.test.ts
git commit -m "feat(plugins): add bounded JSONL RPC"
```

---

## Task 3: 子进程入口与 Host

**Files:**
- Create: `resources/plugin-host-child.mjs`
- Create: `src/main/plugins/plugin-host.ts`
- Create: `tests/fixtures/plugin-child/plugin.json`
- Create: `tests/fixtures/plugin-child/main/index.mjs`
- Create: `tests/core/plugin-host.test.ts`
- Modify: `electron-builder.yml`

- [ ] **Step 1: 写测试插件 fixture**

`tests/fixtures/plugin-child/plugin.json`：

```json
{
  "id": "fixture-child", "name": "Fixture", "version": "1.0.0", "apiVersion": 2,
  "main": "main/index.mjs"
}
```

`tests/fixtures/plugin-child/main/index.mjs`：

```js
let activated = false;
export async function activate(context) {
  activated = true;
  context.commands.register("echo", async (input) => ({ echo: input, activated }));
  context.commands.register("storage", async () => {
    await context.storage.set("hello", "world");
    return await context.storage.get("hello");
  });
  context.commands.register("fail", async () => { throw new Error("fixture failure"); });
}
export async function deactivate() { activated = false; }
```

- [ ] **Step 2: 写 host 失败测试**

```ts
import path from "node:path";
import { expect, test } from "vitest";
import { PluginHost } from "../../src/main/plugins/plugin-host";

const root = path.resolve("tests/fixtures/plugin-child");
const childPath = path.resolve("resources/plugin-host-child.mjs");
const logDir = path.resolve("tests/.tmp/plugin-logs");

test("starts, invokes commands, and stops a plugin child", async () => {
  const host = new PluginHost({
    pluginId: "fixture-child", version: "1.0.0", root, entry: "main/index.mjs",
    childPath, logDir, requestTimeoutMs: 5000,
    onRequest: async (method, params) => {
      if (method === "storage.get") return null;
      if (method === "storage.set") return true;
      throw new Error("unknown host method");
    },
  });
  try {
    const commands = await host.start();
    expect(commands).toContain("echo");
    await expect(host.request("invoke", { command: "echo", input: { value: 1 }, projectPath: "E:\\p" }, 5000)).resolves.toMatchObject({ echo: { value: 1 } });
    await expect(host.request("invoke", { command: "fail" }, 5000)).rejects.toThrow("fixture failure");
  } finally { await host.stop(); }
});
```

- [ ] **Step 3: 运行测试并确认失败**

Run: `npx vitest run tests/core/plugin-host.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 4: 实现 child**

`resources/plugin-host-child.mjs`：

```js
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import path from "node:path";

const [root, entry] = process.argv.slice(2);
const handlers = new Map();
let activated = false;
let sequence = 0;
const pending = new Map();
const log = (...args) => console.error("[plugin]", ...args);
for (const method of ["log", "info", "debug", "warn"]) console[method] = log;

function write(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}
function hostRequest(method, params, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const id = `c${++sequence}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Host request timed out: ${method}`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    write({ id, method, params });
  });
}
const storage = {
  get: (key) => hostRequest("storage.get", { key }),
  set: (key, value) => hostRequest("storage.set", { key, value }),
  delete: (key) => hostRequest("storage.delete", { key }),
};

async function handle(message) {
  if (message.method === "activate") {
    if (activated) return { commands: [...handlers.keys()] };
    const module = await import(pathToFileURL(path.resolve(root, entry)).href);
    if (typeof module.activate !== "function") throw new Error("Plugin exports no activate()");
    await module.activate({
      commands: { register(name, handler) { handlers.set(name, handler); } },
      storage,
    });
    activated = true;
    return { commands: [...handlers.keys()] };
  }
  if (message.method === "deactivate") {
    if (activated) {
      const module = await import(pathToFileURL(path.resolve(root, entry)).href);
      await module.deactivate?.();
    }
    activated = false; handlers.clear();
    return { ok: true };
  }
  if (message.method === "invoke") {
    const command = message.params?.command;
    const handler = handlers.get(command);
    if (!handler) throw Object.assign(new Error(`Unknown plugin command: ${command}`), { code: "COMMAND_NOT_FOUND" });
    const projectPath = message.params?.projectPath;
    return await handler(message.params?.input, { projectPath });
  }
  throw Object.assign(new Error(`Unknown plugin method: ${message.method}`), { code: "METHOD_NOT_FOUND" });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { log("invalid protocol JSON"); return; }
  if (message.method) {
    void handle(message).then(
      (result) => write({ id: message.id, ok: true, result }),
      (error) => write({ id: message.id, ok: false, error: { code: error.code ?? "COMMAND_FAILED", message: error.message ?? String(error) } }),
    );
    return;
  }
  const waiting = pending.get(message.id);
  if (!waiting) return;
  pending.delete(message.id); clearTimeout(waiting.timer);
  if (message.ok) waiting.resolve(message.result);
  else waiting.reject(new Error(message.error?.message ?? "Host request failed"));
});
```

- [ ] **Step 5: 实现 PluginHost**

`src/main/plugins/plugin-host.ts`：

```ts
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { PluginRpc, PluginRpcError } from "./plugin-rpc";

export interface PluginHostOptions {
  pluginId: string;
  version: string;
  root: string;
  entry: string;
  childPath: string;
  logDir: string;
  requestTimeoutMs?: number;
  onRequest: (method: string, params: unknown) => Promise<unknown>;
  onFailure?: (error: Error) => void;
}
export class PluginHost {
  private child?: ChildProcessWithoutNullStreams;
  private rpc?: PluginRpc;
  private log?: WriteStream;
  private failure?: Error;
  private stopping = false;
  private started = false;
  constructor(private readonly options: PluginHostOptions) {}

  async start(): Promise<string[]> {
    if (this.started) throw new Error("Plugin host already started");
    this.started = true;
    await mkdir(this.options.logDir, { recursive: true });
    this.log = createWriteStream(path.join(this.options.logDir, `${this.options.pluginId}.log`), { flags: "a" });
    this.child = spawn(process.execPath, [this.options.childPath, this.options.root, this.options.entry], {
      cwd: this.options.root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.pipe(this.log, { end: false });
    this.rpc = new PluginRpc(this.child.stdout, this.child.stdin, this.options.onRequest, (error) => this.fail(error));
    this.child.once("error", (error) => this.fail(error));
    this.child.once("exit", (code, signal) => { if (!this.stopping) this.fail(new Error(`Plugin process exited (${signal ?? code ?? "unknown"})`)); });
    try {
      const result = await this.rpc.request("activate", undefined, 15_000) as { commands?: unknown };
      if (!Array.isArray(result?.commands) || result.commands.some((item) => typeof item !== "string")) throw new Error("Plugin activate returned invalid command list");
      return result.commands as string[];
    } catch (error) { this.fail(error as Error); await this.stop(); throw error; }
  }

  async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.failure) throw this.failure;
    if (!this.rpc) throw new Error("Plugin host is not running");
    return this.rpc.request(method, params, timeoutMs);
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.rpc && !this.failure) { try { await this.rpc.request("deactivate", undefined, 15_000); } catch { /* best effort */ } }
    this.rpc?.close();
    const child = this.child;
    if (child && child.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
        child.kill();
      });
    }
    if (this.log && !this.log.closed) await new Promise<void>((resolve) => { this.log!.once("error", () => resolve()); this.log!.end(() => resolve()); });
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.rpc?.close(error);
    this.child?.kill();
    if (!this.stopping) this.options.onFailure?.(error);
  }
}
```

- [ ] **Step 6: 加入打包资源**

`electron-builder.yml` 的 `extraResources` 增加：

```yaml
  - from: resources/plugin-host-child.mjs
    to: plugin-host-child.mjs
```

- [ ] **Step 7: 运行测试**

Run: `npx vitest run tests/core/plugin-rpc.test.ts tests/core/plugin-host.test.ts`
Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add resources/plugin-host-child.mjs src/main/plugins/plugin-host.ts tests/fixtures/plugin-child tests/core/plugin-host.test.ts electron-builder.yml
git commit -m "feat(plugins): run plugins in isolated child hosts"
```

---

## Task 4: Manager 改为 Host 生命周期

**Files:**
- Modify: `src/main/core/plugins/plugin-manager.ts`
- Modify: `tests/core/plugin-manager.test.ts`
- Modify: `tests/core/git-plugin.test.ts`

- [ ] **Step 1: 更新 manager 测试 fixture**

`tests/core/plugin-manager.test.ts` 的 `fixture()` 写 `apiVersion: 2`、删除 `contributes.pages`，并给两个 manager 构造增加：

```ts
childPath: path.resolve("resources/plugin-host-child.mjs"),
logDirectory: path.join(userData, "plugin-logs"),
```

测试插件 main 保持：

```js
export async function activate(context) {
  context.commands.register("ping", async (input, ctx) => ({ pong: true, input, projectPath: ctx.projectPath }));
}
export async function deactivate() {}
```

- [ ] **Step 2: 写失败测试**

新增断言：

```ts
expect(manager.list()).resolves.toMatchObject({ trusted: true });
expect((await manager.list()).plugins.find((plugin) => plugin.id === "official")?.nativePages).toEqual([]);
await expect(manager.invoke("official", "ping", { value: 1 })).resolves.toEqual({ pong: true, input: { value: 1 }, projectPath: project });
```

并删除 `resolvePage` / `resolvePageAsset` 测试。

- [ ] **Step 3: 运行测试并确认失败**

Run: `npx vitest run tests/core/plugin-manager.test.ts`
Expected: FAIL，manager 仍使用 `import()` 且 `pages` 字段不存在。

- [ ] **Step 4: 重写 PluginManager**

关键结构：

```ts
interface PluginRecord {
  manifest: PluginManifest;
  root: string;
  source: "builtin" | "user";
  enabled: boolean;
  error?: string;
  host?: PluginHost;
  commands: string[];
}
export interface PluginManagerOptions {
  builtinDirectory: string;
  userDataDirectory: string;
  getProjectPath: () => string | undefined;
  childPath: string;
  logDirectory: string;
}
```

- `list()`：discover → activateEnabled → summary/nativePages。
- `setEnabled()`：enable 调 `activate`；disable 调 `deactivate`；失败记录 error 并禁用。
- `invoke()`：确保 host；`projectPath` 必填；调用
  `host.request("invoke", { command, input, projectPath }, timeoutFor(command))`。
- `activate()`：
  ```ts
  const entry = path.resolve(record.root, record.manifest.main);
  const host = new PluginHost({ pluginId: record.manifest.id, version: record.manifest.version, root: record.root, entry, childPath: this.options.childPath, logDir: this.options.logDirectory,
    onRequest: (method, params) => this.handleHostRequest(record.manifest.id, method, params),
    onFailure: (error) => { record.error = message(error); record.host = undefined; } });
  record.commands = await host.start();
  record.host = host;
  delete record.error;
  ```
- `deactivate`：`await host.stop()`，清空 host/commands。
- `handleHostRequest`：只接受 `storage.get/set/delete`，key 长度 1–128，value JSON ≤256 KiB；其他方法抛 `PluginRpcError("METHOD_NOT_FOUND", ...)`。
- `timeoutFor(command)`：`fetch/pull/push` 返回 300000，其余 120000。
- `summary`：`nativePages: record.manifest.nativePages ?? []`，删除 pages。
- 无效插件记录需要构造一个满足 `PluginManifest` 的占位对象：`{ id: "invalid", name: entry.name, version: "0", apiVersion: PLUGIN_API_VERSION, main: "" }`，仅用于错误展示。
- 删除 `resolvePage`、`resolvePageAsset`、`resolvePluginFile`、`pathToFileURL`、`randomUUID`、`PluginPageSummarySchema`。
- `installDirectory` / `uninstall` / `revealTarget` / state 保持语义，卸载前 deactivate。

- [ ] **Step 5: 运行 manager 测试**

Run: `npx vitest run tests/core/plugin-manager.test.ts`
Expected: PASS。

- [ ] **Step 6: 更新 Git 插件测试**

`tests/core/git-plugin.test.ts` 增加 `childPath`、`logDirectory`，删除 `resolvePage` 断言。运行：

```bash
npx vitest run tests/core/git-plugin.test.ts
```

Expected: PASS，所有 Git 命令通过子进程完成。

- [ ] **Step 7: 提交**

```bash
git add src/main/core/plugins/plugin-manager.ts tests/core/plugin-manager.test.ts tests/core/git-plugin.test.ts
git commit -m "feat(plugins): manage plugin child hosts"
```

---

## Task 5: 主进程、IPC 与 preload 清理

**Files:**
- Modify: `src/main/main.ts`
- Modify: `src/main/ipc.ts`
- Modify: `src/main/preload.ts`
- Modify: `src/shared/desktop-api.ts`
- Delete: `src/main/plugins/plugin-protocol.ts`

- [ ] **Step 1: 写 API 失败测试**

在 `tests/renderer/PluginManagementView.test.tsx` 增加：

```ts
expect("pageUrl" in (api.plugins ?? {})).toBe(false);
```

运行：

```bash
npx vitest run tests/renderer/PluginManagementView.test.tsx
```

Expected: FAIL，当前 API 仍有 `pageUrl`。

- [ ] **Step 2: 修改 desktop-api**

`src/shared/desktop-api.ts` 的 `PluginsApi`：

```ts
export interface PluginsApi {
  list(): Promise<SpecLoomPluginInventory>;
  setEnabled(id: string, enabled: boolean): Promise<SpecLoomPluginInventory>;
  invoke(id: string, command: string, input?: unknown): Promise<unknown>;
  install(): Promise<SpecLoomPluginInventory>;
  uninstall(id: string): Promise<SpecLoomPluginInventory>;
  reveal(id: string): Promise<void>;
}
```

删除 `pageUrl`。

- [ ] **Step 3: 修改 preload**

删除：

```ts
pageUrl: (id, pageId) => `specloom-plugin://${id}/${pageId}/`,
```

- [ ] **Step 4: 修改 main**

删除：

```ts
import { registerPluginProtocol, registerPluginScheme } from "./plugins/plugin-protocol";
registerPluginScheme();
registerPluginProtocol(plugins);
```

新增 child path：

```ts
const pluginChildPath = app.isPackaged
  ? path.join(process.resourcesPath, "plugin-host-child.mjs")
  : path.join(applicationRoot, "resources", "plugin-host-child.mjs");
```

`PluginManager` 构造增加：

```ts
childPath: pluginChildPath,
logDirectory: path.join(app.getPath("userData"), "plugin-logs"),
```

- [ ] **Step 5: 修改 ipc**

删除 `plugin-protocol` 相关 import 和 scheme 注册；保留插件操作白名单和 dispatch；不新增页面操作。

- [ ] **Step 6: 删除协议文件**

```bash
Remove-Item -LiteralPath "src/main/plugins/plugin-protocol.ts" -Force
```

- [ ] **Step 7: 暂不运行完整类型检查**

Task 6 会删除 `PluginPageHost` 和 `pageUrl` 的最后引用；在 Task 6 完成前，`npm run typecheck` 预期会报这些残留引用。不要在这一步修改无关代码。

- [ ] **Step 8: 提交**

```bash
git add -A src/main/main.ts src/main/ipc.ts src/main/preload.ts src/shared/desktop-api.ts src/main/plugins/plugin-protocol.ts tests/renderer/PluginManagementView.test.tsx
git commit -m "refactor(plugins): remove HTML page protocol"
```

---

## Task 6: Git 原生页面

**Files:**
- Create: `src/renderer/GitView.tsx`
- Create: `src/renderer/git.css`
- Modify: `src/renderer/App.tsx`
- Delete: `src/renderer/PluginPageHost.tsx`
- Modify: `src/renderer/plugins.css`
- Modify: `resources/plugins/specloom-git/plugin.json`
- Delete: `resources/plugins/specloom-git/renderer/index.html`
- Delete: `resources/plugins/specloom-git/renderer/app.js`
- Delete: `resources/plugins/specloom-git/renderer/style.css`

- [ ] **Step 1: 写 GitView 失败测试**

`tests/renderer/GitView.test.tsx`：

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { GitView } from "../../src/renderer/GitView";

test("loads repository state and stages a file through plugin.invoke", async () => {
  const invoke = vi.fn(async (_id: string, command: string, input?: unknown) => {
    if (command === "state") return { state: "repository", branch: "main", files: [{ path: "a.txt", index: " ", worktree: "M", staged: false, unstaged: true }], ahead: 0, behind: 0 };
    if (command === "stage") return { state: "repository", branch: "main", files: [{ path: "a.txt", index: "M", worktree: " ", staged: true, unstaged: false }], ahead: 0, behind: 0 };
    if (command === "branches") return { current: "main", branches: ["main"] };
    if (command === "history") return { commits: [] };
    if (command === "diff") return { diff: "+hello" };
    return {};
  });
  const api = { plugins: { invoke } } as never;
  render(<GitView api={api} pluginId="specloom-git" projectPath="E:\\project" onError={() => undefined} />);
  await screen.findByText("a.txt");
  fireEvent.click(screen.getByRole("button", { name: "暂存" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("specloom-git", "stage", { paths: ["a.txt"] }));
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npx vitest run tests/renderer/GitView.test.tsx`
Expected: FAIL，`GitView` 不存在。

- [ ] **Step 3: 实现 GitView**

把现有 `resources/plugins/specloom-git/renderer/app.js` 的逻辑迁成 React。最小完整实现：

```tsx
import { useCallback, useEffect, useState } from "react";
import { GitBranch, RefreshCw } from "lucide-react";
import type { DesktopApi } from "../shared/desktop-api";
import "./git.css";

type FileStatus = { path: string; index: string; worktree: string; staged: boolean; unstaged: boolean };
type Repo = { state: "repository" | "not-repository" | "unavailable"; branch?: string; files: FileStatus[]; ahead: number; behind: number; upstream?: string };
type BranchResult = { current: string; branches: string[] };
type Commit = { hash: string; shortHash: string; subject: string; author: string; authoredAt: number };

export function GitView({ api, pluginId, projectPath, onError }: { api: DesktopApi; pluginId: string; projectPath: string; onError: (error: unknown) => void }) {
  const [repo, setRepo] = useState<Repo>();
  const [branches, setBranches] = useState<BranchResult>({ current: "", branches: [] });
  const [history, setHistory] = useState<Commit[]>([]);
  const [selected, setSelected] = useState<FileStatus>();
  const [diff, setDiff] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const invoke = useCallback(async (command: string, input?: unknown) => {
    if (!api.plugins) throw new Error("插件宿主不可用");
    return await api.plugins.invoke(pluginId, command, input);
  }, [api, pluginId]);

  const report = (failure: unknown) => { const text = failure instanceof Error ? failure.message : String(failure); setError(text); onError(failure); };
  const refresh = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const next = await invoke("state") as Repo; setRepo(next);
      if (next.state === "repository") {
        setBranches(await invoke("branches") as BranchResult);
        setHistory((await invoke("history") as { commits: Commit[] }).commits);
        if (selected) { setSelected(next.files.find((file) => file.path === selected.path)); setDiff((await invoke("diff", { path: selected.path, staged: selected.staged && !selected.unstaged }) as { diff: string }).diff); }
      }
    } catch (failure) { report(failure); } finally { setBusy(false); }
  }, [invoke, selected]);
  useEffect(() => { void refresh(); }, []); // projectPath is part of the component key in App

  const act = async (command: string, input?: unknown) => { setBusy(true); setError(""); try { await invoke(command, input); await refresh(); } catch (failure) { report(failure); } finally { setBusy(false); } };
  const select = async (file: FileStatus) => { setSelected(file); try { setDiff((await invoke("diff", { path: file.path, staged: file.staged && !file.unstaged }) as { diff: string }).diff); } catch (failure) { report(failure); } };

  if (!repo) return <section className="git-view"><p className="git-empty">正在读取 Git 状态…</p></section>;
  if (repo.state === "not-repository") return <section className="git-view"><div className="git-header"><h1>Git</h1></div><p className="git-empty">当前项目还没有 Git 仓库。</p><button className="primary" disabled={busy} onClick={() => void act("init")}>初始化仓库</button><GitError error={error} /></section>;

  return <section className="git-view">
    <header className="git-header"><div><h1>Git</h1><span className="git-branch"><GitBranch size={14} />{repo.branch || "detached"}</span><span className="git-sync">↑{repo.ahead} ↓{repo.behind}</span></div><div className="git-actions"><button disabled={busy} onClick={() => void refresh()}><RefreshCw size={14} />刷新</button><button disabled={busy} onClick={() => void act("fetch")}>获取</button><button disabled={busy} onClick={() => void act("pull")}>拉取</button><button disabled={busy} onClick={() => void act("push")}>推送</button></div></header>
    <GitError error={error} />
    <div className="git-layout">
      <aside className="git-files"><h2>变更</h2>{repo.files.length === 0 ? <p className="git-empty">工作区干净。</p> : repo.files.map((file) => <div key={file.path} className={selected?.path === file.path ? "git-file active" : "git-file"}><button className="git-file-name" onClick={() => void select(file)}><b>{file.index}{file.worktree}</b>{file.path}</button><button disabled={busy} onClick={() => void act(file.staged && !file.unstaged ? "unstage" : "stage", { paths: [file.path] })}>{file.staged && !file.unstaged ? "取消暂存" : "暂存"}</button></div>)}</aside>
      <main className="git-diff"><h2>{selected?.path || "差异"}</h2><pre>{diff || "选择一个文件查看差异。"}</pre></main>
      <aside className="git-side"><h2>提交</h2><textarea value={message} onChange={(event) => setMessage(event.target.value)} maxLength={20000} placeholder="提交说明" /><button className="primary" disabled={busy || !message.trim()} onClick={() => void act("commit", { message: message.trim() }).then(() => setMessage(""))}>提交已暂存变更</button><h2>分支</h2>{branches.branches.map((branch) => <button key={branch} className={branch === branches.current ? "git-branch-row current" : "git-branch-row"} disabled={busy || branch === branches.current} onClick={() => void act("switchBranch", { name: branch })}>{branch}</button>)}<button disabled={busy} onClick={() => { const name = window.prompt("新分支名称"); if (name) void act("createBranch", { name }); }}>新建分支</button><h2>历史</h2>{history.map((commit) => <button key={commit.hash} className="git-history-row" disabled={busy} onClick={() => void invoke("commitDetail", { hash: commit.hash }).then((detail) => setDiff((detail as { diff: string }).diff)).catch(report)}><b>{commit.subject}</b><small>{commit.shortHash} · {commit.author}</small></button>)}</aside>
    </div>
  </section>;
}

function GitError({ error }: { error: string }) { return error ? <p role="alert" className="git-error">{error}</p> : null; }
```

`git.css` 直接迁移原插件 `style.css` 中 `.git-*` 规则，并把根类从 `body` 改为 `.git-view`。至少包含：

```css
.git-view { padding: 18px 22px 22px; height: calc(100dvh - 60px); overflow: auto; }
.git-header { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 12px; }
.git-header h1 { margin: 0; font-size: 20px; }
.git-branch, .git-sync { display: inline-flex; align-items: center; gap: 4px; margin-left: 8px; color: var(--text-subtle); font-size: 12px; }
.git-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.git-layout { display: grid; grid-template-columns: minmax(220px, .9fr) minmax(320px, 1.7fr) minmax(240px, 1fr); gap: 10px; }
.git-files, .git-diff, .git-side { border: 1px solid var(--border); border-radius: 8px; padding: 10px; background: var(--bg-surface); min-width: 0; }
.git-file { display: grid; grid-template-columns: 1fr auto; gap: 5px; align-items: center; padding: 4px; border-radius: 5px; }
.git-file.active, .git-file:hover { background: var(--bg-hover); }
.git-file-name { border: 0; background: transparent; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.git-file-name b { margin-right: 6px; color: var(--accent-strong); }
.git-diff pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.55 ui-monospace, monospace; }
.git-side { display: flex; flex-direction: column; gap: 8px; }
.git-side textarea { min-height: 88px; resize: vertical; }
.git-branch-row, .git-history-row { text-align: left; }
.git-history-row small { display: block; color: var(--text-subtle); margin-top: 3px; }
.git-error { margin: 8px 0; padding: 8px 10px; border: 1px solid var(--danger); border-radius: 6px; color: var(--danger); }
.git-empty { color: var(--text-subtle); }
@media (max-width: 900px) { .git-layout { grid-template-columns: 1fr; } }
```

- [ ] **Step 4: App 使用 nativePages**

`src/renderer/App.tsx`：

- 删除 `PluginPageHost` import。
- `PluginPageEntry` 改为：
  ```ts
  interface PluginPageEntry { pluginId: string; pluginTitle: string; id: string; title: string; icon?: string; }
  ```
- 加载：
  ```ts
  setPluginPages(inventory.plugins.filter((plugin) => plugin.enabled && plugin.status === "ready").flatMap((plugin) => plugin.nativePages.map((page) => ({ ...page, pluginId: plugin.id, pluginTitle: plugin.name }))));
  ```
- 导航 key：
  ```tsx
  const pageId = page.id;
  const pageTab = `plugin:${page.pluginId}:${pageId}` as Tab;
  ```
- 渲染：
  ```tsx
  <NavigationPage active={tab.startsWith("plugin:")}>
    {api && activePluginPage && activePluginPage.id === "git" && <GitView key={`${activePluginPage.pluginId}:${state.project.path}`} api={api} pluginId={activePluginPage.pluginId} projectPath={state.project.path} onError={workspace.reportError} />}
  </NavigationPage>
  ```
- 未知 native page 不渲染。

- [ ] **Step 5: 删除旧页面**

```bash
Remove-Item -LiteralPath "src/renderer/PluginPageHost.tsx" -Force
Remove-Item -LiteralPath "resources/plugins/specloom-git/renderer/index.html" -Force
Remove-Item -LiteralPath "resources/plugins/specloom-git/renderer/app.js" -Force
Remove-Item -LiteralPath "resources/plugins/specloom-git/renderer/style.css" -Force
Remove-Item -LiteralPath "resources/plugins/specloom-git/renderer" -Force
```

- [ ] **Step 6: 更新 Git 清单**

`resources/plugins/specloom-git/plugin.json`：

```json
{
  "id": "specloom-git",
  "name": "Git",
  "version": "0.1.0",
  "apiVersion": 2,
  "description": "在工作区内查看变更、暂存、提交、切换分支并同步远程仓库。",
  "author": "SpecLoom",
  "official": true,
  "enabledByDefault": true,
  "main": "main/index.mjs",
  "nativePages": [{ "id": "git", "title": "Git", "icon": "git-branch" }]
}
```

- [ ] **Step 7: 清理 CSS**

删除 `src/renderer/plugins.css` 中 `.plugin-page-host`、`.plugin-page-frame`、`.plugin-page-loading`、`.plugin-page-status` 及移动端 host 规则；保留插件管理样式。

- [ ] **Step 8: 运行测试**

Run:

```bash
npx vitest run tests/renderer/GitView.test.tsx tests/core/plugin-manager.test.ts tests/core/git-plugin.test.ts
npm run typecheck
```

Expected: PASS。

- [ ] **Step 9: 提交**

```bash
git add -A src/renderer/GitView.tsx src/renderer/git.css src/renderer/App.tsx src/renderer/PluginPageHost.tsx resources/plugins/specloom-git/plugin.json resources/plugins/specloom-git/renderer
git commit -m "feat(git): render Git page natively through plugin host"
```

---

## Task 7: 管理界面与文档收尾

**Files:**
- Modify: `src/renderer/SpecLoomPluginsPanel.tsx`
- Modify: `docs/superpowers/specs/2026-10-22-specloom-plugin-host-isolation-design.md` (only if implementation drifts)
- Modify: `docs/release-2.0.0.md` (implementation note)
- Modify: `AGENTS.md` only if paths change (no).

- [ ] **Step 1: 更新管理页文案**

`plugin.pages.length` 改为 `plugin.nativePages.length`；说明文案改为“命令由独立子进程运行；当前只支持 Git 原生页面”。

- [ ] **Step 2: 运行完整定向验证**

```bash
npm run typecheck
npx vitest run tests/core/plugin-manifest.test.ts tests/core/plugin-rpc.test.ts tests/core/plugin-host.test.ts tests/core/plugin-manager.test.ts tests/core/git-plugin.test.ts tests/renderer/GitView.test.tsx tests/renderer/PluginManagementView.test.tsx
```

Expected: all PASS。若 App 测试失败，记录为既有环境失败，不混入本任务。

- [ ] **Step 3: 手动检查（不启动源码也可）**

- `grep -R "specloom-plugin" src resources` 应为空。
- `grep -R "PluginPageHost\|resolvePage\|pageUrl" src` 应为空。
- `git status --short` 只包含预期文件。

- [ ] **Step 4: 提交**

```bash
git add src/renderer/SpecLoomPluginsPanel.tsx docs/release-2.0.0.md
git commit -m "docs(plugins): document child host and native Git page"
```

---

## Task 8: 阶段验收

- [ ] **Step 1: 全量定向测试**

```bash
npm run typecheck
npx vitest run tests/core/plugin-manifest.test.ts tests/core/plugin-rpc.test.ts tests/core/plugin-host.test.ts tests/core/plugin-manager.test.ts tests/core/git-plugin.test.ts tests/renderer/GitView.test.tsx tests/renderer/PluginManagementView.test.tsx
```

Expected: all PASS。

- [ ] **Step 2: 确认无 HTML 页面通道**

```bash
if (Select-String -Path (Get-ChildItem src -Recurse -File).FullName -Pattern "specloom-plugin|PluginPageHost|resolvePageAsset" -Quiet) { throw "leftover page channel" } else { "clean" }
```

Expected: `clean`。

- [ ] **Step 3: 标记阶段完成**

不自动打包。用量页面另行 spec；先让用户确认插件宿主行为，再开始用量功能。

---

## Self-Review

- Spec 目标 1–6 分别由 Task 1–7 覆盖。
- 非目标没有被实现：没有 catalog、静态面板、主题、Agent 工具、项目文件 API、用量页。
- 类型名统一：`PluginHost`、`PluginRpc`、`nativePages`、`PluginNativePage`。
- 所有路径为仓库相对路径；命令为 Windows PowerShell 兼容写法。
- 没有占位符；每个失败测试都有预期失败原因和实现代码。
