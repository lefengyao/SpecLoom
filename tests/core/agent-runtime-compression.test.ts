import { expect, test } from "vitest";
import { AgentRuntime, noToolsCatalog } from "../../src/main/core/agent-runtime";
import { estimateConversationTokens } from "../../src/main/core/agent-client";

const profile = {
  id: "compression-fixture", name: "Compression fixture", provider: "openai-compatible" as const,
  protocol: "openai" as const, model: "fixture", baseUrl: "https://model.test/v1", approved: true,
  timeoutMs: 1000, maxToolRounds: 3, contextTokens: 4096, maxOutputTokens: 256,
};

test("compresses at the context threshold and reuses the active model summary", async () => {
  const bodies: Array<{ messages: Array<{ role: string; content?: unknown }> }> = [];
  const checkpoints: Array<{ summary?: string }> = [];
  const runtime = new AgentRuntime({
    catalog: noToolsCatalog,
    executeTool: async () => undefined,
    onConversation: (_messages, contextSummary) => { checkpoints.push({ ...(contextSummary === undefined ? {} : { summary: contextSummary }) }); },
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content?: unknown }> };
      bodies.push(body);
      const isSummary = body.messages[0]?.role === "system" && String(body.messages[0]?.content).startsWith("Summarize");
      return Response.json({ choices: [{ message: isSummary
        ? { role: "assistant", content: "Old decisions and test facts" }
        : { role: "assistant", content: "completed with compressed context" } }] });
    },
  });
  const old = { role: "user" as const, content: "old implementation facts ".repeat(1800) };
  const result = await runtime.run({ taskId: "compression", profile, prompt: "Continue from the retained context", previousMessages: [old] });
  expect(result.summary).toBe("completed with compressed context");
  expect(result.contextSummary).toContain("Old decisions");
  expect(bodies.some(body => body.messages[0]?.role === "system" && String(body.messages[0]?.content).startsWith("Summarize"))).toBe(true);
  const main = bodies.at(-1)!;
  expect(String(main.messages[0]?.content)).toContain("Old decisions and test facts");
  expect(JSON.stringify(main)).not.toContain("old implementation facts");
  expect(checkpoints.some(checkpoint => checkpoint.summary?.includes("Old decisions"))).toBe(true);
});

test("falls back to normal fitting when the active model cannot summarize", async () => {
  let calls = 0;
  const runtime = new AgentRuntime({
    catalog: noToolsCatalog,
    executeTool: async () => undefined,
    fetch: async () => {
      calls++;
      if (calls === 1) return Response.json({ choices: [{ message: { role: "assistant", tool_calls: [{ id: "bad", type: "function", function: { name: "unexpected", arguments: "{}" } }] } }] });
      return Response.json({ choices: [{ message: { role: "assistant", content: "continued after fallback" } }] });
    },
  });
  const result = await runtime.run({ taskId: "fallback", profile: { ...profile, contextTokens: estimateConversationTokens([{ role: "user", content: "current" }]) + 512 }, prompt: "current", previousMessages: [{ role: "user", content: "old ".repeat(3000) }] });
  expect(result.summary).toBe("continued after fallback");
  expect(calls).toBe(2);
  expect(result.contextSummary).toBeUndefined();
});

test("continues the main request when a later summary merge loses its connection", async () => {
  let historySummaries = 0;
  let mergeRequests = 0;
  const activity: string[] = [];
  const runtime = new AgentRuntime({
    catalog: noToolsCatalog, executeTool: async () => undefined,
    onEvent: event => { if (event.type === "activity") activity.push(event.content); },
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      if (body.messages[0]?.content.startsWith("Summarize")) {
        if (body.messages[1]?.content.startsWith("[summary merge]")) {
          mergeRequests++;
          throw new TypeError("summary connection reset");
        }
        historySummaries++;
        return Response.json({ choices: [{ message: { role: "assistant", content: "history fact ".repeat(80) } }] });
      }
      return Response.json({ choices: [{ message: { role: "assistant", content: "continued after merge fallback" } }] });
    },
  });
  const result = await runtime.run({
    taskId: "merge-fallback", profile, prompt: "current",
    previousMessages: [{ role: "user", content: "old ".repeat(2000) }],
  });
  expect(historySummaries).toBeGreaterThan(1);
  expect(mergeRequests).toBe(1);
  expect(result.summary).toBe("continued after merge fallback");
  expect(result.contextSummary).toBeUndefined();
  expect(activity).toContain("上下文压缩失败，已使用历史裁剪继续");
});

test("compresses older completed tools before a single running turn exhausts its window", async () => {
  const mainRequests: Array<Array<{ role: string; content: string | null; tool_calls?: unknown[] }>> = [];
  let summaries = 0;
  const runtime = new AgentRuntime({
    catalog: { providerTools: () => [], parseCall: name => ({ name, input: {} }) },
    executeTool: async () => "old completed receipt ".repeat(75),
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string | null; tool_calls?: unknown[] }> };
      if (body.messages[0]?.role === "system" && body.messages[0].content?.startsWith("Summarize")) {
        summaries++;
        return Response.json({ choices: [{ message: { role: "assistant", content: "Earlier read results and agreed decisions" } }] });
      }
      mainRequests.push(body.messages);
      const index = mainRequests.length;
      return Response.json({ choices: [{ message: index <= 5
        ? { role: "assistant", content: null, tool_calls: [{ id: `call-${index}`, type: "function", function: { name: "read", arguments: "{}" } }] }
        : { role: "assistant", content: "finished the long task" } }] });
    },
  });
  const result = await runtime.run({ taskId: "long-tools", profile, prompt: "Implement the agreed feature" });
  expect(result.summary).toBe("finished the long task");
  expect(summaries).toBeGreaterThan(0);
  const finalRequest = mainRequests.at(-1)!;
  expect(finalRequest).toContainEqual({ role: "user", content: "Implement the agreed feature" });
  expect(finalRequest[0]?.content).toContain("Earlier read results and agreed decisions");
  expect(finalRequest.filter(message => message.role === "tool").length).toBeLessThan(5);
  expect(finalRequest.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call-5" });
});
