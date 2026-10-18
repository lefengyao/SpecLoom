import { expect, test } from "vitest";
import { AgentConversationSchema, boundConversation, PERSISTED_CONVERSATION_JSON_LIMIT, PERSISTED_CONVERSATION_MESSAGE_LIMIT } from "../../src/main/core/agent-conversation";
import type { AgentMessage } from "../../src/main/core/agent-client";

function longConversation(): AgentMessage[] {
  return Array.from({ length: 120 }, (_, index): AgentMessage[] => [
    { role: "user", content: `Goal ${index}: `.padEnd(3000, "u") },
    { role: "assistant", content: `Answer ${index}: `.padEnd(3000, "a") },
  ]).flat();
}

test("retains conversation above the former 96-message and 256KB persistence bounds", () => {
  const history = longConversation();
  expect(history.length).toBeGreaterThan(96);
  expect(JSON.stringify(history).length).toBeGreaterThan(262_144);

  const retained = boundConversation(history);

  expect(retained).toEqual(history);
  expect(AgentConversationSchema.safeParse(history).success).toBe(true);
  expect(AgentConversationSchema.safeParse(retained).success).toBe(true);
});

test("retains more than 256KB of complete tool batches and redacts their credentials", () => {
  const secret = "capacity-test-private-key";
  const history: AgentMessage[] = [{ role: "user", content: "Preserve this original goal" }];
  for (let index = 0; index < 50; index++) history.push(
    { role: "assistant", content: null, tool_calls: [{ id: `read-${index}`, type: "function", function: {
      name: "Read", arguments: JSON.stringify({ file: `${index}.md`, secret }),
    } }] },
    { role: "tool", tool_call_id: `read-${index}`, content: `${secret}\n${"x".repeat(6000)}` },
  );

  const retained = boundConversation(history, secret, history[0]);

  expect(retained).toHaveLength(history.length);
  expect(retained[0]).toEqual(history[0]);
  expect(retained.at(-1)?.tool_call_id).toBe("read-49");
  expect(JSON.stringify(retained).length).toBeGreaterThan(262_144);
  expect(JSON.stringify(retained)).not.toContain(secret);
  expect(AgentConversationSchema.safeParse(retained).success).toBe(true);
});

test("keeps a finite default message ceiling aligned with persisted validation", () => {
  const history = Array.from({ length: PERSISTED_CONVERSATION_MESSAGE_LIMIT + 1 }, (_, index): AgentMessage => ({
    role: "user", content: `Turn ${index}`,
  }));

  const retained = boundConversation(history);

  expect(PERSISTED_CONVERSATION_MESSAGE_LIMIT).toBe(4096);
  expect(retained).toHaveLength(PERSISTED_CONVERSATION_MESSAGE_LIMIT);
  expect(retained[0]).toEqual(history[1]);
  expect(retained.at(-1)).toEqual(history.at(-1));
  expect(AgentConversationSchema.safeParse(history).success).toBe(false);
  expect(AgentConversationSchema.safeParse(retained).success).toBe(true);
});

test("keeps a finite default JSON ceiling aligned with persisted validation", () => {
  const history = Array.from({ length: 40 }, (_, index): AgentMessage => ({ role: "assistant", content: `${index}: `.padEnd(131_000, "x") }));
  history.push({ role: "user", content: "Keep this latest goal" });

  const retained = boundConversation(history);

  expect(PERSISTED_CONVERSATION_JSON_LIMIT).toBe(4_194_304);
  expect(JSON.stringify(retained).length).toBeLessThanOrEqual(PERSISTED_CONVERSATION_JSON_LIMIT);
  expect(retained).toHaveLength(33);
  expect(retained.at(-1)).toEqual(history.at(-1));
  expect(AgentConversationSchema.safeParse(history).success).toBe(false);
  expect(AgentConversationSchema.safeParse(retained).success).toBe(true);
});
