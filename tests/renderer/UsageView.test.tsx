// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { UsageView } from "../../src/renderer/UsageView";

const records = [
  { at: Date.now() - 1000, workspaceId: "E:\\alpha", sessionId: "s1", providerId: "p", providerName: "P", model: "model-a", promptTokens: 10, completionTokens: 5, cachedTokens: 2, cacheWriteTokens: 0, status: "completed" as const, usageSource: "actual" as const },
  { at: Date.now() - 2000, workspaceId: "E:\\beta", sessionId: "s2", providerId: "p", providerName: "P", model: "model-b", promptTokens: 20, completionTokens: 10, cachedTokens: 0, cacheWriteTokens: 0, status: "completed" as const, usageSource: "actual" as const },
];

test("renders totals, project filter, models, and recent calls", async () => {
  const api = { usage: { list: vi.fn(async () => records) } } as never;
  render(<UsageView api={api} onError={() => undefined} />);
  await waitFor(() => expect(screen.getByText("30")).toBeInTheDocument());
  expect(screen.getAllByText("2").length).toBeGreaterThan(0);
  expect(screen.getByText("15")).toBeInTheDocument();
  expect(screen.getAllByText("model-a").length).toBeGreaterThan(0);
  expect(screen.getByRole("option", { name: "alpha" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "beta" })).toBeInTheDocument();
});
