// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OfflineDocsView } from "../../src/renderer/ToolsViews";
import type { OfflineDocumentsApi } from "../../src/shared/desktop-api";
import type { OfflineDocumentBundle } from "../../src/shared/offline-documents";
import { fixture } from "./fixtures";

afterEach(cleanup);

function bundle(): OfflineDocumentBundle {
  const now = new Date().toISOString();
  const versionId = "00000000-0000-4000-8000-000000000002";
  return {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Godot 文档",
    enabled: true,
    activeVersionId: versionId,
    createdAt: now,
    updatedAt: now,
    versions: [{
      id: versionId,
      label: "4.7.1",
      fileCount: 1,
      size: 12,
      hash: `sha256:${"a".repeat(64)}`,
      importedAt: now,
      files: [{ path: "guide.md", name: "guide.md", mimeType: "text/markdown", size: 12, hash: `sha256:${"b".repeat(64)}` }],
    }],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function testApi(overrides: Partial<OfflineDocumentsApi> = {}) {
  const offlineDocuments = {
    list: vi.fn(async () => [] as OfflineDocumentBundle[]),
    selectDirectory: vi.fn(async () => "C:/docs"),
    selectFiles: vi.fn(async () => ["C:/docs/guide.md"]),
    importDirectory: vi.fn(async () => bundle()),
    importFiles: vi.fn(async () => bundle()),
    setEnabled: vi.fn(),
    setVersion: vi.fn(),
    read: vi.fn(),
    remove: vi.fn(),
    ...overrides,
  } satisfies OfflineDocumentsApi;
  return { ...fixture().api, offlineDocuments };
}

function fillImport(label = "4.7.1") {
  fireEvent.change(screen.getByLabelText("文档包名称"), { target: { value: "Godot 文档" } });
  fireEvent.change(screen.getByLabelText("版本号"), { target: { value: label } });
}

describe("OfflineDocsView", () => {
  it("keeps the completed import visible when the initial list response arrives late", async () => {
    const imported = bundle();
    const initial = deferred<OfflineDocumentBundle[]>();
    const emptyBundle = { ...imported, activeVersionId: undefined, versions: [] };
    const api = testApi({
      list: vi.fn().mockResolvedValue([imported]).mockImplementationOnce(() => initial.promise),
    });
    render(<OfflineDocsView api={api} onError={vi.fn()} />);
    fillImport();
    fireEvent.click(screen.getByRole("button", { name: "选择目录" }));

    expect(await screen.findByText("1 个版本 · 当前版本：4.7.1")).toBeVisible();
    await waitFor(() => expect(api.offlineDocuments.list).toHaveBeenCalledTimes(2));
    await act(async () => { initial.resolve([emptyBundle]); await initial.promise; });
    expect(screen.getByText("1 个版本 · 当前版本：4.7.1")).toBeVisible();
  });

  it("refreshes the current page when an import started before navigating away finishes", async () => {
    const pending = deferred<OfflineDocumentBundle>();
    let stored: OfflineDocumentBundle[] = [];
    const listeners = new Set<() => void>();
    const api = testApi({
      list: vi.fn(async () => stored),
      importDirectory: vi.fn(async () => {
        const imported = await pending.promise;
        stored = [imported];
        for (const listener of listeners) listener();
        return imported;
      }),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    });
    const onError = vi.fn();
    const firstPage = render(<OfflineDocsView api={api} onError={onError} />);
    fillImport();
    fireEvent.click(screen.getByRole("button", { name: "选择目录" }));
    await screen.findByText("正在导入文档，请稍候…");
    firstPage.unmount();
    render(<OfflineDocsView api={api} onError={onError} />);
    await act(async () => {});
    expect(screen.getByText("还没有导入离线文档。")).toBeVisible();

    await act(async () => { pending.resolve(bundle()); await pending.promise; });
    expect(screen.getByText("1 个版本 · 当前版本：4.7.1")).toBeVisible();
    expect(onError).not.toHaveBeenCalled();
    expect(listeners.size).toBe(1);
    cleanup();
    expect(listeners.size).toBe(0);
  });

  it("explains an empty bundle instead of implying a selected version exists", async () => {
    const empty = { ...bundle(), activeVersionId: undefined, versions: [] };
    const api = testApi({
      list: vi.fn(async () => [empty]),
    });
    render(<OfflineDocsView api={api} onError={vi.fn()} />);
    expect(await screen.findByText("尚未导入可用版本")).toBeVisible();
  });

  it.each(["选择目录", "选择多个文件"])("shows a completed import immediately while the follow-up list is pending (%s)", async (button) => {
    const pending = deferred<OfflineDocumentBundle[]>();
    const api = testApi({ list: vi.fn().mockResolvedValueOnce([]).mockImplementationOnce(() => pending.promise) });
    render(<OfflineDocsView api={api} onError={vi.fn()} />);
    await act(async () => {});
    fillImport();
    fireEvent.click(screen.getByRole("button", { name: button }));
    expect(await screen.findByText("1 个版本 · 当前版本：4.7.1")).toBeVisible();
    expect(screen.getByText("1 个文件 · 12 B")).toBeVisible();
    expect(screen.getByLabelText("文档包名称")).toHaveValue("");
    await act(async () => { pending.resolve([bundle()]); await pending.promise; });
  });

  it.each(["选择目录", "选择多个文件"])("keeps the import form when the picker is cancelled (%s)", async (button) => {
    const api = testApi({ selectDirectory: vi.fn(async () => undefined), selectFiles: vi.fn(async () => []) });
    render(<OfflineDocsView api={api} onError={vi.fn()} />);
    fillImport();
    fireEvent.click(screen.getByRole("button", { name: button }));
    await waitFor(() => expect(screen.getByRole("button", { name: button })).toBeEnabled());
    expect(screen.getByLabelText("文档包名称")).toHaveValue("Godot 文档");
    expect(screen.getByLabelText("版本号")).toHaveValue("4.7.1");
    expect(api.offlineDocuments.importDirectory).not.toHaveBeenCalled();
    expect(api.offlineDocuments.importFiles).not.toHaveBeenCalled();
    expect(api.offlineDocuments.list).toHaveBeenCalledTimes(1);
  });

  it("reports an import error once and keeps the existing version and form for retry", async () => {
    const error = new Error("Import failed");
    const onError = vi.fn();
    const api = testApi({ list: vi.fn(async () => [bundle()]), importDirectory: vi.fn(async () => { throw error; }) });
    render(<OfflineDocsView api={api} onError={onError} />);
    await screen.findByText("1 个版本 · 当前版本：4.7.1");
    fillImport("4.8");
    fireEvent.click(screen.getByRole("button", { name: "选择目录" }));
    await waitFor(() => expect(onError).toHaveBeenCalledExactlyOnceWith(error));
    expect(screen.getByLabelText("版本号")).toHaveValue("4.8");
    expect(screen.getByText("1 个版本 · 当前版本：4.7.1")).toBeVisible();
  });

  it("shows an import status until the directory finishes and then confirms the imported version", async () => {
    const pending = deferred<OfflineDocumentBundle>();
    const api = testApi({ list: vi.fn().mockResolvedValue([bundle()]).mockResolvedValueOnce([]), importDirectory: vi.fn(() => pending.promise) });
    render(<OfflineDocsView api={api} onError={vi.fn()} />);
    fillImport();
    fireEvent.click(screen.getByRole("button", { name: "选择目录" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("正在导入文档，请稍候"));
    expect(screen.getByLabelText("版本号")).toBeDisabled();
    expect(screen.queryByRole("heading", { name: "Godot 文档" })).not.toBeInTheDocument();
    await act(async () => { pending.resolve(bundle()); await pending.promise; });
    expect(screen.getByRole("status")).toHaveTextContent("已导入 Godot 文档 · 共 1 个版本");
    expect(screen.getByLabelText("版本号")).toBeEnabled();
    expect(screen.getByText("1 个版本 · 当前版本：4.7.1")).toBeVisible();
  });

  it("updates an existing bundle and reflects version selection and deletion on the same page", async () => {
    const first = bundle();
    const secondVersion = { ...first.versions[0]!, id: "00000000-0000-4000-8000-000000000003", label: "4.8" };
    let stored = first;
    const api = testApi({
      list: vi.fn(async () => [stored]),
      importDirectory: vi.fn(async () => (stored = { ...first, versions: [...first.versions, secondVersion] })),
      setVersion: vi.fn(async (_id, versionId) => (stored = { ...stored, activeVersionId: versionId })),
      remove: vi.fn(async (_id, versionId) => { stored = { ...stored, activeVersionId: first.activeVersionId, versions: stored.versions.filter((item) => item.id !== versionId) }; }),
    });
    render(<OfflineDocsView api={api} onError={vi.fn()} />);
    await screen.findByText("1 个版本 · 当前版本：4.7.1");
    fillImport("4.8");
    fireEvent.click(screen.getByRole("button", { name: "选择目录" }));
    expect(await screen.findByText("2 个版本 · 当前版本：4.7.1")).toBeVisible();
    expect(screen.getAllByRole("heading", { name: "Godot 文档" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "设为当前" }));
    await screen.findByText("2 个版本 · 当前版本：4.8");
    const row = screen.getByText("4.8", { exact: true }).closest(".version-row") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: /^删除$/ }));
    expect(await screen.findByText("1 个版本 · 当前版本：4.7.1")).toBeVisible();
    expect(screen.queryByText("4.8", { exact: true })).not.toBeInTheDocument();
  });
});
