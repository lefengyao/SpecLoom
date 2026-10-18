import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { SessionRuns } from "../../src/main/core/session-runs";
import { SessionStore } from "../../src/main/core/session-store";
import { estimateTokens } from "../../src/main/core/model-settings";
import { AgentRuntime } from "../../src/main/core/agent-runtime";
import type { ChatItem } from "../../src/shared/chat";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test("persists assistant response timing and output metrics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-response-metrics-")); roots.push(root);
  const store = await SessionStore.open(root); const session = await store.create("metrics"); const runs = new SessionRuns(store, root);
  const clock = vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(1_100).mockReturnValueOnce(1_600).mockReturnValueOnce(2_100);
  const execute = runs.executor(async (options) => {
    await options.onEvent?.({ type: "thinking", round: 0, messageId: "thinking", content: "checking" });
    await options.onEvent?.({ type: "text", round: 0, messageId: "answer", content: "done" });
    return { summary: "done", toolCalls: 0, rounds: 0, messages: [{ role: "assistant", content: "done" }], usage: { promptTokens: 5, completionTokens: 20, cachedTokens: 0, cacheWriteTokens: 0 } };
  });

  await runs.send(session.id, "hello", execute);
  const assistant = store.get(session.id).items.find((item) => item.kind === "message" && item.role === "assistant");
  expect(assistant?.kind === "message" && assistant.metrics).toEqual({ firstTokenMs: 100, thinkingMs: 500, outputTokens: 20, outputRate: 20, durationMs: 1_100 });
  expect(clock).toHaveBeenCalledTimes(4);
  const reopened = await SessionStore.open(root);
  const restored = reopened.get(session.id).items.find((item) => item.kind === "message" && item.role === "assistant");
  expect(restored?.kind === "message" && restored.metrics?.outputTokens).toBe(20);
});

test("uses a bounded local estimate when provider usage is missing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-response-metrics-")); roots.push(root);
  const store = await SessionStore.open(root); const session = await store.create("estimate"); const runs = new SessionRuns(store, root);
  vi.spyOn(Date, "now").mockReturnValueOnce(2_000).mockReturnValueOnce(2_010);
  const execute = runs.executor(async () => ({ summary: "abc", toolCalls: 0, rounds: 0, messages: [{ role: "assistant", content: "abc" }] }));
  await runs.send(session.id, "hello", execute);
  const assistant = store.get(session.id).items.find((item) => item.kind === "message" && item.role === "assistant");
  expect(assistant?.kind === "message" && assistant.metrics?.outputTokens).toBe(estimateTokens("abc"));
  expect(assistant?.kind === "message" && assistant.metrics && Number.isFinite(assistant.metrics.outputRate)).toBe(true);
});

test.each([false, true])("keeps public progress and tool order while attaching metrics only to the final reply (stream=%s)", async streaming => {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-progress-metrics-")); roots.push(root);
  const store = await SessionStore.open(root); const session = await store.create("progress"); const runs = new SessionRuns(store, root);
  const prior = await runs.send(session.id, "之前的问题", async () => ({ summary: "之前的回复", toolCalls: 0, rounds: 0, messages: [{ role: "assistant", content: "之前的回复" }] }));
  const previousReply = prior.items.find(item => item.kind === "message" && item.role === "assistant");
  const contents = ["先核对玩家脚本，确认移动速度的来源。", "已确认速度定义，接下来检查输入处理。", "已完成检查，输入处理符合预期。"];
  let requests = 0;
  const saved = await runs.send(session.id, "检查移动逻辑", options => new AgentRuntime({ ...options,
    catalog: { providerTools: () => [], parseCall: name => ({ name, input: {} }) },
    executeTool: async () => "检查完成",
    fetch: async () => {
      const round = requests++; const content = contents[round]!;
      const call = { id: `read-${round}`, type: "function", function: { name: "Read", arguments: "{}" } };
      if (!streaming) return Response.json({ choices: [{ message: { role: "assistant", content, ...(round < 2 ? { tool_calls: [call] } : {}) } }] });
      const frames = [
        { choices: [{ delta: { content: content.slice(0, 4) } }] },
        { choices: [{ delta: { content: content.slice(4) } }] },
        ...(round < 2 ? [{ choices: [{ delta: { tool_calls: [{ ...call, index: 0 }] } }] }] : []),
        { choices: [{ delta: {}, finish_reason: round < 2 ? "tool_calls" : "stop" }] },
      ];
      return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    },
  }).run({ taskId: "progress", profile: { id: "test", name: "test", model: "test", provider: "openai-compatible", protocol: "openai", approved: true, baseUrl: "http://model.test/v1", timeoutMs: 15000, maxToolRounds: 3 }, prompt: options.prompt, previousMessages: options.previousMessages, signal: options.signal }));
  const currentItems = saved.items.filter(item => item.id.startsWith(`${saved.runId}:`));
  expect(currentItems.map(item => item.kind === "message" ? item.content : item.kind === "tool" ? item.callId : item.kind)).toEqual([
    "检查移动逻辑", contents[0], "read-0", contents[1], "read-1", contents[2],
  ]);
  const replies = currentItems.filter((item): item is Extract<ChatItem, { kind: "message" }> => item.kind === "message" && item.role === "assistant");
  expect(replies).toHaveLength(3);
  expect(replies.every(item => !item.partial)).toBe(true);
  expect(replies.filter(item => item.metrics)).toHaveLength(1);
  expect(replies.at(-1)?.metrics).toBeDefined();
  expect(saved.items.find(item => item.id === previousReply?.id)).toEqual(previousReply);
  const reopened = await SessionStore.open(root);
  expect(reopened.get(session.id).items).toEqual(saved.items);
});
