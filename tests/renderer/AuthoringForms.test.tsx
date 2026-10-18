// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { NewComponent, NewEntity } from "../../src/renderer/AuthoringForms";

afterEach(cleanup);

describe("material creation forms", () => {
  it("creates an entity by name alone and leaves detail fields for later", async () => {
    const onSave = vi.fn<(path: string, content: string, version?: string) => Promise<boolean>>().mockResolvedValue(true);
    const onClose = vi.fn();
    render(<NewEntity busy={false} onClose={onClose} onSave={onSave} />);
    expect(screen.queryByLabelText("实体 ID")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("类型")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Markdown 内容" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "守灯人" } });
    fireEvent.click(screen.getByRole("button", { name: "创建实体" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    const [path, content, version] = onSave.mock.calls[0]!;
    expect(path).toMatch(/^specs\/entities\/entity_[a-f0-9]{12}\.md$/);
    expect(version).toBe("absent");
    expect(parse(String(content).split("---")[1]!)).toMatchObject({ schemaVersion: 1, type: "entity", title: "守灯人", description: "", status: "draft", version: 1, relations: [], source: "developer", components: [] });
    expect(String(content)).toContain("# 守灯人");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("creates a health component template with editable typed defaults", async () => {
    const onSave = vi.fn<(path: string, content: string, version?: string) => Promise<boolean>>().mockResolvedValue(true);
    render(<NewComponent busy={false} onClose={() => undefined} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText("组件模板"), { target: { value: "health" } });
    expect(screen.getByLabelText("名称")).toHaveValue("生命值");
    fireEvent.click(screen.getByRole("button", { name: "创建组件" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    const [path, content] = onSave.mock.calls[0]!;
    expect(path).toMatch(/^specs\/components\/component_[a-f0-9]{12}\.md$/);
    expect(parse(String(content).split("---")[1]!)).toMatchObject({ type: "component", scope: "user", title: "生命值", fields: [
      { key: "current", label: "当前值", type: "number", default: 100 },
      { key: "max", label: "上限", type: "number", default: 100 },
    ] });
  });

  it("keeps map creation in its existing separate directory", async () => {
    const onSave = vi.fn<(path: string, content: string, version?: string) => Promise<boolean>>().mockResolvedValue(true);
    render(<NewEntity kind="map" busy={false} onClose={() => undefined} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText("地图 ID"), { target: { value: "harbor" } });
    fireEvent.click(screen.getByRole("button", { name: "创建地图" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("specs/maps/harbor.md", expect.any(String), "absent"));
  });

  it("creates a child entity under its selected parent without another required field", async () => {
    const onSave = vi.fn<(path: string, content: string, version?: string) => Promise<boolean>>().mockResolvedValue(true);
    render(<NewEntity initialParent="items" busy={false} onClose={() => undefined} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "武器" } });
    fireEvent.click(screen.getByRole("button", { name: "创建实体" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(parse(onSave.mock.calls[0]![1].split("---")[1]!)).toMatchObject({ title: "武器", parent: "items" });
  });
});
