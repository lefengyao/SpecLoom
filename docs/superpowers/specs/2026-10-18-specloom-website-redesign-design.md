# SpecLoom 官网重设计规格（03 / Spec Sheet）

日期：2026-10-18  
状态：方向 03、标语「让 AI 读懂你的游戏世界」、吉祥物「络络」已确认，进入实施。  
替换目标：仓库根目录 `website/`，旧站归档到 `design/archive/website-0.1.6/`。

## 目标

把 SpecLoom 官网重做成一份可执行的“产品规格单”：纸白蓝图网格、墨绿正文、金色索引、编号章节与发行清单。页面要让 Godot / 独立开发者一眼看懂三件事：

1. SpecLoom 是本地优先的 Godot 项目工作区。
2. 规范、实体、组件、Skills、MCP 与工具围绕同一份项目上下文工作。
3. 当前 Windows x64 0.1.9 版本可以下载，安装版与便携版都在。

官网仍是纯静态站点，不引入构建步骤、第三方脚本、CDN 字体或在线服务。

## 视觉系统

- 背景：纸白 `#edf1e8`，24px / 120px 两层蓝图网格；内容纸面 `#f7f9f3`。
- 主色：墨绿 `#14352a`；辅助绿 `#1f6f54`；金色 `#a9762e` 只用于索引、标注和状态。
- 线框：1px 墨绿半透明线；直角；不用圆角卡片、玻璃拟态或大面积渐变。
- 字体：正文与标题使用系统中文字体（Segoe UI / PingFang SC / Microsoft YaHei）；编号、路径、状态使用等宽字体（Cascadia Code / Consolas）。
- 排版：Hero 标题 `clamp(42px, 5.1vw, 70px)`；章节标题 `clamp(30px, 3.4vw, 44px)`；正文 13–15px；小标签 8–10px；技术图内文字允许 6.5–11px，但必须有 `aria-label` 与图注。
- 交互状态只用颜色、下划线、行底色变化；不使用位移动画（吉祥物除外）。

## 页面结构

### 00 / 侧栏

- 固定 208px 宽，含：品牌 + 动态吉祥物、01–05 章节索引、DOC / REV / PLATFORM / STATUS、MASCOT / 络络、下载入口。
- 1120px 以下变为顶部条：品牌、01–05 索引（窄屏只显示编号，带 `aria-label`）、下载入口。
- 索引随滚动高亮当前章节，使用 `aria-current="true"`。

### 01 / OVERVIEW

- 标语：**让 AI 读懂你的游戏世界。**
- 说明：SpecLoom 把规范、实体、组件和 Skills 收进一张项目图纸。智能体沿着资料、工具与运行画面，先读懂，再动手。
- SPEC 表：PRODUCT / SCOPE / RUNTIME / STORAGE。
- 主 CTA：下载 Windows 版；次 CTA：查看能力清单。
- FIG. 01 / PROJECT CONTEXT：项目、资料、智能体、工具、Godot 的关系图。
- 图内吉祥物「络络」：坐在图纸右上，金线连到 Godot 编辑器；标注 `DRAWN BY / 络络`；旁白“资料在 specs/，我先读一遍。”

### 02 / CAPABILITIES

- 五行能力清单：项目资料、智能体运行时、Godot 连接、执行可见、多工作区。
- FIG. 02 / WORKSPACE PLATE：用 HTML/CSS 构建的工作区图版，三栏为项目资料树、会话/工具链、上下文与文件变化。三枚编号标注：
  - 01 项目资料直接来自 `specs/`
  - 02 工具调用与公开进度
  - 03 上下文与本轮文件变化
- 图版明确标注“界面示意 / 非实际截图”。

### 03 / PROCEDURE

- 三步：选择项目 → 读取项目上下文 → 执行并检查改动。
- 每步保留 SELECT / READ / REVIEW 编号与 OUTPUT 行。

### 04 / RELEASE

- 发行清单：`SpecLoom-0.1.9-Setup-x64.exe`（INSTALLER）与 `SpecLoom-0.1.9-Portable-x64.zip`（PORTABLE）。
- 页面启动时用 HEAD 探测两个文件：存在则启用行链接并显示 `DOWNLOAD ↗`；缺失则移除链接、标记 `LOCAL ONLY`，并提示“本地预览、未检测到文件”。
- 版本与下载路径只从 `site-config.js` 读取，不在 HTML 里重复硬编码。
- 底部状态章：`LOCAL PREVIEW / RELEASE FILES PRESENT` 或缺失提示。

