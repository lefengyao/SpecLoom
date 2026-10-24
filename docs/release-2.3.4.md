# SpecLoom 2.3.4 更新

本轮让「组件挂到哪个锚点」成为规范的一部分，而不是代码里的顺序约定。

## 挂载锚点

- 组件与实体规范都可以用 `anchors` 声明挂载点：`name` 必填，`label`、`node`（相对场景根的节点路径）、`capacity` 可选。
- 实体绑定可以声明 `mount: { parent, anchor }`：`parent` 是同一实体上已绑定的组件，或 `__entity__` 表示挂在实体自身。
- 规范里不再靠 `_mount(0/1)` 这类下标推断挂载位置；父级组件、锚点名都写在规范中，可被校验与编辑。
- 工作台卡片显示组件声明的锚点、以及该组件挂到哪个父级的哪个锚点。

## 校验

新增诊断，全部按错误级别拦截：

- `MOUNT_INVALID`：`mount` 缺 `parent` 或 `anchor`
- `MOUNT_PARENT_UNKNOWN`：挂载父级不是本实体已绑定的组件
- `MOUNT_ANCHOR_UNKNOWN`：父级没有声明该锚点
- `MOUNT_ANCHOR_OCCUPIED`：同一锚点超出 `capacity`（默认 1）
- `ANCHOR_NODE_INVALID`：锚点的 `node` 不是相对场景根的路径

`anchors` 声明本身也做形状校验：数量上限 64、名字唯一、`capacity` 1..64、未知字段拒绝。

## 编辑与工具面

- 工作台与资料页修改字段值时保留 `mount`，覆盖继承组件时一并继承挂载声明。
- 智能体的 `MaterialCreate` / `MaterialUpdate` 接受 `components[].mount`，`MaterialBindComponent` 更新数值时不会抹掉已有的挂载声明。

2.3.3 的布局保存并发修复、2.3.2 的布局参数校验、2.3.1 的 Git 差异与工作台改造保持不变。
