# 分层项目资料与组件实施计划

## 目标

让项目资料支持可继续嵌套的父子分类、实体单继承和组件组合。实体先只填名称创建，再补充详情；生命值、坐标、速度等组件在独立页面管理，实体挂载组件后可填写自己的字段值。

实施状态：数据模型、界面与回归验证已完成。设计契约见 [分层资料与组件设计](../specs/2026-10-06-hierarchical-project-materials-design.md)。

## 数据约定

- 实体与分类资料：`specs/entities/**/<id>.md`，新建默认 `type: entity`；名称创建自动生成安全且唯一的 ID，后续改名或修改类型保持 ID 与路径稳定。
- 组件定义：`specs/components/<id>.md`，`type: component`，`fields` 声明字段 `key`、可选 `label`、`number`/`string`/`boolean` 类型及匹配的 `default`。
- `parent`：同类资料的真实 ID 或路径。分类节点有独立文件，子项由索引反向派生，不存储 `children`，不接受不存在的分类字符串。
- `extends`：单个实体原型引用，与资料父级分别处理。
- `components`：组件引用数组，引用对象通过 `values` 保存实体实例的字段覆盖值。值仅覆盖已有字段；未覆盖字段使用继承值，再回退到组件默认值。
- `relations`：普通实体关联，不承担分类、继承或组合语义。
- Markdown/YAML 为事实来源；派生资料索引、关系树和继承组件展示不保存另一份独立事实。

## 已实现内容

1. **数据与校验。** 初始化独立组件目录；资料扫描包括组件、设定、地图和 UI。Markdown 验证检查实体布局、组件字段、有限数值与默认值类型，引用验证检查真实目标、类别与来源版本、父级/继承环、重复组件及实例覆盖字段和值。
2. **资料树。** `materials-model` 读取 front matter，按真实 `parent` 构建当前类别的关系树。缺失或循环父级进入“关系错误”，无法解析的资料进入“未归类”，均保留选择与源码修复入口。
3. **名称创建与子项。** `NewEntity` 只要求名称；创建后立即进入资料草稿和详情编辑。已提交实体提供“新建子实体”，自动设置父级。地图、设定、UI 与规范继续使用各自创建表单与目录。
4. **独立组件管理。** 导航增加“组件”页；`NewComponent` 提供空白、生命值、坐标和速度模板。详情可维护字段名称、显示名称、类型与默认值；已使用组件的原有字段在详情中限制改名、改类型与删除，允许增加字段与修改显示名称、默认值。资料加载完成前禁用详情，读取失败时提供源码修复与刷新入口。表单阻止字段重名与保留键。
5. **实体详情与继承。** `MaterialDetails` 编辑名称、说明、实体类型、父级、继承和正文；父级与原型选择排除自身及关系环。组件选择器挂载已提交组件，支持移除、数值/文本/布尔实例值，以及继承来源展示和显式覆盖。
6. **编辑与事务。** `project-materials` 使用唯一 YAML 键和受限别名解析，保留未知 front matter 字段与完整正文。详情编辑与“源码编辑”修改同一文件。App 保留当前项目的页面草稿，切换页面可继续编辑，退出时保护未暂存修改，切换项目需确认丢弃；未暂存草稿不写入磁盘。异步暂存只清理目标草稿，保留同时编辑的其他资料。版本冲突可确认丢弃当前修改并读取最新版本。“暂存编辑”复用单文件范围、版本令牌和差异审查流程，批准后落盘。组件与父级资料先提交，再提交引用它们的实体。
7. **工作流说明。** README、架构与设计文档已说明关系区别、组件字段与实例值、创建和审查流程。实体目录与编写 Skills 使用实际父级、独立组件定义和 `values`；默认审查任务范围覆盖 `specs/entities/**` 与 `specs/components/**`。

## 验证范围

- 共享工具：`tests/unit/project-materials.test.ts` 覆盖正文与未知字段保留、无效 YAML、别名限制、字段与绑定读取，以及唯一安全 ID。
- 创建表单：`tests/renderer/AuthoringForms.test.tsx` 覆盖仅名称创建、自动父级、组件模板和地图创建。
- 资料界面：`tests/renderer/Materials.test.tsx`、`tests/renderer/App.test.tsx` 覆盖类别导航、关系树、详情与源码编辑、字段管理、组件挂载/移除、继承值及页面草稿。
- 核心：`tests/core/material-components.test.ts`、`tests/core/validator.test.ts`、`tests/core/project-layout.test.ts` 覆盖组件与关系校验、目录和初始化。
- 桌面流程：`tests/e2e/material-components.spec.ts` 覆盖源码运行时的实体创建、组件管理与暂存审查。
- 完整回归：`npm test -- --maxWorkers=4`，50 文件通过、5 文件跳过；582 测试通过、14 测试跳过。
- 桌面验收：源码 `electron.spec.ts`、`material-components.spec.ts`、`source-runtime.spec.ts` 三条全部通过。验证了组件模板创建、名称创建实体、真实父子树、挂载与修改三个组件、暂存审批、文件校验与持久化重读，Renderer 无页面错误。
- 静态检查与构建：`npm run typecheck`、`npm run lint`、`npm run build:app` 全部通过。构建有依赖注释与分包体积提示，不影响成功；本次未重建分发安装包。
- 验收截图：`.local/component-health.png`、`.local/hierarchical-entity-components.png`。

## 当前实现边界

资料索引目前由 Renderer 从实际文件读取并派生；组件与继承描述作为引擎生成输入，游戏运行时代码由项目工作流实现。页面未暂存草稿没有重启恢复；已暂存内容使用现有审查任务持久化机制。
