# Provider And Model Alignment Design

## Goal

Bring SpecLoom's provider and model configuration in line with the StoryFabric configuration contract while keeping the existing desktop security boundary and agent workflow intact.

## Architecture

The current single `ModelProfile` becomes a versioned provider registry. A provider owns protocol, endpoint, encrypted credential reference, ordered model IDs, and per-model overrides. Runtime selection uses `{ providerId, model }`, resolves the effective model settings from user overrides and local family defaults, then dispatches through a protocol adapter for OpenAI-compatible, Anthropic, or Gemini requests.

The renderer edits provider records and model settings through typed IPC. Secrets remain in the user-data vault and never enter public state, JSON model settings, logs, or error messages. Existing profiles are migrated into one OpenAI provider without changing their endpoint approval semantics.

## Behavior

- Protocols are `openai`, `anthropic`, and `gemini`.
- Model settings use schema version 1 and include reasoning, vision, reasoning mapping, context, and output limits.
- Effective settings follow user override, built-in family profile, then conservative unknown-model fallback.
- JSON editing validates the complete document before applying it to the current draft.
- Provider model discovery is best-effort and preserves existing models and drafts on failure.
- Runtime requests translate reasoning and output settings per protocol, preserve tools, and normalize usage.
- The workspace selects a provider/model reference and session reasoning preference; invalid references fail explicitly.

## Validation

Tests cover schema rejection, JSON round trips, provider persistence and migration, credential reuse, protocol request bodies, tool-call parsing, model selection, and renderer workflows. Full typecheck, lint, unit/integration tests, and production build are required before delivery.

## 补充对齐（2026-10-06，逐条核对基准后补齐的三处差距）

1. **协议级思考映射路径校验**（基准 §4）：Anthropic 的映射 path 必须为 `thinking`，Gemini 必须以 `generationConfig.` 开头。供应商保存时由 `ProviderInputSchema` superRefine 拒绝；请求时由协议适配器跳过不满足协议约束的映射并回落到内置思考参数，输出上限不受映射影响。
2. **智能体温度偏好**（基准 §7）：`Preferences.agentTemperature`（0–100 整数，默认 50），设置页提供滑杆；组装运行时 profile 时按 `temperature = (120 − 偏好值) / 100` 注入，独立于逐模型配置；旧版 vault 模型显式配置过的 temperature 优先。
3. **上下文占用与输出预留**（基准 §7）：运行时 profile 携带 `contextTokens`；每次请求前按本地文本估算（不含图片字节）预留输出空间，预估耗尽上下文时省略输出上限字段，交由供应商报告上下文溢出；会话保存上次运行归一化实际用量（`usage.source = "actual"`），聊天输入栏展示「上下文 ≈估算 / 窗口 · 上次实际：入/出」，明确区分估算与实际。

多阶段模型分配（基准 §6）为条件项：SpecLoom 无多阶段智能体编排流程，不适用。验证：`npm run typecheck`、`npm run lint`、全量 Vitest 回归（含新增 `tests/core/storyfabric-alignment.test.ts` 11 项与设置页滑杆用例）。
