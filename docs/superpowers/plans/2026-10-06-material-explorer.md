# Material Explorer Implementation Plan

**Goal:** 资料创建与保存立即持久化，提供资源管理器浏览，脱离智能体任务。

**Architecture:** ProjectDocuments 复用 FileStore；Desktop IPC 绑定项目身份；浏览器与配图组件独立于 DocumentsView。保留既有层级、继承、组件功能和未提交工作。

**Tech Stack:** Electron、TypeScript、React、Vitest、Playwright。

- [x] 在 tests/integration/project-documents.test.ts 补保存、重开、冲突、目录限制与图片回归；先运行确认新 API 缺失。
- [x] 在 src/main/core/project-documents.ts 实现保存与图片服务，在 ProjectCore、DesktopController、IPC、preload 与 desktop-api 接入专用 API。
- [x] 新增 MaterialExplorer 与 MaterialImage，扩展摘要的 description/group/image；DocumentsView 创建和保存改用专用 API，App 移除任务暂存连接。
- [x] 迁移 Renderer 与 Electron 旧暂存流程断言，验证创建留页、分组检索、视图切换、图片、重开、冲突和草稿保留。
- [x] 更新 README 和架构说明，整理生成目录规则，清理旧测试产物。执行 npm run typecheck、npm run lint、npm test 和 npm run test:e2e。

## 验证结果

- 完整回归：`npm test -- --maxWorkers=2 --reporter=json --outputFile=.local/final-tests.json`，603 通过、14 跳过、0 失败。
- `npm run test:e2e`：5 条源码 Electron 验收通过；资料目录扫描收窄后再次运行 material-components.spec.ts，1 条通过。
- `npm run typecheck`、`npm run lint`：通过。
- 界面截图：`.local/hierarchical-entity-components.png`。现有安装包没有重建，需重启源码窗口加载新 preload 接口。
- 清理旧 test-results 与本轮迁移脚本；build、.workbuddy 纳入本地生成目录忽略规则，保留前序源码、设计与发布产物。
