# SpecLoom 工作流与实体组件工作台设计

> 2026-10-18 与用户确认：官方开发审查采用标准 6 节点；先落地 B，再扩展到 C；运行时采用主进程 WorkflowRunner；工作流页采用“编排 / 运行”双模式；实体采用独立工作台，组件拼接使用实体中心 + 组件节点画布。参考 DeterminFlow 的产品交互与运行时边界，不复制其 AGPL 代码。

## 1. 目标

这次更新包含两个可独立验收、但在同一套资料与任务体系上协作的部分：

1. **工作流**：新增可视化编排与运行入口，内置一条官方开发审查工作流，支持用户自制符合 B 约束的工作流。
2. **实体工作台**：实体页增加可视化组件拼接与字段填充，保留现有详情 / 源码编辑和文件版本保护。

工作流不绕过现有 ProjectCore 的任务 scope、staged change set、校验和人工批准。实体工作台不改变实体 / 组件数据格式。

## 2. 已确认的决策

- 官方开发审查：标准 6 节点（读取规范、规划、实现、自动校验、人工审查、记录决策）。
- 交付顺序：先完成 B 的可执行闭环，再扩展 C 的并行 / 循环 / 子流程 / 恢复能力。
- 运行时：主进程 WorkflowRunner；Renderer 只做编辑、启动、审批和状态展示。
- 页面：顶部切换“编排 / 运行”，两边共用同一张画布和同一份运行数据。
- 实体工作台：独立于工作流的可视化工作台；组件编辑器做成可复用面板，后续实体节点直接复用。
- B 的组件拼接是“挂载到实体”的装配，不是任意组件间连线；画布连线由挂载关系派生。

## 3. 范围与非目标

### 3.1 B 首版包含

- 工作流定义的文件存储、版本保护、Zod 校验。
- 官方标准审查内置模板，只读；可复制为项目工作流。
- 用户新建、编辑、删除、保存自定义工作流。
- 编排 / 运行双模式页面；React Flow 画布；节点检查器；运行输入、状态、时间线、审批。
- 主进程按节点执行：只读规划任务、写入实现任务、校验、人工审查、决策记录。
- 审批驳回回到实现节点；取消；失败状态；运行记录持久化。
- 实体工作台：组件库、实体中心画布、组件字段检查器、继承 / 覆盖、保存、校验、草稿与版本冲突。

### 3.2 B 明确不做

- 并行、循环、子流程、通用网关、多写入 Agent。
- 节点级独立 scope；B 中写入 Agent 共享运行级 scope，规划 Agent 使用独立只读任务强制限制。
- 运行中 Agent 崩溃后的自动续跑；C 再做恢复。
- 工作流市场、跨项目共享、远程协作。
- 实体节点接入工作流；实体工作台先独立，C 再增加实体节点。
- 实体 / 组件 schema 变更；不新增字段类型，不改变现有 Markdown front matter 语义。
- 游戏运行时代码生成；工作流只编排开发与审查。

## 4. 工作流定义

### 4.1 存储

- 自定义工作流：specs/workflows/<id>.yaml，项目文件，使用现有版本令牌和草稿保护。
- 官方模板：随应用提供的只读资源 resources/workflows/official-development-review.yaml；列表显示“官方”，复制后才写入项目。复制目标已存在时要求另存或明确覆盖，覆盖必须带当前版本令牌。
- 运行记录：.specloom/workflows/runs/<runId>.json，原子写入；智能体不可写。
- 运行记录保存有界节点输出和状态摘要，不另建事件文件。

### 4.2 定义 Schema

SchemaVersion 为 1。一个完整定义至少包含：

~~~yaml
schemaVersion: 1
id: wf_official_development_review
title: 官方开发审查
description: 读取规范、规划、实现、校验、人工审查并记录决策。
version: 1
inputs:
  - { key: goal, label: 目标, type: string, required: true }
  - { key: readPaths, label: 读取范围, type: paths, required: true }
  - { key: writePaths, label: 修改范围, type: paths, required: true }
  - { key: model, label: 模型, type: model, required: false }
nodes:
  - { id: context, type: context, label: 读取规范, position: { x: 80, y: 120 }, config: {} }
  - { id: plan, type: agent, label: 规划, position: { x: 260, y: 120 }, config: { access: read, prompt: "阅读运行范围内的项目资料，输出可执行的实现计划；不得修改文件。" } }
  - { id: implement, type: agent, label: Agent 实现, position: { x: 440, y: 120 }, config: { access: write, prompt: "根据目标和计划实现改动；只写 writePaths 允许的路径；完成后总结改动与验证建议。" } }
  - { id: validate, type: validation, label: 自动校验, position: { x: 620, y: 120 }, config: {} }
  - { id: review, type: approval, label: 人工审查, position: { x: 800, y: 120 }, config: { allowReject: true } }
  - { id: decide, type: decision, label: 记录决策, position: { x: 980, y: 120 }, config: { directory: specs/decisions } }
