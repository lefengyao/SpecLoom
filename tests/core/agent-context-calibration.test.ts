import { expect, test } from "vitest";
import { AgentRuntime, noToolsCatalog, fitConversationContext } from "../../src/main/core/agent-runtime";
import { calibratedInputTokens, estimateConversationTokens, reservedOutputTokens, type AgentMessage } from "../../src/main/core/agent-client";
import { compressConversation, conversationStorageSize, shouldCompress } from "../../src/main/core/agent-compression";
import { requestProtocolCompletion } from "../../src/main/core/protocols";

const profile = { id: "calibration", name: "Calibration", provider: "openai-compatible" as const, protocol: "openai" as const, model: "fixture", baseUrl: "https://model.test/v1", approved: true, timeoutMs: 1000, contextTokens: 10000, maxOutputTokens: 1000 };
const user = (content: string): AgentMessage => ({ role: "user", content });
const assistant = (content: string): AgentMessage => ({ role: "assistant", content });

test("reuses a matching request calibration and stores the next single-request sample", async () => {
  const previousMessages = [user("previous"), assistant("answer")];
  const initial = [...previousMessages, user("continue")];
  const raw = estimateConversationTokens(initial);
  const checkpoints: Array<{ estimate?: number; calibration?: unknown }> = [];
  const runtime = new AgentRuntime({ catalog: noToolsCatalog, executeTool: async () => undefined,
    onConversation: (_messages, _summary, estimate, calibration) => { checkpoints.push({ ...(estimate === undefined ? {} : { estimate }), ...(calibration ? { calibration } : {}) }); },
    fetch: async () => Response.json({ choices: [{ message: assistant("done") }], usage: { prompt_tokens: 750, completion_tokens: 4 } }),
  });
  const result = await runtime.run({ taskId: "calibrate", profile, prompt: "continue", previousMessages,
    contextCalibration: { profileId: profile.id, model: profile.model, estimatedInputTokens: raw - 20, actualInputTokens: 500 } });
  expect(checkpoints[0]?.estimate).toBe(520);
  expect(result.contextCalibration).toEqual({ profileId: profile.id, model: profile.model, estimatedInputTokens: raw, actualInputTokens: 750 });
  expect(result.contextTokensEstimate).toBe(750 + estimateConversationTokens([...initial, assistant("done")]) - raw);
  expect(checkpoints.at(-1)?.calibration).toEqual(result.contextCalibration);
});

test("ignores samples belonging to a different model or profile", async () => {
  for (const sample of [{ profileId: "other", model: profile.model }, { profileId: profile.id, model: "other" }]) {
    const estimates: number[] = [];
    const runtime = new AgentRuntime({ catalog: noToolsCatalog, executeTool: async () => undefined,
      onConversation: (_messages, _summary, estimate) => { if (estimate !== undefined) estimates.push(estimate); },
      fetch: async () => Response.json({ choices: [{ message: assistant("done") }] }),
    });
    const result = await runtime.run({ taskId: "stale", profile, prompt: "continue", contextCalibration: { ...sample, estimatedInputTokens: 1, actualInputTokens: 9000 } });
    expect(estimates[0]).toBe(estimateConversationTokens([user("continue")]));
    expect(result.contextCalibration).toBeUndefined();
  }
});

test("keeps latest input calibration separate from cumulative tool-round usage", async () => {
  const notified: number[] = [];
  let requests = 0;
  const runtime = new AgentRuntime({ catalog: { providerTools: () => [], parseCall: name => ({ name, input: {} }) }, executeTool: async () => "receipt",
    onUsage: usage => { notified.push(usage.promptTokens); },
    fetch: async () => {
      requests++;
      return Response.json({ choices: [{ message: requests === 1 ? { role: "assistant", content: null, tool_calls: [{ id: "call", type: "function", function: { name: "read", arguments: "{}" } }] } : assistant("done") }], usage: { prompt_tokens: requests * 1000, completion_tokens: 10 } });
    },
  });
  const result = await runtime.run({ taskId: "rounds", profile, prompt: "continue" });
  expect(notified).toEqual([1000, 2000]);
  expect(result.usage?.promptTokens).toBe(3000);
  expect(result.contextCalibration?.actualInputTokens).toBe(2000);
  expect(result.contextTokensEstimate).toBeLessThan(2200);
});

