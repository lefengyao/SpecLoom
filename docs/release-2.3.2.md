# SpecLoom 2.3.2 更新

修复实体工作台保存布局时被 IPC 参数校验拒绝的问题。

## 修复

- 工作台布局条目新增了卡片尺寸 `size`，但主进程的布局参数 schema 仍是严格模式且未包含该字段，导致打开实体工作台或拖动组件后保存布局时报 `VALIDATION_FAILED`（Invalid desktop operation arguments）。
- 现在参数 schema 接受 `size: { width, height }`（有限正数，上限 10000）；布局侧车 `.specloom/editor/entity-layouts.json` 可以正常写入卡片尺寸与实体行。
- 补充回归测试：带 `size` 与锚点的布局请求必须通过校验，`width: 0` 与尺寸内的未知字段仍被拒绝；布局存储需要能持久化并读回尺寸。

2.3.1 的 Git 差异着色与批量暂存、实体工作台尺寸与防重叠、版本冲突修复、组件继承与配图裁剪保持不变。
