import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceTools } from "../../src/main/core/tools/workspace-tools";
import type { RuntimeModelProfile } from "../../src/main/core/model-config";

let root: string;
const worksets: WorkspaceTools[] = [];
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "specloom-web-tools-")); });
afterEach(async () => { await Promise.all(worksets.splice(0).map(tools => tools.close())); await rm(root, { recursive: true, force: true }); });
function workspace() { const tools = new WorkspaceTools(root, "web-tools"); worksets.push(tools); return tools; }
const profile: RuntimeModelProfile = { id: "test", name: "Test", provider: "openai-compatible", protocol: "openai", model: "gpt-4.1", baseUrl: "https://api.openai.com/v1", approved: true, timeoutMs: 5000 };
const hostedResult = () => Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ results: [{ title: "Reference", url: "https://example.com/guide", snippet: "Verified source" }] }) }] } });

test("off removes discovered web tools and rejects stale calls without network access", async () => {
  const tools = workspace(); const fetcher = vi.fn<typeof fetch>(async () => hostedResult());
  tools.setWebSearch({ mode: "free", fetcher });
  expect(tools.catalog.providerTools().map(tool => tool.function.name)).toEqual(expect.arrayContaining(["web_search", "web_extract"]));
  tools.setWebSearch({ mode: "off", fetcher });
  expect(tools.catalog.all().some(tool => tool.name.startsWith("web_"))).toBe(false);
  await expect(tools.execute("web_search", { query: "private draft" })).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

test("free search returns untrusted source data without resolving model credentials", async () => {
  const tools = workspace(); const fetcher = vi.fn<typeof fetch>(async () => hostedResult()); const resolveCredential = vi.fn(async () => "model-private-key");
  tools.setWebSearch({ mode: "free", profile, fetcher, resolveCredential }); tools.setPermissions("full");
  expect((await tools.capabilities()).tools.map(tool => tool.name)).toContain("web_search");
  const result = await tools.execute("web_search", { query: "Godot docs", limit: 5 });
  expect(result).toMatchObject({ query: "Godot docs", results: [{ url: "https://example.com/guide" }], notice: expect.stringMatching(/untrusted|不可信/i) });
  expect(resolveCredential).not.toHaveBeenCalled();
  expect(JSON.stringify(fetcher.mock.calls)).not.toContain("model-private-key");
});

test("native only registers search and resolves its selected model credential at execution", async () => {
  const tools = workspace(); const resolveCredential = vi.fn(async () => "native-private-key");
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: "Reference", annotations: [{ type: "url_citation", url: "https://example.com/guide", title: "Reference" }] }] }] }));
  tools.setWebSearch({ mode: "native", profile, resolveCredential, fetcher }); tools.setPermissions("full");
  expect(tools.catalog.all().map(tool => tool.name)).toContain("web_search");
  expect(tools.catalog.all().map(tool => tool.name)).not.toContain("web_extract");
  expect(resolveCredential).not.toHaveBeenCalled();
  await tools.execute("web_search", { query: "Godot" });
  expect(resolveCredential).toHaveBeenCalledWith(profile);
  expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get("authorization")).toBe("Bearer native-private-key");
});

test("auto falls back to anonymous free search when native credentials cannot be read", async () => {
  const tools = workspace(); const fetcher = vi.fn<typeof fetch>(async () => hostedResult());
  const resolveCredential = vi.fn(async () => { throw new Error("vault unavailable"); });
  tools.setWebSearch({ mode: "auto", profile, fetcher, resolveCredential }); tools.setPermissions("full");
  await expect(tools.execute("web_search", { query: "Godot" })).resolves.toMatchObject({ results: [{ url: "https://example.com/guide" }] });
  expect(resolveCredential).toHaveBeenCalledWith(profile);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(String(fetcher.mock.calls[0]![0])).toBe("https://api.anysearch.com/mcp");
  expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get("authorization")).toBeNull();
});

test("native reports credential failures without contacting a fallback service", async () => {
  const tools = workspace(); const fetcher = vi.fn<typeof fetch>();
  tools.setWebSearch({ mode: "native", profile, fetcher, resolveCredential: async () => { throw new Error("vault unavailable"); } }); tools.setPermissions("full");
  await expect(tools.execute("web_search", { query: "Godot" })).rejects.toMatchObject({ code: "MODEL_ERROR", message: "vault unavailable" });
  expect(fetcher).not.toHaveBeenCalled();
});

test("auto propagates cancellation during credential resolution without a fallback request", async () => {
  const tools = workspace(); const fetcher = vi.fn<typeof fetch>(); const controller = new AbortController();
  tools.setWebSearch({ mode: "auto", profile, fetcher, resolveCredential: async () => { controller.abort(); throw new Error("vault unavailable"); } }); tools.setPermissions("full");
  await expect(tools.execute("web_search", { query: "Godot" }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(fetcher).not.toHaveBeenCalled();
});

test("ask denies web requests before dispatch while auto permits enabled public reads", async () => {
  const tools = workspace(); const fetcher = vi.fn<typeof fetch>(async () => hostedResult()); const approve = vi.fn(async () => false);
  tools.setWebSearch({ mode: "free", fetcher }); tools.setPermissions("ask", approve);
  await expect(tools.execute("web_search", { query: "Godot" })).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
  expect(fetcher).not.toHaveBeenCalled();
  expect(approve).toHaveBeenCalledWith(expect.objectContaining({ toolName: "web_search", risk: "standard" }));
  tools.setPermissions("auto", approve);
  await expect(tools.execute("web_search", { query: "Godot" })).resolves.toHaveProperty("results");
  expect(approve).toHaveBeenCalledTimes(1);
});

test("provider failures retain a stable web error code in tool error details", async () => {
  const tools = workspace(); tools.setPermissions("full");
  tools.setWebSearch({ mode: "free", fetcher: async () => new Response("unavailable", { status: 503 }) });
  await expect(tools.execute("web_search", { query: "Godot" })).rejects.toMatchObject({ code: "MODEL_ERROR", details: { reason: "WEB_PROVIDER_ERROR" } });
});