edges:
  - { id: e1, from: context, to: plan, on: success }
  - { id: e2, from: plan, to: implement, on: success }
  - { id: e3, from: implement, to: validate, on: success }
  - { id: e4, from: validate, to: review, on: success }
  - { id: e5, from: review, to: decide, on: success }
  - { id: e6, from: review, to: implement, on: reject }
settings:
  maxImplementAttempts: 3
~~~

节点配置：

| 类型 | 必填 config | 说明 |
|---|---|---|
| context | 无 | 读取运行输入的 readPaths，记录文件清单和摘要；不运行模型 |
| agent | access, prompt | read 或 write；可选 model 覆盖运行模型 |
| validation | 无 | 调用现有资料 / 引用 / Godot 校验；不在 B 接受任意 shell |
| approval | 无 | 展示 write task 的差异与校验；allowReject 固定为 true |
| decision | 无 | 批准后写入决策 Markdown；目录限定 specs/decisions |

B 校验规则：

- 节点 id 唯一；边引用的节点存在；至少一个 context、一个 write agent、一个 validation、一个 approval、一个 decision。
- 图必须从 context 可达 decision。
- 恰好一个 write agent；其余 agent 必须是 read。
- 除“approval → write agent”的 reject 边外不允许环、分支、并行或循环。
- 不允许未知节点类型、未知 edge 事件、重复 decision、空 prompt、非法路径。
- 官方模板和自定义模板使用同一份校验器；官方模板校验失败意味着应用资源损坏，必须在测试中拦截。

## 5. 官方标准审查流程

1. **读取规范**：读取 readPaths，记录文件数与摘要；不建任务。
2. **规划**：创建只读任务（writePaths 为空），运行 plan agent；输出计划文本；成功后移除临时任务，计划保存在运行记录中。
3. **Agent 实现**：创建 write 任务，scope 为运行级 readPaths / writePaths；运行 implement agent，携带目标与计划；改动进入 staged change set。
4. **自动校验**：对 write 任务调用现有校验器；保存 ValidationResult。
5. **人工审查**：调用 previewChanges，展示差异与校验；用户批准则 approveChanges 提交，驳回则 rejectChanges 丢弃改动并重新运行 implement。
6. **记录决策**：提交成功后写入 specs/decisions/<日期>-<workflow-id>-<run-id>.md，记录目标、计划摘要、实现摘要、校验结果、批准时间、模型与运行 id；运行完成。

失败规则：

- plan / implement Agent 调用失败：运行 failed，节点记录错误；用户可取消或重试该节点（B 只允许在节点边界重试，不自动续跑）。
- 校验失败：运行 failed，保留 write 任务与改动；页面提供“重试校验”和“返回实现”；不自动循环。
- 审查驳回：调用 rejectChanges，实现节点 attempts 加一；超过 maxImplementAttempts 后运行 failed，不再自动重跑。
- 用户取消：中止当前 Agent；运行 cancelled；write 任务保留 staged 改动，用户可在任务页处理。

## 6. 运行时

### 6.1 主进程组件

- WorkflowStore：列出 / 读取 / 保存 / 复制 / 删除定义；处理版本令牌、路径安全和目录初始化。
- WorkflowRunner：加载定义快照、创建运行记录、执行节点、调用 ProjectCore、处理审批 / 拒绝 / 取消、写决策。
- WorkflowTaskAdapter：封装 createTask、agentMessage、validate、previewChanges、approveChanges、rejectChanges、removeTask，便于用 fake 实现测试。
- IPC 路由：workflow.list / read / save / remove / copyOfficial / start / retry / cancel / approve / reject / getRun / listRuns。retry 接收 runId 与动作 validate / implement / plan，只允许在 failed 运行上重试对应节点。
- 事件：主进程向当前窗口推送 workflow:update，载荷包含 runId 和更新后的运行摘要；Renderer 只订阅并刷新，不执行节点。

### 6.2 运行状态

~~~text
queued -> running -> waiting_approval -> completed
                    |-> failed
                    |-> cancelled
                    |-> interrupted
~~~

节点状态：pending / running / waiting_approval / completed / failed / skipped。

