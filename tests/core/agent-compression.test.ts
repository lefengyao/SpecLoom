import { describe, expect, test } from "vitest";
import { CompressionError, compressConversation, shouldCompress } from "../../src/main/core/agent-compression";
import { estimateConversationTokens } from "../../src/main/core/agent-client";
import type { AgentMessage } from "../../src/main/core/agent-client";

const user = (content: string): AgentMessage => ({ role: "user", content });
const assistant = (content: string): AgentMessage => ({ role: "assistant", content });
const tool = (id: string, content: string): AgentMessage => ({ role: "tool", content, tool_call_id: id, tool_name: "read" });
const call = (id: string): AgentMessage => ({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "read", arguments: "{}" } }] });

test("triggers at ninety percent of the effective input budget", () => {
  const messages = [user("x".repeat(1600))];
  const used = estimateConversationTokens(messages);
  const contextTokens = Math.floor(used / 0.9) + 1;
  expect(shouldCompress({ messages, contextTokens, outputTokens: 1, triggerRatio: 0.9 })).toBe(true);
  expect(shouldCompress({ messages, contextTokens, outputTokens: 1, triggerRatio: 0.91 })).toBe(false);
});

describe("compressConversation", () => {
  test("summarizes old groups while preserving the current goal and newest tool batch", async () => {
    const messages = [user("old goal"), assistant("old answer"), call("old-call"), tool("old-call", "old output"), user("current goal")];
    const result = await compressConversation({ messages, contextTokens: 1000, summarize: async ({ transcript }) => `summary:${transcript}` });
    expect(result.compressedGroups).toBe(1);
    expect(result.retained).toEqual([user("current goal")]);
    expect(result.summary).toContain("old goal");
  });

  test("splits oversized history into multiple summarizer requests", async () => {
    const calls: string[] = [];
    const messages = [user("a".repeat(10000)), assistant("b".repeat(10000)), user("current")];
    const result = await compressConversation({ messages, contextTokens: 2000, maxChunkTokens: 1000, summarize: async ({ transcript }) => { calls.push(transcript); return `chunk:${calls.length}`; } });
    expect(calls.length).toBeGreaterThan(1);
    expect(result.chunkCount).toBe(calls.length);
    expect(result.summary).toContain("chunk:");
  });

  test("includes an existing summary in the replacement summary", async () => {
    let transcript = "";
    const result = await compressConversation({ messages: [user("old"), user("current")], existingSummary: "previous summary", contextTokens: 1000, summarize: async input => { transcript = input.transcript; return "merged"; } });
    expect(transcript).toContain("previous summary");
    expect(result.summary).toBe("merged");
  });

  test("retains generated continuations after the anchored user goal", async () => {
    const current = user("current");
    const messages = [user("old"), current, assistant("tool response"), user("generated image receipt")];
    const result = await compressConversation({ messages, currentUserMessage: current, contextTokens: 1000, summarize: async () => "old summary" });
    expect(result.retained.map(message => message.content)).toEqual(["current", "tool response", "generated image receipt"]);
  });

  test("merges a large previous summary and chunk summaries within the per-request budget", async () => {
    const maxChunkTokens = 900;
    const transcripts: string[] = [];
    const result = await compressConversation({
      messages: [user("old facts ".repeat(6000)), user("current")],
      existingSummary: "durable-marker ".repeat(250),
      contextTokens: 5000,
      maxChunkTokens,
      summarize: async ({ transcript }) => {
        transcripts.push(transcript);
        expect(estimateConversationTokens([user(transcript)])).toBeLessThanOrEqual(maxChunkTokens);
        return `${transcript.includes("durable-marker") ? "durable-marker " : ""}${"facts ".repeat(60)}`;
      },
    });
    expect(transcripts.length).toBeGreaterThan(result.chunkCount);
    expect(result.summary).toContain("durable-marker");
    expect(estimateConversationTokens([user(result.summary)])).toBeLessThanOrEqual(599);
  });

  test("wraps errors from recursive reduction for runtime fallback", async () => {
    const failure = new Error("connection reset during summary merge");
    const pending = compressConversation({
      messages: [user("old facts"), user("current")], contextTokens: 1000,
      summarize: async ({ transcript }) => {
        if (transcript.startsWith("[history chunk]")) return "long summary ".repeat(80);
        throw failure;
      },
    });
    await expect(pending).rejects.toBeInstanceOf(CompressionError);
    await expect(pending).rejects.toMatchObject({ code: "CONTEXT_COMPRESSION_FAILED", cause: failure });
  });

  test("rejects an empty summary instead of discarding historical context", async () => {
    await expect(compressConversation({
      messages: [user("old facts"), user("current")], contextTokens: 1000,
      summarize: async () => "   ",
    })).rejects.toBeInstanceOf(CompressionError);
  });

  test("stops before a merge request when cancelled after a history summary", async () => {
    const controller = new AbortController();
    const reason = new Error("user cancelled compression");
    let calls = 0;
    await expect(compressConversation({
      messages: [user("old facts"), user("current")], contextTokens: 1000, signal: controller.signal,
      summarize: async () => {
        calls++;
        controller.abort(reason);
        return "long summary ".repeat(80);
      },
    })).rejects.toBe(reason);
    expect(calls).toBe(1);
  });

  test("keeps a fitting tool batch together when its surrounding turn is oversized", async () => {
    const transcripts: string[] = [];
    const output = `receipt-marker ${"r".repeat(400)}`;
    await compressConversation({
      messages: [user("x".repeat(800)), call("old-call"), tool("old-call", output), user("current")],
      contextTokens: 2000, maxChunkTokens: 600,
      summarize: async ({ transcript }) => { transcripts.push(transcript); return "old facts"; },
    });
    const toolTranscript = transcripts.find(transcript => transcript.includes("[assistant tool calls]"));
    expect(toolTranscript).toContain(output);
    expect(toolTranscript).toContain("old-call");
  });

  test("preserves assistant decisions attached to a tool call", async () => {
    const transcripts: string[] = [];
    await compressConversation({
      messages: [user("old"), { ...call("read-call"), content: "Keep the agreed schema" }, tool("read-call", "schema"), user("current")],
      contextTokens: 1000,
      summarize: async ({ transcript }) => { transcripts.push(transcript); return "old facts"; },
    });
    expect(transcripts.join("\n")).toContain("Keep the agreed schema");
  });

  test("labels fragments of a single oversized tool batch and keeps unicode intact", async () => {
    const transcripts: string[] = [];
    await compressConversation({
      messages: [user("old"), call("large-call"), tool("large-call", "😀".repeat(2000)), user("current")],
      contextTokens: 2000, maxChunkTokens: 600,
      summarize: async ({ transcript }) => { transcripts.push(transcript); return "old facts"; },
    });
    const fragments = transcripts.filter(transcript => transcript.includes("😀"));
    expect(fragments.length).toBeGreaterThan(1);
    for (const fragment of fragments) {
      expect(fragment).toContain("[partial history batch");
      expect(new TextDecoder().decode(new TextEncoder().encode(fragment))).toBe(fragment);
      expect(estimateConversationTokens([user(fragment)])).toBeLessThanOrEqual(600);
    }
  });

  test("compresses completed tool batches during a single long user turn", async () => {
    const current = user("Implement the agreed feature");
    const latestBatch = [call("new-call"), tool("new-call", "latest receipt")];
    const messages = [current, call("old-call"), tool("old-call", "old receipt ".repeat(300)), ...latestBatch];
    const transcripts: string[] = [];
    const result = await compressConversation({
      messages, currentUserMessage: current, contextTokens: 2000,
      summarize: async ({ transcript }) => { transcripts.push(transcript); return "earlier read facts"; },
    });
    expect(result.retained).toEqual([current, ...latestBatch]);
    expect(transcripts.join("\n")).toContain("old receipt");
    expect(transcripts.join("\n")).not.toContain("latest receipt");
    expect(result.summary).toContain("earlier read facts");
  });
});
