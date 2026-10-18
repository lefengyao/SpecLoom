// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProvidersView } from "../../src/renderer/ProvidersView";
import type { ProviderInput, ProviderPublic } from "../../src/shared/contracts";
import type { DesktopApi } from "../../src/shared/desktop-api";
import { fixture } from "./fixtures";

afterEach(cleanup);

const provider: ProviderPublic = { id: "p1", name: "服务 A", protocol: "openai", baseUrl: "https://example.com/v1", models: ["gpt-4o"], modelSettings: {}, hasKey: true, keyPreview: "sk-****1234", keyStorage: "encrypted" };

function setup(initial: ProviderPublic[] = [provider]) {
  let list = structuredClone(initial);
  const providers = {
    list: vi.fn(async () => list),
    save: vi.fn(async (input: ProviderInput) => {
      const saved: ProviderPublic = { id: input.id ?? "created", name: input.name, protocol: input.protocol, baseUrl: input.baseUrl, models: input.models, modelSettings: input.modelSettings ?? {}, hasKey: true, keyStorage: "encrypted" };
      list = [...list.filter((entry) => entry.id !== saved.id), saved];
      return list;
    }),
    remove: vi.fn(async (id: string) => { list = list.filter((entry) => entry.id !== id); return list; }),
    listModels: vi.fn(async () => ({ ids: ["gpt-4o", "new-model", "new-model"], known: ["gpt-4o"] })),
    addModels: vi.fn(async () => list),
    fetchModels: vi.fn(async () => ({ list, added: [], message: "" })),
    test: vi.fn(async () => ({ ok: true, message: "ok" })),
  };
  const api = { ...fixture().api, providers } satisfies DesktopApi;
  const onRefresh = vi.fn(async () => undefined);
  const onError = vi.fn();
  render(<ProvidersView providers={initial} api={api} busy={false} onRefresh={onRefresh} onError={onError} />);
  return { providers, onRefresh, onError };
}

