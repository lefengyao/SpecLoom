# SpecLoom 插件宿主隔离设计（Phase A）

- 状态：已确认，等待实现
- 日期：2026-10-22
- 范围：插件运行架构、能力边界、Git 原生页面迁移
- 不包含：插件包 Catalog、静态面板、主题、Agent 工具、用量页面

## 1. 背景

当前 SpecLoom 插件系统是可信 MVP：

- 插件主模块直接 `import()` 到 Electron 主进程。
- 插件页面是任意 HTML iframe，通过 `specloom-plugin://` 协议加载。
- 插件命令直接操作主进程对象。
- 没有独立进程、RPC 超时、消息大小限制或崩溃隔离。

这与 StoryFabric 的插件宿主模型差距较大。StoryFabric 将插件放在独立子进程，通过 RPC 调用，面板使用白名单静态 HTML，并对参数、能力、消息大小做校验。

本阶段只迁移 **运行与权限底座**，不追求 StoryFabric 全量贡献模型。

## 2. 目标

### 2.1 进程隔离

- 每个启用插件运行在独立 Node 子进程。
- Electron 主进程不加载插件主模块。
- 子进程崩溃、退出、超时不能导致 SpecLoom 主窗口或主进程崩溃。
- 一个插件失败不能阻止其他插件或聊天继续工作。

### 2.2 生命周期

插件必须支持：

1. 宿主启动子进程。
2. 子进程加载插件入口并调用 `activate(context)`。
3. 插件通过 `context.commands.register(name, handler)` 注册命令。
4. 宿主通过 RPC 调用命令。
5. 插件停用或宿主退出时调用 `deactivate()`，超时后强制结束进程。

生命周期失败必须可观察：状态、错误信息、日志都保留。

### 2.3 最小能力

本阶段只开放：

- `project.path`
- 命令注册
- 插件自己的 storage

明确不开放：

- 项目文件读写
- 剪贴板
- 通知
- 外部打开
- 网络代理
- 主进程 Electron API

插件子进程本身仍是完整 Node，可直接访问文件、网络和进程；这是可信插件模型，不是操作系统沙箱。UI 必须继续显示信任警告。

### 2.4 Git 原生页面

- Git 页面改为宿主 React 页面。
- Git 后端命令仍由 `specloom-git` 插件提供。
- 删除 Git 插件的 HTML、JS、CSS 页面资源。
- 删除任意 HTML 页面加载通道。

### 2.5 保留管理流程

- 内置 Git 插件默认启用。
- 用户插件默认禁用。
- 本地安装、卸载、启用、禁用、定位继续可用。
- 官方/用户来源、版本、状态和错误继续展示。

## 3. 非目标

本阶段不做：

- 插件包版本、官方 Catalog、安装预览、更新、签名。
- 静态面板、主题变量、Agent 工具贡献。
- OS 级沙箱、权限沙箱、网络隔离。
- 项目文件 API、剪贴板、通知、外部链接能力。
- Git 功能扩展。
- 用量统计页面。
- 多插件共享子进程。

这些能力需要后续独立 spec，不在本阶段偷偷加入。

## 4. 架构

```text
Renderer
  ├─ GitView
  └─ PluginManagementView
        │
        ▼
  preload / IPC
        │
        ▼
  PluginManager
        │ 每插件一个
        ▼
  PluginHost ── JSONL RPC ── PluginHostChild
                                  │
                                  ▼
                            plugin main module
```

### 4.1 PluginHost

每个启用的插件对应一个 `PluginHost`：

- 启动：`spawn(process.execPath, [childScript, pluginRoot, entry], ...)`
- 环境：继承环境变量，增加 `ELECTRON_RUN_AS_NODE=1`
- 工作目录：插件目录
- 标准输入/输出：协议通道
- 标准错误：追加到插件日志
- 不创建 BrowserWindow，不加载 renderer。

### 4.2 PluginHostChild

子进程入口负责：

- 读取插件入口。
- 创建最小 `context`。
- 调用 `activate(context)`。
- 处理宿主请求。
- 调用命令处理器。
- 调用 `deactivate()`。
- 把协议响应写回 stdout。

子进程不能把普通日志写到 stdout，否则会污染协议。实现必须将 `console.log/info/debug` 重定向到 stderr；非 JSON 行由宿主记录并忽略。

## 5. RPC 协议

### 5.1 传输

- `stdin` / `stdout` 使用 UTF-8 JSON Lines。
- 一行一个完整 JSON 对象。
- 单条消息最大 5 MiB。
- 非法 JSON、空行、未知字段：记录日志；请求返回协议错误。

### 5.2 请求

```json
{
  "id": "uuid",
  "method": "invoke",
  "params": {
    "command": "state",
    "input": {},
    "projectPath": "E:\\project"
  }
}
```

### 5.3 成功响应

```json
{ "id": "uuid", "ok": true, "result": {} }
```

### 5.4 失败响应

```json
{
  "id": "uuid",
  "ok": false,
  "error": {
    "code": "COMMAND_FAILED",
    "message": "not a git repository"
  }
}
```

### 5.5 方法

宿主 → 子进程：

- `activate`：无参数；返回已注册命令名列表。
- `invoke`：`{ command, input, projectPath }`。
- `deactivate`：无参数。

子进程 → 宿主：

- `storage.get`：`{ key }` → 值或 null。
- `storage.set`：`{ key, value }`。
- `storage.delete`：`{ key }`。

storage 的 key 必须是非空、长度不超过 128 的字符串；value 必须是 JSON 值，单条不超过 256 KiB。

### 5.6 超时

