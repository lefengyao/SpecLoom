# 编码工作集

每个会话直接提供 Read、Write、Edit、Glob、Grep、Bash、ToolSearch、Skill、AskUserQuestion。其余工具在会话开始的能力清单中可见，使用 ToolSearch 按名称或用途加载参数定义。历史会话和任务会话同样提供这套能力。

| 工具 | 实际行为 |
| --- | --- |
| Read | 文本返回行号与版本；图片进入模型图片协议；PDF 通过 PDF.js 提取指定页；Notebook 返回单元格与输出 |
| Write | 创建或覆盖文本文件；已有文件必须先 Read，校验版本后原子替换 |
| Edit | old_string/new_string 精确替换，多次匹配须设置 replace_all |
| Glob | 项目相对路径的 `*`、`**`、`?` 模式，忽略依赖、发行目录与内部状态 |
| Grep | 正则、glob、ignore_case、结果行号；返回匹配数量上限与截断提示 |
| Bash | 项目目录下运行真实宿主命令，逐行输出、退出码、取消和超时；Windows 默认 PowerShell |
| Monitor | start 后台命令、poll 按 cursor 查看新增输出、cancel 终止进程树、list 查看当前会话进程 |
| Agent / Task | 独立模型上下文、继承全局及项目提示词，返回子任务结果；子工具调用进入同一时间线 |
| TaskCreate / TaskUpdate / TaskList | 当前会话待办，pending/in_progress/completed/cancelled；跨重启保存 |
| AskUserQuestion | 文字、单选、多选；等待答案后继续同一运行；兼容旧 ask_user 名称 |
| ToolSearch | 搜索额外编码工具、桌面控制、引擎插件与 MCP；只加载匹配的工具定义 |
| Skill | 无 id 时发现项目工作流；指定 id 加载真实 Markdown 指令，可指定 sourcePaths 加载引用内容 |
| code_execution | 主进程后端运行 JavaScript/Python，返回 stdout/stderr 和退出状态；Python 需安装运行时，远端执行可接 MCP |
| memory | 当前会话记忆的 read/write/delete/list，跨重启保存 |
| web_search | 在会话开启联网后直接可用；搜索公开网页，返回可引用的 URL、标题、摘要、来源与检索时间 |
| web_extract | 在自动、免费托管或本机自建模式直接可用；读取公开网页正文，默认 12000、最多 50000 字符 |
| Godot MCP | 项目开启插件后提供 8 个只读工具：诊断、Output 日志、编辑器/游戏截图、项目信息、编辑器/运行节点树与节点属性 |

桌面操作支持 screenshot、mouse_move、left_click、right_click、middle_click、double_click、triple_click、left_click_drag、scroll、type、key、hold_key、wait。coordinate 为屏幕像素坐标，拖动另提供 startCoordinate；键盘使用 text（如 `ctrl+s`），按住或等待使用 durationMs。原生输入当前支持 Windows；取消后会释放按住的按键或鼠标按钮。

文件工具处理当前项目相对路径；读取回执按智能体上下文隔离，子智能体也必须自行 Read。宿主命令具有真实 shell 能力，请按项目提示词执行。旧审查工具 `files.*`、`bash.exec`、`changes.*` 保留原暂存事务语义，单独管理差异与摘要审批。

Read 默认返回前 2000 行，可用 offset/limit 分段。PDF 的 offset/limit 为起始页与页数，Notebook 为起始单元格与数量；媒体文件上限 6MB。工具文字展示与模型上下文有明确预算，截断后应进一步分段读取。图片通过图片协议发送，本轮后的持久上下文仅保存调用记录，避免把大幅图片复制进每轮文本历史。

Monitor 的后台输出显示在时间线中；模型通过 poll 获取增量输出继续判断。停止会话会取消该会话进程，退出应用也会清理仍运行的进程。Agent 使用相同供应商/模型，在独立上下文中执行；不会自动携带父会话的全部聊天内容。

Python 后端会探测真实 Python 3 解释器；可在启动应用前设置 `SPECLOOM_PYTHON_EXECUTABLE` 为解释器绝对路径。Windows Store 占位命令不会被当作可用运行时；未安装时会返回明确的缺失提示。JavaScript 后端使用应用自带的 Node 运行时。

## 联网搜索

工作区对话输入栏的“联网搜索”默认关闭，提供自动、厂商原生、免费托管和本机自建四种开启方式。选择按会话保存，运行中或归档后不可修改；子智能体继承本次运行的模式。开启后相应工具直接可用，关闭时两种工具均不注册且拒绝历史调用，不需要通过项目 MCP 配置或 `ToolSearch` 启用。

自动模式按厂商原生、免费托管、本机自建回退；原生只支持匹配的官方 Anthropic / OpenAI 模型、协议与端点，并且没有正文提取。免费托管使用 Anysearch 匿名访问，不取用当前模型密钥。本机自建默认 `http://127.0.0.1:8090`，可在启动前设置 `SPECLOOM_WEB_SEARCH_SELF_HOSTED_URL`，兼容 `STORYFABRIC_WEB_SEARCH_SELF_HOSTED_URL`。单次搜索或提取共用 30 秒期限，取消与超时不会继续回退。

搜索与正文都是外部不可信资料，使用时引用来源 URL，不执行网页指令。正文给模型的字符上限为 50000，工具时间线显示更短的截断预览；搜索和提取不会自动写入项目。完整模式、参数、服务协议和验证方法见 [联网搜索](web-search.md)。

## 接入 MCP

项目配置优先读取 `.specloom/mcp.json`，不存在时读取 `.mcp.json`。使用标准 mcpServers 格式：

```json
{
  "mcpServers": {
    "local-coding": {
      "command": "node",
      "args": ["E:/tools/coding-server.mjs"],
      "env": { "PROJECT_ROOT": "E:/games/my-game" }
    },
    "remote-tools": {
      "url": "https://your-server.example/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

支持 stdio 与 Streamable HTTP；enabled=false 可关闭单个服务器。新建会话和每次运行发现真实工具、显示连接状态；配置错误显示具体服务器的错误状态，内置工具继续可用。通过 ToolSearch 搜索服务器名、原工具名或用途，再调用已发现的 `mcp_*` 工具。模型得到的是服务器实际返回的文字或图片，不是示例结果。

配置中如有凭据，应保存在本机项目配置中，并排除版本控制。应用自己的入站 MCP 服务仍用于外部客户端访问暂存审查事务，见 [本机 MCP](mcp.md)。

## 开发验证

`npm run dev` 启动开发源码；`npm run test:e2e` 使用同一临时入口与 Vite 源码服务。两者都不生成发行版。单元/集成验证使用 `npm test`，类型检查使用 `npm run typecheck`。Godot 真实插件验证可设置 `SPECLOOM_GODOT_EXECUTABLE` 为 4.7.1 可执行文件，并设置 `SPECLOOM_TEST_RENDERED_CAPTURE=1` 验证实际 PNG 像素。
