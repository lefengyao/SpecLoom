# 工具中心、离线文档、Hooks 与项目说明设计

## 目标

在 SpecLoom 的“工具”区域增加离线文档、Hooks、工具说明和归档会话管理，并在偏好区域增加关于项目页面。离线文档存储在用户数据目录，不写入项目；导入内容按文档包和版本隔离；用户显式启用后，智能体通过只读工具按需读取。

## 导航与界面

左侧导航的“工具”分组包含现有 Skills，以及四个新入口：

- 离线文档
- Hooks
- 工具说明
- 归档会话

“偏好”分组增加“关于项目”。页面沿用现有 `standard-view`、设置分区和工具栏样式，保持桌面端和窄屏布局一致。

### 离线文档页面

页面显示文档包列表。每个文档包显示名称、当前版本、文件数量、大小和启用开关；展开后显示版本列表，并提供切换当前版本、删除版本和删除文档包操作。

导入支持两种方式：选择一个本地目录，或选择多个本地文件。两种导入都要求填写文档包名称、版本号和是否立即启用。目录导入保留目录内的相对路径；多文件导入以文件名作为包内路径。导入只复制文件内容并计算 SHA-256，不保存源文件绝对路径作为运行依赖。

## 离线文档存储与数据模型

离线文档使用 Electron `app.getPath("userData")` 下的独立目录，不使用 `ProjectCore` 或项目 `FileStore`：

```text
<userData>/offline-documents/
  index.json
  bundles/<bundleId>/versions/<versionId>/files/...
```

核心模型：

```ts
interface OfflineDocumentBundle {
  id: string;
  name: string;
  enabled: boolean;
  activeVersionId?: string;
  createdAt: string;
  updatedAt: string;
  versions: OfflineDocumentVersion[];
}

interface OfflineDocumentVersion {
  id: string;
  label: string;
  fileCount: number;
  size: number;
  hash: string;
  importedAt: string;
  files: OfflineDocumentFile[];
}

interface OfflineDocumentFile {
  path: string;
  name: string;
  mimeType: string;
  size: number;
  hash: string;
}

interface OfflineDocumentRead {
  bundleId: string;
  versionId: string;
  path: string;
  name: string;
  mimeType: string;
  size: number;
  kind: "text" | "binary";
  content?: string;
}
```

索引和文件写入使用临时文件加原子重命名。导入路径必须先经过主进程校验；归一化后的包内路径不得穿越根目录。单文件、单版本、文档包数量和文件数量都有固定上限。重复导入同一文档包版本时按内容哈希识别并返回已有版本，不产生重复副本。

首次导入的版本自动成为该文档包的当前版本；后续导入新版本不会自动切换当前版本，除非用户在导入对话框勾选“设为当前版本”。停用文档包时保留当前版本选择，重新启用后继续使用该版本。

启用状态和当前版本是全局用户设置，应用重启后保留。启用文档不会自动把全文注入每轮提示词，而是通过两个只读工具按需访问：

- `OfflineDocsList`：列出已启用文档包、版本和文件索引。
- `OfflineDocsRead`：读取已启用版本中的指定相对路径，返回受大小限制的文本或文件元数据。

二进制文件只返回元数据，后续可扩展图片预览和 PDF 解析。

## IPC 与主进程 API

新增离线文档 API，并通过共享类型、IPC schema、preload 映射暴露给 renderer：

```ts
offlineDocuments.list(): Promise<OfflineDocumentBundle[]>;
offlineDocuments.importFiles(paths: string[], name: string, version: string, enabled: boolean): Promise<OfflineDocumentBundle>;
offlineDocuments.importDirectory(path: string, name: string, version: string, enabled: boolean): Promise<OfflineDocumentBundle>;
offlineDocuments.setEnabled(id: string, enabled: boolean): Promise<OfflineDocumentBundle>;
offlineDocuments.setVersion(id: string, versionId: string): Promise<OfflineDocumentBundle>;
offlineDocuments.read(id: string, versionId: string, filePath: string): Promise<OfflineDocumentRead>;
offlineDocuments.remove(id: string, versionId?: string): Promise<void>;
```

