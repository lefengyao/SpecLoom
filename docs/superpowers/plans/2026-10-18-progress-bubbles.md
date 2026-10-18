# Progress Bubbles Implementation Plan

> **For agentic workers:** 用户已给出气泡方向并授权修改；主线程完成展示，子任务完成提示词和最终回复指标；不重复询问执行方式。

**Goal:** 将公开过程说明作为独立气泡，按执行顺序穿插工具步骤。

**Architecture:** 保留现有text事件和会话结构，按连续详情段渲染工具组；侧栏继续按完整用户轮次组织。普通assistant文字承担进度说明，模型推理保持可选详情。

**Tech Stack:** React、TypeScript、Vitest、Electron、Playwright。

- [x] 保存src/tests/docs快照及SHA256清单，核对现有事件与持久化链路。
- [x] `src/main/core/agent-prompts.ts` 加入简短公开进度规则；`session-runs.ts` 仅将指标附在最后assistant。对应runtime/session测试验证多段文字、顺序及不重复指标。
- [x] `tool-chain.ts` 将连续详情分段；`ChatTimeline.tsx` 复用MessageBubble呈现公开进度；`ToolChainBox.tsx` 默认保留可选推理入口。CSS区分轻量进度气泡与最终答复。
- [x] 先用renderer用例复现“后续工具越过公开说明”，再验证段落顺序、生成状态、引导归属、文件报告和线性遍历。独立审查发现引导和停止报告边界，均补回归修正。
- [x] `tests/e2e/chat-progress.spec.ts` mock在工具前后返回不同公开说明，真实源码窗口验证气泡、工具次序和重载。
- [x] 跑相关renderer/core/integration回归、typecheck、本轮文件lint与源码E2E；183项相关回归、6项源码场景分批通过。
- [x] 更新反馈/发布说明和验证记录，确认源码窗口加载修改；保留源码供体验，不打包或提交。

验证及本次失败复验说明见 `docs/reports/2026-10-18-progress-bubbles-verification.md`。
