import { expect, test, vi } from "vitest";
import { requestCompletion } from "../../src/main/core/agent-client";
import { AgentRuntime } from "../../src/main/core/agent-runtime";
import type { Protocol } from "../../src/shared/contracts";

const profile = { id: "fixture", name: "Fixture", provider: "openai-compatible" as const, model: "fixture",
  baseUrl: "https://model.test/v1", approved: true, timeoutMs: 1000, maxToolRounds: 1 };
const tool = { id: "c", type: "function", function: { name: "write", arguments: "{}" } };
function completion(protocol: Protocol, finishReason?: string | null) {
  if (protocol === "openai") return { choices: [{ message: { role: "assistant", content: "answer", tool_calls: [tool] }, ...(finishReason === undefined ? {} : { finish_reason: finishReason }) }] };
  if (protocol === "anthropic") return { content: [{ type: "text", text: "answer" }, { type: "tool_use", id: tool.id, name: tool.function.name, input: {} }], ...(finishReason === undefined ? {} : { stop_reason: finishReason }) };
  return { candidates: [{ content: { parts: [{ text: "answer" }, { functionCall: { name: tool.function.name, args: {} } }] }, ...(finishReason === undefined ? {} : { finishReason }) }] };
}

const interrupted: Array<[Protocol, string]> = [
  ["openai", "length"], ["openai", "content_filter"], ["anthropic", "max_tokens"], ["gemini", "MAX_TOKENS"],
  ["gemini", "SAFETY"], ["gemini", "RECITATION"], ["gemini", "BLOCKLIST"], ["gemini", "PROHIBITED_CONTENT"], ["gemini", "SPII"],
];
test.each(interrupted)("rejects %s JSON completion with %s before dispatching complete-looking tool calls", async (protocol, finishReason) => {
  const executeTool = vi.fn(async () => "should not run");
  const parseCall = vi.fn(() => ({ name: "write", input: {} }));
  const runtime = new AgentRuntime({ executeTool, catalog: { providerTools: () => [], parseCall },
    fetch: async () => Response.json(completion(protocol, finishReason)) });
  await expect(runtime.run({ taskId: "fixture", profile: { ...profile, protocol }, prompt: "hello" }))
    .rejects.toMatchObject({ code: "MODEL_ERROR" });
  expect(parseCall).not.toHaveBeenCalled();
  expect(executeTool).not.toHaveBeenCalled();
});

test("rejects Gemini promptFeedback blocking even if the body has completion content", async () => {
  const body = { ...completion("gemini", "STOP"), promptFeedback: { blockReason: "SAFETY" } };
  await expect(requestCompletion({ profile: { ...profile, protocol: "gemini" }, messages: [], tools: [], canRetry: false }, async () => Response.json(body)))
    .rejects.toMatchObject({ code: "MODEL_ERROR" });
});

test.each(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"])("rejects Gemini SSE completion blocked by %s before dispatching a tool", async reason => {
  const executeTool = vi.fn(async () => "should not run");
  const parseCall = vi.fn(() => ({ name: "write", input: {} }));
  const runtime = new AgentRuntime({ executeTool, catalog: { providerTools: () => [], parseCall }, onEvent: () => {},
    fetch: async () => new Response(`data: ${JSON.stringify(completion("gemini", reason))}\n\n`, { headers: { "content-type": "text/event-stream" } }) });
  await expect(runtime.run({ taskId: "fixture", profile: { ...profile, protocol: "gemini" }, prompt: "hello" }))
    .rejects.toMatchObject({ code: "MODEL_ERROR", message: "The model response was blocked." });
  expect(parseCall).not.toHaveBeenCalled();
  expect(executeTool).not.toHaveBeenCalled();
});

test("rejects Gemini SSE promptFeedback blocking with complete-looking content", async () => {
  const body = { ...completion("gemini", "STOP"), promptFeedback: { blockReason: "SAFETY" } };
  await expect(requestCompletion({ profile: { ...profile, protocol: "gemini" }, messages: [], tools: [], canRetry: false, onDelta: () => {} },
    async () => new Response(`data: ${JSON.stringify(body)}\n\n`, { headers: { "content-type": "text/event-stream" } })))
    .rejects.toMatchObject({ code: "MODEL_ERROR", message: "The model response was blocked." });
});

const completed: Array<[Protocol, string | null | undefined]> = [
  ["openai", "stop"], ["openai", "tool_calls"], ["openai", ""], ["openai", null], ["openai", undefined],
  ["anthropic", "end_turn"], ["anthropic", "tool_use"], ["anthropic", "stop_sequence"], ["anthropic", ""], ["anthropic", null], ["anthropic", undefined],
  ["gemini", "STOP"], ["gemini", "FINISH_REASON_UNSPECIFIED"], ["gemini", ""], ["gemini", null], ["gemini", undefined],
];
test.each(completed)("accepts normal %s JSON completion with reason %j", async (protocol, finishReason) => {
  const message = await requestCompletion({ profile: { ...profile, protocol }, messages: [], tools: [], canRetry: false }, async () => Response.json(completion(protocol, finishReason)));
  expect(message.content).toBe("answer");
  expect(message.tool_calls).toHaveLength(1);
});

test.each([5, 100000])("keeps %i characters of Gemini JSON thinking separate from the answer", async thinkingChars => {
  let thinking = "";
  const answer = "a".repeat(40000);
  const body = { candidates: [{ content: { parts: [{ thought: true, text: "t".repeat(thinkingChars) }, { text: answer }] }, finishReason: "STOP" }] };
  const message = await requestCompletion({ profile: { ...profile, protocol: "gemini" }, messages: [], tools: [], canRetry: false,
    onDelta(delta) { if (delta.type === "thinking-delta") thinking += delta.text; } }, async () => Response.json(body));
  expect(message.content).toBe(answer);
  expect(thinking).toBe("t".repeat(thinkingChars));
});
