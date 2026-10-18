# 会话性能与模型请求边界修复

原会话包含 142 项时间线记录。折叠的思考与工具详情仍挂载正文，流式更新和输入也会重新解析不变的历史 Markdown。当前源码窗口有约 1.5 万个节点，其中约 8400 个属于折叠的 Markdown 正文。

在临时 Electron 配置中导入原会话副本进行对比，不发送模型请求，不改动原项目或原会话草稿。修复后，详情正文在展开时挂载、收起时卸载；Markdown 按正文和显示模式缓存，不受其他消息或输入变化影响。当前正在流式输出的思考仍会自动展开和更新。

| 同一会话副本的测量 | 修复前 | 修复后 |
| --- | ---: | ---: |
| 页面节点 | 14993 | 1108 |
| 折叠的 Markdown 节点 | 8420 | 0 |
| 滚动帧间隔 P95 | 750 ms | 16.8 ms |
| 输入 5 个字符 | 4426 ms | 160 ms |
| 主线程长任务 | 771–948 ms，多次 | 50 ms，两次 |

这些数值来自本机源码版与固定会话副本，反映测试操作下的改善，不代表所有设备、页面或展开内容都有相同耗时。原窗口也已确认隐藏 Markdown 节点归零。14 个界面测试文件共 151 项通过，覆盖详情展开/收起、思考流式显示、历史解析复用、输入、删除和会话切换。

重启验收另发现：恢复选中的会话时，历史尚未加载，草稿缓存会提前保存空占位值，使已保存的草稿没有显示在输入框。现在仅缓存本地已有的草稿或已加载的历史；用户输入仍立即进入缓存。新增 3 项延迟加载回归，覆盖没有本地缓存、本地明确清空及未保存的本地修改。修复后 43 项重点界面回归通过；原会话 142 条时间线逐项内容哈希、模型设置、磁盘草稿与界面草稿均核验一致。

## 同时发现的模型响应超限

原会话于 18:28:32 报错 `The model response exceeded the size limit.`，保存了约 10801 字符的部分思考。触发点是累计 SSE 传输量超过 1 MiB；每帧重复的协议元数据也计入此上限。这与界面卡顿分别发生在协议读取和渲染两层。

流式传输现允许累计 32 MiB，单帧/未完成帧限 1 MiB；非流式 JSON 仍限 1 MiB，解码后的正文、思考和工具参数限制继续生效。读取失败时仍会取消剩余响应体。回归测试验证普通长思考在协议开销超过 1 MiB 后可以完成，错误 Content-Type 下也能识别 SSE，并验证总量、单帧、未完成帧、正文和思考的上限。151 项界面回归、67 项模型及会话回归、2 项桌面验收、类型和代码规范检查通过。未自动重发用户的真实项目请求。

继续审计同一条请求链后又发现两个独立的边界错误。模型配置解析曾把 `maxOutputTokens` 硬限为 65536，但内置 GPT-5 使用 128000、o 系列使用 100000；这些模型会在发请求前被错误拒绝。现在改为正安全整数，若 profile 明确提供 `contextTokens`，输出上限必须不超过该上下文窗口；未实现的 `maxContextTokens` 别名不会被运行时类型或 schema 接受。

上下文裁剪和请求参数预留原来使用不同的 token 估算方式。裁剪层可能认为请求仍能放下，而请求层却返回“没有可用输出空间”，随后协议层回退到默认 8192，绕过模型 profile 的输出预算。两层现在共享同一个保守估算；耗尽上下文时在本地明确报错并且不发请求，只有合法剩余空间才生成 `max_tokens`/`max_completion_tokens`。

## 2026-10-08 接续验收

恢复会话后重新检查当前工作区，两次独立代码审查未发现上述性能、响应限额或草稿修复的阻断问题。本轮没有继续修改这些生产逻辑。

| 本轮命令 | 结果 |
| --- | --- |
| `npm test -- tests/renderer` | 14 个文件、154 项全部通过；包含草稿修复新增的 3 项回归 |
| `npm test -- tests/core/model-profile-limits.test.ts tests/core/protocol-completion-status.test.ts tests/core/protocol-termination.test.ts tests/core/model-response-size.test.ts tests/core/model-stream-timeout.test.ts tests/core/streaming.test.ts tests/core/agent-runtime.test.ts tests/core/session-capacity.test.ts tests/integration/chat-sessions.test.ts tests/integration/session-response-metrics.test.ts tests/core/storyfabric-alignment.test.ts` | 10 个文件、158 项全部通过 |
| `npm run test:e2e -- source-runtime.spec.ts` | 2 项全部通过，覆盖源码启动、重载、配置恢复及项目 Skills |
| `npm run typecheck`、`npm run lint`、`git -c core.safecrlf=false diff --check` | 均退出码 0 |

