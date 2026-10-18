import { randomFillSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { afterEach, expect, test } from "vitest";
import { AgentRuntime, type AgentMessage } from "../../src/main/core/agent-runtime";
import { WorkspaceTools } from "../../src/main/core/tools/workspace-tools";

const roots: string[] = [];
const toolboxes: WorkspaceTools[] = [];
afterEach(async () => {
  await Promise.all(toolboxes.splice(0).map((tools) => tools.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-runtime-regression-"));
  roots.push(root);
  const tools = new WorkspaceTools(root, "regression");
  toolboxes.push(tools);
  return { root, tools };
}
test.each(["name: [broken", "null"])("an invalid Skill entry (%s) does not disable coding tools or valid workflows", async (metadata) => {
  const { root, tools } = await fixture();
  const broken = path.join(root, ".specloom/skills/broken");
  const valid = path.join(root, ".specloom/skills/valid");
  await mkdir(broken, { recursive: true });
  await mkdir(valid, { recursive: true });
  await writeFile(path.join(broken, "SKILL.md"), `---\n${metadata}\n---\nInvalid workflow\n`);
  await writeFile(path.join(valid, "SKILL.md"), "---\nname: Valid workflow\ndescription: Read project sources\n---\nFollow the valid workflow.\n");
  const capabilities = await tools.capabilities();
  expect(capabilities.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["Read", "Write", "Bash", "ToolSearch"]));
  expect(capabilities.skills).toEqual([{ id: "valid", name: "Valid workflow", purpose: "Read project sources" }]);
  expect(await tools.execute("Skill", { id: "valid" })).toMatchObject({ instructions: expect.stringContaining("Follow the valid workflow.") });
  await expect(tools.execute("Skill", { id: "broken" })).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
});

function photographicPng(): Buffer {
  const width = 800, height = 800, rowBytes = width * 3 + 1;
  const pixels = randomFillSync(Buffer.alloc(rowBytes * height));
  for (let y = 0; y < height; y++) pixels[y * rowBytes] = 0;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  const chunk = (name: string, content: Buffer) => {
    const body = Buffer.concat([Buffer.from(name), content]);
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(content.length); checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([size, body, checksum]);
  };
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}

test("a real image larger than the text budget reaches the vision provider after Read, while history omits its bytes", async () => {
  const { root, tools } = await fixture();
  const image = photographicPng();
  const base64 = image.toString("base64");
  expect(base64.length).toBeGreaterThan(2_097_152);
  await writeFile(path.join(root, "capture.png"), image);
  const requests: { messages: { role: string; content: unknown }[] }[] = [];
  const checkpoints: AgentMessage[][] = [];
  const runtime = new AgentRuntime({
    catalog: tools.catalog,
    executeTool: (call) => tools.execute(call.name, call.input, call.signal),
    onConversation: (messages) => { checkpoints.push(messages); },
    fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      const message = requests.length === 1 ? { role: "assistant", content: null, tool_calls: [{ id: "read-image", type: "function", function: { name: "Read", arguments: JSON.stringify({ path: "capture.png" }) } }] }
        : { role: "assistant", content: "实际图像已送达" };
      return new Response(JSON.stringify({ choices: [{ message }] }), { headers: { "content-type": "application/json" } });
    },
  });
  const result = await runtime.run({ taskId: "vision", prompt: "查看 capture.png", profile: {
    id: "fixture", name: "Fixture", provider: "openai-compatible", protocol: "openai", model: "fixture",
    baseUrl: "http://fixture.invalid/v1", approved: true, vision: true, timeoutMs: 5000, maxToolRounds: 4,
    contextTokens: 8192, maxOutputTokens: 1024,
  } });
  expect(result.summary).toBe("实际图像已送达");
  expect(requests).toHaveLength(2);
  expect([...(requests[1]?.messages ?? [])].reverse().find((message) => message.role === "user")?.content).toContainEqual({ type: "image_url", image_url: { url: `data:image/png;base64,${base64}` } });
  expect(checkpoints.flat().every((message) => !message.images?.length)).toBe(true);
  expect(JSON.stringify(checkpoints)).not.toContain(base64);
});

test("Monitor streams a live child line before completion and cancelling its run stops the process tree", async () => {
  const { tools } = await fixture();
  tools.setPermissions("full");
  const controller = new AbortController();
  const lines: string[] = [];
  let resolveLine!: () => void;
  const firstLine = new Promise<void>((resolve) => { resolveLine = resolve; });
  const job = await tools.execute("Monitor", { operation: "start", command: "node -e 'console.log(12345);setTimeout(()=>console.log(98765),30000)'" }, controller.signal, (line) => {
    lines.push(line);
    if (line === "12345") resolveLine();
  }) as { id: string; status: string };
  expect(job.status).toBe("running");
  try {
    await Promise.race([firstLine, new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error("Monitor did not stream the live child line")), 8000); firstLine.finally(() => clearTimeout(timer)).catch(() => undefined); })]);
    expect(await tools.execute("Monitor", { operation: "poll", id: job.id })).toMatchObject({ status: "running", output: "12345" });
    controller.abort();
    expect(await tools.execute("Monitor", { operation: "poll", id: job.id })).toMatchObject({ status: "cancelled" });
  } finally {
    await tools.execute("Monitor", { operation: "cancel", id: job.id });
  }
  expect(lines).toContain("12345");
  expect(lines).not.toContain("98765");
});
