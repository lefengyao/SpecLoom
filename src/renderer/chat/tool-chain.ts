import type { ChatItem } from "../../shared/chat";

export type ChatToolItem = Extract<ChatItem, { kind: "tool" }>;
export type ChatDetailItem = Extract<ChatItem, { kind: "tool" | "thinking" | "activity" }>;
export type ToolSidebarSelection = { turnId: string; itemId?: string };
export type ChatTurn = { id: string; number: number; items: ChatItem[]; details: ChatDetailItem[]; tools: ChatToolItem[] };
export type ChatDetailStage = { id: string; number: number; details: ChatDetailItem[]; tools: ChatToolItem[] };
export type ChatTurnBlock = { kind: "details"; stage: ChatDetailStage } | { kind: "item"; item: Exclude<ChatItem, ChatDetailItem>; progress: boolean };

export const toolStatusLabels: Record<ChatToolItem["status"], string> = {
  receiving: "接收参数", running: "调用中", waiting: "等待确认", ok: "完成", error: "失败", cancelled: "已停止",
};

/** User messages remain durable turn boundaries, including imported sessions. */
export function splitChatTurns(items: ChatItem[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  let number = 0;
  for (const item of items) {
    if (item.kind === "message" && item.role === "user" && !item.guidance) {
      number++;
      turns.push({ id: item.id, number, items: [], details: [], tools: [] });
    }
    if (!turns.length) turns.push({ id: item.id, number: 0, items: [], details: [], tools: [] });
    const turn = turns[turns.length - 1]!;
    turn.items.push(item);
    if (item.kind === "tool" || item.kind === "thinking" || item.kind === "activity") turn.details.push(item);
    if (item.kind === "tool") turn.tools.push(item);
  }
  return turns;
}

/** Visual stages stop at each public message or interaction; sidebar turns stay intact. */
export function splitTurnBlocks(turn: ChatTurn): ChatTurnBlock[] {
  const blocks: ChatTurnBlock[] = [];
  let stage: ChatDetailStage | undefined;
  let number = 0;
  for (const item of turn.items) {
    if (item.kind === "tool" || item.kind === "thinking" || item.kind === "activity") {
      if (!stage) {
        stage = { id: item.id, number: ++number, details: [], tools: [] };
        blocks.push({ kind: "details", stage });
      }
      stage.details.push(item);
      if (item.kind === "tool") stage.tools.push(item);
    } else {
      stage = undefined;
      blocks.push({ kind: "item", item, progress: false });
    }
  }
  let laterWork = false;
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index]!;
    if (block.kind === "details" || block.item.kind !== "message") laterWork = true;
    else if (block.item.role === "assistant" && block.item.content) {
      block.progress = laterWork;
      laterWork = true;
    }
  }
  return blocks;
}

export function toolCounts(tools: ChatToolItem[]) {
  const counts = { pending: 0, completed: 0, failed: 0, cancelled: 0 };
  for (const tool of tools) {
    if (tool.status === "ok") counts.completed++;
    else if (tool.status === "error") counts.failed++;
    else if (tool.status === "cancelled") counts.cancelled++;
    else counts.pending++;
  }
  return counts;
}