### 05 / NOTES

- 四问 FAQ，使用原生 `<details>`：
  1. SpecLoom 支持哪些系统？——Windows x64，安装版 / 便携版。
  2. 除了 Godot，也适用于普通代码项目吗？——Godot 优先，也支持普通代码项目；EditorPlugin 与截图桥只适用于 Godot。
  3. 项目资料保存在哪里？——`specs/`、`.specloom/skills/`、`.specloom/history/`。
  4. 智能体会自动修改项目文件吗？——按工具审批策略执行；每轮结束列出文件变化。

### 页脚

- 文档编号 `SL-PRODUCT-01`、REV 0.1.9、`SHEET 01 OF 01`、返回顶部。

## 吉祥物：络络

- 身份：SpecLoom 的 Thread Sprite，中文名「络络」。
- 出现位置：
  1. 左上品牌标记（28px，会眨眼）。
  2. FIG. 01 图纸右上（约 76px），坐在图纸边缘，金线连到 Godot。
- 动作：
  - 每 5.4 秒眨眼一次。
  - 4.8 秒呼吸循环：上下 3px、轻微旋转 1.2°。
  - 静置时瞳孔每 6.4 秒左右张望。
  - 鼠标进入 FIG. 01 时瞳孔跟随光标（仅在精细指针设备上启用）。
  - 金线持续流动，悬停图纸时加速。
- 标识：图内标注 `DRAWN BY / 络络`；旁白“资料在 specs/，我先读一遍。”
- 无障碍：吉祥物为装饰性元素；开启 `prefers-reduced-motion: reduce` 时停止眨眼、呼吸、视线跟随与线流动；触屏设备不启用视线跟随。
- 实现：内联 SVG + CSS 动画 + 少量原生 JS；不引入动画库。

## 文案要点

- 不声称自动生成完整游戏、不声称支持 Windows 以外桌面平台、不虚构用户数或性能数字。
- 本地优先表述为“项目资料保存在项目目录；模型请求由你配置的供应商处理”，不承诺“数据绝不离开电脑”。
- 下载提示明确“仅支持 Windows x64”。

## 响应式

- `> 1120px`：固定侧栏 + 双栏 Hero。
- `761–1120px`：侧栏转顶部条；Hero 单栏；FIG. 01 最大 680px；能力行与发行清单保持表格布局。
- `≤ 760px`：隐藏 Hero 旁白气泡；能力行、步骤、发行清单纵向堆叠；FIG. 02 隐藏左右栏、保留会话主栏；章节索引只显示编号。
- 所有断点不得出现横向滚动。

## 文件结构

- `website/index.html`：语义结构、章节、图版、FAQ、下载。
- `website/styles.css`：视觉系统、响应式、动效降级。
- `website/site-config.js`：版本、平台、下载路径单一来源。
- `website/site.js`：下载探测、版本注入、章节高亮、络络动画。
- `website/assets/specloom.svg`：静态品牌资源（favicon / 回退）。
- `website/serve.mjs`、`website/package.json`、`website/README.md`：本地预览。
- `website/tests/site.test.mjs`：下载探测、配置、结构、FAQ、命名与版本。
- 旧站归档：`design/archive/website-0.1.6/`。

## 验收

- `node --check website/site.js` 与 `node --check website/site-config.js` 通过。
- `node --test website/tests/site.test.mjs` 全部通过。
- Playwright 在 1440 / 1120 / 1024 / 900 / 768 / 601 / 390 七个宽度：无横向溢出、无控制台错误、锚点全部存在。
- 下载 HEAD 请求返回 200，两个行链接可用；模拟 404 时显示本地预览状态。
- 吉祥物在桌面有眨眼/呼吸/视线跟随；减少动效时静止；触屏无视线跟随。
- 键盘可访问：跳转链接、章节索引、FAQ、下载链接、可见焦点。
- 旧站归档且新站不引用旧站文件；`/website/` 仍在 `.gitignore` 中。

## 非目标

- 不做公网部署、域名、账户、遥测、服务端接口。
- 不生成安装包或修改 Electron 应用。
- 不保留旧站 0.1.6 的暖白编辑式视觉。
