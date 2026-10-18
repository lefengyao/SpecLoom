# SpecLoom 0.1.4

新增 Trailblazer Hub 模块多开，继续使用现有 Hub 0.1.6，面向 Windows x64 PC。

## 使用方法

关闭所有 SpecLoom 模块窗口，在 Hub「下载」页导入 `specloom-module-0.1.4.zip`。之后每次在「启动」页点击 SpecLoom 的「启动」，都会打开一个新窗口。更新保留供应商、设置和项目数据。

## 窗口与后台

- 窗口可各自选择不同项目，独立切换页面、编辑草稿和准备引导消息。
- 同一项目的多个窗口共享会话、运行和 MCP。会话创建、修改、删除及任务变化同步；同一会话不能重复启动智能体。
- 可在另一个窗口继续引导正在运行的智能体。关闭发送消息的窗口后，只要仍有窗口打开该项目，工作继续。
- 最后一个项目窗口关闭时取消运行，等待已开始的会话和工具操作结束，再释放后台。并发重新打开会等待旧后台清理完成，避免恢复历史时覆盖尚未保存的结果。
- 供应商、全局设置、最近项目、离线资料、Skills 和 Hooks 共享。并发设置与最近项目更新协调写入；全局 Skill 同步到项目时，安装或删除等待复制完成。
- 原有页面保留、导航收缩、官方与自定义组件分类、工具链方框、右侧栏和引导功能继续保留。

模块支持由其清单的 `multiInstance: true` 启用。独立桌面版继续提供相同功能与后台改进；本次多开入口位于 Hub 模块的「启动」按钮。

## 验证与发行文件

- TypeScript 类型检查、完整 ESLint 和最终多窗口代码审查通过。
- 完整单元与集成测试：1189 项通过、14 项跳过，跳过项依赖外部 Python、Godot 或 Docker 环境。日志：`.local/full-unit-0.1.4.log`。
- Electron 完整端到端测试：18 项通过，覆盖原有权限、会话、引导、输入恢复、组件和导航操作。日志：`.local/full-e2e-0.1.4.log`。
- 实际 Windows 便携版启动检查通过：版本、9 个发行文件与构建文件的内容一致、沙盒运行、组件分类、引导接口和导航收缩均正常，没有 Renderer 错误。
- 使用原始 Hub 0.1.6 便携发行版导入模块，实际三窗口检查通过：不同项目独立、同项目共享 MCP、拒绝同会话重复运行、跨窗口引导、关闭发送窗口后回复继续、最后窗口关闭 MCP、持久化、卸载重装和 StoryFabric 兼容均正常，没有 Renderer 错误。结果：`../TraiblazerHub/.codex/verification/specloom-module-0.1.4-packaged-result.json`。

实际发行包检查和 SHA256 记录保存在 `release/0.1.4/verification.json`、`release-manifest.json` 和各产物旁的 `.sha256` 文件。

| 产物 | 字节数 | 位置 |
| --- | ---: | --- |
| Hub 模块 | 19,218,590 | `TraiblazerHub/exports/specloom-module-0.1.4.zip` |
| Windows x64 安装包 | 118,741,094 | `SpecLoom/release/0.1.4/SpecLoom-0.1.4-Setup-x64.exe` |
| Windows x64 便携版 | 167,682,750 | `SpecLoom/release/0.1.4/SpecLoom-0.1.4-Portable-x64.zip` |

Hub 模块同时保存在 `TraiblazerHub/release/0.1.6/modules`。0.1.3 的三个旧发行文件经 SHA256 核对保持不变。
