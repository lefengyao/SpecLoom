# Agent instructions

## 打包规则

- **默认出包（2026-10-23 用户常设授权）**：用户已明确要求「后面都要出包」。此后每完成一批源码改动，先跑通测试与类型检查，然后直接执行 `npm run module:build` 生成 Hub 模块，不再逐次确认。
- 仍然只出 **Hub 模块**。桌面安装包相关命令（`npm run build`、`npm run build:dir`、`npm run build:app`、`electron-builder`）仍需用户当轮明确要求。
- 每批改动建议单独升一个小版本（例如 2.3.4 → 2.3.5），避免同名版本换内容导致 Hub 更新器无法识别；同名覆盖只在版本尚未分发时使用。
- 打包前必须先完成源码验证：`npm run typecheck` 与相关定向测试通过；失败时先修或如实报告，不带病出包。
- 打包后报告产物路径、字节数与 sha256，并说明是否已包含本轮修复（从产物里核对，而不是只看版本号）。
- 例外与收回：如果用户当轮说「先不打包」「只改代码」「稍后再出包」，以当轮指令为准；用户可随时收回这条常设授权。
- 未在常设授权覆盖范围内的其他发布行为（打 tag、推送远端、生成桌面安装包、发布到外部渠道）仍需用户当轮明确要求。

## 出包后的安装与复核

- 用 Trailblazer Hub 的 CLI 安装，不要手动改 `%APPDATA%\trailblazer-hub\modules` 或 `plugins` 目录。
- CLI 是与 `Trailblazer Hub.exe` 同目录的 `hub.cmd`（便携版在解压根目录）。若某个 `win-unpacked` 里缺少 exe 和 `hub.cmd`，从 `TraiblazerHub/release/<ver>/TrailblazerHub-Portable-<ver>.zip` 重新解压一份可用副本，不要凭猜测补文件。
- 标准流程：`npm run module:build` → 关闭 Hub → `hub.cmd update "<zip 绝对路径>"` → `hub.cmd list modules` 复核版本。
- `install`/`update`/`uninstall` 要求 Hub 已关闭；退出码 3 表示 Hub 在运行或另一个 CLI 正在写。此时请用户关闭 Hub，不要结束 Hub 进程、不要提权。
- `update` 只能更新已安装的 id；未安装时改用 `install` 前先问用户。`uninstall` 必须得到用户明确确认后才加 `--yes`。
- 路径含空格要加引号；失败时报告退出码和 CLI 的错误行，不要自己绕过。
- 复核除版本号外，还要确认安装目录里的产物确实包含本轮改动（例如在 `runtime/backend.mjs` 里查新增的诊断码或标识）。
