# SpecLoom 官网重设计实施计划

> **给执行代理：** 按任务顺序执行；每个验证步骤通过后再进入下一步。网站文件被 `.gitignore` 忽略，仓库还有既有未提交改动，本计划不执行 git 提交。

**目标：** 用已确认的方向 03（Spec Sheet）、标语 A 和吉祥物「络络」替换 `website/`，保留纯静态实现与本地下载探测。

**架构：** 单页静态站点，HTML + 外部 CSS + 原生 ES module。`site-config.js` 是版本/平台/下载路径唯一来源；`site.js` 负责 HEAD 探测、版本注入、章节高亮和络络动画。旧站整体归档到 `design/archive/website-0.1.6/`。

**技术栈：** HTML5、CSS、原生 JavaScript、Node.js `node:test`、Playwright（仅验证，不新增依赖）。

---

## 文件结构

- `website/index.html`：语义结构、五个章节、FIG. 01 / FIG. 02、下载清单、FAQ。
- `website/styles.css`：蓝图视觉、响应式、动效降级、焦点与跳转链接。
- `website/site-config.js`：`version = "0.1.9"`、`platform = "Windows x64"`、setup/portable 路径。
- `website/site.js`：`probeDownload`、`initializeSite`、`initializeMascot`、`initializeSectionNav`。
- `website/assets/specloom.svg`：静态品牌资源。
- `website/serve.mjs`、`website/package.json`、`website/README.md`：本地预览。
- `website/tests/site.test.mjs`：下载探测、配置、结构、FAQ、命名、版本。
- `design/archive/website-0.1.6/`：旧站归档。
- `design/website-directions/03-spec.html`：已确认的视觉源稿（不直接作为发布页）。

---

### Task 1：归档旧站

**Files:**
- Move: `website/` → `design/archive/website-0.1.6/`
- Create: `website/`

- [ ] **Step 1：核对路径**

Run:
```powershell
$source = (Resolve-Path 'website').Path
$archive = (Resolve-Path 'design').Path
"$source -> $archive\archive\website-0.1.6"
```

Expected: 输出仓库内的绝对路径，source 以 `\SpecLoom\website` 结尾。

- [ ] **Step 2：移动并重建目录**

Run:
```powershell
New-Item -ItemType Directory -Force -Path 'design/archive' | Out-Null
Move-Item -LiteralPath 'website' -Destination 'design/archive/website-0.1.6'
New-Item -ItemType Directory -Path 'website' | Out-Null
```

Expected: `website/` 为空；`design/archive/website-0.1.6/index.html` 存在。

- [ ] **Step 3：确认旧站文件完整**

Run:
```powershell
Get-ChildItem 'design/archive/website-0.1.6' | Select-Object Name
```

Expected: `index.html`、`styles.css`、`site.js`、`site-config.js`、`tests`、`assets`、`serve.mjs` 等。

---

### Task 2：复制视觉源稿并拆分 CSS / JS

**Files:**
- Create: `website/index.html`
- Create: `website/styles.css`
- Create: `website/site.js`
- Create: `website/site-config.js`
- Create: `website/assets/specloom.svg`
- Create: `website/serve.mjs`
- Create: `website/package.json`
- Create: `website/README.md`

- [ ] **Step 1：复制源稿、品牌资源和预览服务**

Run:
```powershell
Copy-Item 'design/website-directions/03-spec.html' 'website/index.html'
Copy-Item 'design/website-directions/assets/specloom.svg' 'website/assets/specloom.svg'
Copy-Item 'design/archive/website-0.1.6/serve.mjs' 'website/serve.mjs'
```

Expected: 三个文件存在。

- [ ] **Step 2：提取内联样式到 `styles.css`**

用脚本读取 `website/index.html`，把 `<style>...</style>` 的内容写入 `website/styles.css`，并把原 `<style>` 块替换为：

```html
<link rel="stylesheet" href="./styles.css">
```

