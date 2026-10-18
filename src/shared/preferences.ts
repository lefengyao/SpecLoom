import { z } from "zod";
import { ModelReferenceSchema, SessionModelPreferenceSchema, type ModelReference, type SessionModelPreference } from "./contracts";
import { avatarByteLimit, isAvatarDataUrl } from "./avatars";

/**
 * Application preferences. They describe how this installation looks and how the
 * agent should behave; they are stored in the app user-data directory and never
 * inside a project, so they can never touch project data.
 */

export const themeModes = ["paper", "system", "light", "dark"] as const;
export const accentIds = [
  "loom",
  "teal",
  "indigo",
  "violet",
  "amber",
  "rose",
  "graphite",
] as const;
export const uiStyles = ["default", "compact"] as const;

export type ThemeMode = (typeof themeModes)[number];
export type AccentId = (typeof accentIds)[number];
export type UiStyle = (typeof uiStyles)[number];

/**
 * Accent base colors. Light and dark tints are derived from the base with
 * `color-mix`, so one hue stays readable in both themes.
 */
export const accents: Record<AccentId, { label: string; color: string }> = {
  loom: { label: "织绿", color: "#1f6f54" },
  teal: { label: "青绿", color: "#137f78" },
  indigo: { label: "靛蓝", color: "#3a5fc8" },
  violet: { label: "紫罗兰", color: "#7b4bc6" },
  amber: { label: "琥珀", color: "#b0761b" },
  rose: { label: "玫红", color: "#bb3f68" },
  graphite: { label: "石墨", color: "#4d5a5c" },
};

export const themeLabels: Record<ThemeMode, string> = {
  paper: "纸墨",
  system: "跟随系统",
  light: "浅色",
  dark: "深色",
};

export const styleLabels: Record<UiStyle, string> = {
  default: "默认",
  compact: "紧凑",
};

export interface Preferences {
  theme: ThemeMode;
  accent: AccentId;
  style: UiStyle;
  /** Plays a short chime once an agent reply finishes. */
  completionSound: boolean;
  /** Extra operator instructions appended after the built-in system prompt. */
  customInstructions: string;
  /** Embedded raster avatars; empty or absent means the built-in avatar. */
  userAvatar?: string | undefined;
  assistantAvatar?: string | undefined;
  /** Collapse thinking and tool details inside completed assistant replies. */
  hideAgentDetails: boolean;
  /** Show token output rate on completed assistant replies. */
  showOutputRate: boolean;
  /** Show time to the first streamed model token. */
  showFirstTokenLatency: boolean;
  /** Show the time spent receiving model thinking content. */
  showThinkingDuration: boolean;
  /** Installation-wide default provider/model selection. */
  defaultModel?: ModelReference | undefined;
  /** Last explicitly selected conversation model and reasoning preference. */
  sessionModel?: SessionModelPreference | undefined;
  /** Agent stability preference, 0..100: higher is precise and stable, lower is creative. */
  agentTemperature: number;
  /** Optional local executable paths used by the top-level tool launchers. */
  godotPath: string;
  externalEditorPath: string;
}

export const customInstructionsLimit = 4000;
/** StoryFabric-aligned stability preference range; mapped via temperature = (120 - value) / 100. */
export const agentTemperatureRange = { min: 0, max: 100 } as const;
export const defaultAgentTemperature = 50;
const AvatarSchema = z.string().max(Math.ceil(avatarByteLimit / 3) * 4 + 32).refine(isAvatarDataUrl, "头像必须是256KB以内的PNG、JPEG或WebP图片");

export const defaultPreferences: Preferences = {
  theme: "paper",
  accent: "loom",
  style: "default",
  completionSound: true,
  customInstructions: "",
  hideAgentDetails: true,
  showOutputRate: true,
  showFirstTokenLatency: true,
  showThinkingDuration: true,
  agentTemperature: defaultAgentTemperature,
  godotPath: "",
  externalEditorPath: "",
};