运行记录至少包含：schemaVersion、runId、workflowId、workflowVersion、title、status、inputs、definitionSnapshot、nodeStates、readTaskIds、writeTaskId、attempts、validation、approval、decisionPath、startedAt、finishedAt、error。

每次状态转换后原子落盘。同一项目同时只允许一个活动运行；有活动运行时不接受新的 start，返回明确错误。

### 6.3 任务与权限

- 只读规划任务：writePaths 为空，运行结束后移除；任务 id 只出现在运行记录中。
- 写入任务：一个；scope 来自运行输入；审批 / 校验都以它为准。
- B 不允许节点自行扩大 scope；write agent 只能写运行输入的 writePaths。
- 规划节点不可能通过提示词越权写入，因为它拿到的任务没有写路径。
- 任务标题使用 [工作流] <title> / <runId>，便于在任务历史中识别。

### 6.4 重启与审批

- 等待审批的运行在重启后仍可加载；审批需要提交当前 digest，过期 digest 拒绝并刷新预览。
- 正在运行的 Agent 遇到重启：运行标为 interrupted，不自动重跑；用户可新开运行。C 再做检查点续跑。
- 运行记录、决策文件和 write 任务历史保留；只读临时任务不保留。

## 7. 工作流页面

新增顶层导航“工作流”。页面顶部固定“编排 / 运行”双模式，切换不丢失当前工作流选择。

### 7.1 编排模式

- 左栏：官方模板、自定义工作流、最近运行入口；官方项标记只读，提供“复制为自定义”。
- 中间：React Flow 画布；节点类型 palette（context / agent / validation / approval / decision）；拖入、选择、连线、删除；缩放、平移、适配视图。
- 右栏：工作流设置、节点检查器；字段校验错误就地显示；保存前运行完整 B 校验。
- 工具栏：新建、复制官方、保存、运行、删除；有未保存修改时离开 / 切换需要确认。
- 定义保存到 specs/workflows/<id>.yaml；保存使用版本令牌，冲突时保留草稿并提示重新读取。

### 7.2 运行模式

- 左栏：运行列表，按状态和开始时间排序；支持打开历史运行。
- 中间：同一张画布，显示节点状态、当前节点、失败 / 等待审批高亮，不提供编辑。
- 右栏：运行时间线、节点输出摘要、校验结果、审批面板；批准 / 驳回需要对应 digest。
- 启动前显示输入表单：目标、读取范围、修改范围、模型；路径来自项目内选择，不允许项目外路径。模型为空时使用当前默认模型；没有可用模型则不能启动。
- 运行完成后显示决策文件入口；失败 / 取消提供返回编排、重试节点（校验 / 实现 / 规划）、查看 write 任务的入口。
- 审批展示复用现有差异 / 校验信息，不另造一套文件 diff 语义。

### 7.3 交互与无障碍

- 画布节点可通过键盘选择；检查器和审批面板可键盘操作；焦点可见。
- 支持 prefers-reduced-motion；画布缩放 / 节点动画不阻塞操作。
- 窄窗口下左栏 / 右栏改为可收起抽屉，画布保留；最小可用宽度 900px，390px 只保证查看状态与关键操作，不保证完整编排。
- 新增依赖 @xyflow/react（MIT），不复制 DeterminFlow 的 React Flow 封装代码。

## 8. 实体工作台

### 8.1 入口与布局

实体分类页增加模式标签：工作台 / 详情 / 源码，实体默认进入工作台；现有实体关系树保留，三种模式共享同一份本地草稿。工作台布局：

- 左：实体关系树。
- 次级左：组件库（搜索、系统 / 自定义筛选、拖动 / 点击添加）。
- 中：实体中心 + 已挂载组件节点 + 拖入落点；缩放 / 平移。
- 右：选中组件的字段检查器和拼接关系。

窄窗口时组件库和检查器进入抽屉；树可收起，不新增顶层“实体工作台”导航。

### 8.2 组件拼接

- 组件从库拖入实体，或点击卡片添加；组件节点可拖动，位置写入项目内部布局文件 .specloom/editor/entity-layouts.json，不写实体 front matter。
- 组件节点与实体中心的连线由 components 挂载关系派生；B 不支持任意组件到组件的自定义连线。
- 组件顺序沿用实体 components 数组顺序；布局文件按实体路径和组件 id 记录位置，组件移除 / 重命名时清理孤立项。
- 继承组件以只读卡片显示；点击“覆盖继承值”后创建本实体绑定，行为与现有详情编辑器一致。
- 拖入 / 移除 / 覆盖均更新本地草稿，点击“保存资料”才写入；离开页面保留草稿。

### 8.3 字段填充

