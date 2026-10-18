# SpecLoom Godot MCP 集成规格

日期：2026-10-11
状态：用户已确认
上游来源：`AI工作流/GodotMCP-Standalone`，Godot MCP Server 1.1.0；插件元数据版本以随包源码为准。

## 问题与目标

SpecLoom 目前用自有文件轮询插件提供 `GodotScreenshot`，只覆盖运行中游戏的根视口截图。用户已有的 GodotMCP-Standalone 则通过 Godot EditorPlugin 与本地 WebSocket 桥接，默认注册四个只读观察工具，`inspect` 配置再增加四个只读项目/场景检查工具。SpecLoom 应直接承载这些已注册能力，并将 Godot 插件安装和启用纳入官方插件管理流程。

目标是让同一个 Godot 编辑器连接同时服务 SpecLoom 内部智能体和 SpecLoom 入站官方 MCP；用户确认安装后即把插件安装到当前 Godot 项目并启用。迁移后，SpecLoom 不再依赖旧截图桥实现 Godot 游戏截图。

## 方案选择

1. **在 SpecLoom 主进程内集成桥接和已注册工具（选定）**：随应用打包 Godot 插件资源，在主进程提供按项目隔离的 loopback WebSocket 服务，并把固定工具注册到内部 Agent 与入站 Streamable HTTP MCP。统一生命周期和错误处理，也不要求用户另行配置 Node MCP 子进程。
2. **随应用打包独立 Node MCP 子进程**：保留上游服务边界，但需要 Electron 再启动、配置和监控一条 stdio MCP 连接，且增加打包后的 Node 运行时与进程生命周期复杂度。
3. **只打包 Godot 插件，继续由外部 MCP 客户端连接独立服务**：改动最少，但 Godot 工具不会进入 SpecLoom 官方 MCP 服务，不满足本次目标。

## 用户可见行为

- 插件管理页将旧“SpecLoom 截图桥”卡片替换为“SpecLoom Godot MCP”官方插件卡片，显示安装状态、启用状态、插件版本、连接状态和定位目录操作；该插件不再重复出现在普通 Godot 插件列表中。
- 未安装时，用户点击“安装并启用”后先看到说明和确认操作。取消不修改项目。确认后，SpecLoom 把随应用打包的官方插件复制到上游兼容路径 `addons/godot_mcp/`，在 `project.godot` 中保留原有启用项并加入该 EditorPlugin；安装完成后提示重新载入 Godot 项目，使 EditorPlugin 与其运行时辅助 Autoload 生效。
- 插件已安装但禁用时，启用动作也先要求确认，因为 Godot 会加载项目中的插件脚本。禁用动作移除该插件的启用引用；Godot 插件自身只移除它创建且内容仍匹配的辅助 Autoload。
- 安装和更新遵循不覆盖原则：目标文件不存在时创建，字节完全一致时视为已安装；只有逐文件匹配已知上游基线或 SpecLoom 上一版本的文件才可安全更新。其它同名文件内容不同或项目设置格式不受支持时中止并给出冲突位置，不覆盖第三方文件。
- SpecLoom 提供游戏截图、编辑器截图、输出日志、Godot 诊断、项目信息、编辑场景树、运行中游戏场景树和游戏节点属性读取。桌面 `screenshot`、鼠标和键盘工具仍然是独立的通用桌面能力。

## 组件与数据流

### 随应用打包的 Godot 插件

将 GodotMCP-Standalone 中运行上述工具所需的 `addons/godot_mcp/` 随应用资源打包，同时保留上游 MIT License 和来源/版本说明。项目内插件标识沿用上游路径 `addons/godot_mcp/plugin.cfg`，由 SpecLoom 插件管理器作为一等官方插件管理并从普通插件扫描列表去重。插件与 SpecLoom 服务使用明确的服务标识完成握手，避免同一项目中旧的外部 Godot MCP 服务争抢此插件连接。

插件仅通过当前 Godot MCP 服务的显式路由白名单响应已注册工具所需请求。上游源目录中其它模块即使随插件资源存在，也不得由 SpecLoom MCP 暴露或路由调用。插件对 Godot 项目新增的辅助 Autoload 必须按上游的所有权检查规则添加和移除。

### 主进程桥接服务

新增项目隔离的 `GodotMcpHost`，用项目规范化绝对路径作为键复用桥接服务，避免 Agent 会话和入站 MCP 为同一 Godot 项目重复监听或争夺编辑器连接。服务只监听 `127.0.0.1`，使用上游兼容的 WebSocket/JSON-RPC 协议和 6505–6514 端口范围；插件握手中的项目路径必须精确匹配。服务在应用退出或对应项目生命周期结束时关闭，并清理尚未完成请求。

桥接只允许这八条 Godot 路由：

