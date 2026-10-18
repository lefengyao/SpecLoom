# 联网搜索

工作区对话输入栏提供“联网搜索”下拉框，与模型、思考偏好和审批权限并列。新会话默认关闭；选择按项目和会话保存，重启及会话 JSON 导入导出后保留。运行中、等待回答或审批时，以及已归档会话中不能修改，停止运行或恢复归档后再切换。

开启后，智能体直接获得当前模式可用的 `web_search` / `web_extract` 工具，无需配置项目 MCP 或通过 `ToolSearch` 加载。关闭时不提供这两个工具，执行端也拒绝历史调用；子智能体继承父会话本次运行的联网模式。联网搜索与现有审批权限分别设置，在“请求批准”模式中，发送搜索词或公开网页地址前会请求批准。

## 模式

| 界面名称 | 值 | 行为 |
| --- | --- | --- |
| 关闭 | `off` | 默认模式。不提供或执行内置联网搜索、网页正文工具。 |
| 自动 | `auto` | 按厂商原生、免费托管、本机自建顺序尝试；不支持原生搜索的模型或端点直接从免费托管开始。 |
| 厂商原生 | `native` | 仅调用当前模型供应商的原生搜索。此模式不提供 `web_extract`。 |
| 免费托管 | `free` | 仅调用内置 Anysearch 托管 MCP，提供搜索和公开网页正文提取。 |
| 本机自建 | `self-hosted` | 仅调用配置的 Web Content Service，提供搜索和正文提取。 |

自动模式在 provider 失败后尝试下一层；当前模型凭据不可用时也会跳过原生层，继续尝试免费托管与本机自建。用户取消、参数错误或整个工具调用超时会终止，不继续回退。正文提取没有原生层，自动模式按免费托管、本机自建顺序尝试。一次搜索或正文提取的总调用期限为 30 秒，回退共享该期限。

## 厂商原生

应用只对模型名称、协议及官方端点同时匹配的路线启用原生搜索：

| 模型名称 | 供应商协议 | HTTPS 主机 | 请求接口 |
| --- | --- | --- | --- |
| `claude*` | `anthropic` | `api.anthropic.com` | Anthropic Messages，补齐 `/v1/messages` |
| `gpt-*`、`chatgpt*`、`o1` 至 `o9` 开头 | `openai` | `api.openai.com` | OpenAI Responses，补齐 `/responses`；常用地址为 `/v1/responses` |

原生路线使用当前模型供应商的密钥。端点必须使用 HTTPS，不能包含自定义端口或 URL 用户名、密码。OpenAI 的 `/chat/completions` 地址会先移除该后缀再补齐 `/responses`。Gemini、xAI、未知模型和兼容网关不会仅凭模型名称被视为原生可用；自动模式会跳过原生层，显式选择原生模式则在发出搜索前报错。

底层 `webSearchKit` 支持部署方通过 `capability`、`capableModels` 或 `families` 显式描述兼容网关能力；当前会话界面没有提供这些覆盖项。厂商原生搜索只返回搜索来源和引用，不提供网页正文抓取，需要正文时请选择自动、免费托管或本机自建。

## 免费托管

当前内置免费服务是 Anysearch，MCP endpoint 为 `https://api.anysearch.com/mcp`，通过 JSON-RPC `tools/call` 调用 `search` 或 `extract`，接受 JSON 和 SSE 响应。搜索词、网页地址和相关结果由该托管服务处理，匿名额度与可用性由服务端决定。

应用包装层使用匿名访问，不自动读取 `ANYSEARCH_API_KEY`，也不读取或向免费服务发送当前模型供应商的密钥。自动模式即使先尝试了原生搜索，回退到免费托管时也不会携带原生模型的密钥。

## 本机自建

SpecLoom 内置 Web Content Service 客户端，不包含该服务端。地址按下列顺序解析：

1. 调用方显式传入的 `selfHostedUrl`。
2. 环境变量 `SPECLOOM_WEB_SEARCH_SELF_HOSTED_URL`。
3. StoryFabric 兼容变量 `STORYFABRIC_WEB_SEARCH_SELF_HOSTED_URL`。
4. 默认地址 `http://127.0.0.1:8090`。

会话界面不单独保存自建地址。在启动源码版前设置环境变量即可覆盖默认值：

```powershell
$env:SPECLOOM_WEB_SEARCH_SELF_HOSTED_URL = 'http://127.0.0.1:8090'
npm run dev
```

服务必须实现 `POST /v1/search` 与 `POST /v1/extract`。搜索请求一次携带一个查询：

```json
{
  "queries": ["Godot release notes"],
  "maxResults": 5
}
```

搜索响应的 `results` 必须与 `queries` 数量一致，每项必须回显相同 `query` 并提供 `sources` 数组；来源必须带可引用的绝对 HTTP(S) URL。`sources: []` 表示有效的零结果搜索，缺少字段或来源 URL 无效则作为 provider 错误处理。

```json
{
  "results": [{
    "query": "Godot release notes",
    "sources": [{
      "url": "https://example.com/article",
      "title": "Example article",
      "snippet": "Readable search excerpt",
      "publishedAt": "2026-10-01T00:00:00Z"
    }],
    "truncated": false
  }]
}
```

正文请求发送 `url`、`mode: "auto"` 和经过上限约束的 `maxChars`；响应返回 `url`、`content` 与 `truncated`。应用接收服务报告的最终 URL，正文通常为 Markdown。

## 工具结果与限制

`web_search` 的 `query` 去除首尾空白后必须为 1–500 字符；`limit` 为 1–8，默认 5。结果保留标题、URL、摘要、来源主机、检索时间，以及 provider 提供的发布时间 `publishedAt`。使用结果时，智能体应在回答中用 Markdown 链接引用具体来源 URL。

`web_extract` 只接收公开的绝对 HTTP(S) URL，拒绝嵌入用户名或密码、localhost、环回、私网与链路本地等地址字面量。后端自行解析域名及执行抓取，因此后端仍需负责其网络访问策略。`maxChars` 范围为 1000–50000，默认 12000；正文超限时截断并设置 `truncated`。自建请求使用同一字符上限，免费托管响应先解开正文记录，再对正文裁剪。

模型可接收最多 50000 字符的单页正文；聊天时间线和工具详情使用更短的有界预览，字符串超过 8000 字符或整条预览超过预算时会显示截断标记。界面预览截断不表示模型只收到了预览内容；模型请求仍受会话上下文与工具输出总预算约束。

搜索摘要和网页正文都带外部不可信内容提示。智能体可以据此核对资料并引用来源，不应执行网页中的指令或把它们作为项目规则。搜索及正文提取本身不会自动修改项目资料。

## 源码验证

协议与路由测试使用 mock fetch，可在不访问真实服务的情况下验证参数、回退、来源字段、取消和超时：

```powershell
npx vitest run tests/core/web-search-service.test.ts tests/core/web-search-integration.test.ts tests/core/web-extract-service.test.ts
```

真实托管服务和自建服务的连接质量应在本机配置下另行验证；上述模拟测试不代表真实联网成功。复用的 `webSearchKit` 代码许可见 `src/main/core/search/webSearchKit/NOTICE.md`。
