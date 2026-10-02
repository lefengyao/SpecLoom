# SpecLoom

面向 Godot 独立开发者的本地桌面智能体工作区。规范、实体、提示词和决策保存为 Markdown/YAML；智能体的文件操作、隔离命令和外部 MCP 共享版本检查与任务范围。

## 运行

需要 Node.js 22.12+、npm 和 Windows 桌面环境。Bash 与 Godot 验证需要运行中的 Docker Desktop Linux 容器后端；没有 Docker 时规范编辑和模型对话仍可使用，执行与验证会明确报告未运行。

```powershell
npm install
docker pull bash:5.3@sha256:61962062d969cb46dfc2bad061d36342406fa485f64f246aa7e95693ca07df1f
docker pull barichello/godot-ci:4.4.1@sha256:274a9a1849ec64d0ce8577ccf698bd1b97f9994c150a8e9783e561533e568708
npm run dev
```

开发启动器自动选择可用端口并打开 Electron。`npm run build` 生成 `release/win-unpacked/SpecLoom.exe`，可以直接运行。首版固定使用已验证的 Godot 4.4.1 容器镜像，不调用宿主 Godot 或 Bash；其他引擎版本的镜像配置留待后续版本。

## 项目流程

1. 打开含 `project.godot` 的项目，或创建内置的“灯塔守望”示例。
2. 在规范与实体中整理项目大纲、人物、地图和系统；每个实体保持独立文件。
3. 在模型页面填写 OpenAI 兼容 Base URL、模型名和 API 密钥，明确批准端点。无密钥的本地服务可以显式保存为空密钥。
4. 创建任务并确认读写路径、删除权限与提交模式。目录递归权限必须写为 `目录/**`。
5. 输入任务要求。智能体通过 Skills 读取规范，通过当前版本令牌读取文件，生成暂存变更。
6. 查看文件差异与验证结果。人工模式只有桌面中的“批准并提交”可以授权当前差异；自动模式必须先通过当前变更的完整验证。
7. 在任务与历史中回看范围、对话、工具事件、变更和验证结果。模型请求失败后可继续同一任务；重启恢复未提交草稿与完整工具批次的有界会话，旧批准、读取凭证与活动草稿的验证授权不恢复。

现有文件必须先被当前任务实际读取，才能改写。`VERSION_CONFLICT` 表示输出文件或读取过的来源已被外部修改；保留人工修改，读取最新版本并创建新任务。已经冲突的任务不会自动替换其旧基线。

## 数据布局

`specs/project.md` 与 `specs/outline.md` 保存项目规则和大纲，`specs/entities/` 保存实体，`specs/tasks/`、`specs/decisions/`、`specs/prompts/` 保存流程资料。项目 Skills 位于 `.specloom/skills/`。内部历史位于 `.specloom/history/`，不能授予智能体写权限。

实体 front matter 示例：

```yaml
id: keeper
type: character
status: draft
version: 1
relations: []
source: developer
```

类型支持 `character`、`map`、`system`、`item`、`event`。项目规则中的 `constraints.maxScriptLines` 和 `constraints.maxSceneNodes` 控制生成预算，默认分别为 250 和 80。

生成清单首版提供初始化和引用校验，实体与生成文件的映射由开发者维护。

API 密钥在应用用户数据目录中通过 Electron `safeStorage` 加密保存，不进入游戏项目，不通过列表返回。模型端点变更需要重新提供密钥或显式选择无密钥访问。

## 验证与限制

```powershell
npm test -- --fileParallelism=false
npm run typecheck
npm run lint
npm run test:e2e
npm run build
```

Docker 集成测试在后端或固定镜像不可用时明确跳过；跳过不等于验证成功。Godot 验证检查规范字段、引用、生成预算、无头导入和可选场景冒烟。引擎运行始终使用私有快照、禁网、只读容器根目录、无额外 capabilities 和资源限制。

异常退出后，再次打开项目会回收已确认所有者退出的快照与容器。活跃或存活状态不确定的所有者会保留；清理失败也保留快照与恢复记录，并在工作区显示警告。

单文件替换是原子的。跨文件提交使用串行处理、持久日志和版本保护的恢复；普通文件系统无法对任意外部编辑器保证跨文件事务。恢复遇到外部新修改时会保留文件并报告冲突。

本机 MCP 的地址、临时认证令牌和任务 ID 可在应用中查看。见 [MCP 配置](docs/mcp.md) 与 [架构](docs/architecture.md)。
