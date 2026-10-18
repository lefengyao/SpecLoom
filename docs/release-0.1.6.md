# SpecLoom 0.1.6

发布日期：2026-10-11

0.1.6 增加独立插件管理页面，包含 SpecLoom 截图桥和当前 Godot 项目中的 EditorPlugin。用户可以检索和筛选插件、启用或禁用插件，并定位项目目录。第三方插件文件保持由 Godot/用户管理；SpecLoom 不加载或执行插件代码。

本版沿用 0.1.5 的请求诊断日志、Trailblazer Hub 多开支持，以及工作区、资料、工具链侧栏和智能体引导等功能。

## 验证

- 通过：插件扫描、启停、截图桥、IPC、控制器、Hub reveal、插件页面及导航定向测试，共 44 项通过。
- 通过：`npm run typecheck`、`npm run lint`。
- 未通过：完整 `npm test` 汇总为 89 个测试文件通过、19 个文件失败、5 个跳过；1,185 项通过、56 项失败、14 项跳过，并有 2 个未处理错误。失败分布在会话审批/并发、资料编辑器和 App `tree` 角色查询等现有测试；插件管理定向测试通过。失败尚未在本版解决。
- 通过：Windows x64 桌面构建及 Hub 模块构建。安装程序资源版本为 0.1.6；Hub ZIP 清单版本为 0.1.6，host API 2，最低 Hub 0.1.6，支持多开，且 bundle 将 Electron 保留为宿主运行时依赖。
- 构建附带的 Vite 报告指出 renderer bundle 超过 500 KiB；构建成功，该警告未阻断打包。

## 产物

| 产物 | 大小 | SHA-256 |
| --- | ---: | --- |
| `SpecLoom-0.1.6-Setup-x64.exe` | 118,779,863 bytes | `e903fb5735b14e713cab7e27352783d425da9e9d08b3c73170986f6b644a629a` |
| `SpecLoom-0.1.6-Portable-x64.zip` | 167,728,016 bytes | `29dd765c9a2515eb3eabb90f4d125d4316a9a37bf5e0670c9866ddab5d73d340` |
| `specloom-module-0.1.6.zip` | 19,242,572 bytes | `43dbb354f7f779b11b4931bdf09982e983f08c3615e2a7b0ad8b2d70fae1f946` |

Windows 安装程序的 ProductVersion 和 FileVersion 均为 0.1.6。Hub ZIP 校验为 262 个条目；归档清单确认 `win32`、`x64`、host API 2、最低 Hub 0.1.6、`multiInstance: true`。导出目录中的 SHA-256 sidecar 和 Hub `modules.json` 索引与归档哈希一致。旧 0.1.5 产物保持不变。
