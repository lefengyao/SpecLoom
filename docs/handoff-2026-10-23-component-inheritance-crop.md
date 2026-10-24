# 交接文档：组件继承 + 配图裁剪 + Git 分支表头修复

日期：2026-10-23
仓库：`E:\生产项目\项目\TrailblazerStation\SpecLoom`
关联产物：Trailblazer Hub 模块（尚未打包）

## 1. 本轮范围

用户确认的范围是「裁剪 + 组件继承」，同时附带修复「关于项目」页 Git 分支表头黑底黑字。明确约定：

- 组件继承是**组件定义继承组件定义**（`component extends component`），只合并字段与默认值。
- 实体 `extends` 仍然只能指向实体，不因组件继承改变。
- 画布连线仍然是实体 → 组件绑定，不做组件之间的连线。
- 配图裁剪要同时给桌面 UI 和智能体工具（`MaterialSetImage`）用。
- 验证后**只打包 Hub 模块**，不打包桌面安装包。

## 2. 当前状态

| 项目 | 状态 |
| --- | --- |
| 组件继承后端（工具/校验） | 已完成，定向测试通过 |
| 组件继承 UI（资料页/工作台） | 已完成，jsdom 测试通过；未做真机视觉验收 |
| 配图裁剪（主进程 + 工具 schema） | 已完成，schema 拒绝用例通过；`nativeImage.crop` 未在真机验证 |
| 配图裁剪 UI（框选对话框） | 已完成，jsdom 测试通过；未做真机拖拽验证 |
| Git 分支表头配色 | 已改 CSS；未截图验收 |
| 全量测试 | 已跑两遍；失败全部为环境缺失或并行抖动，非本轮回归（§7.1） |
| 真机裁剪链路（主进程 + Electron） | 已在真实 Electron 验证 14/14（§7.2） |
| 渲染层裁剪换算与 WebP 编码 | 已在真实 Chromium 验证（§7.3） |
| Git 分支表头配色 | 已用真实 CSS 实测，三套主题对比度 5.19–8.09（§7.4） |
| Hub 模块打包 | **已完成**：2.3.0 与 2.3.1 模块均已生成（§8、§9.0） |
| 提交 | **未提交**，工作树包含此前多轮未提交改动 |

## 3. 改动明细

### 3.1 组件继承

新增：

- `src/shared/component-inheritance.ts`
  - `ComponentDefinition`：`{ path, id, data }`。
  - `mergeComponentFieldLists()`：基类优先、同名字段由派生类原位覆盖。
  - `resolveComponentFields()`：沿 `extends` 链解析，返回 `fields / chain`，并标记 `cycle` 或 `missing`。
  - `withInheritedComponentFields()`：把 `MaterialSummary[]` 中组件摘要的 `fields` 替换为继承后的有效字段。

主进程：

- `src/main/core/tools/materials.ts`
  - `MaterialRead` 对组件返回继承合并后的有效 `fields`。
  - `MaterialBindComponent` 用有效字段补默认值并校验类型；自身字段定义是否合法仍单独用原始 `fields` 校验。
  - `assertProperties` 允许 `component` 设置 `extends`；`components` 仍只允许实体/地图。
  - `MaterialCreate` / `MaterialUpdate` 对组件 `extends` 做目标存在性与环检测（`validateComponentExtends`）。
  - 新增 `componentDefinitions()` / `definitionsWith()` 读取组件定义快照。
- `src/main/core/validator-references.ts`
  - 组件 `extends` 走 `COMPONENT_INHERIT` 语义校验（目标必须存在且是组件）。
  - 新增 `COMPONENT_INHERIT_CYCLE`。
  - 实体绑定组件时，字段白名单与类型校验改用**继承后的有效字段**。
- `src/main/core/validator-markdown.ts`
  - 组件 front matter 的 `extends` 增加引用形状校验。
- `src/main/core/tools/material-tool-catalog.ts`
  - `MaterialRead` / `MaterialCreate` / `MaterialUpdate` / `MaterialBindComponent` 描述补充继承语义。

