---
id: entity-authoring
name: 实体编写
purpose: 依据当前需求创建实体，再完善层级、继承与组件实例，维护独立的 Markdown/YAML 事实文件。
allowedSources:
  - specs/project.md
  - specs/outline.md
  - specs/entities/**
  - specs/components/**
  - specs/prompts/**
  - specs/tasks/**
  - specs/decisions/**
---

# 实体编写流程

1. 读取任务、相关实体、拟引用的组件及 specs/prompts/ 中当前版本的模板，确认目标资料与允许写入的文件范围。
2. 创建实体时先确定名称，自动分配稳定且唯一的 id，使用 specs/entities/<id>.md；新建实体默认 type 为 entity，schemaVersion 为 1，title 为名称，description 为空，status 为 draft，version 为 1，relations 与 components 为空数组，source 为 developer。名称足以创建草稿，其余详情在后续编辑中补充。
3. 用实际资料组织大类与子类。分类节点也有独立文件，parent 引用同类资料已经存在的真实 ID 或路径；不能写入未创建的分类字符串，也不能使用物理目录代替 parent。extends 只引用单个实体原型，分类、继承和 relations 分别表达。
4. 可复用数据放在 specs/components/<id>.md。组件 type 为 component，声明 schemaVersion、id、title、description 与 fields；每个字段包含 key、可选 label、number/string/boolean 类型和匹配的 default。实体 components 挂载组件 ID 或引用对象，以 values 覆盖已有字段。未覆盖的值按继承链与组件默认值解析，检查重复挂载、未知字段和类型不符。
5. 后续详情填写说明、正文、实体类型、父级、继承及组件实例值。正文记录任务要求的叙述、行为、约束、输入输出、依赖、失败情况和验收标准；引用其他事实文件与 specs/decisions/ 中的 ADR。尚未确定的设计写明提案和影响，不把提案写成既定事实。
6. 检查关系目标的真实 ID、类型、文件版本与父级/继承环。先提交新组件与父级资料，再提交引用它们的实体。变更已使用的组件字段名称、类型或删除字段前，检查并处理引用者；删除或废弃资料仍需任务允许相应操作。
7. 以已读取的内容版本令牌暂存变更，检查格式和引用，预览差异后交给统一提交门禁。页面创建草稿不等于文件已经落盘；实体业务 version 按项目约定更新，不能代替文件版本令牌。

## 流程与模板

本文件维护编辑流程；实体字段示例、叙述模板和生成模板只从 specs/prompts/ 读取。不能自行增加未批准功能，不能扩大任务写入范围，也不能从 Skill 文本获得 shell 权限。
