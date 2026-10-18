# SpecLoom 默认工作流与顺序编排设计

> 2026-10-18 与用户确认：默认工作流接工作流 YAML；全局默认官方工作流，项目可覆盖；默认只允许单个工作流；任务创建时保存 goal，首次实现消息启动；聊天使用显式“实现”模式；编排保存为项目定义，也支持临时队列另存；步骤共用输入，上一步摘要注入下一步；每步审批可继承/强制人工/自动；失败暂停可重试；智能体可创建并自主运行工作流与编排，自动批准必须由配置显式开启。

## 1. 目标

在现有 Workflow B 和 WorkflowRunner 上增加：

1. 默认工作流：任务和聊天“实现”模式在用户未指定时使用项目默认；全局默认是官方开发审查，项目可覆盖。
2. 顺序编排：多个工作流保存为有序编排，共用输入，按步骤执行；支持临时队列另存。
3. 智能体自主工作流：智能体可创建工作流/编排、启动目标，并按配置自动批准；未配置时仍人工审批。

不改变实体/组件 schema，不绕过 ProjectCore 的 staged change set、校验和版本保护。

## 2. 已确认决策

- 默认是项目工作流 YAML，不是 Skill。
- 全局默认官方 + 项目覆盖；默认不能指向编排。
- 任务：创建时增加并保存 goal；任务创建后不立即运行，首次实现消息启动默认工作流。
- 聊天：输入框“问答 / 实现”模式；实现模式未指定工作流时使用默认；普通问答不触发 Runner。
- 启动前优先复用当前任务 scope；没有则弹紧凑范围卡。
- 编排保存为项目定义，也支持临时排队再另存；编排不能设为默认。
- 编排共用 goal/readPaths/writePaths/model，不允许每步独立输入。
- 只把上一步摘要、决策路径、审批结果、校验状态注入下一步，不传整条历史。
- 工作流 approvalPolicy: manual | auto，默认 manual。
- 编排步骤 approval: inherit | always | auto，默认 inherit。
- auto 自动批准并继续；always 强制人工；inherit 使用工作流配置。
- 自动批准在 UI 显示警告，运行记录标记 auto-approved。
- 失败暂停编排；重试当前步成功后继续；取消取消当前子运行。
- 智能体可列出、读取、创建、运行工作流和编排；可显式覆盖默认；没有直接“批准”工具。
- 工作流页三模式“工作流 / 编排 / 运行”；不新增顶层导航。

## 3. 数据模型

### 3.1 工作流定义

在现有 WorkflowDefinition.settings 增加可选：

    approvalPolicy?: "manual" | "auto" // default manual

schemaVersion 仍为 1；缺省 manual；官方模板不写该字段。现有 B 节点/边约束不变。

### 3.2 编排定义

保存到 specs/orchestrations/<id>.yaml：

~~~yaml
schemaVersion: 1
id: orch_release
title: 发布前检查
description: 发布前的连续审查
steps:
  - id: s1
    workflowId: wf_official_development_review
    approval: inherit
  - id: s2
    workflowId: wf_custom_release
    approval: always
  - id: s3
    workflowId: wf_custom_notes
    approval: auto
~~~

规则：
- id 与文件名一致，复用 WORKFLOW_ID_PATTERN。
- 1 到 20 步；步骤 id 唯一；workflowId 可重复。
- approval 缺省 inherit。
- 引用工作流必须在运行时存在；缺失禁止运行并显示步骤。
- 线性编排，不支持分支、并行、循环、嵌套编排。

### 3.3 项目默认设置

.specloom/editor/workflow-settings.json：

~~~json
{
  "schemaVersion": 1,
  "defaultWorkflowId": "wf_official_development_review"
}
~~~

- 字段可选；缺省或失效回退官方工作流。
- 只允许单个工作流 id，不允许编排 id。
- 官方显示全局默认；项目覆盖显示项目默认；恢复全局默认删除覆盖。
- 固定路径、原子写入。

### 3.4 任务 goal

TaskScopeSpec 增加可选 goal（最长 8192 字符，仅用于启动默认工作流，不参与文件权限匹配），随任务保存。旧任务没有 goal 时使用任务标题。任务页发送的第一条非空消息视为实现消息。

### 3.5 编排运行

保存到 .specloom/workflows/orchestration-runs/<id>.json：

