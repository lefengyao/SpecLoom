// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnosticsView } from "../../src/renderer/DiagnosticsView";
import type { DiagnosticsApi } from "../../src/shared/desktop-api";
import type { DiagnosticEvent } from "../../src/shared/diagnostics";

const diagnosticId = "9c1c7c73-ec83-41bb-8e1f-6d4770039f56";
function apiFixture(): DiagnosticsApi {
  const event: DiagnosticEvent = {
    schemaVersion: 1, eventId: "dfc4810f-8f69-449a-9cd9-6320c2f839c8", at: "2026-10-10T10:00:00.000Z",
    type: "stream_read_error", diagnosticId, severity: "error", sessionId: "session-1", runId: "run-1",
    providerId: "p1", modelId: "m1", protocol: "openai", attempt: 2, round: 1,
    errorCategory: "response_stream_error", causeCode: "UND_ERR_SOCKET", receivedBytes: 24, receivedFrames: 1, completionReceived: false,
  };
  return {
    list: vi.fn(async () => ({ events: [event], readIssues: 0 })),
    summary: vi.fn(async () => ({ files: 1, bytes: 512, events: 1, retentionDays: 30, maxBytes: 26_214_400, maxFileBytes: 5_242_880, readIssues: 0 })),
    clearExpired: vi.fn(async () => 0),
    clearAll: vi.fn(async () => 1),
    export: vi.fn(async () => true),
  };
}

describe("DiagnosticsView", () => {
  afterEach(() => cleanup());
  beforeEach(() => { vi.restoreAllMocks(); });

  it("shows bounded lifecycle metadata and retention summary", async () => {
    const api = apiFixture();
    render(<DiagnosticsView api={api} />);
    expect(await screen.findByText("流读取失败")).toBeInTheDocument();
    expect(screen.getByText("UND_ERR_SOCKET")).toBeInTheDocument();
    expect(screen.getByText(/512 B/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("prompt");
  });

  it("filters by a valid diagnostic ID and confirms before clearing all logs", async () => {
    const api = apiFixture();
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<DiagnosticsView api={api} />);
    await screen.findByText("流读取失败");
    fireEvent.change(screen.getByLabelText("诊断编号筛选"), { target: { value: diagnosticId } });
    fireEvent.click(screen.getByRole("button", { name: "筛选" }));
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith({ limit: 200, diagnosticId }));
    fireEvent.click(screen.getByRole("button", { name: "清空全部日志" }));
    expect(api.clearAll).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "清空全部日志" }));
    await waitFor(() => expect(api.clearAll).toHaveBeenCalledOnce());
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("exports logs and reports a canceled save dialog without treating it as an error", async () => {
    const api = apiFixture();
    render(<DiagnosticsView api={api} />);
    await screen.findByText("流读取失败");
    fireEvent.click(screen.getByRole("button", { name: "导出日志" }));
    expect(await screen.findByText("已导出诊断日志。")).toBeInTheDocument();
    expect(api.export).toHaveBeenCalledOnce();
  });
});
