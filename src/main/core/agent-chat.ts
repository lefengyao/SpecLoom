import { randomUUID } from "node:crypto";
import type { ModelProfile } from "../../shared/contracts";
import { AgentRuntime, type AgentMessage, type AgentRuntimeOptions } from "./agent-runtime";
import { WorkspaceTools } from "./tools/workspace-tools";
import { systemPrompt } from "./agent-prompts";
import { readProjectContext } from "./project-context";

export async function chatMessage(options: Pick<AgentRuntimeOptions, "resolveCredential" | "fetch" | "onDiagnostic"> & { workspaceRoot: string }, profile: ModelProfile, prompt: string, globalInstructions: string, workspaceInstructions = "", previousMessages: AgentMessage[] = [], signal?: AbortSignal) {
  const tools = new WorkspaceTools(options.workspaceRoot, `chat-${randomUUID()}`);
  const runtime = new AgentRuntime({
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.resolveCredential ? { resolveCredential: options.resolveCredential } : {}),
    ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
    catalog: tools.catalog,
    executeTool: call => tools.execute(call.name, call.input, call.signal, call.onProgress, call.redactText),
  });
  try { await tools.capabilities(signal); return await runtime.run({
    taskId: `chat-${randomUUID()}`, profile, prompt,
    systemPrompt: systemPrompt(globalInstructions, workspaceInstructions, undefined, await readProjectContext(options.workspaceRoot, !previousMessages.some(message => message.role === "assistant"))),
    ...(previousMessages.length ? { previousMessages } : {}),
    ...(signal ? { signal } : {}),
  }); } finally { await tools.close(); }
}