渲染层：

- `src/renderer/DocumentsView.tsx`
  - 目录摘要统一经过 `withInheritedComponentFields()`，资料详情里的绑定卡片能看到继承字段。
- `src/renderer/EntityWorkbench.tsx`
  - 组件条目（工作台节点、检查器、组件浏览页）使用继承后的有效字段。
- `src/renderer/MaterialDetails.tsx`
  - 组件编辑页新增「组件继承」区块，基类候选只列组件。
  - 新增「继承字段」列表，可一键「覆盖」为自身字段。
  - 有组件子类时锁定已存在字段的名称/类型/删除，并提示哪些组件依赖。
- `src/renderer/locales/en/materials.ts`
  - 补齐新增文案英文翻译。
- `src/renderer/materials.css`
  - 继承字段样式。

行为约定：

- 派生组件有效字段 = 基类字段顺序 + 派生新增字段；同名派生字段覆盖基类字段并保留基类位置。
- 只在 UI 里「覆盖」时才把基类字段复制进自身 `fields`；覆盖后基类再改不会自动同步。
- 不继承 `notes`、`scope`、`description` 或正文。
- 组件成环、目标缺失会在保存时直接报 `VALIDATION_FAILED`，校验器也会给出对应诊断。

### 3.2 配图裁剪

主进程：

- `src/main/core/project-documents.ts`
  - 新增 `ImageCrop`（归一化 `x/y/width/height`，0~1）。
  - `assertCrop()` 校验范围与正数宽高。
  - `cropImage()` 使用 Electron `nativeImage.crop()` 裁剪后转 PNG；GIF 拒绝（可能含动画），非 Electron 环境明确报错。
  - `importImage(dataUrl, crop?)`：先裁剪、再在超过 2 MiB 时复用现有压缩逻辑（PNG/JPEG）。
- `src/main/core/tools/materials.ts`
  - `MaterialSetImage` 支持 `crop`：
    - `sourcePath + crop`：读取项目图片 → 裁剪导入。
    - `imagePath + crop`：重新读取已导入图片 → 裁剪后另存为新图片并切换引用。
    - `imagePath` 不带 crop：保持原有复用行为。
- `src/main/core/tools/material-tool-catalog.ts`
  - schema 增加 `crop`，要求 `0<=x,y`、`width,height>0`、右下角不越界；`crop` 不能与 `remove` 同用。

渲染层：

- `src/renderer/MaterialImage.tsx`
  - 抽出 `encodeWebp()`，裁剪和超大图压缩共用同一套「质量 + 尺寸」收敛逻辑，保证结果 ≤ 2 MiB。
  - 新增 `CropDialog`：在图片上拖动框选，显示保留比例，支持取消/应用。
  - 已有配图旁新增「裁剪」按钮；GIF 禁用并提示动画原因。
  - 应用后通过 `importMaterialImage` 另存为新图，再写回资料 `image`。
- `src/renderer/materials.css`
  - 裁剪遮罩、对话框、选区样式。

注意：

- 裁剪结果统一转 WebP；动画 WebP 会只保留当前帧（对话框有提示）。
- 旧的 content-addressed 图片不会删除，重新裁剪会留下未引用资源（与现有换图行为一致，暂未做 GC）。

### 3.3 Git 分支表头修复（附带）

- `src/renderer/about-view.css`
  - 原因：`th` 使用不存在的 `--panel` 变量，回退到深色 `#191f29`，浅色纸感主题下文字仍是深色，形成黑底黑字。
  - 改为 `background: var(--bg-sunken)` + `color: var(--text-muted)`，两套主题都可读。

## 4. 测试与验证记录

已执行：

