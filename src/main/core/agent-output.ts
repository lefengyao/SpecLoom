const secretField = /(?:api[-_]?key|password|secret|authorization|credential|cookie|^(?:access|refresh|auth)[-_]?token$)/i;
const OUTPUT_LIMIT = 16_384;

export function redactSecret(value: string, secret?: string): string {
  const scrubbed = secret ? value.split(secret).join("[redacted]") : value;
  return scrubbed.replace(/\bBearer\s+[^\s,;"'\\}\]]+/gi, "Bearer [redacted]");
}

export function toolOutput(ok: boolean, value: unknown, secret?: string): string {
  let truncated = false;
  const seen = new WeakSet<object>();
  function compact(item: unknown, depth = 0): unknown {
    if (typeof item === "string") {
      const safe = redactSecret(item, secret);
      if (safe.length <= 8_000) return safe;
      truncated = true;
      return `${safe.slice(0, 8_000)}[truncated]`;
    }
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number") return Number.isFinite(item) ? item : null;
    if (typeof item !== "object") return null;
    if (depth > 8 || seen.has(item)) { truncated = true; return "[truncated]"; }
    seen.add(item);
    if (Array.isArray(item)) {
      if (item.length > 64) truncated = true;
      return item.slice(0, 64).map((entry) => compact(entry, depth + 1));
    }
    const entries = Object.entries(item);
    if (entries.length > 64) truncated = true;
    return Object.fromEntries(entries.slice(0, 64).filter(([key]) => !secretField.test(key))
      .map(([key, entry]) => [redactSecret(key, secret).slice(0, 256), compact(entry, depth + 1)]));
  }
  const result = compact(value);
  const envelope = ok ? { ok: true, result, truncated } : { ok: false, error: result, truncated };
  const serialized = JSON.stringify(envelope);
  if (serialized.length <= OUTPUT_LIMIT) return serialized;
  const preview = serialized.slice(0, 6_000);
  return JSON.stringify({ ok, truncated: true, preview });
}
