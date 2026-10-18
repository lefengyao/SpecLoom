import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { ProjectError } from "./errors";
import type { RuntimeModelProfile } from "./model-config";
import { estimateTokens } from "./model-settings";
import type { ProviderTool } from "./tool-catalog";
import { requestProtocolCompletion } from "./protocols";
import type { CompletionDelta } from "./protocol-stream";
import type { DiagnosticTrace, DiagnosticEventWithoutId } from "../../shared/diagnostics";
import type { ContextCalibration } from "../../shared/chat";

export const ToolCallSchema = z.object({
  id: z.string().min(1).max(256), type: z.literal("function"),
  function: z.object({ name: z.string().min(1).max(128), arguments: z.string().max(524_288) }).strict(),
  thought_signature: z.string().max(65_536).optional(),
}).strict();
export type AgentToolCall = z.infer<typeof ToolCallSchema>;
export const MessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string().max(131_072).nullable(),
  images: z.array(z.object({ mimeType: z.string().min(1).max(128), base64: z.string().min(1).max(8_388_608) }).strict()).max(16).optional(),
  tool_calls: z.array(ToolCallSchema).max(16).optional(),
  tool_call_id: z.string().min(1).max(256).optional(),
  tool_name: z.string().min(1).max(128).optional(),
  reasoning_content: z.string().max(131_072).optional(),
  thinking_blocks: z.array(z.unknown()).max(64).optional(),
}).strict();
export type AgentMessage = z.infer<typeof MessageSchema>;
export interface CompletionRequest {
  profile: RuntimeModelProfile; messages: AgentMessage[]; tools: ProviderTool[];
  secret?: string; signal?: AbortSignal; canRetry: boolean;
  onDelta?: (delta: CompletionDelta) => void | Promise<void>;
  onUsage?: (usage: { promptTokens: number; completionTokens: number; cachedTokens: number; cacheWriteTokens: number }) => void | Promise<void>;
  diagnostics?: DiagnosticTrace;
  inputTokensEstimate?: number;
}

/** Uses the same conservative estimate as context fitting before reserving output. */
export function estimateConversationTokens(messages: AgentMessage[], tools: ProviderTool[] = []): number {
  const textMessages = messages.map(({ images, ...message }) => ({
    ...message,
    ...(images?.length ? { imageCount: images.length } : {}),
  }));
  return estimateTokens(JSON.stringify({ messages: textMessages, tools }))
    + messages.reduce((sum, message) => sum + (message.images?.length ?? 0) * 1024, 0);
}

/** Adjust the current raw estimate using the latest request to this exact profile/model. */
export function calibratedInputTokens(estimated: number, profile: Pick<RuntimeModelProfile, "id" | "model">, calibration?: ContextCalibration): number {
  if (!calibration || calibration.profileId !== profile.id || calibration.model !== profile.model
    || !Number.isSafeInteger(calibration.actualInputTokens) || calibration.actualInputTokens <= 0
    || !Number.isSafeInteger(calibration.estimatedInputTokens) || calibration.estimatedInputTokens <= 0) return estimated;
  return Math.max(0, Math.ceil(calibration.actualInputTokens + estimated - calibration.estimatedInputTokens));
}

/**
 * StoryFabric baseline: the configured output limit is reserved against the locally
 * estimated context usage, so a request never promises more output than the model's
 * context window can still hold. Image payload bytes are represented by a fixed cost.
 */
export function reservedOutputTokens(profile: RuntimeModelProfile, messages: AgentMessage[], tools: ProviderTool[] = [], inputTokensEstimate?: number): number | undefined {
  const configuredOutput = profile.maxOutputTokens;
  if (profile.contextTokens === undefined) return configuredOutput;
  const estimated = inputTokensEstimate ?? estimateConversationTokens(messages, tools);
  const available = Math.min(configuredOutput ?? 8192, profile.contextTokens - estimated);
  // The caller rejects an exhausted context before sending; a non-positive limit is not sendable.
  return available > 0 ? available : undefined;
}

