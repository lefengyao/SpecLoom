import { afterEach, describe, expect, it, vi } from "vitest";
import { selfHostedBaseUrl, webSearch } from "../../src/main/core/search/webSearchService";

const anysearchUrl = "https://api.anysearch.com/mcp";
const source = { url: "https://search.example/article", title: "Search article", snippet: "A source excerpt", publishedAt: "2026-10-01T00:00:00Z" };
const nativeProvider = { protocol: "anthropic" as const, baseUrl: "https://api.anthropic.com", apiKey: "test-key" };

function mcpResponse(sources: unknown[] = [source], sse = false): Response {
  const envelope = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ sources }) }] } });
  return new Response(sse ? `event: message\ndata: ${envelope}\n\ndata: [DONE]\n\n` : envelope, {
    status: 200, headers: { "content-type": sse ? "text/event-stream" : "application/json" },
  });
}

function selfHostedResponse(query = "query", sources: unknown[] = [source]): Response {
  return Response.json({ backend: "searxng", results: [{ query, sources, truncated: false }] });
}

function abortingFetch() {
  return vi.fn(async (_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    const abort = () => reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  }));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("webSearch service contract", () => {
  it("rejects empty and oversized queries before making a request", async () => {
    const fetcher = vi.fn();
    await expect(webSearch("   ", { mode: "free", fetcher })).rejects.toThrow("搜索关键词不能为空");
    await expect(webSearch("x".repeat(501), { mode: "free", fetcher })).rejects.toThrow("不能超过 500");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("never contacts a provider while search is off", async () => {
    const fetcher = vi.fn();
    await expect(webSearch("query", { mode: "off", fetcher })).rejects.toThrow("未开启");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([false, true])("uses the Anysearch tools/call contract for an SSE response: %s", async sse => {
    const fetcher = vi.fn<typeof fetch>(async () => mcpResponse([source], sse));
    const result = await webSearch("  query  ", { mode: "free", limit: 3, fetcher: fetcher as typeof fetch });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(anysearchUrl);
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(new Headers(init?.headers).get("accept")).toBe("application/json, text/event-stream");
    expect(JSON.parse(String(init?.body))).toEqual({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", arguments: { query: "query", max_results: 3 } } });
    expect(result).toMatchObject({ query: "query", provider: "free", results: [{ ...source, source: "search.example" }] });
    expect(Number.isNaN(Date.parse(result.searchedAt))).toBe(false);
  });

  it.each([{ requested: 0, expected: 1 }, { requested: 99, expected: 8 }, { requested: 3.8, expected: 3 }, { requested: Number.NaN, expected: 5 }])("caps the requested source count at $expected", async ({ requested, expected }) => {
    const sources = Array.from({ length: 10 }, (_, index) => ({ ...source, url: `https://search.example/${index}` }));
    const fetcher = vi.fn<typeof fetch>(async () => mcpResponse(sources));
    const result = await webSearch("query", { mode: "free", limit: requested, fetcher: fetcher as typeof fetch });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).params.arguments.max_results).toBe(expected);
    expect(result.results).toHaveLength(expected);
  });

  it("tries native, hosted MCP and self-hosted search in order when providers fail", async () => {
    const fetcher = vi.fn<typeof fetch>(async input => {
      const url = String(input);
      if (url === "http://127.0.0.1:8090/v1/search") return selfHostedResponse();
      return new Response("temporarily unavailable", { status: 503 });
    });
    const result = await webSearch("query", { mode: "auto", model: "claude-sonnet-4", provider: nativeProvider, fetcher: fetcher as typeof fetch });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(["https://api.anthropic.com/v1/messages", anysearchUrl, "http://127.0.0.1:8090/v1/search"]);
    expect(result.results[0]).toMatchObject(source);
  });

  it("skips native search for an unknown model in auto mode", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => mcpResponse());
    await webSearch("query", { mode: "auto", model: "deepseek-flash", provider: { ...nativeProvider, protocol: "openai" }, fetcher: fetcher as typeof fetch });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([anysearchUrl]);
  });

  it("posts normalized queries to the self-hosted v1 path and preserves publication dates", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => selfHostedResponse());
    const result = await webSearch(" query ", { mode: "self-hosted", limit: 4, selfHostedUrl: "http://127.0.0.1:8091/", fetcher: fetcher as typeof fetch });
    expect(fetcher.mock.calls[0]?.[0]).toBe("http://127.0.0.1:8091/v1/search");
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ queries: ["query"], maxResults: 4 });
    expect(result.results[0]).toMatchObject(source);
  });

  it.each([
    { name: "missing results", payload: {} },
    { name: "missing query result", payload: { results: [] } },
    { name: "extra query result", payload: { results: [{ query: "query", sources: [source] }, { query: "query", sources: [source] }] } },
    { name: "missing query echo", payload: { results: [{ sources: [source] }] } },
    { name: "wrong query echo", payload: { results: [{ query: "another query", sources: [source] }] } },
    { name: "missing sources", payload: { results: [{ query: "query" }] } },
    { name: "source without URL", payload: { results: [{ query: "query", sources: [{ title: "No URL" }] }] } },
    { name: "invalid source URL", payload: { results: [{ query: "query", sources: [{ url: "not-a-url" }] }] } },
    { name: "non-HTTP source URL", payload: { results: [{ query: "query", sources: [{ url: "file:///private.md" }] }] } },
  ])("rejects a self-hosted contract violation: $name", async ({ payload }) => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(payload));
    await expect(webSearch("query", { mode: "self-hosted", fetcher: fetcher as typeof fetch })).rejects.toMatchObject({ code: "WEB_PROVIDER_ERROR" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("accepts an empty self-hosted source list as a valid zero-result search", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => selfHostedResponse("query", []));
    const result = await webSearch("query", { mode: "self-hosted", fetcher: fetcher as typeof fetch });
    expect(result.results).toEqual([]);
  });

  it("resolves self-hosted URL from the SpecLoom setting before the compatibility setting", () => {
    vi.stubEnv("SPECLOOM_WEB_SEARCH_SELF_HOSTED_URL", "http://127.0.0.1:8092");
    vi.stubEnv("STORYFABRIC_WEB_SEARCH_SELF_HOSTED_URL", "http://127.0.0.1:8093");
    expect(selfHostedBaseUrl({})).toBe("http://127.0.0.1:8092");
    expect(selfHostedBaseUrl({ selfHostedUrl: "http://127.0.0.1:8094" })).toBe("http://127.0.0.1:8094");
  });

  it.each([
    { model: "gpt-5", protocol: "anthropic" as const },
    { model: "claude-sonnet-4", protocol: "openai" as const },
    { model: "gemini-2.5-pro", protocol: "gemini" as const },
    { model: "deepseek-flash", protocol: "openai" as const },
  ])("rejects native mode before dispatch for $model with $protocol", async ({ model, protocol }) => {
    const fetcher = vi.fn();
    await expect(webSearch("query", { mode: "native", model, provider: { ...nativeProvider, protocol }, fetcher })).rejects.toThrow("不支持");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { model: "gpt-5", protocol: "openai" as const },
    { model: "claude-sonnet-4", protocol: "anthropic" as const },
  ])("does not infer gateway native capability from the $model name", async ({ model, protocol }) => {
    const fetcher = vi.fn();
    await expect(webSearch("query", { mode: "native", model, provider: { ...nativeProvider, protocol, baseUrl: "https://gateway.example/v1" }, fetcher })).rejects.toThrow("不支持");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("skips a gateway route in auto mode even when the model name belongs to a native family", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => mcpResponse());
    await webSearch("query", { mode: "auto", model: "gpt-5", provider: { ...nativeProvider, protocol: "openai", baseUrl: "https://gateway.example/v1" }, fetcher: fetcher as typeof fetch });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([anysearchUrl]);
  });

  it("uses Anthropic Messages native search only with a matching model and protocol", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ content: [
      { type: "web_search_tool_result", content: [{ type: "web_search_result", url: source.url, title: source.title, page_age: source.publishedAt }] },
      { type: "text", text: "Found", citations: [{ type: "web_search_result_location", url: source.url, cited_text: source.snippet }] },
    ] }));
    const result = await webSearch("query", { mode: "native", model: "claude-sonnet-4", provider: { ...nativeProvider, baseUrl: "https://api.anthropic.com/v1" }, fetcher: fetcher as typeof fetch });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: "claude-sonnet-4", tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }] });
    expect(new Headers(init?.headers).get("x-api-key")).toBe("test-key");
    expect(result.results[0]).toMatchObject({ url: source.url, title: source.title, snippet: source.snippet, publishedAt: source.publishedAt });
  });

  it("uses OpenAI Responses native search and extracts URL citations", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ output: [
      { type: "web_search_call", id: "ws_1", status: "completed" },
      { type: "message", content: [{ type: "output_text", text: "Found", annotations: [{ type: "url_citation", url: source.url, title: source.title, start_index: 0, end_index: 5 }] }] },
    ] }));
    const result = await webSearch("query", { mode: "native", model: "gpt-5", provider: { ...nativeProvider, protocol: "openai", baseUrl: "https://api.openai.com/v1/chat/completions" }, fetcher: fetcher as typeof fetch });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: "gpt-5", tools: [{ type: "web_search" }] });
    expect(result.results[0]).toMatchObject({ url: source.url, title: source.title });
  });

  it("does not fall back after the caller cancels an active native search", async () => {
    const controller = new AbortController();
    const fetcher = abortingFetch();
    const pending = webSearch("query", { mode: "auto", model: "claude-sonnet-4", provider: nativeProvider, signal: controller.signal, fetcher: fetcher as typeof fetch });
    const rejection = expect(pending).rejects.toMatchObject({ code: "WEB_ABORTED" });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    controller.abort();
    await rejection;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("classifies a 30-second search deadline as TOOL_TIMEOUT without a fallback request", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const fetcher = abortingFetch();
    const pending = webSearch("query", { mode: "auto", model: "claude-sonnet-4", provider: nativeProvider, fetcher: fetcher as typeof fetch });
    const rejection = expect(pending).rejects.toMatchObject({ code: "TOOL_TIMEOUT" });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    deadline.abort(new DOMException("Timed out", "TimeoutError"));
    await rejection;
    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
