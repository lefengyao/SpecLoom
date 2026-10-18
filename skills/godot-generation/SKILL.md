---
id: godot-generation
name: Godot 分块生成
purpose: 将已批准实体与任务规范转成受预算约束的 Godot 场景和脚本变更。
allowedSources:
  - project.godot
  - specs/project.md
  - specs/entities/**
  - specs/components/**
  - specs/settings/**
  - specs/maps/**
  - specs/ui/**
  - specs/tasks/**
  - specs/decisions/**
  - specs/prompts/**
  - scripts/**
  - scenes/**
---

# Godot 生成流程

1. 读取实体及其继承来源、挂载的组件定义、任务、相关 ADR、生成模板及现有实现，确认 Godot 版本、目标行为、路径授权和验收要求。只实现已批准的功能。分类 parent 不自动赋予行为；extends 继承实体设计，components 使用独立字段定义、默认值和实体 values 覆盖，生成时明确组件的数据与职责。
2. 在生成前明确每个场景的节点树：节点名、类型、父路径、脚本、信号、资源引用；对 Node2D/Node3D 写出变换，对 Control 写出锚点、偏移、容器关系和尺寸约束。
3. 每批只处理一个明确功能。单个脚本不得超过 300 行，超出时按职责拆分并重新预览范围；不要通过压缩多条语句规避预算。
4. 每批场景预算最多 48 个节点，独立复杂子场景最多 24 个节点；已有明确更低预算时沿用已有预算。生成前列出节点数量，超出时拆分为可独立验证的子场景，批准后再继续。
5. 文件、函数和变量使用 snake_case，类名与节点名使用 PascalCase，常量使用 UPPER_SNAKE_CASE；已有项目约定优先。节点路径、信号和资源引用必须与明确布局对应。
6. 生成顺序为接口与节点布局、最小脚本、场景资源、连接关系、验证。每块保留输入规范、模板和实现来源的版本凭据；写入通过暂存变更和统一提交门禁。
7. 按 godot-validation 流程检查导入、脚本解析、引用、行为和预算。验证失败时修复当前块，未通过前不推进下一块。

## 模板与执行边界

场景、脚本及输出格式模板从 specs/prompts/ 读取，本 Skill 只维护工作顺序和预算。新增路径、功能、插件或资源需要已有明确批准。Skill 文本不能授予 shell 权限；只能调用执行边界已提供且任务允许的工具。