export async function requestCompletion(input: CompletionRequest, fetcher: typeof fetch = fetch): Promise<AgentMessage> {
  const controller = new AbortController();
  const signal = input.signal ? AbortSignal.any([controller.signal, input.signal]) : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Bound waiting for headers or the next body chunk, allowing active reasoning
  // streams to finish and excluding local UI/history persistence from network time.
  const onWait = (waiting: boolean) => {
    clearTimeout(timer); timer = undefined;
    if (waiting && !signal.aborted) timer = setTimeout(() => controller.abort(), input.profile.timeoutMs);
  };
  const reservedOutput = reservedOutputTokens(input.profile, input.messages, input.tools, input.inputTokensEstimate);
  if (input.profile.contextTokens !== undefined && reservedOutput === undefined) {
    throw new ProjectError("MODEL_ERROR", "The current prompt does not fit the model context window.");
  }
  try {
    for (let attempt = 0; attempt <= (input.canRetry ? 2 : 0); attempt++) {
      signal.throwIfAborted();
      const attemptNumber = input.diagnostics?.nextAttempt();
      const startedAt = Date.now();
      const record = (event: Omit<DiagnosticEventWithoutId, "attempt">) => input.diagnostics?.record({
        ...event,
        ...(attemptNumber === undefined ? {} : { attempt: attemptNumber }),
      });
      await record({ type: "request_started" });
      onWait(true);
      const protocol = input.profile.protocol ?? "openai";
      const profile = input.profile;
      try {
        const result = await requestProtocolCompletion({
          protocol,
          baseUrl: profile.baseUrl,
          model: profile.model,
          messages: input.messages,
          tools: input.tools,
          ...(input.secret === undefined ? {} : { secret: input.secret }),
          fetcher,
          onWait,
          ...(input.onDelta ? { onDelta: input.onDelta } : {}),
          ...(input.diagnostics ? { onDiagnostic: (event: Omit<DiagnosticEventWithoutId, "attempt">) => input.diagnostics!.record({
            ...event, ...(attemptNumber === undefined ? {} : { attempt: attemptNumber }),
          }) } : {}),
          ...(signal ? { signal } : {}),
          settings: {
            ...(profile.reasoningSupport === undefined ? {} : { reasoningSupport: profile.reasoningSupport }),
            ...(profile.reasoning === undefined ? {} : { reasoning: profile.reasoning }),
            ...(profile.reasoningMap === undefined ? {} : { reasoningMap: profile.reasoningMap }),
            ...(profile.vision === undefined ? {} : { vision: profile.vision }),
            ...(profile.temperature === undefined ? {} : { temperature: profile.temperature }),
            ...(reservedOutput === undefined ? {} : { maxOutputTokens: reservedOutput }),
          },
        });
        const parsed = MessageSchema.safeParse(result.message);
        if (!parsed.success) throw new ProjectError("MODEL_ERROR", "The model returned a malformed completion.", { reason: "response_parse_error" });
        const ids = new Set(parsed.data.tool_calls?.map((call) => call.id));
        if (ids.size !== (parsed.data.tool_calls?.length ?? 0)) throw new ProjectError("MODEL_ERROR", "The model returned duplicate tool-call IDs.", { reason: "response_parse_error" });
        if (!parsed.data.content && !parsed.data.tool_calls?.length) throw new ProjectError("MODEL_ERROR", "The model returned an empty completion.", { reason: "response_parse_error" });
        await record({ type: "request_completed", elapsedMs: Math.max(0, Date.now() - startedAt) });
        if (result.usage) await input.onUsage?.(result.usage);
        return parsed.data;
      } catch (error) {
        if (error instanceof ProjectError) {
          if (error.details?.reason === "response_parse_error") {
            await record({ type: "protocol_parse_error", errorCategory: "response_parse_error" });
          }
          const status = typeof error.details?.status === "number" ? error.details.status : undefined;
          const transient = status === 429 || (status !== undefined && status >= 500);
          if (transient && input.canRetry && attempt < 2) {
            await record({ type: "retry_scheduled", errorCategory: "http_error", status, retryLimitReached: false });
            await delay(100 * 2 ** attempt, undefined, { signal }); continue;
          }
          throw error;
        }
        throw new ProjectError("MODEL_ERROR", "The model connection failed.");
      }
    }
    throw new ProjectError("MODEL_ERROR", "The model retry limit was reached.");
  } catch (error) {
    if (input.signal?.aborted) throw new ProjectError("MODEL_ERROR", "The agent run was cancelled.");
    if (controller.signal.aborted) throw new ProjectError("MODEL_ERROR", `The model request timed out after ${input.profile.timeoutMs / 1000} seconds without response data.`, { reason: "idle_timeout", timeoutMs: input.profile.timeoutMs });
    if (error instanceof ProjectError) throw error;
    throw new ProjectError("MODEL_ERROR", "The model connection failed.");
  } finally { onWait(false); }
}
