---
id: entity-catalog
name: 实体目录
purpose: 从实体文件建立可追踪的临时索引，并检查类型、关系与版本来源。
allowedSources:
  - specs/project.md
  - specs/entities/**
  - specs/tasks/**
  - specs/decisions/**
---

# 实体目录流程

1. 按任务选择 specs/entities/characters、maps、systems、items、events 中的文件，不默认读取与任务无关的全部实体。
2. 读取每个实体的 YAML front matter 和正文。索引 id、type、status、version、relations、source，以及真实文件路径与内容版本令牌。
3. 检查 id 唯一性、声明类型与目录是否一致、关系目标是否存在且类型兼容。缺失、重复和循环关系分别报告；循环关系是否允许以规范为准。
4. 找出本次变更的直接依赖和受影响实体，按关系链接回来源文件。目录索引只作为本次任务派生视图，不作为另一份实体事实。
5. 输出相关实体列表、关系、影响范围、诊断和来源凭据。实体数据始终保存在各自的 specs/entities/ 文件，Skill 中不保存人物、地图、物品或系统的副本。

## 执行边界

读取与修改分别由任务范围授权，目录发现结果不扩大权限。任何来源版本变化都使对应索引失效；重新读取后再做实体编辑或 Godot 生成。本 Skill 没有 shell 权限。
