---
id: entity-authoring
name: 实体编写
purpose: 依据已批准需求和当前模板编写独立的 Markdown/YAML 实体规范。
allowedSources:
  - specs/project.md
  - specs/outline.md
  - specs/entities/**
  - specs/prompts/**
  - specs/tasks/**
  - specs/decisions/**
---

# 实体编写流程

1. 读取任务、相关实体和 specs/prompts/ 中当前版本的实体模板。确认人物、地图、系统、物品或事件的类型及允许写入的目标文件。
2. 每个实体使用独立文件与稳定 id。front matter 至少检查 id、type、status、version、relations、source；字段细则和状态转换以当前规范及模板为准。
3. 在正文写明已批准的叙述、行为、约束、输入输出、依赖、失败情况和验收标准。仅链接其他实体和决策，不复制对方事实。
4. 对新增或变更关系检查目标 id、类型和来源版本。删除或废弃实体前检查引用者，并确保任务明确允许相应操作。
5. 重大设计选择引用 specs/decisions/ 中的 ADR；尚无批准决策时提供具体提案与影响，不把提案写成既定事实。
6. 以已读取的内容版本令牌暂存变更，检查格式和引用，预览差异后交给统一提交门禁。实体业务 version 按项目约定更新，不能代替文件版本令牌。

## 流程与模板

本文件维护编辑流程；实体字段示例、叙述模板和生成模板只从 specs/prompts/ 读取。不能自行增加未批准功能，不能扩大任务写入范围，也不能从 Skill 文本获得 shell 权限。
