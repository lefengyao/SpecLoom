# SpecLoom 0.1.9 · Trailblazer Hub 应用

需要 **Trailblazer Hub 0.1.6 或更新版本，Windows x64**。

## 在 Hub 中启动最新源码

当前 SpecLoom 源码版本为 0.1.9，配套 Trailblazer Hub 源码版本为 0.1.7；模块最低兼容 Hub 0.1.6。两个相邻项目安装好依赖后，在 `TraiblazerHub` 目录执行：

```powershell
npm run dev:specloom
```

命令会编译当前 SpecLoom 的 Renderer、后端、预加载桥、附件解析 Worker、Skills、官方 Godot MCP 插件及 PDF 运行时资源，写入稳定开发 profile `TraiblazerHub/.codex/runtime/specloom-source/profile`，再启动当前 Hub 源码。在 Hub「启动」页选择 SpecLoom，点击「启动」即可打开应用；每次点击都会打开新窗口。应用通过已有的 API 2 模块发现机制加载，宿主管理 Electron 与窗口。

程序资源位于该 profile 的 `modules/specloom-0.1.9`。版本号每次从 SpecLoom 的 `package.json` 读取。源码更新后，关闭该源码 Hub 及其 SpecLoom 窗口，再次执行 `npm run dev:specloom` 即可刷新最新资源；设置和项目数据继续保留。同一开发 profile 不允许并发启动以避免替换正在使用的程序。原有 `npm run dev` 命令及其默认 profile 行为不变。

此入口只准备开发资源，不生成 ZIP、安装器或发布索引，也不写入 `release`、`exports`。源码更新不会自动替换已安装的旧版模块。需要发布包时，按本文末尾的显式打包流程操作；2026-10-18 的正式打包结果见 [0.1.9 打包验收](reports/2026-10-18-v0.1.9-package-verification.md)。

0.1.9 将顶部项目信息收进可展开的侧栏，按顺序穿插公开进度气泡与工具步骤，显示编辑文件和片段，并在每轮结束后显示实际文件变化报告。供应商推理保留为默认折叠的可选详情，运行指标只附最终回复。Windows 进程通道修复中文输入与输出编码，保留原有后台作业所有权。文件报告有界比较本轮前后内容，区分直接工具证据与工作区期间观测；敏感内容遵守 Read 审批，受限范围会明确说明。具体边界见 [0.1.9 更新](release-0.1.9.md)。

0.1.8 补齐七项体验反馈：有效或失效的近期项目都可移除历史记录；关于项目展示真实 Git/分支/脱敏仓库地址、README/ignore 和 SpecLoom 信息，智能体沿用现有审批提供 Git 帮助；项目树与资源列表可选择普通文本、图片、音频和视频；`.import` 隐藏选项按项目记忆；聊天输入区紧凑并自动增高；选择文件、键盘和右键粘贴统一传入真实图片或文档正文；后台作业新增安全重启、无进展提示与有界 Stop。

0.1.7 引入的上下文压缩、请求用量校准和联网搜索继续保留。上下文或会话保存容量默认达到 90% 时触发压缩；压缩后的摘要与保留内容用于后续请求，过大的历史会分块处理。

0.1.6 增加项目插件管理页，可查看 Godot EditorPlugin、按名称和状态筛选、启用/禁用及定位目录，并管理 SpecLoom 官方 Godot MCP 插件。用户确认后，模块从模块资源 `resources/godot-mcp` 安装并启用插件；该插件向 Agent 和受认证的本地 MCP 服务提供八个只读 Godot 工具。插件元数据只由主进程有界读取，页面不会执行第三方插件代码；禁用第三方插件不会删除文件。0.1.5 的模型请求诊断日志也包含在本版，可查看阶段和重试记录、按诊断编号检索、导出和清理。日志不保存模型输入、输出、思考、工具参数或凭据。模块多开和其余工作区功能保持可用；每次点击「启动」都会打开新窗口。模块保留页面保留、左侧导航收缩、官方与自定义组件分类、工具链侧栏及智能体引导，以及项目工作区、供应商与模型、权限模式、材料、离线文档、Skills、Hooks 和本地 MCP 功能。Hub 提供 Electron、窗口、文件选择和系统密钥加密；无需另行安装 SpecLoom。

