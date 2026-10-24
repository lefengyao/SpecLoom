# SpecLoom 2.2.1 更新

2.2.1 把外置 MCP 提升到与内置智能体同等工具面，并集中补齐实体工作台、组件备注和图片导入体验。

## 外置 MCP

- 外置智能体与内置 agent 共用完整工具目录：Read/Write/Edit/Glob/Grep/Bash/Monitor、资料 7 件套、Skill/ToolSearch、Task*/memory、code_execution、桌面操作、Workflow*/Orchestration*、离线文档和 Godot 工具。
- 下游 MCP 服务器以 `mcp_*` 透传并携带真实参数 schema；连接时下发项目工作区提示词、全局自定义指令和项目上下文，并提示临时借用下游工具、无需长期注册。
- 新增、修改、启停或删除 MCP 服务后自动重新发现；令牌和端口按项目固定，启动时先重试原端口约 5 秒。
- 离线文档列表改为分页（默认每版本 200 个文件，返回 fileCount/nextOffset）。

## 任务与校验

- 直写任务可反复读取和修改同一文件：应用或外部写入后按磁盘最新版本继续；staged 任务仍对外部基线变动报 VERSION_CONFLICT。
- 任意 Markdown 变更跳过 Godot 校验（任务 spec 的 smoke scene 也不再强制），非 Godot 项目直接跳过 import。
- 直接写入的文档变更同样参与文档-only 判定。

## 资料与图片

- `MaterialUpdate` 支持 `specs/project.md` 的 `materialGroups`，按类别覆盖分组树，可省略 id/order 自动生成。
- 超过 2 MiB 的 PNG/JPEG 导入自动压缩：界面转 WebP，智能体导入走 nativeImage；GIF/WebP 超限仍拒绝。
- 组件定义新增分条「说明条目」；实体组件绑定新增分条「补充描述」，保存时自动清理空白条目。

## 实体工作台

- 点击语义：实体列表留在工作台并在右侧显示实体详情；组件卡在侧边检查器显示字段/说明；标题行「详情」按钮才打开完整编辑页；拖动不误触。
- 配图显示在实体卡，保持原始比例，可在 80–360px 间调整并可隐藏，偏好按项目保存。
- 继承来源写进列表、标题栏、实体卡和悬停信息；继承组件字段可直接编辑，首次修改自动建立当前实体的自有覆盖。
- 添加组件改为 Godot「创建 Node」式弹窗：收藏/最近使用、搜索、筛选、按分组与继承关系嵌套、说明与 Markdown 正文、创建/取消；画布右上角浮动加号。
- 组件连接锚点可分别选择实体侧/组件侧，可为组件添加自定义锚点，支持拖动连线与拖动端点重连；拖动过程不再闪烁。

## 剪贴板与测试

- 右键菜单覆盖页面选中文字：复制；输入框、文本域和 contenteditable 支持剪切与粘贴。
- 修复实体测试的 ResizeObserver 模拟与详情页返回实体页的导航；修正工作流通配、用量重复发布、编排保存入口等测试。

## 打包产物

- Windows x64 Setup / Portable。
- Trailblazer Hub 模块 `specloom-module-2.2.1.zip`。
