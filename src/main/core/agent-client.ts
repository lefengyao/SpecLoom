import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { ProjectError } from "./errors";
import { chatCompletionsUrl } from "./model-config";
import type { ModelProfile } from "../../shared/contracts";
import type { ProviderTool } from "./tool-catalog";

export const ToolCallSchema = z.object({
  id: z.string().min(1).max(256), type: z.literal("function"),
  function: z.object({ name: z.string().min(1).max(128), arguments: z.string().max(524_288) }).strict(),
}).strict();
export type AgentToolCall = z.infer<typeof ToolCallSchema>;
export const MessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string().max(131_072).nullable(),
  tool_calls: z.array(ToolCallSchema).max(16).optional(),
  tool_call_id: z.string().min(1).max(256).optional(),
}).strict();
export type AgentMessage = z.infer<typeof MessageSchema>;
const ResponseSchema = z.object({ choices: z.array(z.object({ message: z.object({
  role: z.literal("assistant"), content: z.string().max(131_072).nullable().optional(),
  tool_calls: z.array(ToolCallSchema).max(16).optional(),
}) })).min(1).max(16) });

async function boundedBody(response: Response): Promise<string> {
  if (!response.body) throw new ProjectError("MODEL_ERROR", "The model returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 1_048_576) {
        await reader.cancel();
        throw new ProjectError("MODEL_ERROR", "The model response exceeded the size limit.");
      }
      chunks.push(Buffer.from(chunk.value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}

export interface CompletionRequest {
  profile: ModelProfile; messages: AgentMessage[]; tools: ProviderTool[];
  secret?: string; signal?: AbortSignal; canRetry: boolean;
}

export async function requestCompletion(input: CompletionRequest, fetcher: typeof fetch = fetch): Promise<AgentMessage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.profile.timeoutMs);
  const signal = input.signal ? AbortSignal.any([controller.signal, input.signal]) : controller.signal;
  try {
    for (let attempt = 0; attempt <= (input.canRetry ? 2 : 0); attempt++) {
      signal.throwIfAborted();
      const response = await fetcher(chatCompletionsUrl(input.profile.baseUrl), {
        method: "POST", redirect: "error", signal,
        headers: { "Content-Type": "application/json", ...(input.secret ? { Authorization: `Bearer ${input.secret}` } : {}) },
        body: JSON.stringify({ model: input.profile.model, messages: input.messages, tools: input.tools, tool_choice: "auto",
          ...(input.profile.temperature === undefined ? {} : { temperature: input.profile.temperature }),
          ...(input.profile.maxOutputTokens === undefined ? {} : { max_tokens: input.profile.maxOutputTokens }),
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        const transient = response.status === 429 || response.status >= 500;
        if (transient && input.canRetry && attempt < 2) { await delay(100 * 2 ** attempt, undefined, { signal }); continue; }
        throw new ProjectError("MODEL_ERROR", `The model request failed with HTTP ${response.status}.`);
      }
      let parsed: unknown;
      try { parsed = JSON.parse(await boundedBody(response)); }
      catch (error) {
        if (signal.aborted || error instanceof ProjectError) throw error;
        throw new ProjectError("MODEL_ERROR", "The model returned invalid JSON.");
      }
      const result = ResponseSchema.safeParse(parsed);
      if (!result.success) throw new ProjectError("MODEL_ERROR", "The model returned a malformed completion.");
      const message = result.data.choices[0]!.message;
      if (!message.content && !message.tool_calls?.length) throw new ProjectError("MODEL_ERROR", "The model returned an empty completion.");
      const ids = new Set(message.tool_calls?.map((call) => call.id));
      if (ids.size !== (message.tool_calls?.length ?? 0)) throw new ProjectError("MODEL_ERROR", "The model returned duplicate tool-call IDs.");
      return { role: "assistant", content: message.content ?? null, ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}) };
    }
    throw new ProjectError("MODEL_ERROR", "The model retry limit was reached.");
  } catch (error) {
    if (input.signal?.aborted) throw new ProjectError("MODEL_ERROR", "The agent run was cancelled.");
    if (controller.signal.aborted) throw new ProjectError("MODEL_ERROR", "The model request timed out.");
    if (error instanceof ProjectError) throw error;
    throw new ProjectError("MODEL_ERROR", "The model connection failed.");
  } finally { clearTimeout(timer); }
}