## 0.1.8 文件、附件与后台作业边界

普通文本选中后只读加载，上限 1 MiB；项目树不预读全部媒体或计算整文件摘要。图片上限 32 MiB，支持适应窗口、100% 和缩放；音视频使用原生 controls、进度拖动和视频全屏，能否解码由宿主 Electron 决定，不提供自动转码。媒体由共享 `ProjectMediaRegistry` 颁发单文件、窗口 owner 绑定的临时 URL，通过随机 `127.0.0.1` 端口流式提供 GET/HEAD 和单 Range；每窗最多 4 个 lease，服务合计最多 8 个活动流。切文件、隐藏页面、换项目或关闭窗口会停止播放器并释放该窗口授权，其他窗口的 lease 继续有效；最后后端关闭回收端口与流。路径检查拒绝越界、网络/设备路径、ADS、链接/junction 与保留运行目录，文件替换或删除会使旧授权失效。

聊天附件每批最多 16 项、原始合计 16 MiB，合成正文最多 131072 字符。PNG/JPEG/WebP/GIF 单图最多 2 MiB，真实进入模型 vision 请求；不支持看图的模型会提示并保留草稿。已识别 UTF-8 文本最多 64 KiB；PDF/DOCX 原始文件最多 6 MiB、提取正文最多 64 KiB。PDF 最多 20 页，截断、密码、损坏与无文字扫描件分别说明，不含 OCR；DOCX 只读 `word/document.xml`，拒绝危险 ZIP/XML 结构。解析 Worker 最多 2 并发、16 排队，待处理原始字节合计最多 16 MiB，old-generation heap 128 MiB，10 秒超时或取消即终止。

`scripts/hub-module-resources.mjs` 生成 `runtime/chat-attachment-worker.cjs`，将 yauzl/saxes 随 Worker 打入，并复制 PDF.js 的 worker、字体、cmaps、wasm 和 Windows canvas 依赖。`hub-workspaces` 通过共享服务将 Worker 真实路径传入各 controller，窗口关闭或项目退出会撤销所属解析任务；临时资源 smoke 实际启动 Worker 提取 PDF/DOCX 正文。

Windows 原生粘贴先读取明确文件表示：FileNameW，或 Electron 归一化后的 `text/uri-list`。URI-list 只解析显式本地 `file:` URI，普通文字不会被当作路径读取；有效文件优先于文档预览位图，无效文件表示直接报错。原生回退每次只读一个本地普通文件，多文件表示会提示只取第一个；DOM FileList 和文件选择器支持多选。无文件表示才读取截图或文本，截图先检查空图及 1600 万像素上限，再编码并检查 2 MiB。右键与键盘粘贴共用同一准备链，异步结果绑定原项目/会话，不落入后来选中的会话。

Windows 宿主进程使用 Job Object，在目标进程恢复执行前建立子孙所有权；Stop 可以取消永不完成的 executor 等待并保存已停止状态，同时回收本会话拥有的进程树。Monitor 的 restart 要求本会话作业 ID、完全相同的原命令和正常命令审批，外部实例/端口占用只报告，不按名称或端口批量终止。短暂无输出先建议较长等待；同一运行中作业至少 5 次无变化且达到 120 秒无进展才结束重复轮询，真实进展和作业/状态变化重置预算。该提示保留仍运行进程的真实状态，不冒称测试已完成。

