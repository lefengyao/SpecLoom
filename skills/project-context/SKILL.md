---
id: project-context
name: 项目上下文
purpose: 从项目事实与决策记录建立本次任务所需的版本化上下文。
allowedSources:
  - specs/project.md
  - specs/outline.md
  - specs/decisions/**
  - specs/tasks/**
---

# 项目上下文流程

1. 读取项目说明和大纲，记录来源路径与版本令牌。按任务选择相关决策与任务文件，避免把整个项目历史放入上下文。
2. 从来源确认目标平台、受众、核心体验、引擎版本、约束、验收条件和当前阶段。来源没有写明的事实标记为待确认，不自行补全。
3. 使用来源中的阶段：concept、prototype、vertical-slice、production、alpha、beta、gold、post-release。阶段目标依次关注概念、风险验证、完整体验切片、内容生产、功能完整、稳定性、发布候选、发布后维护；实际进入和退出条件以项目大纲为准。
4. 汇总已采纳 ADR 的背景、决策、替代方案、影响和状态。规范与决策冲突时指出来源，先解决冲突再修改实现。
5. 输出本次任务目标、相关事实、来源凭据、已知缺口、约束和验收条件。项目事实保存在 specs/project.md、specs/outline.md 和 specs/decisions/，不得在本 Skill 中保存另一份可独立修改的事实。

## 执行边界

任务范围决定可读写文件；这些流程不授予权限，也不授予 shell 执行权。来源版本发生变化时重新读取并重新规划。新增功能、变更阶段、扩大任务范围或替换已采纳决策需要已有明确批准。
