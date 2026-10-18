import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { AgentRuntime, type AgentMessage } from "../../src/main/core/agent-runtime";
import { estimateConversationTokens } from "../../src/main/core/agent-client";
import { SessionRuns, type SessionRunOptions } from "../../src/main/core/session-runs";
import { SessionStore } from "../../src/main/core/session-store";
import type { ProviderTool } from "../../src/main/core/tool-catalog";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const profile = {
  id: "estimate-fixture", name: "Estimate fixture", provider: "openai-compatible" as const,
  protocol: "openai" as const, model: "fixture", baseUrl: "https://model.test/v1", approved: true,
  timeoutMs: 1000, maxToolRounds: 2,
};
const tool: ProviderTool = { type: "function", function: {
  name: "fixture_read", description: "Read an approved fixture", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
} };
const image = { name: "fixture.png", mimeType: "image/png", base64: "aGVsbG8=" };

test("reports a request estimate including system prompt, tools and image input", async () => {
  const checkpoints: number[] = [];
  const runtime = new AgentRuntime({
    catalog: { providerTools: () => [tool], parseCall: () => ({ name: "fixture_read", input: {} }) },
    executeTool: async () => undefined,
    onConversation: (_messages, _summary, contextTokensEstimate) => { if (contextTokensEstimate !== undefined) checkpoints.push(contextTokensEstimate); },
    fetch: async () => Response.json({ choices: [{ message: { role: "assistant", content: "done" } }] }),
  });
  const result = await runtime.run({ profile, taskId: "estimate", prompt: "current request", systemPrompt: "system instructions", images: [{ mimeType: image.mimeType, base64: image.base64 }] });
  const initialMessages: AgentMessage[] = [
    { role: "system", content: "system instructions" },
    { role: "user", content: "current request", images: [{ mimeType: image.mimeType, base64: image.base64 }] },
  ];
  const initialExpected = estimateConversationTokens([...initialMessages], [tool]);
  const finalExpected = estimateConversationTokens([...initialMessages, { role: "assistant", content: "done" }], [tool]);

  expect(checkpoints[0]).toBe(initialExpected);
  expect(checkpoints.at(-1)).toBe(finalExpected);
  expect(result.contextTokensEstimate).toBe(finalExpected);
});

test("persists the runtime request estimate through a session run", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-context-estimate-")); roots.push(root);
  const store = await SessionStore.open(root); const session = await store.create("estimate session");
  const runs = new SessionRuns(store, root);
  let requestedTools: ProviderTool[] = [];
  const execute = runs.executor(options => new AgentRuntime({
    ...options,
    catalog: { providerTools: () => [tool], parseCall: () => ({ name: "fixture_read", input: {} }) },
    executeTool: async () => undefined,
    fetch: async (_url, request) => {
      requestedTools = (JSON.parse(String(request?.body)) as { tools: ProviderTool[] }).tools;
      return Response.json({ choices: [{ message: { role: "assistant", content: "done" } }] });
    },
  }).run({ taskId: "estimate", prompt: options.prompt, systemPrompt: "system instructions", profile, ...(options.images ? { images: options.images.map(({ mimeType, base64 }) => ({ mimeType, base64 })) } : {}), previousMessages: options.previousMessages, signal: options.signal }));

  const completed = await runs.send(session.id, "current request", execute, undefined, [image]);
  const expected = estimateConversationTokens([
    { role: "system", content: "system instructions" },
    { role: "user", content: "current request", images: [{ mimeType: image.mimeType, base64: image.base64 }] },
    { role: "assistant", content: "done" },
  ], requestedTools);
  expect(requestedTools.map(candidate => candidate.function.name)).toEqual(["fixture_read", "AskUserQuestion", "ask_user"]);
  expect(completed.contextTokensEstimate).toBe(expected);
  expect(store.get(session.id).contextTokensEstimate).toBe(expected);
});

test("publishes context checkpoints immediately during a running session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-context-live-")); roots.push(root);
  const store = await SessionStore.open(root); const session = await store.create("live estimate");
  const runs = new SessionRuns(store, root); const observed: number[] = [];
  runs.subscribe(event => { if (event.session.status === "running" && event.session.contextTokensEstimate !== undefined) observed.push(event.session.contextTokensEstimate); });
  await runs.send(session.id, "continue", async options => {
    await options.onConversation?.([{ role: "user", content: "continue" }], undefined, 40000);
    expect(observed).toContain(40000);
    return { summary: "done", toolCalls: 0, rounds: 0, messages: [{ role: "user", content: "continue" }, { role: "assistant", content: "done" }], contextTokensEstimate: 40005 };
  });
});