源码入口的模块设置、供应商密钥和最近项目列表保存在 `TraiblazerHub/.codex/runtime/specloom-source/profile/module-data/specloom`。常规安装版 Hub 则使用 `%APPDATA%/trailblazer-hub/module-data/specloom`，程序安装在其 `modules/specloom-<版本>` 目录。源码开发 profile、常规 Hub 和独立桌面版使用各自的全局设置，因此首次使用源码模块需要配置供应商。项目文件和 `.specloom` 会话数据仍保留在原项目目录中，可以直接打开已有项目。

窗口的项目选择、页面、草稿和待引导消息各自保留。不同项目分别运行后台；多个窗口打开同一项目时，共享会话、智能体运行和本地 MCP，避免重复执行同一会话。可从另一窗口继续引导运行。供应商、设置、最近项目、离线资料和全局 Skills、Hooks 在窗口间共享。

关闭一个窗口会释放该窗口的项目引用，其余窗口仍打开同一项目时，正在运行的智能体继续工作。关闭该项目的最后一个窗口才取消运行、等待已开始的操作完成并关闭 MCP。更新或卸载前需关闭所有 SpecLoom 窗口。Hub 0.1.6 已支持此次多开，无需更新宿主。卸载仅移除模块程序，保留模块设置与项目数据；更新不清除 `module-data/specloom`。

Windows 会将 PDF 读取用的原生库保持加载至 Hub 退出。卸载和更新会立即移除旧模块的安装记录；仍被 Windows 占用的库暂存在隐藏的 `.retired-*` 目录，下次启动 Hub 时自动清理。

旧版 Hub 仅支持宿主 API 1，无法安装此 API 2 模块。StoryFabric 等 API 1 模块继续兼容新版 Hub。Hub 安装包不预装任何模块。

## 源码验证与安装版的区别

0.1.8 验证中的 `tests/e2e/hub-project-files.spec.ts` 使用临时 Electron 测试宿主，加载当时的 `createRuntime` 模块源码、真实隔离 preload 和两个 BrowserWindow，验证共享项目/会话、窗口独立媒体授权、项目切换、原生剪贴板与附件 Worker。该 fixture 提供所需 Hub 上下文和每窗 IPC 路由，资源 smoke 则使用资源准备脚本生成临时模块目录。它们覆盖模块运行链，但没有启动相邻 Hub 的完整界面，也没有安装或更新常规 Hub 发布模块；不能据此声称已安装 Hub 或旧 ZIP 已包含 0.1.8 或 0.1.9。

0.1.9 的源码验证范围与执行结果见 [0.1.9 验收报告](reports/2026-10-17-v0.1.9-verification.md)；0.1.8 的历史结果保留在 [0.1.8 验收报告](reports/2026-10-17-v0.1.8-verification.md)。源码测试结果不代替正式 Hub 安装、更新和发布包验收。

## 安装已生成的发布包

以下流程仅用于已经生成并取得的发布 ZIP，源码启动不需要此步骤：

1. 安装或解压支持 API 2 的 Trailblazer Hub，并启动 Hub。
2. 在「下载」页点击「选择车厢包…」，选择对应版本的 `specloom-module-<版本>.zip`。
3. 在「启动」页选择已安装的 SpecLoom，点击「启动」。

## 显式请求时从源码打包

仅在明确要求打包发布时，在 SpecLoom 目录执行 `npm run module:build`，或在 Hub 目录执行 `npm run module:build:specloom`。该命令与源码启动共用 `scripts/hub-module-resources.mjs` 的资源准备逻辑，重建当前 Renderer、后端和附件 Worker，包含必要的 PDF 运行时、ZIP/XML 解析依赖、Skills、官方 Godot MCP 插件资源和预加载桥，不包含 Electron 运行时、独立安装器或用户密钥。运行时从已安装模块自己的 `resources/godot-mcp` 读取插件文件。只有此打包流程会将 ZIP、校验值及发布索引写入相邻 `TraiblazerHub/release/<Hub版本>/modules` 及 `TraiblazerHub/exports`。可通过 `TRAILBLAZER_HUB_ROOT` 指定 Hub 项目目录。
