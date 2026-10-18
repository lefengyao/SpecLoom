# SpecLoom 0.1.7

发布日期：2026-10-13

修复 Godot MCP 在 MCP 页面中“消失”的显示问题。MCP 页面此前只列出会话配置的外部 MCP 服务，因此即使 Godot 项目插件已安装并启用，外部服务列表仍会显示为空。现在 Godot 项目会单独显示 SpecLoom Godot MCP 的安装、启用和连接状态，并保留外部 MCP 服务列表及其独立空状态。刷新会同时读取两类状态。

## 验证

- 通过：`tests/renderer/CapabilitiesViews.test.tsx`，10 项通过。
- 通过：`npm run typecheck`。
- 通过：本次涉及的 Renderer 和回归测试文件 ESLint 检查。
- 通过：Windows x64 安装程序与便携 ZIP 构建。
- 构建提示：Zod 依赖中 Rollup 无法识别的注释会被移除；renderer bundle 超过 500 KiB。两项提示未阻断打包。

## 产物

| 产物 | 大小 | SHA-256 |
| --- | ---: | --- |
| `SpecLoom-0.1.7-Setup-x64.exe` | 119,086,892 bytes | `7846A72B10F0491CAFAC9BB5684D0132CFFE6AB43CB67AD7D08FE1EAA97EE633` |
| `SpecLoom-0.1.7-Portable-x64.zip` | 168,049,176 bytes | `6C5DC6C982C1024C211434899957463BA62C551801CE9AD2A9F96C6A3FDC83BC` |