- `npm run typecheck`：通过（main / renderer / tools 三套 tsconfig）。
- `npx eslint <本轮改动文件>`：通过。
- `npx vitest run tests/core/material-tools.test.ts`：15/15 通过。
- `npx vitest run tests/core/material-components.test.ts`：通过（新增 3 个组件继承用例）。
- `npx vitest run tests/renderer/Materials.test.tsx`：
  - 第一次全文件：34/35；唯一失败是裁剪用例 mock 返回了与原图相同的路径，内容未变化因此没有触发保存。
  - 修正 mock 为返回新路径后，单跑 `-t "crop dialog"` 通过；**修正后尚未重跑整文件**。

本轮新增/更新的测试：

- `tests/core/material-tools.test.ts`
  - 组件继承有效字段、绑定默认值、环/缺失目标拒绝、清除 `extends`。
  - 越界 crop、`crop + remove` 被 schema 拒绝。
- `tests/core/material-components.test.ts`
  - 组件继承合法链路。
  - 继承目标缺失与 `COMPONENT_INHERIT_CYCLE`。
  - 实体绑定继承字段合法、未知字段仍报错。
- `tests/renderer/Materials.test.tsx`
  - 组件页出现「组件继承」而不是实体继承。
  - 继承字段展示与一键覆盖。
  - 配图裁剪对话框打开、应用并触发导入（canvas 与 toBlob 为 mock）。

未验证：

- 真实界面上拖动框选手感、遮罩观感（CSS 与坐标换算已分别验证；拖动交互本身仍需人工点一次）。
- 组件继承区块在真实资料页布局下的观感（行为已由 jsdom 测试覆盖）。
- 外部 MCP 调 `MaterialSetImage` 带 `crop` 的落盘冒烟——当前正在运行的应用是已安装版本，其 `MaterialSetImage` 尚未暴露 `crop` 参数（§7.5）。
- Hub 模块安装后的插件、Skills、MCP、继承与裁剪联动冒烟（未打包）。

## 5. 下一步检查清单

1. ~~**补跑测试**~~（已完成，见 §7.1）
2. **真机验证**（自动部分已完成，见 §7.2–7.4；仅剩人工点选）
   - `SPECLOOM_USER_DATA_DIR=<临时目录> npm run dev`，避免与正在运行的安装版共用 `%APPDATA%\specloom`。
   - 资料页：给组件 A 设置 `extends` 为组件 B，确认继承字段出现、覆盖后保存为自身字段；实体挂载 A 时能看到继承字段。
   - 配图：上传后点「裁剪」，拖拽选区、应用，确认新图尺寸变化且仍 ≤ 2 MiB；GIF 的裁剪按钮应为禁用。
   - 装好新模块后再用外部 MCP 调 `MaterialSetImage` 带 `crop`，验证一次真实裁剪落盘。
3. **版本与打包（只打 Hub 模块）**——**已完成**（§8）
   - `package.json` 已升到 `2.3.0` 并同步 `package-lock.json`，新增 `docs/release-2.3.0.md`。
   - 执行 `npm run module:build`。该命令会用 Vite 构建 renderer、esbuild 打包 main，并生成：
     - `TraiblazerHub/release/0.1.7/modules/specloom-2.3.0/`
     - `TraiblazerHub/release/0.1.7/modules/specloom-module-2.3.0.zip`
     - 同名 `.sha256`、更新后的 `modules.json`
     - `TraiblazerHub/exports/` 下的 ZIP 与校验和副本
   - 不要运行 `npm run build` / `electron-builder`（用户只授权 Hub 模块）。
   - 安装模块后重点冒烟：About 页、组件继承、配图裁剪、插件列表、Skills、MCP 工具面。

## 6. 工作树与风险提示

- 当前 `SpecLoom` 工作树有大量**此前轮次**的未提交改动（MCP、插件、工作台、Hub 后端等），不是本轮独有；本轮新增文件为 `src/shared/component-inheritance.ts`，其余为本轮修改。提交前请按功能分组审查，不要整树回滚。
- `MaterialRead` 读取组件时会扫描 `specs/components` 下全部组件来解析继承链；组件数量很大时可考虑缓存，当前未做。
- 组件继承的 UI 只显示最近一级基类的字段来源标题；多级链路不会逐字段标注最初来源。
- 字段锁定只限制名称/类型/删除；默认值和显示名仍可改，新字段仍可加。
- `MaterialBindComponent` 会拒绝组件自身字段定义非法的组件（原始 `fields` 中存在无法识别的项），即使继承后的有效字段看起来正常。
- 裁剪依赖 Electron；在非 Electron 宿主里通过工具请求裁剪会明确报「当前运行环境不支持图片裁剪」。
- 本轮没有改 Hub 模块打包配置；`resources/plugins`、`resources/workflows`、`plugin-host-child.mjs` 的复制逻辑沿用上一轮修复。

