import { z } from "zod";
import { MAX_MODEL_TIMEOUT_MS, MAX_MODEL_TOOL_ROUNDS, ModelProfileSchema, ProtocolSchema, ReasoningLevelSchema, ReasoningMapSchema, type ModelProfile, type Protocol, type ReasoningLevel, type ReasoningMap } from "../../shared/contracts";
import { ProjectError } from "./errors";

/** Runtime-only extensions carried by the provider registry while legacy profiles remain supported. */
export interface RuntimeModelProfile extends ModelProfile {
  protocol?: Protocol | undefined;
  reasoningSupport?: boolean | undefined;
  reasoning?: ReasoningLevel | undefined;
  reasoningMap?: ReasoningMap | null | undefined;
  vision?: boolean | undefined;
  contextTokens?: number | undefined;
  providerId?: string | undefined;
}

const RuntimeModelProfileSchema = ModelProfileSchema.extend({
  maxToolRounds: z.number().int().positive().max(MAX_MODEL_TOOL_ROUNDS).optional(),
  maxOutputTokens: z.number().int().safe().positive().optional(),
  protocol: ProtocolSchema.optional(),
  reasoningSupport: z.boolean().optional(),
  reasoning: ReasoningLevelSchema.optional(),
  reasoningMap: ReasoningMapSchema.nullable().optional(),
  vision: z.boolean().optional(),
  contextTokens: z.number().int().safe().positive().optional(),
  providerId: z.string().min(1).max(256).optional(),
}).strict();

export function parseModelProfile(value: unknown): RuntimeModelProfile {
  const parsed = RuntimeModelProfileSchema.safeParse(value);
  const isProviderRuntimeProfile = parsed.success && parsed.data.providerId !== undefined;
  if (!parsed.success || parsed.data.timeoutMs > MAX_MODEL_TIMEOUT_MS
    || (parsed.data.contextTokens !== undefined && parsed.data.maxOutputTokens !== undefined
      && parsed.data.maxOutputTokens > parsed.data.contextTokens)
    || parsed.data.id.length > (isProviderRuntimeProfile ? 769 : 256)
    || parsed.data.name.length > (isProviderRuntimeProfile ? 771 : 256)
    || parsed.data.model.length > (isProviderRuntimeProfile ? 512 : 256) || parsed.data.baseUrl.length > 2_048) {
    throw new ProjectError("MODEL_ERROR", "Invalid or unbounded model configuration.");
  }
  return parsed.data;
}

export function chatCompletionsUrl(baseUrl: string): string {
  let endpoint: URL;
  try { endpoint = new URL(baseUrl); }
  catch { throw new ProjectError("MODEL_ERROR", "Invalid model endpoint."); }
  const validated = ModelProfileSchema.shape.baseUrl.safeParse(baseUrl);
  if (!validated.success) throw new ProjectError("MODEL_ERROR", "Invalid model endpoint.");
  const root = endpoint.pathname.replace(/\/+$/, "");
  endpoint.pathname = root.endsWith("/chat/completions") ? root : `${root}/chat/completions`;
  endpoint.hash = "";
  endpoint.searchParams.sort();
  return endpoint.toString();
}

export const normalizeEndpoint = chatCompletionsUrl;
