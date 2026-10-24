# SpecLoom 2.6.0 更新

新增「决策树」规范、官方组件与节点工作区，行为决策可以像动画树一样可视化编排。

## 规范

- 新类别「决策树」：`specs/decision_trees/<id>.md`，`type: decision_tree`。
- 树用嵌套 `root.children` 写在 front matter，单根与无环由结构保证。
- 节点类型：组合（选择/顺序/并行/随机）、条件（字段比较或事件名，二选一）、动作（名称 + 参数）、修饰（取反/冷却/重试，单子节点）。
- 字段比较写成 `组件.字段 运算符 值`，运算符限定 `<= < >= > == !=`，校验组件、字段与字面量类型。

## 工作区

- 「决策树」页选中一棵树即进入节点画布：拖拽移动、点选节点在右侧检查器改类型/标题/条件/动作/参数。
- 工具栏支持自动整理、添加子节点、删除节点、同级上移/下移；画布位置按树文件记忆在本地布局。
- 源码编辑仍然可用，随时切回看原始 YAML。

## 官方组件与挂载

- 官方组件 `decision_tree`（`scope: system`）：字段 `enabled`、`tree`；新项目初始化时自动创建，已有项目可直接新建同名组件或用本次附带的文件。
- 绑定新增可选 `key`，同一组件可在实体上挂多次，用 key 区分（`id#key` 为实例身份）。
- 系统新增 `mounts` 实例列表，可挂决策树；系统的 `components` 仍是“引用了哪些组件”。

## 校验

新增诊断码：`TREE_ROOT_INVALID`、`TREE_NODE_INVALID`、`TREE_NODE_DUPLICATE`、`TREE_CHILDREN_INVALID`、`TREE_CONDITION_INVALID`、`TREE_ACTION_INVALID`、`TREE_COMPARATOR_UNKNOWN_COMPONENT`、`TREE_COMPARATOR_UNKNOWN_FIELD`、`TREE_COMPARATOR_TYPE_MISMATCH`、`DECISION_TREE_MISSING`、`BINDING_KEY_REQUIRED`、`BINDING_KEY_DUPLICATE`、`SYSTEM_MOUNT_DUPLICATE`、`SYSTEM_MOUNT_FIELD_UNKNOWN`、`SYSTEM_MOUNT_VALUE_INVALID`。

## 兼容

- 没有 `key` 的现有绑定身份不变，行为不变。
- 系统没有 `mounts` 时行为不变。
- 未声明 `root` 的决策树文件会提示创建根节点，不会影响其他资料。
- 2.5.0 的场景校验与结构化编辑保持不变。
