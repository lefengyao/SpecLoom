import { afterEach, describe, expect, it, vi } from "vitest";
import { webExtract } from "../../src/main/core/search/webExtractService";

const publicUrl = "https://example.com/article";

function hostedResponse(content: string, sse = false): Response {
  const envelope = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ url: publicUrl, content }) }] } });
  return new Response(sse ? `event: message\ndata: ${envelope}\n\n` : envelope, {
    status: 200, headers: { "content-type": sse ? "text/event-stream" : "application/json" },
  });
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

describe("webExtract service contract", () => {
  it.each(["off", "native"] as const)("does not dispatch extraction in %s mode", async mode => {
    const fetcher = vi.fn();
    await expect(webExtract(publicUrl, { mode, fetcher })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([false, true])("extracts and unwraps the hosted MCP page record for an SSE response: %s", async sse => {
    const fetcher = vi.fn<typeof fetch>(async () => hostedResponse("# Example\n\nReadable page body.", sse));
    const result = await webExtract(publicUrl, { mode: "free", fetcher: fetcher as typeof fetch });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.anysearch.com/mcp");
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(JSON.parse(String(init?.body))).toEqual({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "extract", arguments: { url: publicUrl } } });
    expect(result).toMatchObject({ url: publicUrl, content: "# Example\n\nReadable page body.", truncated: false, provider: "free" });
    expect(Number.isNaN(Date.parse(result.extractedAt))).toBe(false);
  });

  it("sends self-hosted extraction mode and maxChars through the v1 contract", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ url: publicUrl, content: "Page body", truncated: false }));
    const result = await webExtract(publicUrl, { mode: "self-hosted", selfHostedUrl: "http://127.0.0.1:8091/", maxChars: 14000, fetcher: fetcher as typeof fetch });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8091/v1/extract");
    expect(JSON.parse(String(init?.body))).toEqual({ url: publicUrl, mode: "auto", maxChars: 14000 });
    expect(result.content).toBe("Page body");
  });

  it.each([{ requested: 20, expected: 1000 }, { requested: 60000, expected: 50000 }, { requested: 1400.9, expected: 1400 }, { requested: Number.NaN, expected: 12000 }])("bounds self-hosted body requests at $expected characters", async ({ requested, expected }) => {
    const content = "x".repeat(expected + 10);
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ url: publicUrl, content, truncated: false }));
    const result = await webExtract(publicUrl, { mode: "self-hosted", maxChars: requested, fetcher: fetcher as typeof fetch });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ mode: "auto", maxChars: expected });
    expect(result.content).toBe(content.slice(0, expected));
    expect(result.truncated).toBe(true);
  });

  it("caps a long hosted body after unwrapping its JSON record", async () => {
    const content = "# Article\n\n" + "long page ".repeat(300);
    const fetcher = vi.fn<typeof fetch>(async () => hostedResponse(content));
    const result = await webExtract(publicUrl, { mode: "free", maxChars: 1000, fetcher: fetcher as typeof fetch });
    expect(result.content).toBe(content.slice(0, 1000));
    expect(result.truncated).toBe(true);
    expect(result.content.startsWith("{\"url\"")).toBe(false);
  });

  it("preserves service truncation and the final extracted URL", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ url: "https://example.com/final", content: "Limited body", truncated: true }));
    const result = await webExtract(publicUrl, { mode: "self-hosted", fetcher: fetcher as typeof fetch });
    expect(result).toMatchObject({ url: "https://example.com/final", content: "Limited body", truncated: true });
  });

  it("falls back from hosted extraction to the self-hosted service in auto mode", async () => {
    const fetcher = vi.fn<typeof fetch>(async input => String(input) === "https://api.anysearch.com/mcp"
      ? new Response("temporarily unavailable", { status: 503 })
      : Response.json({ url: publicUrl, content: "Self-hosted body", truncated: false }));
    const result = await webExtract(publicUrl, { mode: "auto", maxChars: 1500, fetcher: fetcher as typeof fetch });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(["https://api.anysearch.com/mcp", "http://127.0.0.1:8090/v1/extract"]);
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({ url: publicUrl, mode: "auto", maxChars: 1500 });
    expect(result.content).toBe("Self-hosted body");
  });

  it.each([
    "http://localhost/private", "http://service.localhost/private", "http://127.0.0.1/private", "http://10.0.0.1/private",
    "http://172.16.0.1/private", "http://192.168.1.1/private", "http://169.254.169.254/latest/meta-data/", "http://2130706433/private",
    "http://[::1]/private", "http://[fc00::1]/private", "http://[fe80::1]/private", "http://[::ffff:127.0.0.1]/private",
    "https://username:password@example.com/", "file:///private.md", "/relative-url",
  ])("refuses a non-public or invalid URL before dispatch: %s", async url => {
    const fetcher = vi.fn();
    await expect(webExtract(url, { mode: "free", fetcher })).rejects.toMatchObject({ code: "INVALID_ARGS" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("stops extraction without another provider request after caller cancellation", async () => {
    const controller = new AbortController();
    const fetcher = abortingFetch();
    const pending = webExtract(publicUrl, { mode: "auto", signal: controller.signal, fetcher: fetcher as typeof fetch });
    const rejection = expect(pending).rejects.toMatchObject({ code: "WEB_ABORTED" });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    controller.abort();
    await rejection;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("classifies an extraction deadline as TOOL_TIMEOUT without falling back", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const fetcher = abortingFetch();
    const pending = webExtract(publicUrl, { mode: "auto", fetcher: fetcher as typeof fetch });
    const rejection = expect(pending).rejects.toMatchObject({ code: "TOOL_TIMEOUT" });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    deadline.abort(new DOMException("Timed out", "TimeoutError"));
    await rejection;
    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
