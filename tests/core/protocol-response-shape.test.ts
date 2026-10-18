import { describe, expect, it } from "vitest";
import type { Protocol } from "../../src/shared/contracts";
import { requestProtocolCompletion } from "../../src/main/core/protocols";

function completion(protocol: Protocol, body: unknown) {
  return requestProtocolCompletion({
    protocol, baseUrl: "https://model.test/v1", model: "fixture", messages: [], tools: [],
    secret: "fixture-secret", fetcher: async () => Response.json(body),
  });
}

const malformed: Array<[Protocol, string, unknown]> = [
  ["openai", "non-string answer", { choices: [{ message: { content: { text: "answer" } } }] }],
  ["openai", "non-array calls accompanying text", { choices: [{ message: { content: "answer", tool_calls: {} } }] }],
  ["openai", "non-string reasoning", { choices: [{ message: { content: "answer", reasoning_content: { text: "private" } } }] }],
  ["openai", "missing call ID", { choices: [{ message: { content: null, tool_calls: [{ type: "function", function: { name: "lookup", arguments: "{}" } }] } }] }],
  ["openai", "non-string call arguments", { choices: [{ message: { content: "answer", tool_calls: [{ id: "c", type: "function", function: { name: "lookup", arguments: {} } }] } }] }],
  ["anthropic", "numeric text", { content: [{ type: "text", text: 123 }] }],
  ["anthropic", "missing text accompanying a valid answer", { content: [{ type: "text", text: "answer" }, { type: "text" }] }],
  ["anthropic", "null block accompanying a valid answer", { content: [{ type: "text", text: "answer" }, null] }],
  ["anthropic", "missing call ID", { content: [{ type: "tool_use", name: "lookup", input: {} }] }],
  ["anthropic", "numeric call ID", { content: [{ type: "tool_use", id: 123, name: "lookup", input: {} }] }],
  ["anthropic", "missing call name", { content: [{ type: "tool_use", id: "c", input: {} }] }],
  ["anthropic", "array call input", { content: [{ type: "tool_use", id: "c", name: "lookup", input: [] }] }],
  ["anthropic", "null call input", { content: [{ type: "tool_use", id: "c", name: "lookup", input: null }] }],
  ["anthropic", "missing call input", { content: [{ type: "tool_use", id: "c", name: "lookup" }] }],
  ["anthropic", "malformed thinking accompanying a valid answer", { content: [{ type: "text", text: "answer" }, { type: "thinking", thinking: 123, signature: "sig" }] }],
  ["gemini", "numeric function name", { candidates: [{ content: { parts: [{ functionCall: { name: 123, args: {} } }] } }] }],
  ["gemini", "missing function name accompanying a valid answer", { candidates: [{ content: { parts: [{ text: "answer" }, { functionCall: { args: {} } }] } }] }],
  ["gemini", "array function args", { candidates: [{ content: { parts: [{ functionCall: { name: "lookup", args: [] } }] } }] }],
  ["gemini", "null function args", { candidates: [{ content: { parts: [{ functionCall: { name: "lookup", args: null } }] } }] }],
  ["gemini", "non-string text accompanying a valid answer", { candidates: [{ content: { parts: [{ text: "answer" }, { text: 123 }] } }] }],
  ["gemini", "non-boolean thought", { candidates: [{ content: { parts: [{ text: "answer", thought: "false" }] } }] }],
  ["gemini", "non-string thought signature", { candidates: [{ content: { parts: [{ functionCall: { name: "lookup", args: {} }, thoughtSignature: 123 }] } }] }],
];