test("keeps the latest individual request usage separate from accumulated run usage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-context-usage-")); roots.push(root);
  const store = await SessionStore.open(root); const session = await store.create("request usage");
  const runs = new SessionRuns(store, root); const observed: number[] = [];
  runs.subscribe(event => { if (event.session.status === "running" && event.session.lastRequestUsage) observed.push(event.session.lastRequestUsage.promptTokens); });
  const usage = (promptTokens: number) => ({ promptTokens, completionTokens: 10, cachedTokens: 0, cacheWriteTokens: 0 });
  await runs.send(session.id, "continue", async options => {
    await options.onUsage?.(usage(1000));
    await options.onUsage?.(usage(2000));
    expect(observed).toEqual([1000, 2000]);
    return { summary: "done", toolCalls: 0, rounds: 0, messages: [{ role: "user", content: "continue" }, { role: "assistant", content: "done" }], usage: { ...usage(3000), completionTokens: 20 } };
  });
  const completed = store.get(session.id);
  expect(completed.lastRequestUsage).toMatchObject({ promptTokens: 2000, source: "actual" });
  expect(completed.usage).toMatchObject({ promptTokens: 3000, completionTokens: 20 });
  expect((await SessionStore.open(root)).get(session.id).lastRequestUsage).toEqual(completed.lastRequestUsage);
});

test("continues calibrated context across a session-store restart without accumulating old run usage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-context-restart-")); roots.push(root);
  let store = await SessionStore.open(root);
  const session = await store.create("restart calibration");
  const initialEstimates: number[] = [];
  const requestEstimates: number[] = [];
  let requestCount = 0;
  const execute = (options: SessionRunOptions) => {
    let firstCheckpoint = true;
    return new AgentRuntime({
      ...options,
      catalog: { providerTools: () => [tool], parseCall: () => ({ name: "fixture_read", input: {} }) },
      executeTool: async () => undefined,
      onConversation: async (...args) => {
        if (firstCheckpoint) { initialEstimates.push(args[2]!); firstCheckpoint = false; }
        await options.onConversation?.(...args);
      },
      fetch: async (_url, request) => {
        const body = JSON.parse(String(request?.body)) as { messages: AgentMessage[]; tools: ProviderTool[] };
        requestEstimates.push(estimateConversationTokens(body.messages, body.tools));
        requestCount++;
        return Response.json({ choices: [{ message: { role: "assistant", content: "done" } }], usage: { prompt_tokens: requestCount === 1 ? 8000 : 12000, completion_tokens: 10 } });
      },
    }).run({
      taskId: session.id, prompt: options.prompt, profile, systemPrompt: "system instructions",
      previousMessages: options.previousMessages, signal: options.signal,
      ...(options.session.contextCalibration ? { contextCalibration: options.session.contextCalibration } : {}),
    });
  };
  await new SessionRuns(store, root).send(session.id, "first request", execute);
  const first = store.get(session.id);
  expect(first.contextCalibration).toEqual({ profileId: profile.id, model: profile.model, estimatedInputTokens: requestEstimates[0], actualInputTokens: 8000 });
  expect(first.contextTokensEstimate).toBeGreaterThan(8000);

  store = await SessionStore.open(root);
  expect(store.get(session.id).contextCalibration).toEqual(first.contextCalibration);
  await new SessionRuns(store, root).send(session.id, "continue", execute);
  const second = store.get(session.id);
  expect(initialEstimates[1]).toBe(8000 + requestEstimates[1]! - requestEstimates[0]!);
  expect(second.contextCalibration).toEqual({ profileId: profile.id, model: profile.model, estimatedInputTokens: requestEstimates[1], actualInputTokens: 12000 });
  expect(second.lastRequestUsage).toMatchObject({ promptTokens: 12000, source: "actual" });
  expect(second.usage).toMatchObject({ promptTokens: 12000, source: "actual" });
});
