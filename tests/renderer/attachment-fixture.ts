import { vi } from "vitest";
import type { DesktopApi } from "../../src/shared/desktop-api";

/** Transport fixture: parser correctness is covered by real document core tests. */
export function attachmentApi(): NonNullable<DesktopApi["chatAttachments"]> {
  return {
    prepare: vi.fn(async (_project, _session, _request, input) => input.declaredMime?.startsWith("image/")
      ? { kind: "image" as const, name: input.name, size: input.bytes.length, image: { name: input.name, mimeType: input.declaredMime, base64: Buffer.from(input.bytes).toString("base64") } }
      : { kind: "document" as const, name: input.name, size: input.bytes.length, text: new TextDecoder().decode(input.bytes), notices: [], truncated: false }),
    cancel: vi.fn(async () => undefined),
    readClipboard: vi.fn(async () => ({ files: [], notices: [] })),
  };
}
