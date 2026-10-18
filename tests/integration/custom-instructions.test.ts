import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test, expect } from "vitest";
import { ProjectCore } from "../../src/main/core/project-core";
import type { ModelProfile } from "../../src/shared/contracts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/** Runs one agent round against a local mock endpoint and returns the system message it received. */
async function systemPromptOf(customInstructions?: () => string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-instructions-"));
  roots.push(root);
  await cp(path.resolve("tests/fixtures/godot-minimal"), root, { recursive: true });
  let received = "";
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as {
      messages: { role: string; content: string }[];
    };
    received = body.messages.find((message) => message.role === "system")?.content ?? "";
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "收到。" } }],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const core = await ProjectCore.open(root, {
      resolveCredential: async () => "fixture-secret",
      ...(customInstructions ? { customInstructions } : {}),
    });
    await core.createTask({
      id: "greet",
      title: "打招呼",
      readPaths: ["*"],
      writePaths: [],
      allowDelete: false,
      mode: "manual",
    });
    const profile: ModelProfile = {
      id: "fixture",
      name: "Fixture",
      provider: "openai-compatible",
      model: "mock",
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      approved: true,
      timeoutMs: 10000,
      maxToolRounds: 2,
    };
    await core.agentMessage("greet", profile, "你好");
    return received;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("appends the operator instructions after the built-in system prompt", async () => {
  const system = await systemPromptOf(() => "回答先给结论；GDScript 注释用中文。");
  expect(system).toContain("You are SpecLoom, a project development agent.");
  expect(system).toContain("Additional operator instructions");
  expect(system).toContain("回答先给结论；GDScript 注释用中文。");
  expect(system.indexOf("Respond in Chinese.")).toBeLessThan(
    system.indexOf("Additional operator instructions"),
  );
});

test("leaves the system prompt untouched when no instructions are configured", async () => {
  const system = await systemPromptOf();
  expect(system).toContain("You are SpecLoom, a project development agent.");
  expect(system).not.toContain("Additional operator instructions");
});

test("asks for brief public progress during tool work without forcing it on simple answers", async () => {
  const system = await systemPromptOf();
  expect(system).toContain("公开进度说明");
  expect(system).toContain("首次操作前");
  expect(system).toContain("实际发现、阶段变化或阻塞");
  expect(system).toContain("普通 assistant 文本");
  expect(system).toContain("不逐工具机械播报");
  expect(system).toContain("简单问答无需额外的进度说明");
});

test("reads the instructions for every run so an edit applies to the next reply", async () => {
  let instructions = "第一版要求";
  const first = await systemPromptOf(() => instructions);
  instructions = "第二版要求";
  const second = await systemPromptOf(() => instructions);
  expect(first).toContain("第一版要求");
  expect(second).not.toContain("第一版要求");
  expect(second).toContain("第二版要求");
});
