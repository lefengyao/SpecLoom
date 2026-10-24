# SpecLoom 2.9.1 更新

补上「官方」标注：分组与系统现在都能标记官方，界面也会显示徽标。

## 数据

- 资料分组支持 `scope: system | user`；`system` 表示随项目基线提供。
- 系统资料允许 `scope: system`（此前只有组件允许）。
- 新项目初始化时写入两个官方分组：组件「基础组件」、系统「音频」；内置组件改用稳定的 `groupId` 指向「基础组件」，音频系统带 `scope: system` 与 `groupId: group_audio`。
- 官方判定：组件看是否随基线提供（`state_machine`、`decision_tree` 的固定路径），其它类别看 `scope: system`。复制出来的组件即使写了 `scope: system` 仍算自定义。

## 界面

- 分组树：官方分组显示「官方」徽标，且重命名、删除被禁用。
- 资料列表（图标/层级/关系图）：官方系统等显示「官方」；组件仍显示「官方组件 / 自定义组件」。
- 详情页：官方资料在名称旁显示「官方」徽标。

## 资料工具

- `materialGroups` 分组项接受并保留 `scope`，与界面写入同一份登记表。

## 兼容

- 旧项目打开后不会自动改写分组；需要官方标记时在 `specs/project.md` 的分组项上加 `scope: system`（本次已为 pvz_warG 的「基础组件」「音频」补上）。
- 已有音频系统补上 `scope: system` 与 `groupId: group_audio`。
