# SpecLoom

**中文** | [English](README.en.md)

> 面向游戏与软件项目的智能体开发工作区。把规范、资料、工作流和审批放在同一个可读、可改、可追踪的桌面空间里。

SpecLoom 不是只会在聊天框里回答问题的编码助手。它把项目资料变成结构化文件，把实现过程变成可视化工作流，把 AI 的修改放进带范围限制、校验和人工审批的轨道。

![SpecLoom 可视化工作流](docs/images/workflow.png)

## 重点能力

### 1. 规范、实体、组件先于代码

项目规则、实体、组件、设定、地图和 UI 都以 Markdown / YAML 保存在项目里。实体工作台把实体中心和组件绑定画成连线，组件字段和继承关系直接在右侧检查器中编辑。

![实体工作台与组件伸缩栏](docs/images/entity-drawer.png)

- 实体搜索、组件搜索
- 组件库放右侧伸缩栏，默认不占画布
- 实体与组件之间自动连线
- 字段值、继承组件和组件定义分开保存
- 组件、设定、地图、UI、规范使用“左侧查找 + 右侧阅读/编辑”三栏布局

![组件资料浏览与详情编辑](docs/images/materials.png)

### 2. 可视化工作流，而不是黑盒长任务

工作流页分为“工作流 / 编排 / 运行”三种模式：

- 官方开发审查作为全局默认模板，项目可以覆盖自己的默认工作流
- 工作流由读取、规划、实现、校验、人工审查、记录决策等节点组成
- 支持顺序编排多个工作流，步骤共享目标、读写范围和模型
- 审批支持继承、强制人工和自动三种策略；自动审批会留下审计标记
- 失败会暂停编排，重试当前步骤后再继续

### 3. 问答和实现是两条路径

| 模式 | 适合 | 行为 |
| --- | --- | --- |
| 问答 | 讨论、分析、查资料 | 普通聊天智能体，不启动工作流 |
| 实现 | 真正修改项目 | 启动默认或指定工作流，按读写范围和审批执行 |

带任务的会话默认进入“实现”模式，自动复用任务范围；自由聊天使用“实现”模式时，会选择已有任务范围或弹出紧凑的范围卡。

### 4. 智能体可以操作项目，但改动有边界

内置资料工具支持查询、读取、创建、更新、挂载组件和设置配图；工作流工具支持列出、创建、运行和取消工作流与编排。修改必须遵守 writePaths，保存需要版本保护，人工审批不会被智能体绕过。

同时支持：

- 项目 Skills 与全局 Skills
- MCP 工具和项目级扩展
- Godot MCP 插件、编辑器打开和项目媒体预览
- 会话历史、上下文压缩、联网搜索和诊断日志

## 快速开始

需要 Node.js 22.12+、npm 和 Windows 桌面环境。编码工作集默认使用宿主 PowerShell，也可以配置 Git Bash；Godot 无头验证和旧审查隔离命令需要 Docker。

~~~powershell
npm install
npm run dev
~~~

开发启动器会自动选择可用端口并打开 Electron。源码版默认复用安装版的用户数据目录；显式设置 SPECLOOM_USER_DATA_DIR 可使用独立调试目录。

验证：

~~~powershell
npm run typecheck
npm test -- --fileParallelism=false
npm run test:e2e
~~~

## 项目数据

~~~text
specs/
  project.md              项目规则
  outline.md              项目大纲
  entities/               实体与分类
  components/             可复用组件
  settings/               设定
  maps/                   地图
  ui/                     UI
  workflows/              项目工作流定义
  orchestrations/         顺序编排定义
  decisions/              决策记录
  prompts/                项目提示词
.specloom/
  skills/                 项目 Skills
  history/                会话历史（不可授予写权限）
  workflows/runs/         工作流运行记录
~~~

实体和组件使用 front matter 保存 id、父级、继承、组件绑定和字段值；正文继续使用 Markdown。完整字段说明见 [架构文档](docs/architecture.md) 和 [分层资料设计](docs/superpowers/specs/2026-10-06-hierarchical-project-materials-design.md)。

## 深入文档

- [架构](docs/architecture.md)
- [品牌与视觉规范](docs/brand.md)
- [编码工具工作集](docs/tool-workset.md)
- [联网搜索](docs/web-search.md)
- [MCP 配置](docs/mcp.md)
- [Godot MCP 插件](docs/plugins/godot-mcp.md)
- [默认工作流与顺序编排设计](docs/superpowers/specs/2026-10-18-default-workflow-orchestration-design.md)
- [会话性能记录](docs/chat-performance-2026-10-08.md)

## 当前状态

v0.1.9，源码开发版。主要面向 Windows 桌面；工作流、编排、实体工作台和资料编辑器仍在快速迭代。欢迎通过 issue 或 PR 反馈具体使用场景。

---

[English README](README.en.md)
