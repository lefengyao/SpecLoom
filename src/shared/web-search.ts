import { z } from "zod";

export const WebSearchModeSchema = z.enum(["off", "auto", "native", "free", "self-hosted"]);
export type WebSearchMode = z.infer<typeof WebSearchModeSchema>;
export const DEFAULT_WEB_SEARCH_MODE: WebSearchMode = "off";
export const WEB_SEARCH_MODE_LABELS: Record<WebSearchMode, string> = {
  off: "关闭",
  auto: "自动",
  native: "厂商原生",
  free: "免费托管",
  "self-hosted": "本机自建",
};