describe("provider and model management", () => {
  it("surfaces an undecryptable key and requires a replacement key before saving", async () => {
    const needsReconfiguration: ProviderPublic = { ...provider, credentialStatus: "needs-reconfiguration" };
    const { providers } = setup([needsReconfiguration]);
    expect(screen.getByText("密钥需重新配置")).toBeInTheDocument();
    expect(screen.getByText("系统加密存储（无法解密）")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编辑 服务 A" }));
    expect(screen.getByRole("alert")).toHaveTextContent("当前密钥无法解密，请输入新的 API 密钥后保存");
    const secret = screen.getByLabelText("API 密钥");
    expect(secret).toBeRequired();
    expect(secret).toHaveAttribute("placeholder", "请输入新的 API 密钥（必填）");
    fireEvent.change(secret, { target: { value: "replacement-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "保存供应商" }));
    await waitFor(() => expect(providers.save).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "replacement-secret" })));
  });

  it("saves a provider before opening its model manager and keeps keys out of public fields", async () => {
    const { providers } = setup([]);
    fireEvent.click(screen.getByRole("button", { name: "添加供应商" }));
    fireEvent.change(screen.getByLabelText("供应商名称"), { target: { value: "我的供应商" } });
    fireEvent.change(screen.getByLabelText("协议"), { target: { value: "anthropic" } });
    fireEvent.change(screen.getByLabelText("服务地址"), { target: { value: "https://example.com" } });
    fireEvent.change(screen.getByLabelText("API 密钥"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "保存供应商" }));
    await waitFor(() => expect(providers.save).toHaveBeenCalledWith(expect.objectContaining({ name: "我的供应商", protocol: "anthropic", models: [], apiKey: "secret" })));
    expect(await screen.findByRole("heading", { name: "我的供应商 · 模型管理" })).toBeInTheDocument();
    expect(screen.queryByDisplayValue("secret")).not.toBeInTheDocument();
  });

  it("supports discovery, filtering, deduplicated batch/manual drafts and deleting models", async () => {
    const { providers } = setup();
    fireEvent.click(screen.getByRole("button", { name: "管理 服务 A 的模型" }));
    fireEvent.click(screen.getByRole("button", { name: "拉取模型列表" }));
    await screen.findByLabelText("添加 new-model");
    fireEvent.change(screen.getByLabelText("搜索待添加模型"), { target: { value: "new" } });
    fireEvent.click(screen.getByLabelText("添加 new-model"));
    fireEvent.click(screen.getByRole("button", { name: "添加所选模型" }));
    await waitFor(() => expect(providers.addModels).toHaveBeenCalledWith("p1", ["new-model"]));
    fireEvent.change(screen.getByLabelText("手动模型 ID"), { target: { value: " new-model " } });
    fireEvent.click(screen.getByRole("button", { name: "手动添加" }));
    fireEvent.click(screen.getByRole("button", { name: "删除模型 gpt-4o" }));
    fireEvent.click(screen.getByRole("button", { name: "保存模型配置" }));
    await waitFor(() => expect(providers.save).toHaveBeenCalledWith(expect.objectContaining({ id: "p1", models: ["new-model"] })));
    expect(screen.getByRole("heading", { name: "服务 A · 模型管理" })).toBeInTheDocument();
  });

  it("preserves model drafts on discovery and persistence failures", async () => {
    const { providers, onError } = setup();
    fireEvent.click(screen.getByRole("button", { name: "管理 服务 A 的模型" }));
    fireEvent.change(screen.getByLabelText("手动模型 ID"), { target: { value: "draft-model" } });
    fireEvent.click(screen.getByRole("button", { name: "手动添加" }));
    providers.listModels.mockRejectedValueOnce({ code: "INTERNAL_ERROR", message: "Discovery unavailable" });
    fireEvent.click(screen.getByRole("button", { name: "拉取模型列表" }));
    expect(await screen.findByText("Discovery unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "选择模型 draft-model" })).toBeInTheDocument();
    providers.save.mockRejectedValueOnce(new Error("Save failed"));
    fireEvent.click(screen.getByRole("button", { name: "保存模型配置" }));
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "选择模型 draft-model" })).toBeInTheDocument();
  });

  it("applies valid JSON only to the draft and rejects invalid JSON without modifying it", async () => {
    const { providers } = setup();
    fireEvent.click(screen.getByRole("button", { name: "管理 服务 A 的模型" }));
    const initial = screen.getByLabelText("完整 JSON 配置") as HTMLTextAreaElement;
    const json = { ...JSON.parse(initial.value), vision: false, maxOutputTokens: 4096 };
    fireEvent.change(initial, { target: { value: JSON.stringify({ ...json, extra: true }) } });
    fireEvent.click(screen.getByRole("button", { name: "应用 JSON" }));
    expect(await screen.findByText(/额外字段/)).toBeInTheDocument();
    expect(screen.getByLabelText("支持图片输入")).toBeChecked();
    fireEvent.change(initial, { target: { value: JSON.stringify(json) } });
    fireEvent.click(screen.getByRole("button", { name: "应用 JSON" }));
    expect(screen.getByLabelText("支持图片输入")).not.toBeChecked();
    expect(providers.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存模型配置" }));
    await waitFor(() => expect(providers.save).toHaveBeenCalledWith(expect.objectContaining({ modelSettings: { "gpt-4o": expect.objectContaining({ vision: false, maxOutputTokens: 4096 }) } })));
  });

  it("offers context and output token presets while retaining custom numeric values", async () => {
    const { providers } = setup();
    fireEvent.click(screen.getByRole("button", { name: "管理 服务 A 的模型" }));
    const contextPreset = screen.getByLabelText("上下文 tokens 预设");
    const outputPreset = screen.getByLabelText("输出 tokens 预设");
    expect(within(contextPreset).getByRole("option", { name: "1M" })).toBeInTheDocument();
    expect(within(contextPreset).getByRole("option", { name: "300K" })).toBeInTheDocument();
    expect(within(outputPreset).getByRole("option", { name: "64K" })).toBeInTheDocument();
    fireEvent.change(contextPreset, { target: { value: "1048576" } });
    fireEvent.change(outputPreset, { target: { value: "65536" } });
    expect(screen.getByLabelText("上下文 tokens")).toHaveValue(1048576);
    expect(screen.getByLabelText("输出 tokens")).toHaveValue(65536);
    fireEvent.click(screen.getByRole("button", { name: "保存模型配置" }));
    await waitFor(() => expect(providers.save).toHaveBeenCalledWith(expect.objectContaining({ modelSettings: { "gpt-4o": expect.objectContaining({ contextTokens: 1048576, maxOutputTokens: 65536 }) } })));
  });

  it("hides the legacy tool round setting and does not emit it in new JSON", async () => {
    const { providers } = setup();
    fireEvent.click(screen.getByRole("button", { name: "管理 服务 A 的模型" }));
    expect(screen.queryByLabelText("工具轮次上限")).not.toBeInTheDocument();
    expect((screen.getByLabelText("完整 JSON 配置") as HTMLTextAreaElement).value).not.toContain("maxToolRounds");
    fireEvent.click(screen.getByRole("button", { name: "保存模型配置" }));
    await waitFor(() => expect(providers.save).toHaveBeenCalledWith(expect.objectContaining({
      modelSettings: {},
    })));
  });

  it("preserves legacy provider settings when saving unrelated model changes", async () => {
    const { providers } = setup([{ ...provider, modelSettings: { "gpt-4o": { maxToolRounds: 1 } } }]);
    fireEvent.click(screen.getByRole("button", { name: "管理 服务 A 的模型" }));
    expect(screen.queryByLabelText("工具轮次上限")).not.toBeInTheDocument();
    expect((screen.getByLabelText("完整 JSON 配置") as HTMLTextAreaElement).value).not.toContain("maxToolRounds");
    fireEvent.change(screen.getByLabelText("默认思考"), { target: { value: "low" } });
    fireEvent.click(screen.getByRole("button", { name: "保存模型配置" }));
    await waitFor(() => expect(providers.save).toHaveBeenCalledWith(expect.objectContaining({ modelSettings: { "gpt-4o": { maxToolRounds: 1, reasoning: "low" } } })));
  });
});
