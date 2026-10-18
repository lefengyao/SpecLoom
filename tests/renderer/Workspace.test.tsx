// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceView } from "../../src/renderer/WorkspaceView";

afterEach(() => cleanup());

function renderEmptyWorkspace(onStartConversation = vi.fn()) {
  render(
    <WorkspaceView
      tasks={[]}
      selected={undefined}
      onSelect={vi.fn()}
      onNew={vi.fn()}
      onRestart={vi.fn()}
      models={[]}
      providers={[{ id: "provider-1", name: "本地供应商", protocol: "openai", baseUrl: "https://example.test/v1", models: ["gpt-test"], modelSettings: {}, hasKey: false, keyStorage: "none" }]}
      defaultModel={{ providerId: "provider-1", model: "gpt-test" }}
      review={undefined}
      busy={false}
      running={false}
      messages={[]}
      onSend={vi.fn(async () => undefined)}
      onCancel={vi.fn()}
      onRefresh={vi.fn()}
      onValidate={vi.fn()}
      onApprove={vi.fn()}
      onReject={vi.fn()}
      onProviders={vi.fn()}
      onStartConversation={onStartConversation}
    />,
  );
  return onStartConversation;
}

describe("empty workspace agent composer", () => {
  it("sends a chat message without creating a task", () => {
    const onStartConversation = renderEmptyWorkspace();
    expect(screen.getByRole("heading", { name: "智能体对话" })).toBeVisible();
    const input = screen.getByLabelText("任务消息");
    fireEvent.change(input, { target: { value: "创建一个可移动角色" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(onStartConversation).toHaveBeenCalledWith(
      { providerId: "provider-1", model: "gpt-test" },
      "创建一个可移动角色",
    );
    expect(input).toHaveValue("");
  });

  it("does not expose legacy model profiles in the model picker", () => {
    render(
      <WorkspaceView
        tasks={[]}
        selected={undefined}
        onSelect={vi.fn()}
        onNew={vi.fn()}
        onRestart={vi.fn()}
        models={[{
          id: "legacy-model",
          name: "旧模型",
          provider: "openai-compatible",
          model: "legacy-model",
          baseUrl: "https://legacy.example.test/v1",
          approved: true,
          timeoutMs: 60_000,
          maxToolRounds: 12,
        }]}
        providers={[]}
        review={undefined}
        busy={false}
        running={false}
        messages={[]}
        onSend={vi.fn(async () => undefined)}
        onCancel={vi.fn()}
        onRefresh={vi.fn()}
        onValidate={vi.fn()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onProviders={vi.fn()}
        onStartConversation={vi.fn()}
      />,
    );

    expect(screen.queryByRole("option", { name: "旧模型" })).not.toBeInTheDocument();
  });
});
