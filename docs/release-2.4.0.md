# SpecLoom 2.4.0 更新

新增「系统」「功能」「架构决策」三类一等规范，游戏设计文档不再只是普通 Markdown。

## 新类别

| 类别 | 路径 | 关键字段 | 校验 |
| --- | --- | --- | --- |
| 系统 | `specs/systems/<id>.md` | `type: system`、`components`、`entities`、`dependsOn` | 引用的组件/实体/系统必须存在；依赖成环会报 `SYSTEM_DEPENDENCY_CYCLE` |
| 功能 | `specs/features/<id>.md` | `type: feature`、`status`（planned/active/done）、`systems` | 状态受限；关联的系统必须存在 |
| 架构决策 | `specs/decisions/<NNNN>-<slug>.md` | `type: decision`、`status`（proposed/accepted/superseded）、`affectedSystems`、`supersedes` | 文件名必须带四位编号；被取代的决策必须存在 |

## 界面与工具

- 资料页新增「系统」「功能」「架构决策」三个入口，资料树、分组、折叠与搜索沿用现有实现。
- 新建对话框按类别生成正确的 front matter：功能默认 `status: planned`，决策默认 `status: proposed`，决策文件名要求四位编号。
- 智能体的 `MaterialCreate` / `MaterialUpdate` 支持上述字段；用错类别会被拒绝（例如给功能写 `dependsOn`）。
- 新项目初始化时会创建 `specs/systems` 与 `specs/features` 目录。

## 兼容

- 已有的决策文档需要补 `type: decision`；其他类别不受影响。
- 2.3.9 的分组折叠、2.3.8 的自动整理按钮、2.3.7 的居中布局保持不变。
