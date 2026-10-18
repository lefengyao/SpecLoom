import { describe, expect, it } from "vitest";
import { DiagnosticEventInputSchema } from "../../src/shared/diagnostics";

describe("diagnostic event schema", () => {
  it("accepts allowlisted request lifecycle metadata", () => {
    expect(DiagnosticEventInputSchema.parse({
      type: "stream_read_error",
      diagnosticId: "9c1c7c73-ec83-41bb-8e1f-6d4770039f56",
      attempt: 1,
      protocol: "openai",
      errorCategory: "response_stream_error",
      causeCode: "UND_ERR_SOCKET",
      receivedBytes: 96,
      receivedFrames: 2,
      completionReceived: false,
    }).type).toBe("stream_read_error");
  });

  it("rejects raw messages, payloads, and unknown fields", () => {
    expect(DiagnosticEventInputSchema.safeParse({
      type: "stream_read_error",
      diagnosticId: "9c1c7c73-ec83-41bb-8e1f-6d4770039f56",
      message: "secret",
      prompt: "private",
      headers: { authorization: "secret" },
    }).success).toBe(false);
  });
});
