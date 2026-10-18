import { normalizeReasoningMapPath, type ModelSettings, type ProviderProtocol, type ReasoningMap, type ReasoningLevel } from "../../shared/contracts";
export type ThinkingLevel = ReasoningLevel;

export interface ModelFamily {
  id: string;
  name: string;
  /** Case-insensitive family name matched at a model-version boundary without a vendor prefix. */
  match: string;
  reasoningSupport: boolean;
  /** Optional family-level default; user settings still take precedence. */
  defaultReasoning?: ReasoningLevel;
  vision: boolean;
  contextTokens: number;
  maxOutputTokens: number;
  outputTokenParam: "max_tokens" | "max_completion_tokens";
}

/** Local defaults are intentionally conservative and can be overridden per model. */
export const MODEL_FAMILIES: readonly ModelFamily[] = [
  { id: "gpt-5", name: "OpenAI GPT-5", match: "gpt-5", reasoningSupport: true, vision: true, contextTokens: 400_000, maxOutputTokens: 128_000, outputTokenParam: "max_completion_tokens" },
  { id: "gpt-4.1", name: "OpenAI GPT-4.1", match: "gpt-4.1", reasoningSupport: false, vision: true, contextTokens: 1_047_576, maxOutputTokens: 32_768, outputTokenParam: "max_tokens" },
  { id: "gpt-4o", name: "OpenAI GPT-4o", match: "gpt-4o", reasoningSupport: false, vision: true, contextTokens: 131_072, maxOutputTokens: 16_384, outputTokenParam: "max_tokens" },
  { id: "gpt-4-turbo", name: "OpenAI GPT-4 Turbo", match: "gpt-4-turbo", reasoningSupport: false, vision: true, contextTokens: 128_000, maxOutputTokens: 4_096, outputTokenParam: "max_tokens" },
  { id: "gpt-4", name: "OpenAI GPT-4", match: "gpt-4", reasoningSupport: false, vision: false, contextTokens: 131_072, maxOutputTokens: 4_096, outputTokenParam: "max_tokens" },
  { id: "o4-mini", name: "OpenAI o4-mini", match: "o4-mini", reasoningSupport: true, vision: true, contextTokens: 200_000, maxOutputTokens: 100_000, outputTokenParam: "max_completion_tokens" },
  { id: "o3", name: "OpenAI o3", match: "o3", reasoningSupport: true, vision: true, contextTokens: 200_000, maxOutputTokens: 100_000, outputTokenParam: "max_completion_tokens" },
  { id: "o1", name: "OpenAI o1", match: "o1", reasoningSupport: true, vision: true, contextTokens: 200_000, maxOutputTokens: 100_000, outputTokenParam: "max_completion_tokens" },
  { id: "o-series", name: "OpenAI o 系推理", match: "o3", reasoningSupport: true, vision: true, contextTokens: 200_000, maxOutputTokens: 100_000, outputTokenParam: "max_completion_tokens" },
  { id: "claude-sonnet-4", name: "Claude Sonnet 4", match: "claude-sonnet-4", reasoningSupport: true, vision: true, contextTokens: 200_000, maxOutputTokens: 64_000, outputTokenParam: "max_tokens" },
  { id: "claude-opus-4", name: "Claude Opus 4", match: "claude-opus-4", reasoningSupport: true, vision: true, contextTokens: 200_000, maxOutputTokens: 32_000, outputTokenParam: "max_tokens" },
  { id: "claude-4", name: "Claude 4", match: "claude-4", reasoningSupport: true, vision: true, contextTokens: 200_000, maxOutputTokens: 32_000, outputTokenParam: "max_tokens" },
  { id: "claude-3-7", name: "Claude 3.7", match: "claude-3-7", reasoningSupport: true, vision: true, contextTokens: 200_000, maxOutputTokens: 64_000, outputTokenParam: "max_tokens" },
  { id: "claude-3.7", name: "Claude 3.7", match: "claude-3.7", reasoningSupport: true, vision: true, contextTokens: 200_000, maxOutputTokens: 64_000, outputTokenParam: "max_tokens" },
  { id: "claude-3-5", name: "Claude 3.5", match: "claude-3-5", reasoningSupport: false, vision: true, contextTokens: 200_000, maxOutputTokens: 8_192, outputTokenParam: "max_tokens" },
  { id: "claude-3.5", name: "Claude 3.5", match: "claude-3.5", reasoningSupport: false, vision: true, contextTokens: 200_000, maxOutputTokens: 8_192, outputTokenParam: "max_tokens" },
  { id: "claude-3-opus", name: "Claude 3 Opus", match: "claude-3-opus", reasoningSupport: false, vision: true, contextTokens: 200_000, maxOutputTokens: 4_096, outputTokenParam: "max_tokens" },
  { id: "claude", name: "Claude", match: "claude", reasoningSupport: true, vision: true, contextTokens: 200_000, maxOutputTokens: 64_000, outputTokenParam: "max_tokens" },
  { id: "gemini-2.5", name: "Gemini 2.5", match: "gemini-2.5", reasoningSupport: true, vision: true, contextTokens: 1_048_576, maxOutputTokens: 65_536, outputTokenParam: "max_tokens" },
  { id: "gemini-2.0", name: "Gemini 2.0", match: "gemini-2.0", reasoningSupport: false, vision: true, contextTokens: 1_048_576, maxOutputTokens: 8_192, outputTokenParam: "max_tokens" },
  { id: "gemini-1.5", name: "Gemini 1.5", match: "gemini-1.5", reasoningSupport: false, vision: true, contextTokens: 1_048_576, maxOutputTokens: 8_192, outputTokenParam: "max_tokens" },
  { id: "gemini-3", name: "Gemini 3", match: "gemini-3", reasoningSupport: true, vision: true, contextTokens: 1_048_576, maxOutputTokens: 64_000, outputTokenParam: "max_tokens" },
  { id: "deepseek-r1", name: "DeepSeek R1", match: "deepseek-r1", reasoningSupport: true, vision: false, contextTokens: 131_072, maxOutputTokens: 32_768, outputTokenParam: "max_tokens" },
  { id: "deepseek-reasoner", name: "DeepSeek Reasoner", match: "deepseek-reasoner", reasoningSupport: true, vision: false, contextTokens: 131_072, maxOutputTokens: 32_768, outputTokenParam: "max_tokens" },
  { id: "deepseek-flash", name: "DeepSeek Flash", match: "deepseek-flash", reasoningSupport: true, defaultReasoning: "high", vision: false, contextTokens: 131_072, maxOutputTokens: 8_192, outputTokenParam: "max_tokens" },
  { id: "deepseek-v4", name: "DeepSeek V4", match: "deepseek-v4", reasoningSupport: true, defaultReasoning: "high", vision: false, contextTokens: 131_072, maxOutputTokens: 8_192, outputTokenParam: "max_tokens" },
  { id: "deepseek", name: "DeepSeek V3 / Chat", match: "deepseek", reasoningSupport: false, vision: false, contextTokens: 131_072, maxOutputTokens: 8_192, outputTokenParam: "max_tokens" },
  { id: "qwen3", name: "Qwen3", match: "qwen3", reasoningSupport: true, vision: false, contextTokens: 1_048_576, maxOutputTokens: 32_768, outputTokenParam: "max_tokens" },
  { id: "qwen", name: "Qwen", match: "qwen", reasoningSupport: false, vision: false, contextTokens: 1_048_576, maxOutputTokens: 32_768, outputTokenParam: "max_tokens" },
  { id: "qwen-vl", name: "Qwen VL", match: "qwen-vl", reasoningSupport: false, vision: true, contextTokens: 131_072, maxOutputTokens: 8_192, outputTokenParam: "max_tokens" },
  { id: "kimi-k2", name: "Kimi K2", match: "kimi-k2", reasoningSupport: true, vision: false, contextTokens: 262_144, maxOutputTokens: 32_768, outputTokenParam: "max_tokens" },
  { id: "glm-4.5", name: "GLM 4.5+", match: "glm-4.5", reasoningSupport: true, vision: false, contextTokens: 131_072, maxOutputTokens: 16_384, outputTokenParam: "max_tokens" },
  { id: "doubao-seed", name: "豆包 Seed 思考", match: "doubao-seed", reasoningSupport: true, vision: false, contextTokens: 262_144, maxOutputTokens: 32_768, outputTokenParam: "max_tokens" },
  { id: "grok", name: "Grok", match: "grok", reasoningSupport: false, vision: false, contextTokens: 131_072, maxOutputTokens: 16_384, outputTokenParam: "max_tokens" },
];

