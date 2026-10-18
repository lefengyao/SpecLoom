# SpecLoom 插件管理设计

日期：2026-10-10
状态：用户已确认，进入实施

## 背景

SpecLoom 当前把 Godot 截图桥作为应用内置功能，并通过 `GodotPluginInstall` 工具将桥接插件写入当前 Godot 项目。用户无法在界面中查看它的启用状态，也无法集中查看项目内其他 Godot EditorPlugin。现有插件相关状态分散在对话工具与项目配置中，缺少一眼可读的管理入口。

当前应用没有加载任意扩展包的运行时。Godot 插件则由 Godot 自己加载，插件配置位于项目 `addons/` 子目录中；SpecLoom 只负责读取其元数据和维护 `project.godot` 中的启用列表。

## 目标

- 在 SpecLoom 内提供一个清晰的插件管理页面，当前项目状态和插件操作有明确分区。
- 集中管理唯一内置插件：SpecLoom 截图桥。
- 查看当前 Godot 项目内已有的 Godot EditorPlugin，支持检索、状态筛选、启用/禁用与定位目录。
- 变更失败或插件配置损坏时给出可理解的状态，不破坏项目中其他插件配置。
- 所有插件元数据由主进程安全读取；渲染进程不能传入任意绝对路径。

## 不在本次范围

- 安装或卸载第三方 Godot 插件，或从目录/ZIP 导入任意扩展。
- 加载、运行或沙箱化任意插件代码；任意扩展包运行时仍不存在。
- 把 Skills、MCP、Hooks、固定工具等其它功能能力列为“插件”。
- 跨项目的全局插件清单、自动升级、兼容性评分或版本更新。
- 删除 Godot 插件文件。禁用只修改项目启用配置，不删除插件目录。

## 入口与布局

插件管理使用左侧导航中的独立“插件”入口。它是一个独立工作区页面，不收纳在“设置”里，以便用户从全局工具导航直接进入。页面顶部展示当前项目名称、Godot 项目状态、刷新和打开项目目录入口。

页面按两种不同职责分区：

1. **SpecLoom 截图桥**：单独的内置插件状态卡片，展示是否完整安装、是否启用、插件版本/目标版本和简短说明。提供启用/禁用与“在文件管理器中定位”操作；当文件缺失且目录没有冲突内容时，提供“安装截图桥”操作，调用现有内置安装实现。检测到同名文件被修改、自动加载名称冲突或配置无法安全解析时显示异常并阻止覆盖。
2. **Godot 项目插件**：列表展示在 `addons/<目录>/plugin.cfg` 中发现的普通项目插件；截图桥只在上方专属卡片出现，不在列表重复。工具栏提供按名称、说明、作者或目录名检索，以及“全部、已启用、已禁用、异常”筛选。每行展示名称、说明、作者、版本、启用状态、启停控件和定位目录操作；损坏元数据使用异常标记和目录名回退显示。若 `project.godot` 启用列表仍引用已缺失的 `plugin.cfg`，也列为异常项并允许停用；`addons/` 下没有配置且未被引用的普通数据目录不当作插件显示。

列表按名称稳定排序，并显示发现数量与启用数量。无已安装插件时展示空状态和刷新入口。没有打开 Godot 项目时显示项目选择/打开提示，不显示空插件表。切换项目、插件状态变更后刷新结果；提供手动刷新以反映 Godot 编辑器外部所作的更改。

启用状态变更后提示用户重新载入或重开 Godot 项目以让编辑器应用新状态。页面的状态来源是当前项目 `project.godot`，不推断另一个仍在运行的 Godot 编辑器是否已经同步。

## 插件发现与元数据

- 只扫描当前项目 `addons/` 的直接子目录，并查找每个子目录下的 `plugin.cfg`；不递归遍历插件资源树。另检查启用列表中的配置引用，以便展示已失效引用；不把没有配置引用的普通资源目录误判为插件。
- 只识别 `[plugin]` 节下的标准键，如 `name`、`description`、`author`、`version`、`script`。不解析或执行 `script`。
- 扫描最多检查 512 个 `addons/` 直接子目录；超过上限时页面显示“扫描不完整”提示。单个 `plugin.cfg` 最多读取 64 KiB，项目 `project.godot` 最多读取 1 MiB，启用列表最多接受 1,024 个条目。`name`、`author`、`version`、`description` 分别限制为 160、160、80、1,024 个字符；超限或解析失败时将对应插件标为“异常”。
- 不跟随符号链接、junction 或其它重解析点；拒绝越过项目根目录的路径。插件 ID 使用后端扫描所得的相对目录/配置标识，不接受渲染进程提供绝对路径。
- 损坏或缺少必需字段时仍显示可识别的配置条目；只允许定位，若它当前处于启用列表则允许用户禁用，不能启用不完整插件。已启用列表引用缺失配置时，允许移除该失效引用。
- 搜索和筛选在渲染进程对主进程返回的安全元数据执行，不将插件任意内容载入页面。

## 启用与禁用

