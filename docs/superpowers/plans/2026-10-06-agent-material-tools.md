# Agent Material Tools Implementation Plan

> Execute inline with the existing authorized design. Preserve the current working tree.

**Goal:** 智能体通过专用工具可靠操作应用内资料，页面和智能体共用保存校验并同步显示。

**Architecture:** 提取共享资料摘要与分类；工具参数和工具执行分别独立。ProjectDocuments 发布成功保存事件，可信 IPC 向当前项目资料页推送。

**Tech Stack:** TypeScript, Zod, Electron, React, Vitest, Playwright.

- [x] 写入并运行 tests/core/material-tools.test.ts：真实 WorkspaceTools 创建六类资料，查询与分页，修改／绑定／图片，验证冲突和错误引用。
  Run: `npm test -- tests/core/material-tools.test.ts --maxWorkers=2`。新增工具缺失时失败。
- [x] 新建 src/shared/material-catalog.ts，提取现有分类和摘要；renderer/materials-model.ts 重导出供页面继续使用。
- [x] 新建 src/main/core/tools/material-tool-catalog.ts 与 materials.ts，注册七项工具。创建和修改调用 `ProjectDocuments.save(path, content, version)`。
- [x] 通用资料 Write/Edit 也使用 ProjectDocuments；保留代码文件原有写入流程和读取收据。
- [x] 新建项目资料变更事件模块；保存成功后发布 `{ projectPath, path, version }`。IPC/preload 提供订阅，DocumentsView 按项目刷新，保留未保存草稿。
- [x] 增加 renderer 与 IPC 事件回归，以及模拟模型调用的真实 DesktopSessions 集成测试。
- [x] 更新工具说明、架构文档与系统提示词，明确先读版本和专用工具发现。
- [x] 运行 typecheck、lint、完整 Vitest（maxWorkers=2）和源码 Electron 验收，记录结果。

## 验证结果（2026-10-06）

- 完整 Vitest：615 通过，0 失败，14 条件跳过。报告位于 `.local/agent-material-tools-tests.json`。
- 源码 Electron：6 项全部通过，新增 material-agent 验证模型真实调用、配图持久化、干净编辑器刷新、草稿保护与冲突重新读取。
- typecheck、lint、Git diff whitespace 检查通过。
- 实际 Electron 验收发现 contextBridge 丢失 Error 的自定义 code/details，已改用可克隆的错误记录；三个现有界面失败测试先复现 `[object Object]`，共享 error-message 修复后 23 项相关界面测试通过，完整回归再次通过。
- 保留现有工作树与未提交内容；未构建安装包。