export const GENERIC_FALLBACK = {
  reasoningSupport: false,
  vision: false,
  reasoning: "off" as ThinkingLevel,
  reasoningMap: null as ReasoningMap | null,
  contextTokens: 131_072,
  maxOutputTokens: 8_192,
  outputTokenParam: "max_tokens" as const,
};

export interface EffectiveModelSettings {
  reasoningSupport: boolean;
  vision: boolean;
  reasoning: ThinkingLevel;
  reasoningMap: ReasoningMap | null;
  contextTokens: number;
  maxOutputTokens: number;
  outputTokenParam: "max_tokens" | "max_completion_tokens";
  source: string;
  overridden: string[];
}

/** Compatibility profile shape used by protocol parameter builders. */
export interface ModelProfileDefaults {
  label: string;
  contextTokens: number;
  maxOutputTokens: number;
  openaiOutputParam: "max_tokens" | "max_completion_tokens";
  reasoning: boolean;
  vision: boolean;
}

export function stripVendorPrefix(modelId: string): string {
  const index = modelId.lastIndexOf("/");
  return index >= 0 ? modelId.slice(index + 1) : modelId;
}

export function matchModelFamily(modelId: string): ModelFamily | null {
  const bare = stripVendorPrefix(modelId).trim().toLowerCase();
  let match: ModelFamily | null = null;
  for (const family of MODEL_FAMILIES) {
    const prefix = family.match.toLowerCase();
    const suffix = bare.slice(prefix.length);
    // Qwen version names append one major digit directly to their generic stem.
    const boundary = !suffix || /^[.-]/.test(suffix) || (family.id === "qwen" && /^\d(?:[.-]|$)/.test(suffix));
    if (bare.startsWith(prefix) && boundary && (!match || family.match.length > match.match.length)) {
      match = family;
    }
  }
  return match;
}

