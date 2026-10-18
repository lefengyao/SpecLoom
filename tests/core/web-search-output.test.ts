import { expect, test } from "vitest";
import { AgentRuntime } from "../../src/main/core/agent-runtime";
import { toolOutput } from "../../src/main/core/agent-output";
import { WorkspaceTools } from "../../src/main/core/tools/workspace-tools";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

test("bounded web output preserves a 50000 character extraction and still redacts credentials", () => {
  const content = "正文".repeat(25000);
  const value = JSON.parse(toolOutput(true, { url: "https://example.com", content, token: "hidden", note: "Bearer private" }, undefined, { stringLimit: 50000, outputLimit: 131072 }));
  expect(value.result.content).toBe(content);
  expect(value.result.token).toBeUndefined();
  expect(value.result.note).toBe("Bearer [redacted]");
  expect(value.truncated).toBe(false);
  expect(JSON.parse(toolOutput(true, { content })).truncated).toBe(true);
});

test("runtime sends complete web content to the model but bounds visible tool records", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-web-output-"));
  const tools = new WorkspaceTools(root, "output"); const content = "article ".repeat(6250); const visible: string[] = []; let request = 0;
  tools.setWebSearch({ mode: "free" });
  try {
    const runtime = new AgentRuntime({ catalog: tools.catalog, executeTool: async () => ({ url: "https://example.com", content, truncated: false }), onEvent: event => { if (event.type === "tool-result") visible.push(event.output); }, fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
      if (request++ === 0) return Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "extract", type: "function", function: { name: "web_extract", arguments: JSON.stringify({ url: "https://example.com", maxChars: 50000 }) } }] } }] });
      const receipt = [...body.messages].reverse().find(message => message.role === "tool")!;
      expect(JSON.parse(receipt.content).result.content).toBe(content);
      return Response.json({ choices: [{ message: { role: "assistant", content: "Read the source." } }] });
    } });
    await runtime.run({ taskId: "web-output", prompt: "Read this page", profile: { id: "mock", name: "Mock", provider: "openai-compatible", model: "mock", baseUrl: "http://model.test/v1", approved: true, timeoutMs: 5000 } });
    expect(visible).toHaveLength(1); expect(visible[0]!.length).toBeLessThanOrEqual(16384); expect(JSON.parse(visible[0]!).truncated).toBe(true);
  } finally { await tools.close(); await rm(root, { recursive: true, force: true }); }
});
