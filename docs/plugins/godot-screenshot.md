# Godot 截图桥迁移

SpecLoom 已用 [Godot MCP 官方插件](godot-mcp.md)替代旧的文件轮询截图桥。用户确认安装新插件时，应用会从 `project.godot` 移除旧 `res://addons/specloom_capture/plugin.cfg` 启用引用，以及值完全匹配旧桥路径的 `SpecLoomCapture` Autoload。它会保留 `addons/specloom_capture/` 中的旧文件，不会递归删除项目内容。若 Autoload 名称属于项目自己的设置，迁移会停止并显示冲突。

Godot 游戏和编辑器截图现在通过只读 Godot MCP 工具获取。桌面截图与输入是独立的通用电脑操作能力，仍可用于 Windows 当前前台窗口。