## 7. 补充验证记录（同一轮，后续会话补做）

验证方式特意避开启动开发版界面：用**隐藏的 Electron 窗口**（`show: false`, `offscreen: true`）加载真实源码与 CSS，并直接 bundle `ProjectDocuments` 跑真实主进程代码。这样既不抢占焦点，也不与正在运行的安装版共用 `%APPDATA%\specloom`。临时脚本放在系统 temp 目录，不在仓库内。

### 7.1 测试

- 定向：`tests/renderer/Materials.test.tsx` + `tests/core/material-tools.test.ts` + `tests/core/material-components.test.ts` → **3 文件 / 86 用例全部通过**（33.6s；补入收敛回归测试后为 87/87）。交接文档里「裁剪用例修正后未重跑整文件」的问题已消失。
- `npm run typecheck`：三套 tsconfig 通过。
- `npx eslint`（本轮 11 个改动文件）：无问题。
- 全量 `npm test` 连跑两遍：第一遍 190 文件 / 1981 用例，16 失败（11 文件）；第二遍 15 失败（9 文件）。**两遍失败清单不同**，符合负载抖动特征。
- 把第二遍失败的 9 个文件单独串行重跑（`--no-file-parallelism`）：**8/9 文件全绿**。失败类型集中在 60s 超时、10s Hook 超时、临时文件 ENOENT 和时序断言（`running` vs `error`、数组长度 1 vs 2），没有一条落在裁剪或继承断言上。
- 唯一串行也失败的用例：`tests/integration/project-core.test.ts > runs direct bash in the project and lists the files it touched`。根因是**环境**而非代码：本机没有 `C:\Program Files\Git\bin\bash.exe`，`shellCommand()` 回退到 WSL 的 `bash.exe`，而它用 `--noprofile --norc` 启动时 PATH 内没有 `node`（实测 `bash --noprofile --norc -c "node -v"` → exit 127）。装了 Git for Windows 或让 WSL 非登录 shell 能解析 `node` 后该用例即可通过。
- `tests/integration/snapshot-docker.test.ts` 相关日志出现 `failed to connect to the docker API`，是 Docker Desktop 未启动，同样属于环境缺失。

结论：本轮改动**没有引入回归**；全量失败均为环境缺失或并行负载抖动。

### 7.2 主进程裁剪链路（真实 Electron）

把 `project-documents.ts` 用 esbuild bundle 后在真实 Electron 主进程里跑 `ProjectDocuments.importImage(dataUrl, crop)`，构造 200×100 已知像素图（上红下蓝 + 绿色标记），**14/14 项通过**：

- 右下四分之一 → 输出 100×50，取到的像素为蓝、标记为绿 → 证明 `nativeImage.crop()` 的 X/Y 都是**自左上、向下**的像素语义，归一化换算正确。
- 左上四分之一 → 红；整图裁剪 → 仍 200×100。
- 不带 `crop` 的导入保持原 PNG 并命中内容寻址去重。
- 越界（`x+w>1`）、零宽、负坐标、GIF 裁剪 → 均以 `VALIDATION_FAILED` 拒绝。
- 1400×900 噪声图 PNG（4.3 MiB）裁到 0.8 → 1120×720，随后压缩链路压成 **536 KB JPEG**，比例保持不变 → 「裁剪后再压缩」确实生效。

### 7.3 渲染层裁剪换算与 WebP（真实 Chromium）

在隐藏窗口里复现 `CropDialog.apply()` 的换算并实测：

