---
id: entity-catalog
name: 实体目录
purpose: 从实体文件建立可追踪的临时索引，并检查类型、关系与版本来源。
allowedSources:
  - specs/project.md
  - specs/entities/**
  - specs/components/**
  - specs/settings/**
  - specs/maps/**
  - specs/ui/**
  - specs/tasks/**
  - specs/decisions/**
---

# 实体目录流程

1. 按任务选择 specs/entities/ 下的实体与分类资料，以及实体挂载的 specs/components/ 组件定义，不默认读取与任务无关的全部资料。实体目录允许嵌套，文件名与 id 一致；分类关系以 parent 引用为准。
2. 读取 YAML front matter 和正文。索引 id、type、title、description、parent、extends、components、relations、source，以及真实文件路径与内容版本令牌。新实体 type 为 entity；已有具体类型的实体保留其业务字段。
3. parent 只能引用同类资料的真实 ID 或路径，extends 只能引用单个实体；检查目标存在、声明类型、版本令牌以及父级和继承环。分类、继承、普通关系分别记录。
4. 组件定义声明 fields，每项包含 key、可选 label、number/string/boolean 类型与匹配的 default。实体 components 挂载组件 ID 或引用对象；values 只覆盖该定义已有字段，未覆盖字段使用 default。禁止字段重名、重复挂载及不匹配的值。
5. 找出本次变更的直接依赖和受影响实体，顺着父级、继承、组件和关系链接回来源文件。目录索引只作为本次任务派生视图，不作为另一份实体事实。
6. 输出相关实体与组件列表、关系、影响范围、诊断和来源凭据。实体数据保存在 specs/entities/，组件定义保存在 specs/components/；Skill 中不保存项目资料副本。

## 执行边界

读取与修改分别由任务范围授权，目录发现结果不扩大权限。任何来源版本变化都使对应索引失效；重新读取后再做实体编辑或 Godot 生成。本 Skill 没有 shell 权限。
