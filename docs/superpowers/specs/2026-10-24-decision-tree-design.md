# 决策树规范与工作区设计

日期：2026-10-24
状态：待评审
目标版本：SpecLoom 2.6.0

## 1. 目标

给 SpecLoom 增加一类「决策树」规范与一个独立工作区，用来描述实体的行为决策（类比动画树，但更细），并把决策树作为官方组件挂载到实体与系统上。

本轮只做**规范**：数据结构、语义、校验与编辑体验。规范与引擎解耦，运行时由各实现自行决定，不做 Godot 绑定，也不生成代码。

## 2. 非目标

- 不做任何引擎运行时、代码生成或导出格式
- 不支持树内嵌套引用另一棵决策树
- 不支持用户自定义节点类型
- 不改动系统既有的 `components` 语义（仍表示“引用了哪些组件”）

## 3. 数据模型

### 3.1 决策树规范

路径：`specs/decision_trees/<id>.md`，新资料类别 `decision_tree`。

```yaml
schemaVersion: 1
id: combat_decision
title: 战斗决策
type: decision_tree
description: ...
root:
  id: root
  kind: selector
  title: 选择行为
  children:
    - id: flee
      kind: sequence
      children:
        - { id: low_hp, kind: condition, comparator: "vitality.current <= 30" }
        - { id: run, kind: action, action: move_away, params: { speed: 1.5 } }
    - id: attack
      kind: sequence
      children:
        - { id: in_range, kind: condition, event: enemy_in_range }
        - { id: strike, kind: action, action: attack }
```

树用嵌套结构写在 front matter，因此**单根与无环由结构本身保证**，不需要图校验。工作区内部会拍平成节点列表编辑，保存时重新嵌回。

### 3.2 节点词汇

| 类别 | kind | 必需字段 |
| --- | --- | --- |
| 组合 | `selector`、`sequence`、`parallel`、`random` | `children`（至少 1 个） |
| 条件叶子 | `condition` | `comparator` 或 `event`，二选一 |
| 动作叶子 | `action` | `action` 名称；可选 `params` |
| 修饰 | `invert`、`cooldown`、`retry` | 单个 `child`；`cooldown` 另需 `seconds`，`retry` 另需 `count` |

所有节点都有 `id`（树内唯一，`[a-z][a-z0-9_]*`）、`kind`、可选 `title`。

`comparator` 语法：`<组件 id>.<字段 key> <运算符> <字面量>`，运算符限定 `<= < >= > == !=`；字面量按字段类型解析（number / string / boolean）。`event` 是自由事件名（`[a-z][a-z0-9_]*`），语义由实现决定。

### 3.3 官方组件

`specs/components/decision_tree.md`，`scope: system`，字段：

- `enabled`：boolean，默认 true
- `tree`：string，指向决策树规范的 id

### 3.4 挂载与多实例

绑定增加可选 `key`（`[a-z][a-z0-9_]*`），用于同一组件在一个所有者上挂多次。

- 实体：`components: [{ id: decision_tree, key: combat_ai, values: { tree: combat_decision } }]`
- 系统：新增 `mounts: [{ id, key?, values?, mount? }]`，与实体绑定同形；`components` 保持“引用组件”的含义

绑定身份由 `id` 变为 `id#key`（无 key 时仍是 `id`），实体绑定与系统挂载共用同一套身份、字段覆盖与校验规则。

## 4. 工作区

左侧导航新增「决策树」：

- 左侧：决策树规范列表（可按分组折叠，复用资料树样式）
- 中间：React Flow 画布，层级自动布局、拖拽改变父节点与顺序、16px 网格吸附、重叠提示
- 右侧：节点检查器（kind、标题、条件/动作/参数、修饰参数）
- 工具栏：保存、自动整理、校验结果摘要

布局持久化复用现有实体布局 IPC，payload 升到 `version: 3`，增加 `trees` 区域；读取旧版本时 `trees` 视为空，实体布局行为不变。

## 5. 校验

### 5.1 树规范

| 诊断码 | 触发条件 |
| --- | --- |
| `SPEC_TYPE_INVALID` | `type` 不是 `decision_tree` |
| `TREE_ROOT_INVALID` | 缺少 `root`，或根不是组合节点 |
| `TREE_NODE_DUPLICATE` | 节点 id 在树内重复 |
| `TREE_CHILDREN_INVALID` | 组合节点没有子节点，或修饰节点不是恰好一个子节点 |
| `TREE_CONDITION_INVALID` | 条件节点既没有 `comparator` 也没有 `event`，或两者同时存在 |
| `TREE_COMPARATOR_UNKNOWN_COMPONENT` | 比较式引用的组件不存在 |
| `TREE_COMPARATOR_UNKNOWN_FIELD` | 组件没有该字段 |
| `TREE_COMPARATOR_TYPE_MISMATCH` | 字面量与字段类型不匹配 |
| `TREE_ACTION_INVALID` | 动作名缺失或为空 |

### 5.2 挂载

| 诊断码 | 触发条件 |
| --- | --- |
| `DECISION_TREE_MISSING` | `decision_tree` 实例的 `values.tree` 缺失或解析不到树 |
| `BINDING_KEY_DUPLICATE` | 同一所有者上 `key` 重复 |
| `BINDING_KEY_REQUIRED` | 同一所有者重复挂同一组件却没有 `key` |

现有 `ENTITY_COMPONENT_DUPLICATE` 收敛为“同 id 且同 key 才算重复”。

## 6. 兼容

- 无 `key` 的现有绑定身份不变
- 系统没有 `mounts` 时行为不变
- 旧布局文件（version 2）读取后自动按 `trees: {}` 处理
- 新类别加入导航、分组注册、工具 schema；既有类别不变

## 7. 测试

- 树规范合法/非法样例：根缺失、id 重复、子节点缺失、条件二选一、比较式组件/字段/类型、动作名
- 挂载：实体与系统各挂多棵、key 重复、缺 key、`tree` 指错
- 工作区：新增节点、改 kind、拖拽改父、保存回写嵌套结构、布局持久化 v3 往返
- 回归：实体工作区布局、系统引用校验、资料页类别导航

## 8. 交付

版本 2.6.0，测试与类型检查通过后出 Hub 模块并安装验证。
