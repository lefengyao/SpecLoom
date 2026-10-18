// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { SettingsView } from "../../src/renderer/SettingsViews";
import { defaultPreferences } from "../../src/shared/preferences";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=";
const pngBytes = Uint8Array.from(atob(png.split(",")[1]!), (char) => char.charCodeAt(0));

test("uploads separate user and assistant avatars in personalization and restores defaults", async () => {
  const update = vi.fn(async () => undefined);
  render(<SettingsView preferences={{ ...defaultPreferences, assistantAvatar: png }} busy={false} onUpdate={update} />);
  fireEvent.click(screen.getByRole("button", { name: "个性化" }));
  expect(screen.getByRole("region", { name: "个性化" })).toBeVisible();
  fireEvent.change(screen.getByLabelText("上传用户头像"), { target: { files: [new File([pngBytes], "user.png", { type: "image/png" })] } });
  await waitFor(() => expect(update).toHaveBeenCalledWith({ userAvatar: png }));
  fireEvent.change(screen.getByLabelText("上传智能体头像"), { target: { files: [new File([pngBytes], "assistant.png", { type: "image/png" })] } });
  await waitFor(() => expect(update).toHaveBeenCalledWith({ assistantAvatar: png }));
  fireEvent.click(screen.getByRole("button", { name: "恢复默认智能体头像" }));
  await waitFor(() => expect(update).toHaveBeenCalledWith({ assistantAvatar: "" }));
  fireEvent.click(screen.getByRole("button", { name: "恢复默认设置" }));
  expect(update).toHaveBeenLastCalledWith({ ...defaultPreferences, userAvatar: "", assistantAvatar: "" });
});

test("compresses a larger accepted image before saving", async () => {
  const update = vi.fn(async () => undefined);
  const output = png;
  class FakeImage {
    width = 1024;
    height = 768;
    naturalWidth = 1024;
    naturalHeight = 768;
    onload: (() => void) | undefined;
    onerror: (() => void) | undefined;
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
  }
  vi.stubGlobal("Image", FakeImage);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ clearRect: vi.fn(), drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(output);
  render(<SettingsView preferences={defaultPreferences} busy={false} onUpdate={update} />);
  fireEvent.click(screen.getByRole("button", { name: "个性化" }));
  const input = screen.getByLabelText("上传用户头像");
  fireEvent.change(input, { target: { files: [new File([new Uint8Array(300_000)], "large.png", { type: "image/png" })] } });
  await waitFor(() => expect(update).toHaveBeenCalledWith({ userAvatar: output }));
});

test("rejects invalid and too-large avatar uploads and reports a failed save", async () => {
  const update = vi.fn(async () => undefined);
  render(<SettingsView preferences={defaultPreferences} busy={false} onUpdate={update} />);
  fireEvent.click(screen.getByRole("button", { name: "个性化" }));
  const input = screen.getByLabelText("上传用户头像");
  fireEvent.change(input, { target: { files: [new File(["<svg></svg>"], "fake.png", { type: "image/png" })] } });
  expect(await screen.findByRole("alert")).toHaveTextContent(/PNG|JPEG|WebP/);
  expect(update).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { files: [new File([new Uint8Array(8 * 1024 * 1024 + 1)], "large.png", { type: "image/png" })] } });
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("8MB"));
  expect(update).not.toHaveBeenCalled();
  update.mockRejectedValueOnce({ code: "VALIDATION_FAILED", message: "保存失败" });
  fireEvent.change(input, { target: { files: [new File([pngBytes], "user.png", { type: "image/png" })] } });
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("保存失败"));
});