export const PreferencesSchema = z
  .object({
    theme: z.enum(themeModes),
    accent: z.enum(accentIds),
    style: z.enum(uiStyles),
    completionSound: z.boolean(),
    customInstructions: z.string().max(customInstructionsLimit),
    userAvatar: AvatarSchema.optional(),
    assistantAvatar: AvatarSchema.optional(),
    hideAgentDetails: z.boolean(),
    showOutputRate: z.boolean(),
    showFirstTokenLatency: z.boolean(),
    showThinkingDuration: z.boolean(),
    defaultModel: ModelReferenceSchema.optional(),
    sessionModel: SessionModelPreferenceSchema.optional(),
    agentTemperature: z.number().int().min(agentTemperatureRange.min).max(agentTemperatureRange.max),
    godotPath: z.string().max(4096),
    externalEditorPath: z.string().max(4096),
  })
  .strict();

/** A partial update; unknown keys are rejected before anything is written. */
export const PreferencesPatchSchema = PreferencesSchema.partial();

/**
 * Coerces anything that came off disk into a usable preference set: a missing or
 * hand-edited file must never break startup, so unknown values fall back to defaults.
 */
export function normalizePreferences(value: unknown): Preferences {
  const complete = PreferencesSchema.safeParse(value);
  if (complete.success) return complete.data as Preferences;
  const source = (typeof value === "object" && value !== null
    ? value
    : {}) as Partial<Record<keyof Preferences, unknown>>;
  const pick = <T extends string>(
    candidates: readonly T[],
    candidate: unknown,
    fallback: T,
  ): T =>
    typeof candidate === "string" && candidates.includes(candidate as T)
      ? (candidate as T)
      : fallback;
  const repaired: Preferences = {
    theme: pick(themeModes, source.theme, defaultPreferences.theme),
    accent: pick(accentIds, source.accent, defaultPreferences.accent),
    style: pick(uiStyles, source.style, defaultPreferences.style),
    completionSound:
      typeof source.completionSound === "boolean"
        ? source.completionSound
        : defaultPreferences.completionSound,
    customInstructions:
      typeof source.customInstructions === "string"
        ? source.customInstructions.slice(0, customInstructionsLimit)
        : defaultPreferences.customInstructions,
    hideAgentDetails:
      typeof source.hideAgentDetails === "boolean"
        ? source.hideAgentDetails
        : defaultPreferences.hideAgentDetails,
    showOutputRate:
      typeof source.showOutputRate === "boolean"
        ? source.showOutputRate
        : defaultPreferences.showOutputRate,
    showFirstTokenLatency:
      typeof source.showFirstTokenLatency === "boolean"
        ? source.showFirstTokenLatency
        : defaultPreferences.showFirstTokenLatency,
    showThinkingDuration:
      typeof source.showThinkingDuration === "boolean"
        ? source.showThinkingDuration
        : defaultPreferences.showThinkingDuration,
    agentTemperature:
      typeof source.agentTemperature === "number"
        && Number.isFinite(source.agentTemperature)
        && Number.isInteger(source.agentTemperature)
        && source.agentTemperature >= agentTemperatureRange.min
        && source.agentTemperature <= agentTemperatureRange.max
        ? source.agentTemperature
        : defaultPreferences.agentTemperature,
    godotPath: typeof source.godotPath === "string" ? source.godotPath.slice(0, 4096) : defaultPreferences.godotPath,
    externalEditorPath: typeof source.externalEditorPath === "string" ? source.externalEditorPath.slice(0, 4096) : defaultPreferences.externalEditorPath,
  };
  const defaultModel = ModelReferenceSchema.safeParse(source.defaultModel);
  const userAvatar = AvatarSchema.safeParse(source.userAvatar);
  if (userAvatar.success) repaired.userAvatar = userAvatar.data;
  const assistantAvatar = AvatarSchema.safeParse(source.assistantAvatar);
  if (assistantAvatar.success) repaired.assistantAvatar = assistantAvatar.data;
  if (defaultModel.success) repaired.defaultModel = defaultModel.data;
  const sessionModel = SessionModelPreferenceSchema.safeParse(source.sessionModel);
  if (sessionModel.success) repaired.sessionModel = sessionModel.data;
  return repaired;
}
