// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ChatWorkbench } from "../../src/renderer/chat/ChatWorkbench";
import { estimateTokens } from "../../src/main/core/model-settings";
import type { ChatSession, ChatSessionsApi, SessionEvent, SessionUsage } from "../../src/shared/chat";
import { attachmentApi } from "./attachment-fixture";

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
const session = (id = "a"): ChatSession => ({ id, title: `会话${id}`, createdAt: "1", updatedAt: "1", archived: false, draft: "", draftRevision: 0, revision: 1, seq: 0, status: "idle", items: [], contextTokensEstimate: 20000 });
const usage = (promptTokens: number, completionTokens: number, source: SessionUsage["source"] = "actual"): SessionUsage => ({ promptTokens, completionTokens, cachedTokens: 0, cacheWriteTokens: 0, source });
function fixture(initial = [session()], contextTokens = 100000) {
  const records = initial;
  const listeners = new Set<(event: SessionEvent) => void>();
  const api: ChatSessionsApi = {
    list: vi.fn(async () => structuredClone(records)), create: vi.fn(async () => session("new")),
    patch: vi.fn(async (_root, id, patch) => { const record = records.find(value => value.id === id)!; Object.assign(record, patch); record.revision++; return structuredClone(record); }),
    remove: vi.fn(async () => undefined), export: vi.fn(async () => "{}"), import: vi.fn(async () => session("imported")),
    send: vi.fn(async (_root, id) => records.find(record => record.id === id)!), guide: vi.fn(async (_root, id) => records.find(record => record.id === id)!),
    cancel: vi.fn(async () => undefined), answer: vi.fn(async (_root, id) => records.find(record => record.id === id)!), approve: vi.fn(async (_root, id) => records.find(record => record.id === id)!),
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const providers = (limit: number) => [{ id: "p", name: "测试", protocol: "openai" as const, baseUrl: "http://test", models: ["m"], modelSettings: { m: { contextTokens: limit } }, hasKey: false, keyStorage: "none" as const }];
  const props = { api, attachments: attachmentApi(), projectPath: "P", tasks: [], providers: providers(contextTokens), defaultModel: { providerId: "p", model: "m" }, review: undefined, busy: false, onSelectTask: vi.fn(), onNewTask: vi.fn(), onReview: vi.fn(async () => undefined), onError: vi.fn(), onFinished: vi.fn() };
  const view = render(<ChatWorkbench {...props} />);
  return { api, records, emit(next: ChatSession) { records[records.findIndex(record => record.id === next.id)] = next; act(() => { for (const listener of listeners) listener({ projectPath: "P", sessionId: next.id, ...(next.runId ? { runId: next.runId } : {}), seq: next.seq, session: structuredClone(next) }); }); }, setContextTokens(limit: number) { view.rerender(<ChatWorkbench {...props} providers={providers(limit)} />); } };
}
const indicator = () => screen.getByRole("img", { name: /上下文占用/ });

test("separates current context, the last request and cumulative run usage", async () => {
  fixture([{ ...session(), usage: usage(350000, 8000), lastRequestUsage: usage(19000, 700) }]);
  await screen.findByRole("heading", { name: "会话a" });
  expect(indicator()).toHaveTextContent("20%");
  expect(indicator()).toHaveAttribute("title", expect.stringContaining("当前上下文估算 20000 / 100000 tokens"));
  expect(indicator()).toHaveAttribute("title", expect.stringContaining("最近请求：实际输入 19000 · 输出 700 tokens"));
  expect(indicator()).toHaveAttribute("title", expect.stringContaining("本轮累计：实际输入 350000 · 输出 8000 tokens"));
});

test("does not label estimated or unavailable usage as actual", async () => {
  fixture([{ ...session(), usage: usage(50000, 900, "missing"), lastRequestUsage: usage(19000, 700, "estimated") }]);
  await screen.findByRole("heading", { name: "会话a" });
  expect(indicator()).toHaveAttribute("title", expect.stringContaining("最近请求：估算输入 19000 · 输出 700 tokens"));
  expect(indicator()).toHaveAttribute("title", expect.stringContaining("本轮累计：用量未提供"));
  expect(indicator().getAttribute("title")).not.toContain("实际");
});

test("updates the ring from a new runtime estimate while tools are running", async () => {
  const f = fixture([{ ...session(), runId: "run", status: "running" }]);
  await screen.findByRole("heading", { name: "会话a" });
  f.emit({ ...f.records[0]!, revision: 2, seq: 1, contextTokensEstimate: 65000, items: [{ id: "tool", kind: "tool", callId: "call", name: "Read", arguments: "{}", output: "fixture", status: "ok" }] });
  expect(indicator()).toHaveTextContent("65%");
  expect(indicator()).toHaveAttribute("aria-label", "上下文占用 65000 / 100000 tokens");
});

test("includes the local draft immediately without waiting for persistence", async () => {
  const f = fixture(); await screen.findByRole("heading", { name: "会话a" });
  vi.mocked(f.api.patch).mockImplementation(() => new Promise(() => undefined));
  const text = "草稿".repeat(10000);
  fireEvent.change(screen.getByLabelText("任务消息"), { target: { value: text } });
  const projected = 20000 + estimateTokens(text);
  expect(indicator()).toHaveAttribute("aria-label", `上下文占用 ${projected} / 100000 tokens`);
  expect(indicator()).toHaveAttribute("title", expect.stringContaining(`待发送估算 ${estimateTokens(text)} tokens`));
  fireEvent.change(screen.getByLabelText("任务消息"), { target: { value: "" } });
  expect(indicator()).toHaveAttribute("aria-label", "上下文占用 20000 / 100000 tokens");
});

test("includes queued guidance when staging clears the composer draft", async () => {
  fixture([{ ...session(), runId: "run", status: "running" }]);
  await screen.findByRole("heading", { name: "会话a" });
  const text = "补充要求".repeat(3000);
  fireEvent.change(screen.getByLabelText("任务消息"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  expect(screen.getByLabelText("任务消息")).toHaveValue("");
  expect(screen.getByRole("region", { name: "待引导消息" })).toBeVisible();
  expect(indicator()).toHaveAttribute("aria-label", `上下文占用 ${20000 + estimateTokens(text)} / 100000 tokens`);
});

test("counts pending images independently of their draft placeholder", async () => {
  fixture(); await screen.findByRole("heading", { name: "会话a" });
  const image = { name: "screen.png", type: "image/png", size: 3, arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer } as unknown as File;
  fireEvent.change(screen.getByLabelText("添加附件文件"), { target: { files: [image] } });
  await screen.findByRole("button", { name: "移除附件 screen.png" });
  const draft = (screen.getByLabelText("任务消息") as HTMLTextAreaElement).value;
  expect(indicator()).toHaveAttribute("aria-label", `上下文占用 ${20000 + estimateTokens(draft) + 1024} / 100000 tokens`);
  fireEvent.change(screen.getByLabelText("任务消息"), { target: { value: "" } });
  expect(indicator()).toHaveAttribute("aria-label", "上下文占用 21024 / 100000 tokens");
  fireEvent.click(screen.getByRole("button", { name: "移除附件 screen.png" }));
  expect(indicator()).toHaveAttribute("aria-label", "上下文占用 20000 / 100000 tokens");
});

test("keeps pending estimates session-specific and follows the configured context window", async () => {
  const f = fixture([session("a"), { ...session("b"), contextTokensEstimate: 60000 }]);
  await screen.findByRole("heading", { name: "会话a" });
  fireEvent.change(screen.getByLabelText("任务消息"), { target: { value: "pending".repeat(1000) } });
  fireEvent.click(screen.getByRole("button", { name: "会话b" }));
  expect(indicator()).toHaveAttribute("aria-label", "上下文占用 60000 / 100000 tokens");
  f.setContextTokens(200000);
  await waitFor(() => expect(indicator()).toHaveTextContent("30%"));
  expect(indicator()).toHaveAttribute("aria-label", "上下文占用 60000 / 200000 tokens");
});
