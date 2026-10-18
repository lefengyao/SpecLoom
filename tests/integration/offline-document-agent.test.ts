import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OfflineDocumentStore } from "../../src/main/core/offline-documents";
import { WorkspaceTools } from "../../src/main/core/tools/workspace-tools";
import { AgentRuntime } from "../../src/main/core/agent-runtime";
import { redactSecret } from "../../src/main/core/agent-output";
import type { OfflineDocumentRead } from "../../src/shared/offline-documents";
import { DesktopSessions } from "../../src/main/desktop-sessions";
import type { RuntimeModelProfile } from "../../src/main/core/model-config";

let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

test.each(["runtime", "desktop"])("%s: the model receives every page and a fact beyond the old 8000-character cutoff", async (mode) => {
  root = await mkdtemp(path.join(os.tmpdir(), "specloom-doc-agent-"));
  const secret = "PAGE-SECRET-CREDENTIAL";
  const text = "x".repeat(5995) + secret + "y".repeat(16000) + "\nFINAL_FACT=42";
  const source = path.join(root, "guide.md"); await writeFile(source, text, "utf8");
  const store = new OfflineDocumentStore(path.join(root, "user"));
  const bundle = await store.importFiles([source], "Guide", "1", true);
  const tools = new WorkspaceTools(root, "pages", { offlineDocuments: store });
  const pages: OfflineDocumentRead[] = [];
  let turn = 0;
  const call = (name: string, input: object) => Response.json({ choices: [{ message: { role: "assistant", content: null,
    tool_calls: [{ id: `call-${++turn}`, type: "function", function: { name, arguments: JSON.stringify(input) } }] } }] });
  const fetcher: typeof fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      const last = request.messages.at(-1);
      if (last.role !== "tool") return call("ToolSearch", { query: "OfflineDocsRead" });
      const assistant = request.messages.findLast((message: { role: string }) => message.role === "assistant");
      if (assistant.tool_calls[0].function.name === "ToolSearch") return call("OfflineDocsRead", { bundleId: bundle.id, path: "guide.md" });
      const output = JSON.parse(last.content);
      const page = output.result as OfflineDocumentRead; pages.push(page);
      if (page.page?.hasMore) return call("OfflineDocsRead", { bundleId: bundle.id, versionId: page.versionId,
        path: "guide.md", offset: page.page.nextOffset });
      return Response.json({ choices: [{ message: { role: "assistant", content: page.content?.includes("FINAL_FACT=42") ? "42" : "incomplete" } }] });
  };
  const profile: RuntimeModelProfile = { id: "fixture", name: "Fixture", model: "fixture", protocol: "openai", provider: "openai-compatible",
    baseUrl: "https://model.test/v1", approved: true, timeoutMs: 1000, maxToolRounds: 12 };
  let sessions: DesktopSessions | undefined;
  try {
    if (mode === "desktop") {
      vi.stubGlobal("fetch", fetcher);
      sessions = new DesktopSessions(path.join(root, "user"), () => undefined, async () => profile, async () => "", async () => secret, undefined, store);
      const session = await sessions.create("", "Pages");
      await sessions.send("", session.id, "Read the document's final fact");
      expect((await sessions.list(""))[0]?.items.some(item => item.kind === "message" && item.content === "42")).toBe(true);
    } else {
      const runtime = new AgentRuntime({ catalog: tools.catalog, fetch: fetcher,
        executeTool: call => tools.execute(call.name, call.input, call.signal, call.onProgress, call.redactText) });
      const result = await runtime.run({ taskId: "pages", prompt: "Read the document's final fact", secret, profile });
      expect(result.summary).toBe("42");
    }
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.map(page => page.content).join("")).toBe(redactSecret(text, secret));
    expect(pages.every(page => page.page?.totalChars === redactSecret(text, secret).length)).toBe(true);
  } finally { await sessions?.cancelAll(); vi.unstubAllGlobals(); await tools.close(); }
});