export function profileForModel(modelId: string): ModelProfileDefaults {
  const family = matchModelFamily(modelId);
  if (!family) {
    return { label: "通用", contextTokens: GENERIC_FALLBACK.contextTokens, maxOutputTokens: GENERIC_FALLBACK.maxOutputTokens, openaiOutputParam: GENERIC_FALLBACK.outputTokenParam, reasoning: GENERIC_FALLBACK.reasoningSupport, vision: GENERIC_FALLBACK.vision };
  }
  return { label: family.name, contextTokens: family.contextTokens, maxOutputTokens: family.maxOutputTokens, openaiOutputParam: family.outputTokenParam, reasoning: family.reasoningSupport, vision: family.vision };
}

const OVERRIDABLE_FIELDS = [
  "reasoningSupport", "vision", "reasoning", "reasoningMap", "contextTokens", "maxOutputTokens",
] as const;

export function resolveModelSettings(modelId: string, userSettings?: ModelSettings): EffectiveModelSettings;
export function resolveModelSettings(provider: { modelSettings?: Record<string, ModelSettings> }, modelId: string): EffectiveModelSettings;
export function resolveModelSettings(modelOrProvider: string | { modelSettings?: Record<string, ModelSettings> }, settingsOrModel?: ModelSettings | string): EffectiveModelSettings {
  const modelId = typeof modelOrProvider === "string" ? modelOrProvider : settingsOrModel as string;
  const userSettings = typeof modelOrProvider === "string" ? settingsOrModel as ModelSettings | undefined : modelOrProvider.modelSettings?.[modelId];
  const family = matchModelFamily(modelId);
  const overridden = OVERRIDABLE_FIELDS.filter((field) => userSettings?.[field] !== undefined);
  const contextTokens = positiveInteger(userSettings?.contextTokens) ?? family?.contextTokens ?? GENERIC_FALLBACK.contextTokens;
  const maxOutputTokens = positiveInteger(userSettings?.maxOutputTokens) ?? family?.maxOutputTokens ?? GENERIC_FALLBACK.maxOutputTokens;
  const source = family
    ? overridden.length ? `内置档案：${family.name}（${overridden.length} 项手动覆盖）` : `内置档案：${family.name}`
    : overridden.length ? "通用回退（含手动覆盖）" : "通用回退";
  return {
    reasoningSupport: userSettings?.reasoningSupport ?? family?.reasoningSupport ?? GENERIC_FALLBACK.reasoningSupport,
    vision: userSettings?.vision ?? family?.vision ?? GENERIC_FALLBACK.vision,
    reasoning: userSettings?.reasoning ?? family?.defaultReasoning ?? GENERIC_FALLBACK.reasoning,
    reasoningMap: userSettings?.reasoningMap ?? GENERIC_FALLBACK.reasoningMap,
    contextTokens,
    maxOutputTokens: Math.min(maxOutputTokens, contextTokens),
    outputTokenParam: family?.outputTokenParam ?? GENERIC_FALLBACK.outputTokenParam,
    source,
    overridden: [...overridden],
  };
}

/** Effective reasoning and image-input capabilities for UI and routing checks. */
export function resolveCapability(modelId: string, settings?: ModelSettings): { reasoning: boolean; vision: boolean } {
  const effective = resolveModelSettings(modelId, settings);
  return { reasoning: effective.reasoningSupport, vision: effective.vision };
}

/** Effective context/output limits with output always bounded by the context window. */
export function resolveContextWindow(modelId: string, settings?: ModelSettings): { contextTokens: number; maxOutputTokens: number } {
  const effective = resolveModelSettings(modelId, settings);
  return { contextTokens: effective.contextTokens, maxOutputTokens: Math.min(effective.maxOutputTokens, effective.contextTokens) };
}