- [ ] **Step 3：提取内联脚本到 `site.js`**

把 `<script>...</script>` 中的 IIFE 拆成具名函数并导出：

```js
import { siteConfig } from "./site-config.js";

export async function probeDownload(url, fetchImpl = globalThis.fetch, timeoutMs = 5000) { ... }
export async function initializeSite({ documentRef, windowRef, fetchImpl = globalThis.fetch, config = siteConfig, mascot = true } = {}) { ... }
export function initializeMascot({ documentRef, windowRef } = {}) { ... }
export function initializeSectionNav({ documentRef, windowRef } = {}) { ... }
```

页面只保留：

```html
<script type="module" src="./site.js"></script>
```

- [ ] **Step 4：写 `site-config.js`**

```js
const version = "0.1.9";
const releaseDirectory = `../release/${version}`;

export const siteConfig = Object.freeze({
  version,
  platform: "Windows x64",
  downloads: Object.freeze({
    setup: `${releaseDirectory}/SpecLoom-${version}-Setup-x64.exe`,
    portable: `${releaseDirectory}/SpecLoom-${version}-Portable-x64.zip`,
  }),
});
```

- [ ] **Step 5：写 `package.json` 与 README**

```json
{
  "type": "module",
  "scripts": {
    "preview": "node serve.mjs"
  }
}
```

README 写清预览命令、文件职责、版本更新位置和 `/website/` 被忽略。

---

### Task 3：改造 HTML 为正式站

**Files:**
- Modify: `website/index.html`

- [ ] **Step 1：头部与语义**

- `<title>SpecLoom — 项目有脉络，智能体有线索。</title>`
- meta description：`SpecLoom 是本地优先的 Godot 项目工作区，把规范、实体、组件与 Skills 收进同一份项目上下文。`
- favicon：`./assets/specloom.svg`
- 加 skip link：`<a class="skip-link" href="#overview">跳到主要内容</a>`
- `<main id="main">` 与各 section 的 `aria-labelledby` 保持完整。

- [ ] **Step 2：侧栏与顶部条**

- 品牌标记保留动态 SVG。
- 索引改为 5 项：`01 总览`、`02 能力清单`、`03 工作流程`、`04 发行文件`、`05 说明`。
- 每项加 `data-section="overview|capabilities|procedure|release|notes"`，标签文字包在 `<em>` 里，窄屏隐藏。
- rail-meta 增加 `MASCOT / 络络`。
- 下载按钮保留。

- [ ] **Step 3：Hero 与吉祥物**

- H1：`让 AI 读懂<br>你的<em>游戏世界</em>。`
- lede：`SpecLoom 把世界观、角色、关卡和系统设定留在项目里。AI 读过真实资料再动手，而不是从零开始。`
- FIG. 01 的 `DRAWN BY / THREAD SPRITE` 改为 `DRAWN BY / 络络`。
- 图注改为 `界面示意 / 项目资料与智能体协作 · 绘图 络络`。
- 吉祥物 SVG 保留；`data-mascot-scene` 保留。

- [ ] **Step 4：能力区与 FIG. 02**

在能力清单 `</ol>` 后加入工作区图版：

```html
<figure class="plate" aria-label="SpecLoom 工作区界面示意">
  <div class="plate-head"><span>FIG. 02 / WORKSPACE PLATE</span><b>ILLUSTRATIVE UI</b></div>
  <div class="plate-body">
    <aside class="plate-side">...项目资料树...</aside>
    <div class="plate-main">...会话、工具链、公开进度...</div>
    <aside class="plate-ctx">...上下文、本轮文件...</aside>
  </div>
  <div class="plate-legend">
    <span><i>01</i>项目资料直接来自 specs/</span>
    <span><i>02</i>工具调用与公开进度</span>
    <span><i>03</i>上下文与本轮文件变化</span>
  </div>
  <figcaption>界面示意 / 非实际截图</figcaption>
</figure>
```