- `activate` / `deactivate`：15 秒。
- 普通 `invoke`：120 秒。
- `fetch` / `pull` / `push`：300 秒。
- 超时后当前请求返回 `TIMEOUT`；不自动杀掉进程，除非进程已退出。

### 5.7 大小限制

- 请求和响应单条最大 5 MiB。
- 超过限制：拒绝请求并返回 `LIMIT_EXCEEDED`，不解析截断内容。
- 插件输出超过限制时记录错误；宿主不能把截断的 JSON 当成有效响应。

## 6. 插件清单

`PLUGIN_API_VERSION` 从 1 升到 2。

```json
{
  "id": "specloom-git",
  "name": "Git",
  "version": "0.1.0",
  "apiVersion": 2,
  "official": true,
  "enabledByDefault": true,
  "main": "main/index.mjs",
  "nativePages": [
    { "id": "git", "title": "Git" }
  ]
}
```

规则：

- `main` 必填。
- `nativePages` 可选；每项 `id` 和 `title` 必填。
- 本阶段只认识 `git` 原生页面；未知 id 不显示入口，但不阻止插件运行。
- 移除 `contributes.pages` 和任意 HTML 入口。
- 旧 `apiVersion: 1` 插件显示为不兼容，不执行。

## 7. 插件上下文

```js
activate({
  commands: {
    register(name, handler) {}
  },
  storage: {
    async get(key) {},
    async set(key, value) {},
    async delete(key) {}
  }
})
```

命令处理器：

```js
async function handler(input, { projectPath }) {}
```

- `projectPath` 由宿主在每次 `invoke` 时注入，不能由插件参数覆盖。
- 命令名限制为小写字母、数字、点、下划线、短横线，长度 1–80。
- 重复注册同名命令：后者覆盖前者，并在日志记录警告。

## 8. Git 原生页面

### 8.1 页面

新增 `GitView`：

- 只在 `specloom-git` 启用且状态 ready 时显示。
- 通过 `api.plugins.invoke("specloom-git", command, input)` 调用命令。
- 保留现有 Git 页面功能：
  - 状态与分支
  - 文件列表、diff
  - 暂存/取消暂存
  - 提交
  - 创建/切换分支
  - fetch/pull/push
  - 历史与提交详情

### 8.2 删除

- 删除 `resources/plugins/specloom-git/renderer/`。
- 删除 `src/main/plugins/plugin-protocol.ts`。
- 删除 `src/renderer/PluginPageHost.tsx` 及 iframe 相关 CSS。
- 删除 preload `pageUrl` 和对应 IPC。
- 主进程不再调用 `registerPluginScheme` / `registerPluginProtocol`。

### 8.3 插件入口

`main/index.mjs` 只保留 Git 命令实现；不再依赖页面资源、DOM、`window` 或 `postMessage`。

## 9. 管理器与状态

`PluginManager` 负责：

- 扫描内置/用户插件。
- 校验 manifest 和 API 版本。
- 维护 enabled 状态。
- 创建/停止 `PluginHost`。
- 暴露 `list` / `setEnabled` / `invoke` / `installDirectory` / `uninstall` / `revealTarget` / `close`。
- 记录每个插件的状态：`ready` / `disabled` / `error`。
- 错误信息可展示，但不能包含插件任意 HTML。

状态文件继续使用 `<userData>/plugins-state.json`。

## 10. 错误与恢复

- 激活失败：停止子进程，状态 `error`，保留错误和日志路径。
- 命令失败：插件返回 `ok:false`；宿主转成 `ProjectError`。
- 子进程崩溃：状态 `error`，后续 invoke 返回 `PLUGIN_UNAVAILABLE`。
- 超时：返回 `TIMEOUT`，不自动重启。
- 插件禁用：调用 deactivate，15 秒后强制结束。
- 宿主退出：逐个调用 deactivate，总等待最多 2 秒；超时后强制结束全部子进程。
- 安装/卸载失败：不改变当前启用状态。

## 11. 测试要求

### 宿主

- 启动、activate、invoke、deactivate 正常路径。
- 命令返回值和错误映射。
- 超时。
- 超过 5 MiB 的消息。
- 非法 JSON / 非协议 stdout。
- 子进程崩溃后状态和后续调用。
- storage 读写和 key/value 校验。
- 日志写入。

### 管理器

- 内置插件默认启用，用户插件默认禁用。
- apiVersion 不兼容。
- 启用/禁用/安装/卸载。
- 无 HTML 页面仍可运行命令。
- Git 插件命令在临时仓库中完整跑通。

### Renderer

- Git 导航只在 Git 插件启用时出现。
- GitView 通过 invoke 调用命令。
- 插件禁用后 Git 页面不可用。
- 插件管理页显示运行失败和重试。

### 命令

- `npm run typecheck`
- 插件/SDK/Git 定向测试
- 不要求本阶段清理完整 App 测试套件的既有环境失败

## 12. 验收标准

1. 插件主模块不会在 Electron 主进程中加载。
2. 每个启用插件有独立子进程。
3. 插件崩溃不会使主窗口退出或聊天中断。
4. Git 页面所有操作经过子进程命令。
5. 插件不再能提供任意 HTML/JS 页面。
6. 第三方插件仍可安装、启用并注册命令。
7. 插件管理页可以显示 ready/disabled/error 和错误信息。
8. 类型检查和本阶段定向测试通过。

## 13. 迁移影响

- 现有第三方插件如果依赖 HTML 页面，本阶段将失去页面；命令仍可保留。
- 旧 `apiVersion: 1` 插件需要改为 2。
- Git 插件从内置 HTML 页面迁移到原生页面。
- 现有插件安装目录、启用状态和用户数据路径保持不变。
- 用量页面不在本 spec 中；下一项单独设计。
