import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { WorkProcesses } from "../../src/main/core/tools/processes";
import { WorkspaceTools } from "../../src/main/core/tools/workspace-tools";
import { AgentRuntime, type AgentEvent } from "../../src/main/core/agent-runtime";
import type { ToolApprovalInput } from "../../src/shared/approvals";
import { ProjectError } from "../../src/main/core/errors";

const roots: string[] = [];
const close: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(close.splice(0).map(fn => fn())); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
interface JobView { id: string; status: string; output: string; cursor: number; partialOutput?: string; ownership: string; unchangedPolls: number; stalled: boolean; notice?: string; reused?: boolean; restartedFrom?: string; blockage?: { kind: string; message: string } }
async function fixture(script = "console.log('ready');setInterval(()=>{},1000)") {
  const root = await mkdtemp(path.join(os.tmpdir(), "specloom-monitor-")); roots.push(root);
  await writeFile(path.join(root, "job.cjs"), script);
  const processes = new WorkProcesses(root); close.push(() => processes.close());
  return { root, processes, command: 'node "job.cjs"' };
}
async function ready(processes: WorkProcesses, id: string) {
  let result!: JobView;
  await vi.waitFor(async () => { result = await processes.monitor({ operation: "poll", id, waitMs: 50 }) as JobView; expect(result.output).toContain("ready"); }, { timeout: 8000 });
  return result;
}
test("default Monitor polls consume output once and flag bounded consecutive unchanged reads", async () => {
  const { processes, command } = await fixture(); const notices: string[] = [];
  const job = await processes.monitor({ operation: "start", command }, text => { notices.push(text); }) as JobView;
  await ready(processes, job.id);
  for (let i = 1; i <= 5; i++) {
    const poll = await processes.monitor({ operation: "poll", id: job.id, waitMs: 0 }) as JobView;
    expect(poll.output).toBe(""); expect(poll.unchangedPolls).toBe(i);
    if (i >= 3) { expect(poll.stalled).toBe(false); expect(poll.notice).toMatch(/waitMs=30000/); }
  }
  expect(notices.some(notice => /无新输出|没有新输出/.test(notice))).toBe(true);
});
test("owned jobs can be reused, safely stopped and restarted with the original command only", async () => {
  const { root, processes, command } = await fixture("require('node:fs').appendFileSync('starts.txt','start\\n');console.log('ready');setInterval(()=>{},1000)");
  const first = await processes.monitor({ operation: "start", command }) as JobView; await ready(processes, first.id);
  expect(await processes.monitor({ operation: "start", command })).toMatchObject({ id: first.id, ownership: "session", reused: true });
  await expect(processes.monitor({ operation: "restart", id: first.id, command: "echo unrelated" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  const restarted = await processes.monitor({ operation: "restart", id: first.id, command }) as JobView;
  expect(restarted.id).not.toBe(first.id); expect(restarted.restartedFrom).toBe(first.id);
  expect(await processes.monitor({ operation: "poll", id: first.id })).toMatchObject({ status: "cancelled" });
  await ready(processes, restarted.id); expect((await readFile(path.join(root, "starts.txt"), "utf8")).trim().split("\n")).toHaveLength(2);
  await processes.monitor({ operation: "cancel", id: restarted.id });
  expect(await processes.monitor({ operation: "poll", id: restarted.id })).toMatchObject({ status: "cancelled" });
});
test("unknown external job IDs cannot be stopped and completed status remains accurate", async () => {
  const { processes } = await fixture();
  await expect(processes.monitor({ operation: "cancel", id: "external-pid-1234" })).rejects.toThrow(/本会话|外部/);
  const job = await processes.monitor({ operation: "start", command: "echo complete" }) as JobView;
  await processes.monitor({ operation: "poll", id: job.id, waitMs: 5000 });
  expect(await processes.monitor({ operation: "cancel", id: job.id })).toMatchObject({ status: "completed" });
});
test("an externally occupied port produces an actionable blockage while preserving the external server", async () => {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  close.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing test port");
  const { processes, command } = await fixture(`const server=require('node:net').createServer();server.on('error',error=>{console.error(error.code);process.exitCode=1});server.listen(${address.port},'127.0.0.1');`);
  const notices: string[] = []; const job = await processes.monitor({ operation: "start", command }, text => { notices.push(text); }) as JobView;
  const result = await processes.monitor({ operation: "poll", id: job.id, waitMs: 5000 }) as JobView;
  expect(result.status).toBe("error"); expect(result.blockage).toMatchObject({ kind: "existing-instance", message: expect.stringMatching(/外部|本会话/) });
  expect(notices.some(notice => /实例|占用/.test(notice))).toBe(true); expect(server.listening).toBe(true);
});
test("restart passes normal host-command approval and a denial leaves the owned job running", async () => {
  const { root, command } = await fixture(); const tools = new WorkspaceTools(root, "monitor-approval"); close.push(() => tools.close());
  const approve = vi.fn<(request: ToolApprovalInput) => Promise<boolean>>().mockResolvedValue(true); tools.setPermissions("ask", approve);
  const first = await tools.execute("Monitor", { operation: "start", command }) as JobView;
  approve.mockResolvedValueOnce(false);
  await expect(tools.execute("Monitor", { operation: "restart", id: first.id, command })).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
  expect(approve).toHaveBeenCalledTimes(2); expect(await tools.execute("Monitor", { operation: "poll", id: first.id, waitMs: 0 })).toMatchObject({ status: "running" });
  expect(approve.mock.calls[1]?.[0]).toMatchObject({ toolName: "Monitor", arguments: expect.stringContaining(command.replaceAll('"', '\\"')) });
});
test("runtime ends repeated unchanged Monitor polling with a visible truthful summary", async () => {
  const events: AgentEvent[] = []; let calls = 0, now = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const runtime = new AgentRuntime({
    catalog: { providerTools: () => [], parseCall: (_name, json) => ({ name: "Monitor", input: JSON.parse(json) }) },
    executeTool: async () => { now = 1000 + calls++ * 30000; return { id: "owned-job", status: "running", output: "old startup line", cursor: 1, ownership: "session", unchangedPolls: calls, stalled: calls >= 5, changed: false }; },
    onEvent: event => { events.push(event); },
    fetch: async () => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: `poll-${calls}`, type: "function", function: { name: "Monitor", arguments: JSON.stringify({ operation: "poll", id: "owned-job", cursor: 0, waitMs: 0 }) } }] } }] }), { headers: { "content-type": "application/json" } }),
  });
  const result = await runtime.run({ taskId: "monitor-stall", prompt: "重启测试", profile: { id: "mock", name: "Mock", provider: "openai-compatible", model: "mock", baseUrl: "http://mock.invalid/v1", approved: true, timeoutMs: 5000 } });
  expect(calls).toBe(5); expect(result.summary).toMatch(/停止重复轮询/); expect(result.summary).toMatch(/仍在运行/); expect(result.summary).toMatch(/尚未.*完成/);
  expect(events.some(event => event.type === "text" && event.content === result.summary)).toBe(true);
});