图版内三栏使用真实产品文案（松林计划、fire_goblin.md、工具链 3 步、上下文 42%、本轮文件 M/+ 等），但不得伪装成实际截图。

- [ ] **Step 5：发行清单接下载探测**

两个 `.m-row` 加：

```html
data-download="setup" / data-download="portable"
```

动作单元格改为：

```html
<span class="go" data-download-state>CHECKING…</span>
```

清单下方加：

```html
<p class="release-note" data-download-note aria-live="polite">正在检查当前发布文件…</p>
```

- [ ] **Step 6：新增 05 / NOTES**

在 `</main>` 前加入：

```html
<section class="notes" id="notes" aria-labelledby="notes-title">
  <p class="sec">SECTION 05 / NOTES</p>
  <h2 id="notes-title">开始之前。</h2>
  <div class="notes-list">
    <details>…四问…</details>
  </div>
</section>
```

四问内容按规格文档“05 / NOTES”写入。

- [ ] **Step 7：页脚**

增加 `MASCOT / 络络` 与 `SHEET 01 OF 01`，保留返回顶部。

---

### Task 4：CSS 正式化

**Files:**
- Modify: `website/styles.css`

- [ ] **Step 1：排版放大**

- `.lede` 15px / 1.95。
- `.spec dd` 10.5px；`.spec dt` 8.5px。
- `.band-head p` 13px；`.row p` 12.5px；`.row code` 9px。
- `.step p` 12px；`.release .note` 12px。
- `.m-row b` 10.5px；`.m-row span` 9px；`.m-head` 8px。
- rail 元数据 8px；索引 12px。

- [ ] **Step 2：新增组件样式**

- `.skip-link`：默认移出视口，focus 时固定在左上。
- `:focus-visible`：2px 金色 outline，offset 2px。
- `.plate`、`.plate-head`、`.plate-body`（三栏 180px / 1fr / 200px）、`.plate-side`、`.plate-main`、`.plate-ctx`、`.plate-legend`、`.badge`。
- `.notes`、`.notes-list details/summary/p`，沿用规格单的 1px 线框。
- `.rail-index a.is-active`：金色左边线 + 纸面底色。
- `.m-row[aria-disabled="true"]`：降透明度、禁止点击、`.go` 改为 `LOCAL ONLY`。

- [ ] **Step 3：响应式**

- `≤1120px`：rail 横排；索引显示编号 + 文字；`.plate-body` 改为单栏，隐藏 `.plate-side` / `.plate-ctx`；图例两列。
- `≤760px`：索引只显示编号（隐藏 `em`）；图注/旁白缩小；`.plate-body` 保留会话主栏；`.notes` 单栏；发行清单已纵向。
- 所有断点检查 `overflow-x`。

- [ ] **Step 4：动效降级**

`@media (prefers-reduced-motion: reduce)` 中停止 `.sprite-bob`、`.sprite-lid`、`.sprite-pupil`、`.mascot-thread`，并把瞳孔 transform 归零。

---

### Task 5：site.js 行为

**Files:**
- Modify: `website/site.js`

- [ ] **Step 1：`probeDownload`**

保留现有实现：HEAD、AbortController、5s 超时、返回 `{ available, status }`，网络错误 `status: null`。

- [ ] **Step 2：`initializeSite`**

- 填充 `[data-release-version]` / `[data-release-platform]`。
- 对每个 `[data-download]` 读取 `config.downloads[asset]`。
- 成功：设置 `href`、移除 `aria-disabled`、状态 `DOWNLOAD ↗`、note 显示“已检测到发布文件”。
- 失败：移除 `href`、设置 `aria-disabled="true"`、状态 `LOCAL ONLY`、note 显示“本地预览、未检测到对应文件”。

- [ ] **Step 3：`initializeMascot`**