test("uses calibrated estimates for compression, fitting and protocol output headroom", async () => {
  const current = user("current");
  const messages = [user("old"), assistant("answer"), current];
  const estimate = (candidate: AgentMessage[]) => candidate.includes(messages[0]!) ? 9500 : 1500;
  expect(shouldCompress({ messages, contextTokens: 10000, outputTokens: 1000, estimate })).toBe(true);
  expect(fitConversationContext(messages, 10000, 1000, [], current, estimate)).toEqual([current]);
  expect(reservedOutputTokens({ ...profile, maxOutputTokens: 2000 }, messages, [], 9500)).toBe(500);
  let body: { max_tokens?: number } | undefined;
  const runtime = new AgentRuntime({ catalog: noToolsCatalog, executeTool: async () => undefined,
    fetch: async (_url, init) => { body = JSON.parse(String(init?.body)) as { max_tokens?: number }; return Response.json({ choices: [{ message: assistant("done") }] }); },
  });
  await runtime.run({ taskId: "headroom", profile: { ...profile, contextTokens: 2000, maxOutputTokens: undefined }, prompt: "current",
    contextCalibration: { profileId: profile.id, model: profile.model, estimatedInputTokens: estimateConversationTokens([current]), actualInputTokens: 1500 } });
  expect(body?.max_tokens).toBe(500);
});

test("compresses at the storage count boundary even inside a million-token model window", async () => {
  const messages = Array.from({ length: 100 }, (_, index) => user(`fact ${index}`));
  const storageLimits = { messageLimit: 100, jsonLimit: 4_194_304 };
  expect(shouldCompress({ messages, contextTokens: 1_048_576, storageLimits })).toBe(true);
  const transcripts: string[] = [];
  const result = await compressConversation({ messages, contextTokens: 1_048_576, storageLimits,
    summarize: async ({ transcript }) => { transcripts.push(transcript); return "Earlier facts"; } });
  expect(result.retained.length).toBeLessThanOrEqual(68);
  expect(transcripts.join("\n")).toContain("fact 0");
  expect(result.retained.at(-1)?.content).toBe("fact 99");
});

test("compresses storage message count before checkpointing can drop an old fact", async () => {
  const messages = Array.from({ length: 4090 }, (_, index) => user(`history ${index}`));
  const snapshots: AgentMessage[][] = [];
  let summaries = 0;
  const runtime = new AgentRuntime({ catalog: noToolsCatalog, executeTool: async () => undefined,
    onConversation: messages => { snapshots.push(messages); },
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: AgentMessage[] };
      if (body.messages[0]?.content?.startsWith("Summarize")) { summaries++; return Response.json({ choices: [{ message: assistant("Remember history 0") }] }); }
      return Response.json({ choices: [{ message: assistant("done") }] });
    },
  });
  const result = await runtime.run({ taskId: "storage", profile: { ...profile, contextTokens: 1_048_576 }, previousMessages: messages, prompt: "current" });
  expect(summaries).toBeGreaterThan(0);
  expect(result.contextSummary).toContain("history 0");
  expect(snapshots[0]!.length).toBeLessThan(4090);
  expect(result.messages.at(-1)?.content).toBe("done");
});

test("uses the tighter JSON storage target when the model window and count limit are large", async () => {
  const messages = Array.from({ length: 100 }, (_, index) => user(`fact ${index} ${"x".repeat(1000)}`));
  const storageLimits = { messageLimit: 4096, jsonLimit: 110000 };
  expect(shouldCompress({ messages, contextTokens: 8_388_608, storageLimits })).toBe(true);
  const result = await compressConversation({ messages, contextTokens: 8_388_608, storageLimits, summarize: async () => "Earlier facts" });
  expect(conversationStorageSize(result.retained).jsonChars).toBeLessThanOrEqual(storageLimits.jsonLimit * 0.68);
  expect(result.retained.at(-1)?.content).toBe(messages.at(-1)?.content);
});

test("rejects compression when the protected current turn alone exceeds its storage target", async () => {
  const current = user("x".repeat(3000));
  await expect(compressConversation({ messages: [user("old facts"), current], currentUserMessage: current,
    contextTokens: 1_048_576, storageLimits: { messageLimit: 4096, jsonLimit: 4000 }, summarize: async () => "Earlier facts" }))
    .rejects.toMatchObject({ code: "CONTEXT_COMPRESSION_FAILED" });
});

test("clears old calibration after replacing history with a summary", async () => {
  const previousMessages = [user("old facts ".repeat(1000))];
  const initial = [...previousMessages, user("current")];
  let summaries = 0;
  const checkpoints: Array<{ estimate: number | undefined; calibration: unknown }> = [];
  const runtime = new AgentRuntime({ catalog: noToolsCatalog, executeTool: async () => undefined,
    onConversation: (_messages, _summary, estimate, calibration) => { checkpoints.push({ estimate, calibration }); },
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: AgentMessage[] };
      const summary = body.messages[0]?.content?.startsWith("Summarize");
      if (summary) summaries++;
      return Response.json({ choices: [{ message: assistant(summary ? "Earlier decisions" : "done") }] });
    },
  });
  const result = await runtime.run({ taskId: "compression-calibration", profile, prompt: "current", previousMessages,
    contextCalibration: { profileId: profile.id, model: profile.model, estimatedInputTokens: estimateConversationTokens(initial), actualInputTokens: 8500 } });
  expect(summaries).toBeGreaterThan(0);
  expect(result.contextCalibration).toBeUndefined();
  expect(checkpoints.at(-1)?.calibration).toBeUndefined();
  expect(result.contextTokensEstimate).toBe(estimateConversationTokens(result.messages));
});

