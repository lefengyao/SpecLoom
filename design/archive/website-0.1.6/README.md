# SpecLoom 产品展示页

纯静态站点，无构建步骤、无第三方依赖，也不参与 Electron 应用打包。

## 本地预览

从仓库任意位置运行：

```powershell
npm --prefix website run preview
```

然后打开 <http://127.0.0.1:59843/website/>。预览服务从仓库根目录提供文件，因此页面可以访问相邻的 `release/` 目录；默认端口可用环境变量 `PORT` 修改。

## 文件

- `index.html`：首页结构、产品能力、工作流、下载、FAQ。
- `styles.css`：暖白编辑式视觉、响应式布局、减少动态效果适配。
- `site.js`：窄屏导航与下载文件探测（HEAD 请求）。
- `site-config.js`：当前版本、平台与安装版/便携版下载路径的唯一来源。
- `assets/specloom.svg`：站点内使用的品牌标记。
- `tests/site.test.mjs`：下载探测、导航和内容结构测试（`node --test`）。

## 版本与下载

`site-config.js` 中的 `version` 决定页面显示的版本和 `../release/<version>/` 路径。发布新版本时同步修改该文件，确认对应安装包和便携 ZIP 已存在于 `release/<version>/`。文件缺失时页面会显示“本地预览、未检测到对应文件”，不会产生死链。

整个 `/website/` 目录被 `.gitignore` 忽略，不会进入应用构建或发布产物。
