# SpecLoom 2.2.3 更新

修复外置 MCP 的 `skills.load` 在不带 `expectedVersion` 时直接报输入校验错误的问题。

## 技能加载

- `skills.load` 的 `expectedVersion` 改为可选；省略时先调用 `skills.list` 取当前版本再加载，不再需要外置智能体自己先查版本。
- 直接的 `Skill` 工具保持不变：`Skill()` 列出项目技能，`Skill({ id })` 加载指令。
- MCP 连接提示词补充说明 `skills.load` 可省略版本。

2.2.2 的 Hub 插件后端修复、2.2.1 的外置 MCP 工具面与实体工作台改动保持不变。