/** Conservative text token estimate used before an API has returned usage metadata. */
export function estimateTokens(text: string): number {
  return Math.ceil((text.length / 2) * 1.1);
}

/** Maps the 0..100 stability preference used by the aligned products to API temperature. */
export function temperatureFromPreference(preference: number): number {
  return (120 - preference) / 100;
}

export const temperatureFromStabilityPreference = temperatureFromPreference;

/** Returns the output headroom after accounting for estimated input tokens. */
export function availableOutputTokens(modelId: string, inputTokens: number, settings?: ModelSettings): number {
  const { contextTokens, maxOutputTokens } = resolveContextWindow(modelId, settings);
  const used = Number.isFinite(inputTokens) ? Math.max(0, Math.ceil(inputTokens)) : 0;
  return Math.max(0, Math.min(maxOutputTokens, contextTokens - used));
}

export function fitsContext(modelId: string, inputTokens: number, outputTokens = 0, settings?: ModelSettings): boolean {
  const { contextTokens } = resolveContextWindow(modelId, settings);
  const input = Number.isFinite(inputTokens) ? Math.max(0, Math.ceil(inputTokens)) : Number.POSITIVE_INFINITY;
  const output = Number.isFinite(outputTokens) ? Math.max(0, Math.ceil(outputTokens)) : Number.POSITIVE_INFINITY;
  return input + output <= contextTokens;
}

export function pruneModelSettings(models: readonly string[], settings: Record<string, ModelSettings> | undefined): Record<string, ModelSettings> {
  const allowed = new Set(models);
  return Object.fromEntries(Object.entries(settings ?? {}).filter(([model]) => allowed.has(model)));
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Keys that can alter request routing, content, streaming, or output limits. */
export const RESERVED_REASONING_KEYS: ReadonlySet<string> = new Set([
  "__proto__", "constructor", "prototype", "model", "messages", "tools", "tool_choice", "toolConfig",
  "contents", "system", "systemInstruction", "stream", "stream_options", "max_tokens", "max_completion_tokens",
  "maxOutputTokens", "safetySettings", "metadata", "service_tier", "store", "user", "seed", "response_format",
  "responseMimeType", "responseSchema", "responseModalities", "temperature",
]);

export function validateReasoningMapPath(path: string): string {
  if (typeof path !== "string" || !path.trim()) throw new Error("映射 path 不能为空");
  const segments = path.split(".");
  for (const segment of segments) {
    const key = segment.trim();
    if (!key) throw new Error(`映射 path 存在空路径段：「${path}」`);
    if (RESERVED_REASONING_KEYS.has(key)) throw new Error(`映射 path 不能覆盖请求保留字段：「${key}」`);
  }
  const normalized = normalizeReasoningMapPath(path);
  if (!normalized) throw new Error(`映射 path 不能覆盖请求保留字段：「${path}」`);
  return normalized;
}

export function isWritableReasoningPath(path: string): boolean {
  try {
    validateReasoningMapPath(path);
    return true;
  } catch {
    return false;
  }
}

export function parseReasoningValue(raw?: string): unknown | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed === null ? undefined : parsed;
  } catch {
    return text;
  }
}

export function setByPath(target: Record<string, unknown>, path: string, value: unknown): void {
  if (!isWritableReasoningPath(path)) return;
  const segments = path.split(".").map((segment) => segment.trim());
  let cursor = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const key = segments[index] as string;
    const existing = cursor[key];
    if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1] as string] = value;
}

/** Applies one mapped value and reports whether a value was actually written. */
export function applyReasoningMap(target: Record<string, unknown>, map: ReasoningMap | null | undefined, level: ThinkingLevel): boolean {
  if (!map || !isWritableReasoningPath(map.path)) return false;
  const value = parseReasoningValue(map.values?.[level]);
  if (value === undefined) return false;
  setByPath(target, map.path, value);
  return true;
}

const BUDGETS: Record<Exclude<ThinkingLevel, "off">, number> = { low: 2048, medium: 8192, high: 16384 };

/** Anthropic/Gemini require at least 1024 tokens of non-thinking output headroom. */
export function reasoningBudget(level: ThinkingLevel, maxOutputTokens: number): number {
  if (level === "off") return 0;
  const room = maxOutputTokens - 1024;
  if (room < 1024) return 0;
  return Math.min(BUDGETS[level] ?? 0, room);
}

export function protocolLabel(protocol: ProviderProtocol): string {
  switch (protocol) {
    case "anthropic": return "Anthropic";
    case "gemini": return "Gemini 原生";
    default: return "OpenAI 兼容";
  }
}
