import { MAX_MODEL_TOOL_ROUNDS, type ModelSettings, type ModelSettingsJsonV1, type ReasoningMap } from "../../shared/contracts";
import { isWritableReasoningPath, resolveModelSettings, validateReasoningMapPath, type ThinkingLevel } from "./model-settings";

export const REASONING_LEVELS: readonly ThinkingLevel[] = ["off", "low", "medium", "high"];
export const MODEL_JSON_MAX_CHARS = 64_000;

const REQUIRED_FIELDS = ["schemaVersion", "reasoningSupport", "vision", "reasoning", "reasoningMap", "contextTokens", "maxOutputTokens"] as const;
const OPTIONAL_FIELDS = ["maxToolRounds"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} 必须是正的安全整数`);
  return value;
}

function parseReasoningMap(value: unknown): ReasoningMap | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new Error("reasoningMap 必须是映射对象或 null");
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("path") || !keys.includes("values")) throw new Error("reasoningMap 只能包含 path 与 values 两个字段");
  if (typeof value.path !== "string") throw new Error("reasoningMap.path 必须是文本");
  const path = validateReasoningMapPath(value.path);
  if (!isRecord(value.values)) throw new Error("reasoningMap.values 必须是对象");
  const allowed = new Set(REASONING_LEVELS);
  const values: Partial<Record<ThinkingLevel, string>> = {};
  for (const [key, raw] of Object.entries(value.values)) {
    if (!allowed.has(key as ThinkingLevel)) throw new Error(`reasoningMap.values 不支持「${key}」`);
    if (typeof raw !== "string") throw new Error(`reasoningMap.values.${key} 必须是字符串`);
    values[key as ThinkingLevel] = raw;
  }
  if (!Object.values(values).some((entry) => typeof entry === "string" && entry.trim().length > 0)) throw new Error("reasoningMap.values 至少需要一个非空值");
  return { path, values };
}

/** Parses a complete JSON v1 document before any draft is changed. */
export function parseModelSettingsJson(source: string): ModelSettings {
  if (source.length > MODEL_JSON_MAX_CHARS) throw new Error(`JSON 内容不能超过 ${MODEL_JSON_MAX_CHARS} 字符`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw new Error("JSON 顶层必须是对象");
  if (parsed.schemaVersion !== 1) throw new Error("schemaVersion 必须为 1");
  const fields = new Set<string>([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]);
  for (const key of Object.keys(parsed)) if (!fields.has(key)) throw new Error(`不接受额外字段：「${key}」`);
  for (const key of REQUIRED_FIELDS) if (!(key in parsed)) throw new Error(`缺少必需字段：「${key}」`);
  if (typeof parsed.reasoningSupport !== "boolean") throw new Error("reasoningSupport 必须是布尔值");
  if (typeof parsed.vision !== "boolean") throw new Error("vision 必须是布尔值");
  if (!REASONING_LEVELS.includes(parsed.reasoning as ThinkingLevel)) throw new Error("reasoning 必须是 off / low / medium / high 之一");
  const contextTokens = requirePositiveSafeInteger(parsed.contextTokens, "contextTokens");
  const maxOutputTokens = requirePositiveSafeInteger(parsed.maxOutputTokens, "maxOutputTokens");
  if (maxOutputTokens > contextTokens) throw new Error("maxOutputTokens 不能大于 contextTokens");
  const maxToolRounds = parsed.maxToolRounds === undefined
    ? undefined
    : requirePositiveSafeInteger(parsed.maxToolRounds, "maxToolRounds");
  if (maxToolRounds !== undefined && maxToolRounds > MAX_MODEL_TOOL_ROUNDS) throw new Error(`maxToolRounds 不能大于 ${MAX_MODEL_TOOL_ROUNDS}`);
  const reasoningMap = parseReasoningMap(parsed.reasoningMap);
  const result: ModelSettings = {
    reasoningSupport: parsed.reasoningSupport,
    vision: parsed.vision,
    reasoning: parsed.reasoning as ThinkingLevel,
    reasoningMap,
    contextTokens,
    maxOutputTokens,
  };
  // Accept the legacy field for imports without restoring its removed runtime cap.
  return result;
}

export function encodeModelSettingsJson(settings: {
  reasoningSupport?: boolean | undefined;
  vision?: boolean | undefined;
  reasoning?: ThinkingLevel | undefined;
  reasoningMap?: ReasoningMap | null | undefined;
  contextTokens?: number | undefined;
  maxOutputTokens?: number | undefined;
  maxToolRounds?: number | undefined;
}): string {
  const payload: ModelSettingsJsonV1 = {
    schemaVersion: 1,
    reasoningSupport: settings.reasoningSupport ?? false,
    vision: settings.vision ?? false,
    reasoning: settings.reasoning ?? "off",
    reasoningMap: settings.reasoningMap ?? null,
    contextTokens: typeof settings.contextTokens === "number" ? settings.contextTokens : 131_072,
    maxOutputTokens: typeof settings.maxOutputTokens === "number" ? settings.maxOutputTokens : 8_192,
  };
  return JSON.stringify(payload, null, 2);
}

/** Formats effective defaults plus user overrides for the editor. */
export function formatModelConfigJson(model: string, settings: ModelSettings): string {
  return encodeModelSettingsJson(resolveModelSettings(model, settings));
}

/** StoryFabric-compatible parser name; protocol is accepted for caller parity. */
export function parseModelConfigJson(source: string, protocol?: string): ModelSettings {
  void protocol;
  return parseModelSettingsJson(source);
}

/** Alias used by editor callers that want to make the transactional intent explicit. */
export function applyModelSettingsJson(_current: ModelSettings, source: string): ModelSettings {
  return parseModelSettingsJson(source);
}

export { isWritableReasoningPath };
