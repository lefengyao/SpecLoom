# 智能体资料工具

用户已授权继续补全资料查询、创建、更新、组件绑定和配图能力。采用独立工具模块，复用页面的 ProjectDocuments 保存与图片服务。

- MaterialsList 按分类、关键词、稳定分组 ID、实体类型查询，分页返回摘要、版本和包含空节点的层级分组树；父组 ID 查询包含后代，旧 group 文本查询继续兼容。
- MaterialRead 返回原始内容、结构化元数据、正文及版本。
- MaterialCreate 按名称创建实体、组件、地图、设定、UI 或规范，自动生成 ID，也可指定明确 ID。
- MaterialCreate / MaterialUpdate 使用类别内已登记的 `groupId` 维护分组，替代旧自由文本 `group`；更新名称、说明、父级、继承、字段和正文时不允许改变资料 ID 或文件路径。
- MaterialBindComponent / MaterialUnbindComponent 添加、更新和移除组件绑定。绑定填充默认值并验证字段类型。
- MaterialSetImage 从项目相对路径导入图片，或使用已导入图片，或清除配图；沿用 2 MiB 和格式校验。

所有更新要求 expectedVersion，拒绝外部版本冲突。资料专用工具及通用 Write/Edit 的资料写入共用 ProjectDocuments；新增引用、循环关系与错误字段按现有规则拒绝。工具通过 ToolSearch 按需加载，查询与读取初始可用。

保存成功发布绑定项目的资料变更事件，通过可信 preload 通道刷新资料浏览器和干净编辑器。编辑器有本地草稿时保留草稿，继续使用原版本保存时提示冲突。事件订阅在关闭窗口和离开页面时清理。

不新增模型依赖、任务或资料删除操作。先用真实临时项目验证工具持久化、组件默认值、引用与冲突、图片、发现机制，再验证页面事件同步和源码 Electron。
