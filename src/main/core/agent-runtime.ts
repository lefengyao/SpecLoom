import { z } from "zod";
import type { ModelProfile } from "../../shared/contracts";
import { MessageSchema, requestCompletion, type AgentMessage } from "./agent-client";
import { redactSecret, toolOutput } from "./agent-output";
import { ProjectError, serializeError } from "./errors";
import { parseModelProfile } from "./model-config";
import { ToolCatalog, type ToolName } from "./tool-catalog";

export { chatCompletionsUrl } from "./model-config";
export type { AgentMessage } from "./agent-client";
export interface ToolExecution { taskId: string; name: ToolName; input: Record<string, unknown>; signal?: AbortSignal }
export type ToolExecutor = (call: ToolExecution) => Promise<unknown>;
export type AgentEvent =
  | { type: "request"; round: number }
  | { type: "tool-start"; round: number; toolCallId: string; name: ToolName }
  | { type: "tool-result"; round: number; toolCallId: string; name?: ToolName; output: string; ok: boolean }
  | { type: "summary"; summary: string; toolCalls: number };
export interface AgentRuntimeOptions {
  executeTool: ToolExecutor;
  resolveCredential?: (profile: ModelProfile) => Promise<string | undefined>;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  fetch?: typeof fetch;
  catalog?: ToolCatalog;
}
export interface AgentRunInput {
  taskId: string; profile: ModelProfile; prompt: string; systemPrompt?: string;
  previousMessages?: AgentMessage[]; signal?: AbortSignal;
}
export interface AgentRunResult { summary: string; toolCalls: number; rounds: number; messages: AgentMessage[] }

const RunInputSchema = z.object({
  taskId: z.string().min(1).max(256), prompt: z.string().min(1).max(131_072),
  systemPrompt: z.string().max(65_536).optional(), previousMessages: z.array(MessageSchema).max(96).optional(),
});

export class AgentRuntime {
  private readonly catalog: ToolCatalog;

  constructor(private readonly options: AgentRuntimeOptions) { this.catalog = options.catalog ?? new ToolCatalog(); }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const profile = parseModelProfile(input.profile);
    if (!profile.approved) throw new ProjectError("APPROVAL_REQUIRED", "Approve the model profile and endpoint before running an agent.");
    const validation = RunInputSchema.safeParse(input);
    if (!validation.success || JSON.stringify(validation.data.previousMessages ?? []).length > 262_144) {
      throw new ProjectError("MODEL_ERROR", "Invalid or oversized agent conversation.");
    }
    this.assertActive(input.signal);
    const secret = await this.options.resolveCredential?.(profile);
    const messages: AgentMessage[] = [
      ...(input.systemPrompt ? [{ role: "system" as const, content: input.systemPrompt }] : []),
      ...(validation.data.previousMessages ?? []), { role: "user", content: input.prompt },
    ];
    let toolCalls = 0;
    let toolRounds = 0;
    let dispatched = false;
    while (true) {
      this.assertActive(input.signal);
      await this.emit({ type: "request", round: toolRounds });
      const message = await requestCompletion({ profile, messages, tools: this.catalog.providerTools(),
        ...(secret === undefined ? {} : { secret }), ...(input.signal ? { signal: input.signal } : {}), canRetry: !dispatched }, this.options.fetch);
      this.assertActive(input.signal);
      messages.push(message);
      if (!message.tool_calls?.length) {
        const summary = redactSecret(message.content ?? "", secret);
        await this.emit({ type: "summary", summary, toolCalls });
        return { summary, toolCalls, rounds: toolRounds,
          messages: messages.map((item) => ({ ...item, content: item.content === null ? null : redactSecret(item.content, secret),
            ...(item.tool_call_id ? { tool_call_id: redactSecret(item.tool_call_id, secret) } : {}),
            ...(item.tool_calls ? { tool_calls: item.tool_calls.map((call) => ({ ...call, id: redactSecret(call.id, secret), function: {
              name: redactSecret(call.function.name, secret), arguments: redactSecret(call.function.arguments, secret),
            } })) } : {}),
          })) };
      }
      if (toolRounds >= profile.maxToolRounds) throw new ProjectError("MODEL_ERROR", "The agent tool round limit was reached.");
      toolRounds++;
      for (const call of message.tool_calls) {
        this.assertActive(input.signal);
        let name: ToolName | undefined;
        let ok = false;
        let output: string;
        try {
          const parsed = this.catalog.parseCall(call.function.name, call.function.arguments);
          name = parsed.name;
          await this.emit({ type: "tool-start", round: toolRounds, toolCallId: redactSecret(call.id, secret), name });
          this.assertActive(input.signal);
          dispatched = true;
          toolCalls++;
          const result = await this.options.executeTool({ taskId: input.taskId, name, input: parsed.input, ...(input.signal ? { signal: input.signal } : {}) });
          this.assertActive(input.signal);
          ok = true;
          output = toolOutput(true, result, secret);
        } catch (error) {
          this.assertActive(input.signal);
          output = toolOutput(false, serializeError(error), secret);
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: output });
        await this.emit({ type: "tool-result", round: toolRounds, toolCallId: redactSecret(call.id, secret), ...(name ? { name } : {}), output, ok });
      }
      if (messages.length > 640 || JSON.stringify(messages).length > 2_097_152) throw new ProjectError("MODEL_ERROR", "The agent conversation size limit was reached.");
    }
  }

  private assertActive(signal?: AbortSignal): void {
    if (signal?.aborted) throw new ProjectError("MODEL_ERROR", "The agent run was cancelled.");
  }

  private async emit(event: AgentEvent): Promise<void> { await this.options.onEvent?.(event); }
}
