// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextMenu } from "../../src/renderer/ui";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function clipboard() {
  const api = {
    readText: vi.fn(async () => "粘贴内容"),
    writeText: vi.fn(async () => undefined),
  };
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: api });
  return api;
}

function selectText(element: Element, start: number, end: number): void {
  const range = document.createRange();
  range.setStart(element.firstChild!, start);
  range.setEnd(element.firstChild!, end);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

describe("editable context menu", () => {
  it("offers copy, cut and paste for a selected textarea", async () => {
    const clipboardApi = clipboard();
    render(
      <ContextMenu>
        <textarea aria-label="编辑内容" defaultValue="复制内容" />
      </ContextMenu>,
    );
    const textarea = screen.getByLabelText("编辑内容") as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(0, 2);
    fireEvent.contextMenu(textarea, { clientX: 12, clientY: 18 });

    expect(screen.getByRole("menuitem", { name: /复制/ })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: /剪切/ })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: /粘贴/ })).toBeEnabled();

    fireEvent.click(screen.getByRole("menuitem", { name: /复制/ }));
    await waitFor(() => expect(clipboardApi.writeText).toHaveBeenCalledWith("复制"));

    textarea.focus();
    textarea.setSelectionRange(0, 2);
    fireEvent.contextMenu(textarea, { clientX: 12, clientY: 18 });
    fireEvent.click(screen.getByRole("menuitem", { name: /剪切/ }));
    await waitFor(() => expect(textarea).toHaveValue("内容"));

    textarea.focus();
    textarea.setSelectionRange(0, 0);
    fireEvent.contextMenu(textarea, { clientX: 12, clientY: 18 });
    fireEvent.click(screen.getByRole("menuitem", { name: /粘贴/ }));
    await waitFor(() => expect(textarea).toHaveValue("粘贴内容内容"));
  });

  it("disables copy and cut without a selection and closes on escape", () => {
    clipboard();
    render(
      <ContextMenu>
        <input aria-label="编辑值" defaultValue="内容" />
      </ContextMenu>,
    );
    const input = screen.getByLabelText("编辑值") as HTMLInputElement;
    input.focus();
    input.setSelectionRange(0, 0);
    fireEvent.contextMenu(input, { clientX: 12, clientY: 18 });
    expect(screen.getByRole("menuitem", { name: /复制/ })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: /剪切/ })).toBeDisabled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("offers copy for selected page text without edit actions", async () => {
    const clipboardApi = clipboard();
    render(
      <ContextMenu>
        <p>可选择文字</p>
      </ContextMenu>,
    );
    const paragraph = screen.getByText("可选择文字");
    selectText(paragraph, 0, 2);
    fireEvent.contextMenu(paragraph, { clientX: 10, clientY: 20 });

    expect(screen.getByRole("menuitem", { name: /复制/ })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: /剪切/ })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: /粘贴/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("menuitem", { name: /复制/ }));
    await waitFor(() => expect(clipboardApi.writeText).toHaveBeenCalledWith("可选"));
  });

  it("cuts a selection inside editable content after copying it", async () => {
    const clipboardApi = clipboard();
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    render(
      <ContextMenu>
        <div contentEditable suppressContentEditableWarning>编辑文字</div>
      </ContextMenu>,
    );
    const area = screen.getByText("编辑文字");
    selectText(area, 0, 2);
    fireEvent.contextMenu(area, { clientX: 10, clientY: 20 });

    expect(screen.getByRole("menuitem", { name: /复制/ })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: /剪切/ })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: /粘贴/ })).toBeEnabled();
    fireEvent.click(screen.getByRole("menuitem", { name: /剪切/ }));
    await waitFor(() => expect(clipboardApi.writeText).toHaveBeenCalledWith("编辑"));
    expect(execCommand).toHaveBeenCalledWith("delete");
  });

  it("updates a controlled textarea when paste inserts text", async () => {
    const clipboardApi = clipboard();
    function ControlledEditor() {
      const [value, setValue] = useState("原文");
      return (
        <ContextMenu>
          <textarea
            aria-label="受控编辑器"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </ContextMenu>
      );
    }
    render(<ControlledEditor />);
    const textarea = screen.getByLabelText("受控编辑器") as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(2, 2);
    fireEvent.contextMenu(textarea, { clientX: 12, clientY: 18 });
    fireEvent.click(screen.getByRole("menuitem", { name: /粘贴/ }));
    await waitFor(() => expect(clipboardApi.readText).toHaveBeenCalled());
    await waitFor(() => expect(textarea).toHaveValue("原文粘贴内容"));
  });
});