- `<img>` 的 `getBoundingClientRect()` 与 `naturalWidth/Height` 在该布局下为 1:1（200×100 → 200×100），没有 `object-fit` 留边，因此归一化选区不会错位。
- `drawImage(image, 50, 50, 100, 50, ...)` 得到的 100×50 画布取色为蓝 + 绿标记，与主进程裁剪结果一致。
- `canvas.toBlob(..., "image/webp", 0.9)` 真实可用，产出 `RIFF/WEBP` 有效字节（此前 jsdom 测试是 mock 的，这条现在有了真机证据）。
- 裁剪对话框截图确认：遮罩只压暗选区外、白色选框、按钮与提示正常。

### 7.4 Git 分支表头配色

用真实 `styles.css` + `about-view.css` 渲染 `.about-table`，在真实 Chromium 里逐主题读取计算样式并算 WCAG 对比度：

| 主题 | 表头底色 | 表头文字 | 对比度 | 旧回退值对比度 |
| --- | --- | --- | --- | --- |
| light | `#eef1f1` | `#566164` | 5.62 | 2.59 |
| dark | `#171c1d` | `#a9b4b3` | 8.09 | 7.77 |
| paper | `#e7ece2` | `#4e6659` | 5.19 | 2.65 |

三套主题均达到 WCAG AA（≥4.5），表格正文行对比度 11.67–14.94；纸感主题实拍确认是浅灰绿底 + 深绿灰字，黑底黑字已消除。

### 7.5 本轮发现并已修复：大图 WebP 收敛（缺陷非本轮引入）

- `src/renderer/MaterialImage.tsx` 的 `encodeWebp()` 只有 14 次尝试，策略是「先把质量从 0.9 降到 0.5，质量到底后才缩尺寸」。实测：
  - 4032×3024 照片类内容 → 第 3 次（q=0.7）收敛到 1.95 MB；
  - 3000×2000 照片类内容 → 第 2 次收敛到 1.43 MB；
  - 4032×3024 **纯高熵噪声** → 14 次耗尽仍为 2.97 MB，会抛出「图片压缩后仍超过 2 MiB」。
  - 该循环是上一轮既有逻辑，本轮只是把 `compressImage` 里的同一段抽成 `encodeWebp()` 供裁剪复用，所以**这不是回归**；但极端高熵大图（例如细节极密的 12MP 截图）在桌面端上传会失败，而主进程的 `compressImage`（每次不达标就乘 0.8，10 次内可缩到 0.107 倍）反而能收敛。
  - **已修**（本轮按用户选择处理）：质量档位改为固定档位数组 `[0.9, 0.8, 0.7, 0.6, 0.5]`，用尽后按 `scale *= clamp(sqrt(limit / blob.size) * 0.9, 0.35, 0.9)` 缩边，总尝试次数 10。同时消除了原先质量 0.5 因浮点误差被重复编码一次的问题。
  - 复测（真实 Chromium）：4032×3024 照片类仍在第 3 次收敛到 1.95 MB、3000×2000 第 2 次收敛到 1.43 MB（保真策略未变）；4032×3024 纯噪声从「14 次耗尽失败」变为**第 6 次收敛到 1.35 MB**（2071×1553）。
  - 回归测试：`tests/renderer/Materials.test.tsx` 新增「shrinks dense art by the measured overshoot」，用「编码体积随像素数增长」的 mock 断言质量先降、尺寸后缩且总次数 ≤ 10；该用例在旧实现下会因 14 次耗尽而失败。
- 正在运行的安装版 `MaterialSetImage` 工具 schema 里还没有 `crop` 参数，所以「外部 MCP 带 crop 落盘」这一项要等新模块装上后才能验。

## 8. 本轮产物（已获用户授权后完成）

用户在本轮明确选择了「先修 encodeWebp 收敛问题，再一起打包」，因此该项构成打包授权。执行顺序严格为先测试、后出包。