test("a normally silent running job can pass five rapid polls without ending the run", async () => {
  let calls = 0, now = 1000; const events: AgentEvent[] = [];
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const runtime = new AgentRuntime({
    catalog: { providerTools: () => [], parseCall: (_name, json) => ({ name: "Monitor", input: JSON.parse(json) }) },
    executeTool: async () => { calls++; now += 1000; return { id: "silent-job", status: "running", output: "", changed: false }; },
    onEvent: event => { events.push(event); },
    fetch: async () => Response.json({ choices: [{ message: calls < 10 ? { role: "assistant", content: null, tool_calls: [{ id: `silent-${calls}`, type: "function", function: { name: "Monitor", arguments: JSON.stringify({ operation: "poll", id: "silent-job", waitMs: 30000 }) } }] } : { role: "assistant", content: "静默作业仍在正常等待。" } }] }),
  });
  const result = await runtime.run({ taskId: "monitor-silent", prompt: "等待启动", profile: { id: "mock", name: "Mock", provider: "openai-compatible", model: "mock", baseUrl: "http://mock.invalid/v1", approved: true, timeoutMs: 5000 } });
  expect(calls).toBe(10); expect(result.summary).toBe("静默作业仍在正常等待。");
  expect(events.some(event => event.type === "activity" && event.content.includes("waitMs=30000"))).toBe(true);
});

