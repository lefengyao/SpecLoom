# SpecLoom 2.2.2 更新

修复从 Trailblazer Hub 启动时插件页提示 `BACKEND_UNAVAILABLE`（插件系统在当前宿主不可用）的问题。

## Hub 模块

- Hub 运行时为每个项目工作区创建 `PluginManager` 并挂到 `DesktopController`，插件页的内置插件列表、启停、调用、安装和卸载重新可用。
- 模块包补带 `resources/plugins`、`resources/plugin-host-child.mjs` 和 `resources/workflows`；之前只有 Godot MCP 资源，导致 Hub 中没有插件清单和插件宿主进程。
- 关闭项目或窗口时同时关闭插件宿主，避免留下子进程。

2.2.1 的外置 MCP 工具面对齐、任务直写、资料/实体工作台、图片压缩和分条说明等改动保持不变。