test("keeps a good calibration when usage is missing, zero, or malformed", async () => {
  const calibration = { profileId: profile.id, model: profile.model, estimatedInputTokens: estimateConversationTokens([user("current")]), actualInputTokens: 500 };
  for (const usage of [undefined, { prompt_tokens: 0, completion_tokens: 1 }, { prompt_tokens: "invalid", completion_tokens: 1 }]) {
    const runtime = new AgentRuntime({ catalog: noToolsCatalog, executeTool: async () => undefined,
      fetch: async () => Response.json({ choices: [{ message: assistant("done") }], ...(usage ? { usage } : {}) }),
    });
    const result = await runtime.run({ taskId: "missing-usage", profile, prompt: "current", contextCalibration: calibration });
    expect(result.contextCalibration).toEqual(calibration);
    if (usage?.prompt_tokens === "invalid") expect(result.usage).toBeUndefined();
  }
  for (const actualInputTokens of [0, Number.NaN, -1, 1.5]) {
    expect(calibratedInputTokens(100, profile, { ...calibration, actualInputTokens })).toBe(100);
  }
});

test("does not replace a successful request sample with usage from a malformed response", async () => {
  const calibration = { profileId: profile.id, model: profile.model, estimatedInputTokens: estimateConversationTokens([user("current")]), actualInputTokens: 500 };
  const notified: number[] = [];
  const samples: unknown[] = [];
  let requests = 0;
  const runtime = new AgentRuntime({ catalog: noToolsCatalog, executeTool: async () => undefined,
    onUsage: next => { notified.push(next.promptTokens); },
    onConversation: (_messages, _summary, _estimate, sample) => { samples.push(sample); },
    fetch: async () => {
      requests++;
      return Response.json({ choices: [{ message: requests === 1 ? assistant("") : assistant("done") }],
        ...(requests === 1 ? { usage: { prompt_tokens: 9000, completion_tokens: 100 } } : {}) });
    },
  });
  const result = await runtime.run({ taskId: "failed-usage", profile, prompt: "current", contextCalibration: calibration });
  expect(requests).toBe(2);
  expect(notified).toEqual([]);
  expect(result.contextCalibration).toEqual(calibration);
  expect(samples).not.toContainEqual(expect.objectContaining({ actualInputTokens: 9000 }));
});

test("allows a long live tool turn beyond the obsolete two-megabyte guard then compresses by storage", async () => {
  let mainRequests = 0;
  let summaries = 0;
  let maxStoredJson = 0;
  const runtime = new AgentRuntime({ catalog: { providerTools: () => [], parseCall: name => ({ name, input: {} }) }, executeTool: async () => "receipt",
    onConversation: messages => { maxStoredJson = Math.max(maxStoredJson, JSON.stringify(messages).length); },
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: AgentMessage[] };
      if (body.messages[0]?.content?.startsWith("Summarize")) { summaries++; return Response.json({ choices: [{ message: assistant("Earlier tool decisions") }] }); }
      mainRequests++;
      const message = mainRequests <= 32 ? { role: "assistant", content: "x".repeat(120000),
        tool_calls: [{ id: `tool-${mainRequests}`, type: "function", function: { name: "read", arguments: "{}" } }] } : assistant("done");
      return Response.json({ choices: [{ message }] });
    },
  });
  const result = await runtime.run({ taskId: "large-live-tools", profile: { ...profile, contextTokens: 8_388_608 }, prompt: "Implement the full task" });
  expect(result.summary).toBe("done");
  expect(maxStoredJson).toBeGreaterThan(2_097_152);
  expect(maxStoredJson).toBeLessThan(4_194_304);
  expect(summaries).toBeGreaterThan(0);
  expect(result.contextSummary).toContain("Earlier tool decisions");
});

test("normalizes all Anthropic input cache classes for JSON and SSE", async () => {
  const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 9000, cache_creation_input_tokens: 1000 };
  const expected = { promptTokens: 10100, completionTokens: 20, cachedTokens: 9000, cacheWriteTokens: 1000 };
  const input = { protocol: "anthropic" as const, baseUrl: "https://model.test", model: "claude-sonnet-4", messages: [user("current")], tools: [] };
  const json = await requestProtocolCompletion({ ...input, fetcher: async () => Response.json({ content: [{ type: "text", text: "done" }], usage }) });
  expect(json.usage).toEqual(expected);
  const events = [
    { type: "message_start", message: { usage: { ...usage, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "done" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } },
    { type: "message_stop" },
  ];
  const stream = await requestProtocolCompletion({ ...input, onDelta: async () => undefined,
    fetcher: async () => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }) });
  expect(stream.usage).toEqual(expected);
});
