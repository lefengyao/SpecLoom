# SpecLoom 官网实施计划

> **给执行代理：** 必须按 `subagent-driven-development` 或 `executing-plans` 技能逐任务执行本计划。每完成一个任务就运行该任务的验证步骤，再继续。

**目标：** 在 SpecLoom 仓库根目录的 `website/` 制作暖白编辑式中文产品官网，准确介绍 0.1.6 能力并提供本地 Windows 安装版与便携版下载入口；将整个网站目录和本地测试用户数据目录加入 Git 忽略。

**方案：** 官网采用无构建步骤的静态 HTML、CSS 与原生 JavaScript ES modules，不增加 Electron 依赖或改动应用打包配置。独立站点配置模块保存当前版本和相对于 `/website/` 的发行文件路径；页面启动时探测两个文件，只有可访问时才显示有效下载 CTA，否则给出本地预览提示。复制现有品牌 SVG 到站点资源目录，使网站展示和后续托管都不依赖仓库外路径。

**技术：** HTML5、CSS、原生 JavaScript、Node.js 内置语法检查、浏览器手工验收。

---

### 任务 1：收紧 Git 忽略范围并建站点骨架

**文件：**
- 修改：`.gitignore`
- 新建：`website/index.html`
- 新建：`website/styles.css`
- 新建：`website/site-config.js`
- 新建：`website/assets/specloom.svg`（从 `src/renderer/public/brand/specloom.svg` 复制）

**步骤：**

1. 在 `.gitignore` 末尾加入精确根目录规则：

```gitignore
/website/
/.runtime-user-data-fresh/
```

保留已有规则原样，不加入会匹配产品源码或用户项目资料的宽泛模式。

2. 创建 `website/index.html` 的语义骨架：中文语言标记、响应式 viewport、站点标题和描述、站内导航、Hero、产品能力、工作流、版本下载、FAQ 与页脚。为导航和 CTA 设置稳定的片段 ID；工作区构图标明“界面示意”，不冒充真实截图。

3. 创建 `website/site-config.js` 配置模块，并以单一来源描述已核实版本与发行路径：

```js
export const siteConfig = Object.freeze({
  version: "0.1.6",
  platform: "Windows x64",
  downloads: {
    installer: "../release/0.1.6/SpecLoom-0.1.6-Setup-x64.exe",
    portable: "../release/0.1.6/SpecLoom-0.1.6-Portable-x64.zip",
  },
});
```

4. 复制现有 `specloom.svg` 到 `website/assets/`。HTML 所有图片、样式和脚本都用站点内相对路径，不引用 CDN、远程字体或外部脚本。

**验证：**

- `git check-ignore -v website/index.html .runtime-user-data-fresh/Local\ State` 显示两条新规则；
- `git status --short` 不显示 `website/` 下文件；
- 确认 `release/0.1.6/` 的 Setup EXE 与 Portable ZIP 文件名和配置完全一致。

### 任务 2：完成首页内容与响应式交互

**文件：**
- 修改：`website/index.html`
- 修改：`website/styles.css`
- 修改：`website/site-config.js`
- 新建：`website/site.js`
- 新建：`website/tests/site.test.mjs`

**步骤：**

1. 按已确认的 A 方向完成视觉：暖纸白背景、深墨绿标题、克制的品牌青绿色强调、编辑式网格与留白；中文使用系统字体，英文和数字标题可用 Georgia。首屏桌面两栏、窄屏纵向堆叠。

2. 页面按规格组织真实内容：项目资料（规范、实体、组件）、智能体与 Skills/MCP/工具链、Godot EditorPlugin 与截图桥、模型诊断日志、Trailblazer Hub 多开工作区，以及“选择项目—读取上下文—执行并检查”的工作流。清楚说明 Windows 支持范围；不声称自动生成完整游戏、其他操作系统支持、在线服务或未经验证的数据。

3. 用原生 HTML 与 CSS 绘制清晰的工作区示意，表现资料树、对话和受限工具链区域，并加“界面示意”标签。保留文本替代信息；不用未经授权的产品截图或外网资源。

4. 在开始实现下载探测前，先用 Node 内置 `node:test` 为“可下载返回可用、404 或网络错误返回不可用”编写测试，并运行确认按预期失败；不添加测试依赖。

5. 在 `site.js` 为窄屏导航提供可键盘操作的开关、`aria-expanded` 与关闭行为；页内导航继续使用原生锚点。下载状态通过 `fetch(url, { method: "HEAD" })` 检查，成功时显示版本、平台、安装版和便携版链接；失败时保留页面并说明这是本地预览、当前未检测到发行文件。

6. 为焦点状态、窄屏断点、触控尺寸和 `prefers-reduced-motion: reduce` 添加样式。FAQ 使用原生 `<details>`，避免额外组件或脚本依赖。

**验证：**

- `node --check website/site-config.js`；
- `node --check website/site.js`；
- `node --test website/tests/site.test.mjs`；
- 确认无第三方 URL、所有站内锚点目标存在、下载路径来自配置而非重复硬编码。

### 任务 3：本地预览、浏览器验收与工作区核对

**文件：**
- 验收：`website/index.html`
- 验收：`website/styles.css`
- 验收：`website/site-config.js`
- 验收：`website/site.js`
- 验收：`.gitignore`

**步骤：**

1. 从 `SpecLoom` 根目录启动仅绑定本机地址的静态 HTTP 服务，打开 `http://127.0.0.1:59843/website/`。以此根路径保留 `../release/` 相对下载路径。

2. 在浏览器桌面和窄屏视口检查排版、导航、区块跳转、下载探测、FAQ 展开、键盘聚焦与页面溢出。桌面首屏应同时表达产品定位并呈现下载入口；窄屏无横向滚动，菜单按钮可操作。

3. 在开发者工具确认控制台无错误，页面所需静态资源无 404；安装版和便携版请求均返回成功，链接指向项目中的 0.1.6 发行文件。

4. 复查 Git 忽略规则和工作区：

```powershell
git check-ignore -v website/index.html .runtime-user-data-fresh/Local\ State
git status --short
```

确保网站源文件仍被忽略，忽略规则没有掩盖应用源码；不暂存、不提交、不重置、不清理既有改动。

**验证：** 浏览器手工验收通过；两条发行链接可下载；`node --check` 检查通过；`git check-ignore` 命中精确规则。由于官网不进入应用构建，本任务不运行 Electron 打包。

---

**计划自检：** 所有页面结构来自已确认规格；版本和文件名已经本地核实；范围不包括部署、公网链接或应用打包；每个新建页面文件均受 `/website/` 忽略规则覆盖；测试步骤能验证导航、下载和响应式要求。计划保留现有工作区改动，不包含暂存或提交操作。