~~~ts
interface OrchestrationRun {
  schemaVersion: 1;
  orchestrationRunId: string;
  orchestrationId: string;
  title: string;
  inputs: WorkflowRunInputs;
  steps: {
    stepId: string;
    workflowId: string;
    approval: "inherit" | "always" | "auto";
    runId?: string;
    status: "pending" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled" | "skipped";
    autoApproved?: boolean;
    error?: string;
    summary?: string;
    decisionPath?: string;
  }[];
  currentStepIndex: number;
  status: "queued" | "running" | "waiting_approval" | "failed" | "completed" | "cancelled" | "interrupted";
  startedAt: string;
  finishedAt?: string;
  error?: string;
}
~~~

每一步关联一个现有 WorkflowRun；子运行记录仍在现有 runs 目录。

### 3.6 输入上下文

WorkflowRunInputs 增加可选 context（上限 32 KiB）。Runner 在 plan/implement 提示中注入。编排把上一步摘要/决策路径/审批/校验拼成该字段。

## 4. 运行时

### 4.1 默认解析

resolveDefaultWorkflow():
1. 读取项目设置 defaultWorkflowId。
2. 存在且可读、合法、通过 B 校验 -> 使用。
3. 否则使用官方开发审查。
4. 返回来源（official/project）和警告。

官方虚拟 id 为 wf_official_development_review；项目覆盖可以是任意合法项目工作流 id。

### 4.2 触发

任务：
- 新建任务表单增加 goal。
- 任务创建后不启动 Runner。
- 首次发送实现消息时，若未显式指定工作流，解析项目默认。
- 用任务 scope + 保存的 goal 启动 WorkflowRunner。
- 启动后任务显示工作流运行状态；本次消息不再走普通 agent。
- 同一任务只触发一次默认启动；后续消息用于查看/审批/恢复。

聊天：
- 输入框增加“问答 / 实现”模式。
- 问答保持现有行为。
- 实现模式：显式选择工作流则用选择项，否则用默认。
- 优先复用当前选中任务 scope；没有则弹紧凑范围卡。
- 启动后聊天显示运行卡片，点击进入运行详情。
- 智能体显式调用 WorkflowRun/OrchestrationRun 时覆盖默认。

### 4.3 Orchestrator 状态机

主进程 WorkflowOrchestrator：
- 创建 OrchestrationRun 并持久化。
- 从当前步开始，读取工作流定义，启动子 WorkflowRun，传共享输入 + 上一步 context。
- 子运行到 waiting_approval：
  - auto（或 inherit + 工作流 auto）-> 调 runner.approve，标记 autoApproved，继续。
  - 否则设置编排 waiting_approval，返回。
- 人工批准/驳回子运行后，runner 的 onUpdate 通知编排器；子运行 completed 进入下一步，failed 暂停。
- 子运行 completed：写入步骤摘要/决策路径，继续。
- failed/cancelled：编排 failed，保留 currentStepIndex，可重试当前步。
- 最后一步完成：编排 completed。
- 取消：取消当前子运行，编排 cancelled。
- 同一项目同时只允许一个活动工作流运行或编排。
- 重启：运行中的编排标记 interrupted；waiting_approval 保持可批准；failed 可重试。

### 4.4 审批策略

- effectiveApproval = step.approval === inherit ? workflow.settings.approvalPolicy ?? manual : step.approval.
- auto：调用子运行 approve；记录 autoApproved 和操作者 orchestrator。
- always：即使工作流 auto 也必须人工。
- inherit：遵循工作流。
- 单跑也遵循自身 approvalPolicy；官方默认 manual。

### 4.5 智能体工具

新增工具（命名沿用现有 PascalCase）：
- WorkflowList：列表 + 默认标记。
- WorkflowRead：读取定义。
- WorkflowCreate：提交完整定义对象；B 校验后写入 specs/workflows；返回 id/version。
- WorkflowRun：指定 id 或 default，goal/readPaths/writePaths/model；返回 runId + 当前状态。
- WorkflowStatus / WorkflowCancel。
- OrchestrationList / OrchestrationRead / OrchestrationCreate / OrchestrationRun / OrchestrationStatus / OrchestrationCancel。
- 不提供 WorkflowApprove；自动批准只由配置和 Orchestrator 执行。
- 工具在当前任务中运行时默认复用任务 scope；显式 scope 必须通过现有路径校验。
- 工具返回可读错误（VALIDATION_FAILED / VERSION_CONFLICT / 缺失引用）。