describe("provider response shape validation", () => {
  it.each([ ["anthropic", false], ["anthropic", true], ["gemini", false], ["gemini", true] ] as const)("classifies deeply nested %s tool arguments as malformed (stream=%s)", async (protocol, stream) => {
    const nested = '{"x":'.repeat(12000) + '{}' + '}'.repeat(12000);
    const call = protocol === "anthropic" ? { type: "tool_use", id: "c", name: "lookup", input: "NESTED" } : { functionCall: { name: "lookup", args: "NESTED" } };
    const frame = protocol === "anthropic" ? (stream ? { type: "content_block_start", index: 0, content_block: call } : { content: [call] }) : { candidates: [{ content: { parts: [call] }, finishReason: "STOP" }] };
    const wire = JSON.stringify(frame).replace('"NESTED"', nested);
    const body = stream ? `data: ${wire}\n\ndata: [DONE]\n\n` : wire;
    await expect(requestProtocolCompletion({ protocol, baseUrl: "https://model.test/v1", model: "fixture", messages: [], tools: [],
      fetcher: async () => new Response(body, { headers: { "content-type": stream ? "text/event-stream" : "application/json" } }),
    })).rejects.toMatchObject({ code: "MODEL_ERROR", details: { reason: "response_parse_error" } });
  });
  it("classifies a headers callback failure as local processing and closes the body", async () => {
    let cancelled = false;
    await expect(requestProtocolCompletion({ protocol: "openai", baseUrl: "https://model.test/v1", model: "fixture", messages: [], tools: [],
      onWait: () => { throw new Error("local clock failed"); },
      fetcher: async () => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } })),
    })).rejects.toMatchObject({ code: "INTERNAL_ERROR", details: { reason: "response_consumer_error" } });
    expect(cancelled).toBe(true);
  });
  it.each(malformed)("classifies %s %s as recoverable before normalization", async (protocol, _label, body) => {
    await expect(completion(protocol, body)).rejects.toMatchObject({
      code: "MODEL_ERROR", details: { reason: "response_parse_error" },
    });
  });

  it.each(["openai", "anthropic", "gemini"] as const)("classifies a null %s JSON response as recoverable", async protocol => {
    await expect(completion(protocol, null)).rejects.toMatchObject({ code: "MODEL_ERROR", details: { reason: "response_parse_error" } });
  });

  it.each(["openai", "anthropic", "gemini"] as const)("preserves %s provider errors without requesting format repair", async protocol => {
    await expect(completion(protocol, { error: { message: "fixture-secret" } })).rejects.toMatchObject({
      code: "MODEL_ERROR", message: "The model returned an error.", details: undefined,
    });
  });

  it("preserves output-limit interruptions before validating malformed content", async () => {
    await expect(completion("openai", { choices: [{ finish_reason: "length", message: { content: 123 } }] }))
      .rejects.toMatchObject({ message: "The model output was interrupted.", details: undefined });
    await expect(completion("anthropic", { stop_reason: "max_tokens", content: [{ type: "text", text: 123 }] }))
      .rejects.toMatchObject({ message: "The model output limit interrupted the response.", details: undefined });
    await expect(completion("gemini", { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: 123 }] } }] }))
      .rejects.toMatchObject({ message: "The model output limit interrupted the response.", details: undefined });
  });

  it("retains signed Anthropic thinking and valid tool arguments", async () => {
    const thinking = { type: "thinking", thinking: "private", signature: "signature" };
    const redacted = { type: "redacted_thinking", data: "opaque" };
    const result = await completion("anthropic", { content: [thinking, redacted, { type: "text", text: "answer" },
      { type: "tool_use", id: "c", name: "lookup", input: { q: "x" } }] });
    expect(result.message.content).toBe("answer");
    expect(result.message.tool_calls).toEqual([{ id: "c", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } }]);
    expect(result.message.thinking_blocks).toEqual([thinking, redacted]);
    expect(result.thinkingBlocks).toEqual([thinking, redacted]);
  });

  it("retains Gemini thought signatures and permits omitted optional args", async () => {
    const result = await completion("gemini", { candidates: [{ content: { parts: [{ thought: true, text: "private" },
      { functionCall: { name: "lookup" }, thoughtSignature: "signature" }] } }] });
    expect(result.message.content).toBeNull();
    expect(result.message.tool_calls).toEqual([{ id: "call_0", type: "function", function: { name: "lookup", arguments: "{}" }, thought_signature: "signature" }]);
  });

  it("does not expose malformed payload or authentication secrets in parse errors", async () => {
    let failure: unknown;
    try { await completion("anthropic", { content: [{ type: "tool_use", id: { secret: "fixture-secret" }, name: "lookup", input: {} }] }); }
    catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "MODEL_ERROR", details: { reason: "response_parse_error" } });
    expect(JSON.stringify(failure)).not.toContain("fixture-secret");
  });
});