- 查找 `[data-mascot-scene]` 与 `.sprite-hero`。
- `prefers-reduced-motion` 或非精细指针时不绑定跟随。
- pointermove 用 rAF 计算 `--look-x` / `--look-y`，范围 ±3.2px；pointerleave 复位并加 `.is-idle`。
- 页面加载时加 `.is-idle`。

- [ ] **Step 4：`initializeSectionNav`**

- IntersectionObserver 观察 `#overview/#capabilities/#procedure/#release/#notes`。
- 给对应 `[data-section]` 加 `.is-active` 与 `aria-current="true"`。
- 点击索引后平滑滚动（`scroll-behavior` 已有）。

- [ ] **Step 5：自动初始化**

```js
if (typeof document !== "undefined" && typeof window !== "undefined") {
  void initializeSite({ documentRef: document, windowRef: window });
  initializeMascot({ documentRef: document, windowRef: window });
  initializeSectionNav({ documentRef: document, windowRef: window });
}
```

---

### Task 6：测试

**Files:**
- Create: `website/tests/site.test.mjs`

- [ ] **Step 1：下载探测测试**

四个用例：200 可用、404 不可用、503 不可用、网络异常不可用、超时不可用（用假 fetch 返回永不 resolve 的 Promise）。

- [ ] **Step 2：配置测试**

`siteConfig.version === "0.1.9"`；setup 以 `.exe` 结尾；portable 以 `.zip` 结尾；路径包含 `0.1.9`。

- [ ] **Step 3：页面结构测试**

读取 `index.html`：

- 包含标语“项目有脉络”“智能体有线索”。
- 包含 `络络` 与 `DRAWN BY / 络络`。
- 包含 `id="overview"`、`capabilities`、`procedure`、`release`、`notes`。
- 包含 `FIG. 02 / WORKSPACE PLATE`。
- 包含四个 FAQ 的 summary 文本。
- 两个 `data-download` 值。
- 不含 `src="http` / `href="http`（除邮件或本地锚点外）。

- [ ] **Step 4：初始化测试**

用 FakeDocument / FakeElement 模拟：
- 成功 HEAD：链接有 `href`、无 `aria-disabled`、状态为 `DOWNLOAD ↗`。
- 失败 HEAD：无 `href`、`aria-disabled="true"`、状态为 `LOCAL ONLY`。

- [ ] **Step 5：运行**

```powershell
node --check website/site.js
node --check website/site-config.js
node --test website/tests/site.test.mjs
```

Expected: 全部通过。

---

### Task 7：浏览器验证

**Files:**
- Verify: `website/`

- [ ] **Step 1：启动预览**

```powershell
npm --prefix website run preview
```

打开 `http://127.0.0.1:59843/website/`。

- [ ] **Step 2：七宽度检查**

1440 / 1120 / 1024 / 900 / 768 / 601 / 390：

- `scrollWidth === innerWidth`
- 无 console error / pageerror
- 所有 `#` 锚点存在
- 两个下载链接 HEAD 为 200
- 章节索引高亮随滚动变化
- FAQ 可展开
- 吉祥物：桌面有 `sprite-blink` / `sprite-bob` 动画；reduced motion 时 `animationName === "none"`；触屏无视线跟随。

- [ ] **Step 3：截图**

保存桌面、平板、手机完整截图到 `design/website-directions/shots/site-*.png`。

- [ ] **Step 4：忽略与工作区检查**

```powershell
git check-ignore -v website/index.html
git status --short | Select-String 'website'
```

Expected: `.gitignore` 命中 `/website/`；`git status` 不显示 `website/`。

---

### Task 8：文档与收尾

- [ ] 更新 `website/README.md`：预览、版本、文件职责、旧站归档位置。
- [ ] 更新 `design/website-directions/index.html` 的 03 卡片：新标语、络络、FIG. 02、移动端截图。
- [ ] 给用户提供最终预览 URL、验证结果和旧站归档位置。