test.each(["id", "status"])("changing Monitor job %s resets the elapsed consecutive-poll budget", async change => {
  let calls = 0, now = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const runtime = new AgentRuntime({
    catalog: { providerTools: () => [], parseCall: (_name, json) => ({ name: "Monitor", input: JSON.parse(json) }) },
    executeTool: async () => { now = 1000 + calls++ * 30000; return { id: change === "id" && calls > 4 ? "second-job" : "first-job", status: change === "status" && calls > 4 ? "completed" : "running", output: "", changed: false }; },
    fetch: async () => Response.json({ choices: [{ message: calls < 8 ? { role: "assistant", content: null, tool_calls: [{ id: `job-${calls}`, type: "function", function: { name: "Monitor", arguments: JSON.stringify({ operation: "poll", id: change === "id" && calls >= 4 ? "second-job" : "first-job", waitMs: 0 }) } }] } : { role: "assistant", content: "已分别检查两个状态。" } }] }),
  });
  const result = await runtime.run({ taskId: "monitor-job-switch", prompt: "检查后台作业", profile: { id: "mock", name: "Mock", provider: "openai-compatible", model: "mock", baseUrl: "http://mock.invalid/v1", approved: true, timeoutMs: 5000 } });
  expect(calls).toBe(8); expect(result.summary).toBe("已分别检查两个状态。");
});