| SpecLoom MCP 工具 | Godot 路由 | 参数 |
| --- | --- | --- |
| `get_diagnostics` | `mcp/diagnostics` | 无 |
| `get_output_log` | `editor/get_output_log` | 上游游标、方向、页长、日志级别筛选 |
| `get_editor_screenshot` | `editor/get_screenshot` | 无 |
| `get_game_screenshot` | `editor/get_game_screenshot` | 无 |
| `get_project_info` | `project/get_info` | 无 |
| `get_scene_tree` | `scene/get_tree` | 深度 0–64，默认 15 |
| `get_game_scene_tree` | `runtime/get_scene_tree` | 无 |
| `get_game_node_properties` | `runtime/get_node_properties` | 相对节点路径和可选属性名 |

输入按上游对应 Zod schema 校验并应用 SpecLoom 的尺寸/时限限制。只注册上述只读工具；Godot MCP 未在上游 MCP Server 注册的写入、执行、输入模拟、场景编辑、项目控制或资源删除工具均不进入 SpecLoom。输出日志游标和有限历史由项目级服务保管。截图校验 PNG 签名、字节数及尺寸，并以 MCP image content 返回，不写入项目文件，也不把完整 base64 放进会话记录。

### 服务接入

- 入站官方 MCP 的工具目录增加上述八项；调用仍须携带现有 `taskId`，使用对应 `ProjectCore` 项目路径的桥接服务，并保留现有任务状态校验。服务未启用、插件未连接或连接项目不匹配时返回包含恢复指引的结构化错误。
- 内部 Agent 的 `WorkspaceCatalog` 提供相同工具名与 schema，调用共用项目级 `GodotMcpHost`。`GodotScreenshot` 和 `GodotPluginInstall` 不再作为旧截图桥工具展示或分派。
- MCP 入站处理器透传 Godot 工具的文本/图像内容块；其它 SpecLoom 工具继续使用现有 JSON 文本返回方式。

## 旧截图桥迁移

确认安装并启用新官方插件时，SpecLoom 从 `project.godot` 中移除旧截图插件的启用引用，以及值精确等于旧桥路径的 `SpecLoomCapture` Autoload；同时保留旧 `addons/specloom_capture/` 文件，不执行递归删除。遇到同名设置值冲突时中止迁移并提示用户处理。新插件安装/启用与旧设置清理先完成冲突检查，再写入文件和设置；写入失败时恢复此次安装新增或更新的已知基线文件并保留原始项目配置。

旧的截图插件源代码在应用中停止作为运行时工具使用。安装新插件之前仍可查看旧桥状态并进行迁移；不自动卸载其项目文件。桌面截图能力不属于旧 Godot 游戏截图桥，不迁移或删除。

## 安全与错误处理

- 服务只绑定 loopback；不把 Godot WebSocket 服务暴露到局域网。MCP 客户端仍通过现有带 token、Host/Origin 校验的 Streamable HTTP 入口访问工具。
- 项目路径、端口、消息大小和请求时限均有界；连接重置、超时、取消、Godot 返回错误或错误项目路径都转换为可诊断错误，不挂起 MCP 会话。
- 项目安装器使用现有 `PathPolicy` 与安全文件操作，拒绝符号链接、junction、路径逃逸、超限文件和并发修改。
- 工具结果日志记录工具名、结果类别和关联诊断信息；不记录 PNG base64 或完整输出日志文本。
- 对旧 standalone MCP 与 SpecLoom 同时服务同一个 Godot 项目的情况，SpecLoom 插件必须以服务标识握手；SpecLoom 插件不应连接到普通 standalone 服务。

## 验收标准

1. `tools/list` 在插件工具集定义中恰好包含上述八个 Godot 工具，schema 与限制符合本规格；不出现上游未注册的编辑工具。
2. Agent `ToolSearch` 能发现并执行八个工具；没有 Godot 项目、未启用插件、连接断开和项目路径不匹配时均快速返回可读错误。
3. 入站官方 MCP 能通过现有认证和任务 `taskId` 调用相同八个工具；截图响应包含有效 MCP image content，普通 SpecLoom 变更工具不回归。
4. 两个不同 Godot 项目并行访问时，服务根据项目路径将请求发给对应编辑器；同一项目 Agent 与入站 MCP 共用同一桥接实例。
5. 安装确认取消时文件和 `project.godot` 均不变；确认后插件文件正确安装、启用项合并且旧桥设置被精确禁用；第三方文件冲突时不覆盖并无半安装状态。
6. 插件页正确显示已安装、禁用、连接中/已连接、冲突状态，能够定位目录和刷新。旧截图桥不再被工具目录调用，桌面截图工具仍可用。
7. `typecheck` 与相关单元/集成测试通过；构建的安装包包含 Godot 插件及 MIT License。若机器未配置 Godot 4.7+，真实编辑器截图验证明确标记为环境未提供，不伪报成功。

## 不在本次范围

- 把未注册的 Godot MCP 源模块开放给模型或外部 MCP 客户端。
- 从 ZIP/目录安装、更新或卸载任意第三方 Godot 插件。
- 让 MCP 服务启动/关闭 Godot、控制输入或写入 Godot 场景/资源。
- 删除用户项目中旧截图插件目录或改变桌面控制能力。
