# SpecLoom Hub 多窗口实现计划

**Goal:** 支持多个 SpecLoom 模块窗口，保持项目选择独立、同项目后台一致，并交付 0.1.4 模块。

**Architecture:** 按模块数据目录共享全局服务，按项目路径取得控制器和 MCP 的引用。IPC 从窗口当前控制器分派；关闭窗口释放引用，最后引用才清理后台。使用现有 Hub 0.1.6 多实例清单支持。

**Tech Stack:** TypeScript、Electron、Vitest、Playwright、esbuild。

- [x] 在 `tests/integration/hub-module.test.ts` 增加同数据目录多窗口、项目选择隔离、同项目会话与 MCP 引用、并发设置和失败恢复测试。运行 `npm test -- tests/integration/hub-module.test.ts` 确认缺少多窗口协调造成失败。
- [x] 创建 `src/main/hub-workspaces.ts` 管理共享服务和项目引用。给 `DesktopController` 注入共享服务，保持独立版构造兼容；串行化 RecentProjects 写入。
- [x] 修改 `src/main/ipc.ts`，支持控制器 getter、项目操作覆盖和会话订阅；`hub-module.ts` 管理窗口选择与引用。初始化、切页及关闭均释放引用；关闭时拒绝新调用。
- [x] 增加跨窗口设置/会话/离线资料通知及 Renderer 刷新；保证通知不回写到另一个窗口的项目选择。
- [x] 将模块清单 `multiInstance` 设为 true；更新版本为 0.1.4 和安装说明。
- [x] 扩展 `TraiblazerHub/scripts/test-specloom-module.cjs` 实际多窗口检查。运行 Renderer、会话和模块专项、typecheck、lint、完整 Electron 测试，审查改动。
- [x] 构建 0.1.4 Windows 安装器、便携版和模块，使用原始 Hub 0.1.6 发行包验证导入、多窗口、PDF、引导、关闭、持久化和 StoryFabric 兼容；保存校验值和发布报告。

已有大量未提交改动，保持在当前工作区推进，不创建提交或重置现有文件。