- **收敛修复**：`src/renderer/MaterialImage.tsx` 的 `encodeWebp()` 改为固定质量档位 + 按实测体积比例缩边；新增回归测试。修复后最终门禁 `tests/renderer/Materials.test.tsx` + `material-tools` + `material-components` = **87/87 通过**，`npm run typecheck` 与 `npx eslint` 均通过。
- **版本**：`package.json` / `package-lock.json` 由 `2.2.3` 升到 `2.3.0`（`npm version --no-git-tag-version`，未打 tag、未提交），并新增 `docs/release-2.3.0.md`。
- **构建**：`npm run module:build` 成功，产物在兄弟仓库 `E:\生产项目\项目\TrailblazerStation\TraiblazerHub`：
  - `release/0.1.7/modules/specloom-2.3.0/`（含 `renderer/`、`runtime/backend.mjs`、`resources/{plugins,workflows,godot-mcp,plugin-host-child.mjs}`、`skills/`、`module.json`）
  - `release/0.1.7/modules/specloom-module-2.3.0.zip` —— **23,043,120 字节**，sha256 `acb22fc31d622f43677516515b643706ac30b805eab0772b06bf0b5d7ccee823`
  - 同名 `.sha256`（实测与 ZIP 一致）、更新后的 `modules.json`（只登记 specloom 2.3.0）
  - `exports/` 下的 ZIP 与校验和副本
- **未产生桌面安装包**：没有执行 `npm run build` / `electron-builder`；`SpecLoom/dist` 仍是 10 月 1 日的旧目录，本轮没有改动。
- **产物自检**：`module.json` 的 `version` / `source.version` 均为 2.3.0、`hostApiVersion` 2、`minimumHostVersion` 0.1.6；ZIP 共 340 个条目且包含 `module.json`、`renderer/index.html`、`runtime/backend.mjs`、`resources/plugin-host-child.mjs`；renderer bundle 含「组件继承」「继承字段」「material-crop-stage」，CSS 含 `bg-sunken` 与裁剪样式；`runtime/backend.mjs` 含 `COMPONENT_INHERIT*`，中文串因 esbuild 默认 `charset: ascii` 以 `\uXXXX` 转义存放。

仍待人工完成：

1. 安装 2.3.1 模块后冒烟：About 页表头、组件继承区块、配图裁剪拖拽、Git 差异着色与批量暂存、实体工作台尺寸/防重叠、插件列表、Skills、MCP 工具面。
2. 装上后用外部 MCP 调 `MaterialSetImage` 带 `crop`，验证一次真实裁剪落盘。
3. 按功能分组提交：`SpecLoom` 工作树仍混有此前多轮的未提交改动，不要整树回滚；`TraiblazerHub/release` 在 Hub 仓库里被 `.gitignore` 忽略，不产生待提交改动。

## 9. 同日另一批：版本冲突修复、Git 差异着色、工作台尺寸与防重叠

这批改动发生在 2.3.0 打包之后，已按用户确认**重新出包为 2.3.1**（同名换内容会让 Hub 更新器无法识别，因此升版本号）。

### 9.0 2.3.1 产物

- 版本：`package.json` / `package-lock.json` 升到 `2.3.1`，新增 `docs/release-2.3.1.md`。
- 模块目录：`release/0.1.7/modules/specloom-2.3.1/`
- ZIP：`specloom-module-2.3.1.zip` —— **23,045,045 字节**，sha256 `741b651a3fc02d0d9dc8d5a873d645c53e0944593f23fc83f86adc11e9f9226e`（与 `.sha256` 实测一致）
- `modules.json` 只登记 specloom 2.3.1；`exports/` 有 ZIP 与校验和副本；`module.json` 版本 2.3.1、`hostApiVersion` 2、`minimumHostVersion` 0.1.6
- 包内自检：renderer bundle 含 `git-diff-line`、`ewb-overlap`、「自动整理组件」、「继承字段」、`material-crop-stage`；CSS 含 `git-diff-line` 与 `ewb-overlap`；`runtime/backend.mjs` 含 `replaceDependency` 与 `COMPONENT_INHERIT`
- 未产生桌面安装包：没有执行 `npm run build` / `electron-builder`，`SpecLoom/dist` 仍是 10 月 1 日目录

