// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ChatTimeline } from "../../src/renderer/chat/ChatTimeline";
import type { ChatItem } from "../../src/shared/chat";

const { parsed } = vi.hoisted(() => ({ parsed: vi.fn() }));
vi.mock("react-markdown", async importOriginal => {
  const module = await importOriginal<typeof import("react-markdown")>();
  const Original = module.default;
  return { ...module, default: (props: React.ComponentProps<typeof Original>) => {
    parsed(props.children);
    return <Original {...props} />;
  } };
});
afterEach(() => { cleanup(); parsed.mockClear(); });
const user = (id: string): ChatItem => ({ id, kind: "message", role: "user", content: id });
const live: ChatItem = { id: "run:thinking", kind: "thinking", content: "Live reasoning", partial: true };
const onAnswer = vi.fn();

test("stream updates do not reparse an expanded historical reasoning message", () => {
  const old: ChatItem = { id: "old:thinking", kind: "thinking", content: "Historical **reasoning**" };
  const items = [user("old question"), old, user("new question"), live];
  const view = render(<ChatTimeline sessionId="s" runId="run" running items={items} onAnswer={onAnswer} />);
  const details = screen.getAllByLabelText("模型返回的思考")[0] as HTMLDetailsElement;
  details.open = true; fireEvent(details, new Event("toggle"));
  const current = screen.getAllByLabelText("模型返回的思考")[1] as HTMLDetailsElement;
  current.open = true; fireEvent(current, new Event("toggle"));
  expect(parsed.mock.calls.filter(([text]) => text === old.content)).toHaveLength(1);
  view.rerender(<ChatTimeline sessionId="s" runId="run" running items={[...items.slice(0, -1), { ...live, content: "Live reasoning continues" }]} onAnswer={onAnswer} />);
  expect(parsed.mock.calls.filter(([text]) => text === old.content)).toHaveLength(1);
  expect(screen.getByText("Live reasoning continues")).toBeVisible();
});

test("stream and composer updates do not reparse unchanged historical replies", () => {
  const reply: ChatItem = { id: "reply", kind: "message", role: "assistant", content: "Historical **answer**" };
  const items = [user("old question"), { id: "old:thinking", kind: "thinking" as const, content: "Old thinking" }, reply, user("new question"), live];
  const view = render(<ChatTimeline sessionId="s" runId="run" running items={items} onAnswer={onAnswer} />);
  expect(parsed.mock.calls.filter(([text]) => text === reply.content)).toHaveLength(1);
  view.rerender(<ChatTimeline sessionId="s" runId="run" running items={items} onAnswer={onAnswer}><p>Composer changed</p></ChatTimeline>);
  view.rerender(<ChatTimeline sessionId="s" runId="run" running items={[...items.slice(0, -1), { ...live, content: "Live reasoning continues" }]} onAnswer={onAnswer} />);
  expect(parsed.mock.calls.filter(([text]) => text === reply.content)).toHaveLength(1);
});

test("completed tool-heavy turns require linear history inspection", () => {
  let inspections = 0;
  const tools: ChatItem[] = Array.from({ length: 1500 }, (_, index) => ({ id: `tool-${index}`, get kind() { inspections++; return "tool" as const; }, callId: `call-${index}`, name: "Read", arguments: "{}", output: "完成", status: "ok" as const }));
  render(<ChatTimeline sessionId="s" items={[user("长任务"), ...tools, { id: "answer", kind: "message", role: "assistant", content: "任务完成" }]} onAnswer={onAnswer} />);
  expect(screen.getByText("任务完成")).toBeVisible();
  expect(screen.getByText(/第 1 轮工具调用 · 1500 次/)).toBeVisible();
  expect(inspections).toBeLessThan(tools.length * 20);
});