- 对普通 Godot 插件，只增删 `[editor_plugins].enabled` 中完全匹配的 `res://addons/<目录>/plugin.cfg` 条目；以安全的 `PackedStringArray` 解析/序列化方式修改，不改写其它插件条目和不相关项目设置。
- 写入前重新扫描并校验 ID 仍属于当前已打开项目；采用基线内容比较/冲突检测，避免覆盖外部并发修改。
- `project.godot` 缺失、不是受支持的 Godot 项目、列表语法不受支持或路径安全检查失败时不写入，并返回明确错误。
- 截图桥沿用其内置规则：启用时同时确认截图 EditorPlugin 条目与 `SpecLoomCapture` autoload 配置；禁用时移除截图插件启用条目，并且只移除值仍等于 SpecLoom 所有的自动加载项。不得触碰其它 autoload 或插件文件。
- 截图桥安装复用已有 `GodotScreenshotPlugin.install()` 的冲突保护和幂等行为。安装只适用于内置截图桥，不扩展成第三方插件安装入口。
- 所有禁用操作保留插件文件。操作成功后返回状态及是否需要在 Godot 中重新载入项目。

## 定位目录

“定位目录”由主进程根据当前项目根目录和插件 ID 重新解析目标。目标必须是扫描到的插件目录（内置桥使用固定的 `addons/specloom_capture`）；路径需通过 `PathPolicy` 安全校验后再交给 Electron shell 打开。IPC 不接受任意文件系统路径，也不回显项目绝对路径给插件表。

## 接口与组件边界

- **Godot 插件目录服务**（`src/main/core/plugins/`）：扫描 `addons/`、有界解析 `plugin.cfg`、读取启用列表、计算状态并安全修改项目设置。
- **截图桥复用**：使用现有 `GodotScreenshotPlugin` 的安装、资源校验和项目路径策略；增加其可安全管理的状态切换支持，避免重复实现插件文件安装逻辑。
- **桌面控制器与 IPC**：只允许针对当前已打开项目进行列举、状态变更和定位。载荷用严格 schema 校验；路径由主进程持有和生成。
- **渲染页面**：新增插件页及样式；读取列表后本地检索/筛选，操作期间显示忙碌状态，失败显示可理解错误，成功后重新查询状态。
- **Hub 模块**：沿用现有 desktop API/IPC 适配方式，不依赖 standalone Electron API；模块和独立桌面版使用相同的管理行为。

建议接口形状：

```ts
interface GodotPluginEntry {
  id: string; // backend-generated relative identifier, e.g. "addons/dialogue_manager/plugin.cfg"
  name: string;
  description?: string;
  author?: string;
  version?: string;
  enabled: boolean;
  metadataValid: boolean;
  issue?: "missing_config" | "invalid_config";
}

interface ScreenshotBridgeEntry {
  status: "missing" | "ready" | "incomplete" | "conflict";
  installedVersion?: string;
  enabled: boolean;
  issue?: "project_setting_conflict" | "files_modified" | "metadata_invalid";
}

interface PluginManagementApi {
  list(): Promise<{ screenshotBridge: ScreenshotBridgeEntry; plugins: GodotPluginEntry[]; scanLimitReached: boolean }>;
  setGodotPluginEnabled(id: string, enabled: boolean): Promise<{ restartRequired: boolean }>;
  setScreenshotBridgeEnabled(enabled: boolean): Promise<{ restartRequired: boolean }>;
  installScreenshotBridge(): Promise<{ restartRequired: boolean }>;
  revealDirectory(id: string | "screenshot-bridge"): Promise<void>;
}
```

实际命名可以适配项目既有接口风格；契约必须严格限定 ID、字段与当前项目范围，且不暴露任意路径参数。

## 安全、错误与并发

- `plugin.cfg` 是不可信项目数据；读取受字节数、字段长度与插件数量上限保护，解析器不得执行配置中的脚本或表达式。
- 目录扫描拒绝符号链接、junction 和路径遍历；每次变更前二次解析并校验目标。
- 只更新指定插件条目。未知格式或并发修改时安全失败，提示刷新后重试，不能重置整个 `project.godot` 启用列表。
- Electron shell 只接收服务端校验后的目录。日志和错误不包含原始插件配置内容或绝对路径。
- 单插件元数据错误不应阻止显示其余插件。
- 无项目、非 Godot 项目、`addons/` 缺失、配置损坏及写入失败均有独立的空态/错误状态。

## 验证范围

- 单元测试：目录扫描、元数据解析、缺失/损坏配置、长度/数量上限、普通与 built-in 插件状态、配置读改写、保留其它插件/autoload、语法冲突与乐观并发冲突、路径遍历与链接拒绝。
- IPC/控制器测试：要求当前项目上下文，拒绝任意路径与未知插件 ID；确认模块宿主适配。
- 渲染测试：独立导航入口、两类插件分区、搜索、状态筛选、空态/异常态、启停/定位/安装反馈及请求去抖或忙碌状态。
- 验收：对隔离临时 Godot 项目执行列表、切换单个插件并验证其它条目保留；不要求运行或导入第三方插件代码。

## 已确认决定

- 页面入口：左侧导航独立“插件”入口。
- 管理范围：SpecLoom 截图桥与当前 Godot 项目插件；不展示其它固定工具能力。
- Godot 插件操作：查看、启用/禁用、定位目录；不提供第三方插件安装与卸载。
- Godot 项目插件的文件由 Godot 管理；禁用不删除目录。截图桥仅可通过 SpecLoom 内置安装器安装。