### 9.1 VERSION_CONFLICT：任务读取基线落后于外部保存

- 现象：在会话/任务工作区点 Skill（或读取 `specs/project.md`）报 `A dependency was read at incompatible versions`。
- 根因：`ProjectCore.read()` 对**没有暂存条目**的文件用 `addDependency` 登记版本；资料页保存走 `ProjectDocuments.save` 直接落盘、不经过任务，旧基线过期后任务再读就硬冲突。新增的集成用例复现到同一行（`project-core.ts:362`）。
- 修复：无暂存条目时改用 `replaceDependency` 把基线推进到最新读取版本；有暂存条目时仍走 `addDependency`（暂存内容建立在旧版本上，必须拦住）。`read()` 的 `direct` 形参随之删除。
- 测试：`tests/integration/project-core.test.ts` 新增「refreshes a stale read baseline after the app saves a document outside the task」；该文件 22 通过，唯一失败仍是环境导致的 direct bash 用例（本机无 Git Bash，WSL 非登录 shell 无 node）。

### 9.2 工作台布局契约：size、原点、防重叠

- 契约（`src/shared/entity-layout.ts`）：`EntityComponentLayout.size = { width, height }`；新增 `ENTITY_SELF_LAYOUT_ID = "__entity__"`，实体自身也有一条布局（位置恒为原点）。`x/y` 统一表示**左上角**，实体左上角就是画布原点 `(0,0)`。
- 几何（`src/renderer/entity-layout.ts`）：`defaultEntityPositions` 改为按卡片尺寸装进实体左右两侧的列（间距 `CARD_GAP = 24`），默认就不重叠；`rectsOverlap` 与 `nearestFreePosition` 分别提供碰撞检测和最近空位搜索；`pruneEntityLayout` 保留实体行。
- 存储：localStorage 负载改为 `{ version: 2, entities }`。只有**没有 version** 的旧数据才按旧中心 `(420,280)` 平移迁移，避免新数据（还没测到尺寸时没有实体行）被误判成旧格式。
- 界面（`EntityWorkbench.tsx`）：卡片尺寸由 React Flow 测量后回写布局（`measureNode` 用 1px 容差去重，避免渲染循环）；拖动中实时判重叠并加 `.ewb-overlap` 红描边；松手仍重叠时自动落到最近空位；画布右上新增「自动整理组件」按钮，用实测尺寸重排。
- 测试：`tests/renderer/entity-layout.test.ts`（11 项）覆盖装箱不重叠、左右两侧、最近空位、迁移与版本化存储；`EntityWorkbench.test.tsx`（14 项）含「重叠标记 + 自动整理后无重叠」。renderer 全量 448/453，失败为已知并行抖动（`NavigationMaterials`、`MultiWindow` 单跑通过，`Races` 在本批改动前即失败）。

### 9.3 Git 差异着色与批量暂存

- 新增 `src/renderer/GitDiff.tsx`：按行分类（先认 `+++ `/`--- ` 文件头，再认 `+`/`-`/`@@`），新增绿、删除红、hunk 加粗、文件头弱化，配色复用三套主题的 `--ok-*` / `--danger-*`。
- `GitView.tsx`：每行复选框 + 表头「全选」（含半选态）+「暂存所选 / 取消暂存所选」；暂存只提交仍未暂存的，取消暂存只提交 `staged` 的；刷新后裁剪选中集；单行按钮保留。
- 测试：`GitDiff.test.tsx`（5 项）+ `GitView.test.tsx`（5 项）。

### 9.4 顺带修复

- `git.css` 的 `.git-error` 与 `usage.css` 的 `.usage-error` 引用了**不存在**的 `--danger`，整条声明失效（与「关于项目」表头黑底黑字同一类问题）；改为 `--danger-text` / `--danger-border` / `--danger-soft`。