文件和目录选择通过主进程对话框完成。renderer 只收到导入结果和受限读取结果，不直接访问用户真实路径。

## Hooks

Hooks 存储在用户数据目录，默认关闭。每条 Hook 包含：名称、事件、命令、Shell、超时和启用状态。首期事件为：

- `session.before`
- `session.after`
- `tool.before`
- `tool.after`

命令通过标准输入接收 JSON payload，标准输出作为结果摘要；超时或非零退出记录错误但不阻断会话和工具调用。payload 包含项目路径、会话 ID、事件、工具名称、工具参数摘要、结果摘要和错误信息，并限制字符串长度，避免泄露完整文件和密钥。

调用流程固定为：

```text
session.before
  -> AgentRuntime.run
      -> tool.before
      -> WorkspaceTools.execute
      -> tool.after
  -> session.after
```

`session.after` 使用 `finally` 执行，确保取消、失败和正常完成都能触发。Hook 页面支持新增、编辑、启用/停用、删除、测试运行，并显示最近调用状态和时间。

Hook 管理 API 为：

```ts
hooks.list(): Promise<HookDefinition[]>;
hooks.save(input: HookDefinitionInput): Promise<HookDefinition>;
hooks.remove(id: string): Promise<void>;
hooks.setEnabled(id: string, enabled: boolean): Promise<HookDefinition>;
hooks.test(id: string): Promise<HookRunResult>;
```

`hooks.test` 使用固定的脱敏测试 payload，不启动会话，也不调用项目工具。

## 工具说明

工具说明页从共享工具目录生成内置工具文档，并在当前会话能力加载后追加动态 MCP 工具。每项显示名称、用途、参数 JSON Schema、是否默认加载、结果说明和典型调用流程。页面顶部展示模型搜索工具、加载参数、执行工具、接收结果并继续推理的流程说明。

## 归档会话

归档会话页面复用现有 `ChatSessionsApi`：

- 只列出当前项目的 `archived === true` 会话。
- 支持恢复会话、永久删除和导出。
- 恢复后切换到工作区并选中该会话。
- 删除前显示确认对话框。

不新增第二套会话持久化格式。

## 关于项目

关于项目页面读取已有 `ProjectMetadata`，显示项目名称、描述、路径、引擎、Godot 特性、主场景和当前 SpecLoom 版本。描述为空时显示明确的未填写状态。页面为只读，项目内容仍由项目文件和现有资料编辑器维护。

## 错误处理

- 导入路径不存在、无法读取、超出大小限制或路径穿越时返回结构化错误，并保留已存在的文档包。
- 版本写入失败时使用临时文件清理，不更新索引中的半成品记录。
- Hook 失败只写入调用状态和错误摘要，不改变会话或工具结果。
- 离线文档读取遇到不存在的包、版本或文件时返回明确的 `FILE_NOT_FOUND` 类错误。
- IPC 输入全部通过 Zod schema 校验，路径和字符串长度在主进程再次限制。

## 测试计划

核心测试覆盖：

- 文件和目录导入。
- 版本隔离、当前版本切换和重启后持久化。
- 全局启用/停用。
- 重复版本去重。
- 大小限制、非法路径和缺失源文件。
- `OfflineDocsList` 和 `OfflineDocsRead` 只暴露启用版本。
- 四类 Hook 的调用顺序、超时、非零退出和 `session.after` finally 行为。

renderer 测试覆盖：

- 离线文档导入、版本切换和启用开关。
- Hook 表单、测试运行和启用开关。
- 工具说明分组和参数详情。
- 归档会话恢复、删除和导出。
- 关于项目内容展示。

完成后运行完整 Vitest、typecheck、lint 和 Electron 构建验证。