- number：数字输入；若同一组件同时存在数值字段 current 与 max，额外显示进度条和滑杆，范围 0..max；否则仅数字输入。
- string：文本输入。
- boolean：开关。
- 检查器显示字段名、类型、默认值、继承来源和当前值；继承值在未覆盖时只读。
- 不新增字段类型、不改变组件定义 schema、不执行游戏逻辑。
- 保存走现有资料保存 API，复用字段 / 引用 / 版本校验；保存失败保留草稿并显示错误。

### 8.4 可复用组件

抽出 EntityComponentBoard（实体中心 + 组件节点 + 派生连线）和 ComponentFillPanel（字段填充与继承展示）。实体工作台先使用；后续实体工作流节点可在抽屉中复用同一个 ComponentFillPanel，不复制表单逻辑。

## 9. 安全与边界

- 工作流不能绕过 ProjectCore 的任务 scope、读取回执、staged change set、校验和审批。
- 只读规划使用真实只读任务，不靠提示词约束。
- 官方模板只读；自定义工作流同样只能使用 Core 节点类型，不能注入 shell、MCP 或任意工具。
- 运行记录、布局文件位于 .specloom，不属于智能体可写的 specs 资料；官方模板不写入项目，复制后才成为用户文件。
- 自定义工作流文件与普通 specs 文件同权限；修改它不会自动提升运行权限，运行仍要求 scope 与审批。
- 审批提交 digest；工作区外部修改会让 digest 变化，必须重新预览。

## 10. 错误处理与限制

- 定义不合法：保存失败，检查器标记节点 / 边 / 配置错误，不启动运行。
- 路径越界或为空：启动失败，不创建任务。
- Agent 失败：节点失败，运行 failed；不自动无限重试。
- 校验失败：保留改动与 write 任务，提供重试校验 / 返回实现 / 取消。
- 审批冲突：拒绝旧 digest，刷新预览，不覆盖用户已查看的批准。
- 重启：等待审批可继续；运行中的 Agent 标为 interrupted；不伪造完成。
- 单项目单活动运行；B 不排队，直接拒绝第二个启动。
- B 的自定义工作流如果包含多个 write agent、分支或环，保存 / 运行校验直接拒绝，并解释 C 才支持。

## 11. 测试与验收

### 11.1 自动化测试

- 主进程单元：定义 schema、B 校验规则、WorkflowStore 版本冲突、运行状态机、只读任务不可写、审批驳回 / 超限、取消、运行记录落盘。
- Fake ProjectCore / TaskAdapter：官方 6 节点成功路径、规划失败、实现失败、校验失败、重试校验 / 重试实现、审批驳回一次后成功、审批 digest 过期、取消。
- IPC：参数校验、错误码、事件载荷、路径安全。
- Renderer：编排模式增删节点 / 连线 / 检查器校验 / 保存冲突；运行模式时间线 / 审批 / 失败操作；实体工作台拖入 / 移除 / 继承 / 字段保存 / 草稿。
- E2E：示例项目上启动官方工作流，使用测试模型替身走完读取 → 规划 → 实现 → 校验 → 批准 → 决策；实体工作台完成一次组件拼接与保存。
- 回归：现有资料、任务、评审、版本冲突和键盘 / 无障碍测试不退化。

### 11.2 验收标准

- 官方 6 节点工作流可以在测试项目上完整跑通，驳回后能回到实现并最终批准，决策文件生成。
- 自定义工作流可以创建、保存、重开、运行；不合法定义无法保存或启动。
- 只读规划任务不能写文件；写入任务只能写运行输入的 writePaths；没有审批不能提交。
- 运行记录在重启后仍可查看；等待审批的 digest 仍有效；运行中的 Agent 不假装完成。
- 实体工作台可以从组件库添加 / 移除组件、编辑字段、继承覆盖、保存并在重开项目后恢复；详情 / 源码编辑仍可用。
- 类型检查、lint、定向单元 / 集成测试、Electron E2E 通过；不运行打包命令，除非用户明确要求。

## 12. 分阶段

- **阶段 1（B）**：工作流定义 / 存储 / IPC / Runner、官方标准模板、编排 / 运行双模式、审批 / 决策、测试。
- **阶段 2（A）**：实体工作台、组件拼接画布、字段填充、可复用面板、测试。
- **阶段 3（C）**：并行 / 循环 / 子流程 / 通用网关、多写节点、节点级 scope、运行恢复、并发运行、实体节点接入工作流；schema 版本升级并保留 B 定义兼容。

首个可交付版本包含阶段 1 和阶段 2；阶段 3 单独设计与实现，不把 C 的运行时复杂度塞进 B。