test.each(["completed", "blocked"])("repeated %s polls stop promptly without the running-job grace period", async state => {
  let calls = 0;
  const runtime = new AgentRuntime({
    catalog: { providerTools: () => [], parseCall: (_name, json) => ({ name: "Monitor", input: JSON.parse(json) }) },
    executeTool: async () => { calls++; return { id: "owned-job", status: state === "completed" ? "completed" : "running", changed: false, ...(state === "blocked" ? { blockage: { kind: "existing-instance", message: "EADDRINUSE" } } : {}) }; },
    fetch: async () => Response.json({ choices: [{ message: calls < 8 ? { role: "assistant", content: null, tool_calls: [{ id: `terminal-${calls}`, type: "function", function: { name: "Monitor", arguments: JSON.stringify({ operation: "poll", id: "owned-job", waitMs: 0 }) } }] } : { role: "assistant", content: "guard did not run" } }] }),
  });
  const result = await runtime.run({ taskId: "monitor-ended", prompt: "检查后台作业", profile: { id: "mock", name: "Mock", provider: "openai-compatible", model: "mock", baseUrl: "http://mock.invalid/v1", approved: true, timeoutMs: 5000 } });
  expect(calls).toBe(5); expect(result.summary).toContain("停止重复轮询");
});
test("monitoring with real progress resets the idle budget instead of imposing an arbitrary total poll limit", async () => {
  let calls = 0;
  const runtime = new AgentRuntime({
    catalog: { providerTools: () => [], parseCall: (_name, json) => ({ name: "Monitor", input: JSON.parse(json) }) },
    executeTool: async () => ({ id: "owned-job", status: "running", output: ++calls % 3 === 0 ? `progress-${calls}` : "", cursor: calls, ownership: "session", changed: calls % 3 === 0 }),
    fetch: async () => new Response(JSON.stringify({ choices: [{ message: calls < 12 ? { role: "assistant", content: null, tool_calls: [{ id: `progress-${calls}`, type: "function", function: { name: "Monitor", arguments: JSON.stringify({ operation: "poll", id: "owned-job", waitMs: 0 }) } }] } : { role: "assistant", content: "已根据持续更新完成检查。" } }] }), { headers: { "content-type": "application/json" } }),
  });
  const result = await runtime.run({ taskId: "monitor-progress", prompt: "检查运行进度", profile: { id: "mock", name: "Mock", provider: "openai-compatible", model: "mock", baseUrl: "http://mock.invalid/v1", approved: true, timeoutMs: 5000 } });
  expect(calls).toBe(12); expect(result.summary).toBe("已根据持续更新完成检查。");
});
test("repeated failed polls of an unowned instance stop with a visible unknown-state notice", async () => {
  let calls = 0;
  const runtime = new AgentRuntime({
    catalog: { providerTools: () => [], parseCall: (_name, json) => ({ name: "Monitor", input: JSON.parse(json) }) },
    executeTool: async () => { calls++; throw new ProjectError("VALIDATION_FAILED", "作业不属于本会话"); },
    fetch: async () => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: `failed-poll-${calls}`, type: "function", function: { name: "Monitor", arguments: JSON.stringify({ operation: "poll", id: "external-instance", waitMs: 0 }) } }] } }] }), { headers: { "content-type": "application/json" } }),
  });
  const result = await runtime.run({ taskId: "monitor-external", prompt: "测试已有实例", profile: { id: "mock", name: "Mock", provider: "openai-compatible", model: "mock", baseUrl: "http://mock.invalid/v1", approved: true, timeoutMs: 5000 } });
  expect(calls).toBe(5); expect(result.summary).toContain("未能确认本会话作业状态"); expect(result.summary).toContain("尚未验证完成");
});
test.skipIf(process.platform !== "win32")("Windows retains an orphan descendant with inherited pipes until owned cancellation finishes", async () => {
  const { root, processes, command } = await fixture(`const cp=require('node:child_process');const child=cp.spawn(process.execPath,['-e',"console.log('orphan-ready');setInterval(()=>{},1000)"],{detached:true,stdio:'inherit'});require('node:fs').writeFileSync('orphan.pid',String(child.pid));child.unref();`);
  const job = await processes.monitor({ operation: "start", command }) as JobView;
  await vi.waitFor(async () => { expect(await readFile(path.join(root, "orphan.pid"), "utf8")).toMatch(/^\d+$/); }, { timeout: 8000 });
  const pid = Number(await readFile(path.join(root, "orphan.pid"), "utf8"));
  await new Promise(resolve => setTimeout(resolve, 200));
  expect(await processes.monitor({ operation: "poll", id: job.id, waitMs: 0 })).toMatchObject({ status: "running" });
  const start = Date.now(); expect(await processes.monitor({ operation: "cancel", id: job.id })).toMatchObject({ status: "cancelled" });
  expect(Date.now() - start).toBeLessThan(6000); expect(() => process.kill(pid, 0)).toThrow();
});
test("a frozen progress observer cannot block Monitor polling or Stop", async () => {
  const { processes, command } = await fixture();
  const job = await processes.monitor({ operation: "start", command }, () => new Promise<void>(() => undefined)) as JobView;
  await ready(processes, job.id);
  for (let i = 0; i < 3; i++) await processes.monitor({ operation: "poll", id: job.id, waitMs: 0 });
  const stop = processes.monitor({ operation: "cancel", id: job.id });
  const result = await Promise.race([stop, new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error("Stop waited for a frozen observer")), 6000); void stop.finally(() => clearTimeout(timer)); })]);
  expect(result).toMatchObject({ status: "cancelled" });
});
test.skipIf(process.platform !== "win32")("Chinese Monitor commands keep output readable through owned stop and restart", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "specloom-monitor-encoding-")); roots.push(base);
  const root = path.join(base, "中文 项目"); await mkdir(root);
  await writeFile(path.join(root, "中文 作业.cjs"), "console.log('ready 一页永恒');console.error('中文错误');setInterval(()=>{},1000)");
  const processes = new WorkProcesses(root); close.push(() => processes.close());
  const command = `& '${process.execPath.replaceAll("'", "''")}' '.\\中文 作业.cjs'`;
  const first = await processes.monitor({ operation: "start", command, shell: "powershell" }) as JobView;
  const output = await ready(processes, first.id); expect(output.output).toContain("一页永恒");
  const next = await processes.monitor({ operation: "restart", id: first.id, command, shell: "powershell" }) as JobView;
  expect(next.ownership).toBe("session"); expect(next.restartedFrom).toBe(first.id);
  const restarted = await ready(processes, next.id); expect(restarted.output).toContain("一页永恒");
  expect(await processes.monitor({ operation: "cancel", id: next.id })).toMatchObject({ status: "cancelled" });
  const all = await processes.monitor({ operation: "poll", id: next.id, cursor: 0, waitMs: 0 }) as JobView;
  expect(all.output).toContain("中文错误"); expect(all.output).not.toContain("�");
}, 20000);
test.skipIf(process.platform !== "win32")("partial Chinese bytes keep Monitor active before a newline and flush on owned cancellation", async () => {
  const { root, processes, command } = await fixture("process.stdout.write('中文未换行');require('node:fs').writeFileSync('partial.ready','ready');setInterval(()=>process.stdout.write('中文片段'),100)");
  const job = await processes.monitor({ operation: "start", command }) as JobView;
  await vi.waitFor(async () => { expect(await readFile(path.join(root, "partial.ready"), "utf8")).toBe("ready"); }, { timeout: 8000 });
  await processes.monitor({ operation: "poll", id: job.id, waitMs: 0 });
  expect(await processes.monitor({ operation: "poll", id: job.id, waitMs: 350 })).toMatchObject({ status: "running", output: "", changed: true, unchangedPolls: 0, stalled: false });
  const cancelled = await processes.monitor({ operation: "cancel", id: job.id, cursor: 0 }) as JobView;
  expect(cancelled.status).toBe("cancelled"); expect(cancelled.output).toContain("中文未换行"); expect(cancelled.output).not.toContain("�");
}, 15000);
test.skipIf(process.platform !== "win32").each(["utf8", "gbk"])("a long-lived %s process exposes its short unterminated readiness text before cancellation", async encoding => {
  const message = "服务器已就绪";
  const bytes = encoding === "utf8" ? Buffer.from(message).toString("hex") : "b7fecef1c6f7d2d1becdd0f7";
  const { root, processes, command } = await fixture(`process.stdout.write(Buffer.from('${bytes}','hex'));require('node:fs').writeFileSync('partial.ready','ready');setInterval(()=>{},1000)`);
  const progress: string[] = [];
  const job = await processes.monitor({ operation: "start", command }, text => { progress.push(text); }) as JobView;
  await vi.waitFor(async () => { expect(await readFile(path.join(root, "partial.ready"), "utf8")).toBe("ready"); }, { timeout: 8000 });
  await vi.waitFor(async () => {
    const visible = await processes.monitor({ operation: "poll", id: job.id, waitMs: 0 }) as JobView;
    expect(visible.status).toBe("running"); expect(visible.output).toBe(""); expect(visible.cursor).toBe(0); expect(visible.partialOutput).toBe(message);
  }, { timeout: 1500, interval: 25 });
  expect(progress).toContain(`[未换行输出片段]\n${message}`);
  const unchanged = await processes.monitor({ operation: "poll", id: job.id, waitMs: 0 }) as JobView;
  expect(unchanged).toMatchObject({ status: "running", output: "", cursor: 0 }); expect(unchanged).not.toHaveProperty("partialOutput");
  expect(await processes.monitor({ operation: "list" })).toContainEqual(expect.objectContaining({ id: job.id, partialOutput: message }));
  await processes.monitor({ operation: "cancel", id: job.id });
  const final = await processes.monitor({ operation: "poll", id: job.id, cursor: 0, waitMs: 0 }) as JobView;
  expect(final.status).toBe("cancelled"); expect(final.output).toBe(message); expect(final.partialOutput).toBe("");
}, 15000);
test.skipIf(process.platform !== "win32").each(["utf8", "gbk"])("slow %s chunks update a temporary snapshot and complete output once without moving its cursor early", async encoding => {
  const message = encoding === "utf8" ? "\uFEFF服务器已就绪😀" : "一页永恒";
  const bytes = encoding === "utf8" ? Buffer.from(message).toString("hex") : "d2bbd2b3d3c0bae3";
  const { root, processes, command } = await fixture(`const fs=require('node:fs');const bytes=Buffer.from('${bytes}','hex');process.stdout.write(bytes.subarray(0,2));fs.writeFileSync('first.ready','ready');let sent=false;const completion=setInterval(()=>{if(!sent&&fs.existsSync('second.request')){sent=true;process.stdout.write(bytes.subarray(2));fs.writeFileSync('second.ready','ready')}if(fs.existsSync('complete.request')){clearInterval(completion);process.stdout.write('\\n');fs.writeFileSync('complete.ready','ready')}},25);setInterval(()=>{},1000)`);
  const progress: string[] = [];
  const job = await processes.monitor({ operation: "start", command }, text => { progress.push(text); }) as JobView;
  await vi.waitFor(async () => { expect(await readFile(path.join(root, "first.ready"), "utf8")).toBe("ready"); }, { timeout: 8000 });
  const initial = await processes.monitor({ operation: "poll", id: job.id, waitMs: 200 }) as JobView;
  expect(initial).toMatchObject({ output: "", cursor: 0 }); expect(initial.partialOutput ?? "").not.toContain("�");
  if (encoding === "gbk") expect(initial.partialOutput).toBe("һ");
  await writeFile(path.join(root, "second.request"), "continue");
  await vi.waitFor(async () => { expect(await readFile(path.join(root, "second.ready"), "utf8")).toBe("ready"); }, { timeout: 8000 });
  await vi.waitFor(async () => {
    const visible = await processes.monitor({ operation: "poll", id: job.id, waitMs: 0 }) as JobView;
    expect(visible).toMatchObject({ status: "running", output: "", cursor: 0, partialOutput: message });
  }, { timeout: 1000, interval: 20 });
  await writeFile(path.join(root, "complete.request"), "complete");
  await vi.waitFor(async () => { expect(await readFile(path.join(root, "complete.ready"), "utf8")).toBe("ready"); }, { timeout: 1500 });
  const complete = await processes.monitor({ operation: "poll", id: job.id, waitMs: 0 }) as JobView;
  expect(complete).toMatchObject({ status: "running", output: message, cursor: 1, partialOutput: "" });
  expect(await processes.monitor({ operation: "poll", id: job.id, cursor: complete.cursor, waitMs: 0 })).toMatchObject({ output: "", cursor: 1 });
  await processes.monitor({ operation: "cancel", id: job.id });
  expect(await processes.monitor({ operation: "poll", id: job.id, cursor: 0, waitMs: 0 })).toMatchObject({ status: "cancelled", output: message, cursor: 1 });
  const progressCount = progress.length; await new Promise(resolve => setTimeout(resolve, 150));
  expect(progress).toHaveLength(progressCount); expect(progress.some(text => text.includes("未换行输出"))).toBe(true);
  if (encoding === "gbk") expect(progress.some(text => text.includes("[未换行输出已更新]\n一页永恒"))).toBe(true);
}, 15000);