重新打开源码窗口时沿用原安装版配置目录，并在启动前备份配置。打开 `E:\生产项目\New项目\pvz_warG` 后核验 8 个项目 Skills；冷加载原会话后，142 条时间线内容哈希与上次快照一致，磁盘草稿、界面草稿和模型设置均保留，DeepSeek 密钥状态正常。页面共有 1085 个节点、隐藏 Markdown 节点为 0，未出现页面异常。配置备份与核验结果保存在本机诊断目录中；本次未生成新的安装包。

## 模型请求相邻问题审计与修复

继续沿会话偏好、模型档案、请求构造、流式解码和上下文保存检查，确认并修复了以下实际问题。回归使用模拟 fetch 或本机模拟端点；没有重新发送用户的项目请求。

| 问题 | 修复后的行为 |
| --- | --- |
| 新会话忽略全局会话模型或思考偏好；前后端优先级不同 | 已有会话设置优先，其次全局会话设置、默认模型和首个可用模型；首次发送保留所选思考偏好。旧 chat/agent 入口从磁盘恢复偏好，并严格匹配供应商及模型 |
| 供应商前缀或近似名称误用模型档案；GPT-5 点版本输出字段错误 | 家族匹配去除供应商前缀后检查版本边界，拒绝误识别 `gpt-50`、`o30`、`gemini-30`、`qwen30`；输出字段与同一个家族档案一致，GPT-5.1/5.2 使用 `max_completion_tokens` |
| 旧 profile 缺省 protocol 时绕过统一请求实现 | 缺省统一采用 OpenAI 协议，使用相同的输出预算、响应上限、解码与 usage 传递；显式非 assistant 返回角色被拒绝，缺省角色保留兼容 |
| 裁剪遗漏工具定义成本，旧估算对中文更宽松 | 裁剪与输出预留共享保守估算，计入实际工具定义及两个澄清工具；图片按固定成本估算，不将 base64 当文本 token |
| 工具截图生成的 user 消息被误当成新的任务目标 | 运行时用真实用户对象引用定位当前轮，裁剪完整保留其后的工具批次及截图；当前轮无法容纳时本地拒绝下一次请求 |
| 截图后的持久化历史超过 96 条或 262,144 字符时删除真实目标 | 所有 checkpoint 传递同一真实用户引用，脱敏前定位、脱敏后保护对应目标；容量不足时仍按完整工具批次移除历史，保留合法 schema，图片字节不持久化 |
| 完整 operation URL 导致模型发现地址或 Gemini 请求地址重复拼接 | 识别 OpenAI/Anthropic 完整 operation 路径、Gemini GenerateContent 路径与 `/v1beta/openai`；保留代理子路径，Gemini 请求按当前所选模型重建路径 |
| DeepSeek Flash/V4 与 Gemini 3 思考默认参数不兼容 | DeepSeek 官方端点按其支持的开关及档位构造；Gemini 3 Pro、3.1 Pro、3.1 Flash-Lite Image 按各自支持档位向较低合法档位映射，手工映射优先 |
| GPT-5、Gemini 2.5 的 off 被误当成省略参数；温度与思考冲突 | 已知 GPT-5.1/5.2 off 使用 `none`，旧 GPT-5/base/mini/nano 使用 `minimal`；Gemini 2.5 Flash/Flash-Lite 使用 budget 0，Pro 使用最低 budget 128。GPT-5/o 系和开启 thinking 的 Anthropic 请求省略不兼容温度；Anthropic 普通温度限制到 0–1 |

容量回归额外覆盖：大截图工具批次超过历史 JSON 上限、截图工具多轮超过消息数上限、真实用户图片作为新轮、脱敏后的目标保护。当前轮引用仅用于本地运行，不增加上游请求字段或持久化字段。

思考参数依据：[OpenAI GPT-5.2](https://developers.openai.com/api/docs/guides/gpt-5.2)、[Claude thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)、[Claude Messages API](https://platform.claude.com/docs/en/api/messages/create)、[Gemini thinking](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/thinking)、[Gemini 3](https://ai.google.dev/gemini-api/docs/gemini-3)。

### 验证范围与保留边界

token 数仍为字符和固定图片成本的估算，较之前更保守，可能更早裁剪历史；没有验证精确 tokenizer。旧 GPT-5 和 Gemini Pro 的 off 表示最低支持思考档位，不能视为完全关闭。未将 GPT-5 off 映射自动扩展到 pro、codex 或未来型号；最新 Claude 型号的 adaptive-only thinking 等型号专有能力需要独立兼容验证。

原响应超限修复仍保留明确容量限制：SSE 累计 32 MiB，单帧/未完成帧与非流式 JSON 各 1 MiB，正文、思考和工具参数另有限额。超过这些实际上限仍会报错。

修复位于当前源码。未重新生成安装包，未使用真实供应商请求进行验收；测试不会更新用户原有会话或重启已有源码窗口。
