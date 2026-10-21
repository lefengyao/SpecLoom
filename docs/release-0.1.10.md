# SpecLoom 0.1.10 更新

本轮面向测试反馈，集中处理英文界面、MiMo 流式响应兼容、流式输出性能和外部编辑器可选配置。版本号提升到 0.1.10，旧版 0.1.9 的更新文档与安装产物继续保留。

## 使用变化

1. 设置中的“外观 → Language”支持中文和 English 即时切换，偏好保存在本机；核心导航、聊天、工作流、实体、资料、供应商、工具、插件、诊断和关于页面均提供英文文案。
2. 修复 MiMo mimo-v2.6-flash 在 OpenAI 兼容接口下返回 tool_calls: null 时被误判为 malformed response 的问题；同时接受 assistant 文本内容以 content 数组返回。原有 OpenAI / Anthropic / Gemini 校验保持不变。
3. 聊天流式输出改为小批量合并写入和发布，避免每个 token 重写完整会话 JSON。实测同一 DeepSeek 配置从约 7 token/s 提升到约 130 token/s；最终内容、工具顺序、取消、审批和会话容量行为保持不变。
4. “打开外部编辑器”不再强制要求配置路径。未配置时打开项目所在文件夹；配置后仍使用指定编辑器。设置页明确标注该路径为可选项。

## 范围与限制

- 本次流式优化仍是“批量快照”方案：每 64 个流事件合并一次会话写入和发布，尚未切换到 StoryFabric 式的增量 delta + 渲染进程 RAF 架构。
- 流式过程中，应用崩溃可能丢失最近一批尚未落盘的内容；完成、工具、审批、错误和取消边界会强制写入。崩溃日志保存在应用日志目录。
- 英文界面不翻译项目标题、资料正文、模型名称和用户输入；少量底层系统错误文案可能仍为中文。
- 安装包未签名，Windows 可能显示 SmartScreen 提示。

## 验证

- npm run typecheck 通过。
- 会话流批处理、响应指标、容量、停止、审批相关测试通过。
- 真实 DeepSeek deepseek-flash 流式测速：565 completion tokens，约 8.6 秒，130.7 token/s。
- 本轮打包产物与校验值见 release/0.1.10/SHA256SUMS.txt。

流式架构后续计划见 [Streaming Output Performance Implementation Plan](superpowers/plans/2026-10-21-streaming-output-performance.md)。