## 5. UI

### 5.1 工作流页三模式

- 顶部模式：工作流 / 编排 / 运行。
- 工作流：现有画布编辑 + 检查器。
- 编排：左侧工作流列表和编排列表；中间顺序步骤卡片；右侧选中步骤/编排检查器；步骤卡片显示审批策略，可增删、上下移动、从模板另存。
- 运行：可选择单个工作流运行或编排运行；显示链式时间线、当前子运行、审批、失败重试、取消、历史。
- 左侧工作流列表：官方钉在顶部，标全局默认；项目覆盖项标项目默认和 ☆；提供恢复全局默认。
- 默认星标只对单个工作流；编排列表没有默认星标。

### 5.2 编排编辑器

- 新建编排；从临时队列另存。
- 添加步骤：选择项目工作流；顺序固定，拖动排序。
- 每步审批三选一：继承 / 人工 / 自动；自动显示红色警告。
- 共享输入表单：goal/readPaths/writePaths/model；保存编排不保存输入，运行时填写。
- 缺失工作流标红，保存/运行提示修复。

### 5.3 聊天/任务

- 任务表单新增“目标”。
- 聊天输入框“问答 / 实现”分段控件。
- 实现模式显示默认工作流标签；可切换其他工作流。
- 没有选中任务 scope 时弹范围卡。
- 工作流启动后显示运行卡片；不继续普通 agent 回复。

### 5.4 无障碍/响应式

- 模式、步骤、审批按钮可键盘操作，焦点可见。
- 窄窗口下编排步骤纵向堆叠，检查器抽屉化。
- 自动批准警告使用文本，不只颜色。

## 6. 错误与安全

- 默认失效回退官方并提示。
- 编排步骤缺失工作流：禁止运行，显示步骤路径。
- 子运行失败：编排 failed，可重试当前步；不自动跳过。
- 自动批准：显式配置、UI 警告、运行记录标记；官方默认 manual。
- 智能体可创建/启动，但没有直接 approve 工具；只有配置 auto 时编排器批准。
- 上下文注入上限 32 KiB；摘要截断。
- 所有定义/运行/设置写入使用路径安全、版本/原子写入。
- 同一项目单活动运行。

## 7. 测试

- Schema：workflow approvalPolicy、orchestration definition、settings、OrchestrationRun。
- Store：编排保存/读取/版本冲突/路径安全；默认设置读写与回退。
- Orchestrator（fake runner）：顺序、共享输入、上一步摘要、inherit/always/auto、自动批准标记、失败暂停、重试当前步、取消、完成、重启等待审批恢复、运行中 interrupted。
- Agent tools：创建、校验失败、运行默认/显式、状态、取消、scope 边界、无 approve 工具。
- 触发：任务 goal + 首次实现消息；聊天问答不触发；实现模式默认/显式；scope 复用/范围卡。
- Renderer：三模式、默认星标/回退、编排增删排序、审批选择、自动警告、运行时间线。
- E2E：任务默认启动到审批；聊天实现模式；创建编排顺序执行两步并人工批准后继续；失败暂停并重试；智能体创建并运行工作流（模型替身）。

## 8. 非目标

- 编排分支、并行、循环、子编排嵌套。
- 编排设为默认。
- 跨项目编排。
- 全局自定义默认（全局只有官方）。
- 智能体直接批准工具。
- 自动批准未配置时发生。
- 改变实体/组件 schema。

## 9. 验收标准

- 未指定工作流时，任务/聊天实现模式按项目默认启动；默认失效回退官方。
- 项目可以把单个工作流设为默认，并恢复全局默认；不能把编排设为默认。
- 可以保存线性编排、临时排队并另存；运行时共用输入。
- 每步审批 inherit/always/auto 按语义工作；auto 有警告和运行记录。
- 上一步摘要进入下一步；失败暂停，重试当前步后继续。
- 智能体可以创建工作流/编排并启动；没有配置 auto 时不能自批。
- 重启后等待审批的编排仍可批准；运行中的编排不假装完成。
- 类型检查、lint、定向单元/集成测试、Electron E2E 通过；不运行打包。
