# Agent instructions

## 打包规则

- 除非用户在当前任务中明确要求打包，否则不要生成安装包、发行 ZIP、Trailblazer Hub 模块包或其他发布产物。
- 用户未要求打包时，只运行源码开发与验证所需的命令，例如定向测试、类型检查、lint，或启动源码开发版供用户查看。不要擅自运行 `npm run build`、`npm run build:dir`、`npm run build:app`、`electron-builder` 或 `npm run module:build`。
- 只有用户明确要求打包/发布时，才执行对应的打包命令；先完成源码测试，再生成产物。
