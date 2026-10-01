---
id: task-planning
name: 任务规划
purpose: 将当前阶段的已批准目标拆分为有明确范围、依赖与验收条件的任务。
allowedSources:
  - specs/project.md
  - specs/outline.md
  - specs/entities/**
  - specs/tasks/**
  - specs/decisions/**
  - specs/prompts/**
---

# 任务规划流程

1. 读取项目、大纲、相关实体、已有任务、ADR 和 specs/prompts/ 中的任务模板，记录全部来源版本令牌。
2. 确认当前阶段与进入、退出条件。concept 聚焦目标与假设，prototype 验证高风险机制，vertical-slice 验证完整体验，production 按既定标准产出内容，alpha 达成功能完整，beta 聚焦稳定与兼容，gold 准备发布候选，post-release 处理已批准维护；阶段细则以项目事实为准。
3. 将目标拆为可独立预览与验证的任务，写明输入、产物、依赖、读路径、写路径、是否允许删除、manual 或 auto 模式、验收标准与失败后的处理。
4. 明确文件或使用以 /** 结束的受限目录授权。只读来源与写入产物分别列出，不能把 Skill 的 allowedSources 当成任务授权。
5. Godot 生成任务按接口、节点布局、脚本和场景块安排：脚本最多 300 行，每批场景最多 48 节点，复杂子场景最多 24 节点，已有更低预算优先。
6. 涉及架构、范围或阶段调整时列出需要采纳的 ADR，描述背景、选择、替代方案、影响与状态；未批准决策保持提案状态。
7. 输出有序任务及来源凭据，通过版本门禁保存到获准的 specs/tasks/ 路径。输入版本变化后重新检查依赖和计划，不能直接沿用旧上下文执行写入。

## 模板与执行边界

任务格式和 ADR 模板从 specs/prompts/ 读取；项目目标、实体和已有任务继续留在各自来源中。本 Skill 不授予 shell 权限，不批准新功能，也不扩大已确认的任务范围。
