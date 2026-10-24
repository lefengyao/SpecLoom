// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { DocumentsView, type DocumentCategory, type MaterialDraft } from "../../src/renderer/DocumentsView";
import type { FileReadResult } from "../../src/shared/contracts";
import { fixture, version } from "./fixtures";

const markdown = (data: Record<string, unknown>, body = "") => `---\n${stringify(data)}---\n\n# ${String(data.title ?? data.id)}\n\n${body}`;
const entity = (id: string, title: string, extra: Record<string, unknown> = {}) => markdown({
  id, title, type: "entity", status: "draft", version: 1, relations: [], source: "developer", components: [], ...extra,
});
const component = (id: string, title: string, fields: { key: string; label: string; type: string; default: unknown }[] = [{ key: "current", label: "当前生命值", type: "number", default: 100 }], extra: Record<string, unknown> = {}) => markdown({
  schemaVersion: 1, id, title, type: "component", description: "", fields, ...extra,
});
const frontMatter = (content: string) => parse(content.split("---")[1]!) as Record<string, unknown>;

it("edits and persists entity states and transitions with the reusable base component", async () => {
  const contents = {
    "specs/entities/hero.md": entity("hero", "角色", { custom: "保留" }),
    "specs/components/state_machine.md": component("state_machine", "状态机基类", [{ key: "enabled", label: "启用", type: "boolean", default: true }]),
  };
  const f = materials("entity", contents);
  await selectMaterial("角色");
  fireEvent.click(await screen.findByRole("button", { name: "添加状态机" }));
  expect(screen.getByLabelText("初始状态")).toHaveValue("idle");
  fireEvent.click(screen.getByRole("button", { name: /^添加状态$/ }));
  fireEvent.change(screen.getByLabelText("状态名称 2"), { target: { value: "移动" } });
  fireEvent.click(screen.getByRole("button", { name: "添加转换" }));
  fireEvent.change(screen.getByLabelText("转换事件 1"), { target: { value: "move" } });
  fireEvent.change(screen.getByLabelText("初始状态"), { target: { value: "state_2" } });
  fireEvent.change(screen.getByLabelText("状态 ID 2"), { target: { value: "run" } });
  expect(screen.getByLabelText("初始状态")).toHaveValue("run");
  expect(screen.getByLabelText("转换目标 1")).toHaveValue("run");
  fireEvent.click(screen.getByRole("button", { name: "保存资料" }));
  await waitFor(() => expect(f.onStage).toHaveBeenCalledOnce());
  expect(frontMatter(f.onStage.mock.calls[0]![1])).toMatchObject({ custom: "保留", stateMachine: {
    initialState: "run", states: [{ id: "idle", title: "待机" }, { id: "run", title: "移动" }], transitions: [{ from: "idle", event: "move", to: "run" }],
  }, components: [{ id: "state_machine", values: { enabled: true } }] });
  f.unmount();
  materials("entity", contents); await selectMaterial("角色");
  expect(await screen.findByLabelText("初始状态")).toHaveValue("run");
  fireEvent.click(screen.getByRole("button", { name: "移除状态 2" }));
  expect(screen.getByLabelText("初始状态")).toHaveValue("idle");
  expect(screen.queryByLabelText("转换事件 1")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "移除状态 1" })).toBeDisabled();
});

it("adds itemized notes to a component definition", async () => {
  const { onStage } = materials("component", { "specs/components/health.md": component("health", "生命值") });
  await selectMaterial("生命值");
  fireEvent.click(await screen.findByRole("button", { name: "添加说明" }));
  fireEvent.change(screen.getByLabelText("说明 1"), { target: { value: "生命值不得为负" } });
  fireEvent.click(screen.getByRole("button", { name: "保存资料" }));
  await waitFor(() => expect(onStage).toHaveBeenCalledOnce());
  expect(frontMatter(onStage.mock.calls[0]![1]).notes).toEqual(["生命值不得为负"]);
});

it("shows a loading message until the entity catalog arrives", async () => {
  const f = fixture({ project: true });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  f.api.documents.mockImplementation(async () => {
    await gate;
    return [{ path: "specs/entities/hero.md", version, size: 10 }];
  });
  f.api.projectTree.mockResolvedValue([]);
  f.api.readDocument.mockResolvedValue({ path: "specs/entities/hero.md", version, content: entity("hero", "角色") });
  render(<DocumentsView api={f.api} onError={vi.fn()} projectPath="C:/Godot/lantern" busy={false} revision={0} category="entity" />);
  expect(screen.getAllByText("读取资料…").length).toBeGreaterThan(0);
  await act(async () => { release(); await Promise.resolve(); });
  expect((await screen.findAllByText("角色")).length).toBeGreaterThan(0);
});

function materials(category: DocumentCategory, contents: Record<string, string> = {}, read?: (path: string) => Promise<FileReadResult>) {
  const f = fixture({ project: true });
  f.api.documents.mockImplementation(async () => Object.entries(contents).map(([path, content]) => ({ path, version, size: content.length })));
  f.api.projectTree.mockImplementation(async () => Object.keys(contents).map((path) => ({ path, kind: "file" as const })));
  f.api.readDocument.mockImplementation(read ?? (async (path: string) => ({ path, version, content: contents[path]! })));
  const onStage = vi.fn<(path: string, content: string, expectedVersion?: string) => Promise<boolean>>(async () => true);
  f.api.saveDocument.mockImplementation(async (_projectPath, path, content, expectedVersion) => {
    if (expectedVersion !== "absent") {
      if (!await onStage(path, content, expectedVersion)) throw new Error("保存失败");
    }
    contents[path] = content;
    return { path, content, version };
  });
  const onError = vi.fn();
  window.localStorage.setItem("specloom.documents.tree", "open");
  const view = render(<DocumentsView api={f.api} onError={onError} projectPath="C:/Godot/lantern" busy={false} revision={0} category={category} />);
  return { ...f, ...view, onStage, onError };
}

async function selectMaterial(name: string) {
  const tree = await screen.findByRole("tree", { name: /关系树|组件库/ });
  fireEvent.click(await within(tree).findByRole("button", { name: new RegExp(`^${name}(?:\\s|$)`) }));
}

async function expandAllMaterials() {
  const tree = await screen.findByRole("tree", { name: /关系树|组件库/ });
  for (let attempt = 0; attempt < 20; attempt++) {
    const closed = within(tree).queryAllByRole("treeitem", { expanded: false });
    if (!closed.length) break;
    for (const item of closed) fireEvent.click(within(item).getByRole("button", { name: /^展开 / }));
    await act(async () => undefined);
  }
  return tree;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("hierarchical project materials and components", () => {
  it("explains hierarchy, template inheritance, filing and component composition separately", async () => {
    materials("entity", { "specs/entities/hero.md": entity("hero", "守灯人") });
    await selectMaterial("守灯人");
    const hierarchy = await screen.findByRole("region", { name: "资料层级" });
    expect(within(hierarchy).getByLabelText("父级资料")).toHaveAccessibleDescription("父级资料决定列表和关系图中的层级。");
    const inheritance = screen.getByRole("region", { name: "实体继承" });
    expect(within(inheritance).getByLabelText("继承自")).toHaveAccessibleDescription("继承实体模板的数据和组件，与父级资料层级独立。");
    const filing = screen.getByRole("region", { name: "资料分组" });
    expect(within(filing).getByLabelText("分组")).toHaveAccessibleDescription("分组用于归档和筛选，与资料层级独立。");
    expect(within(screen.getByRole("region", { name: "实体组件" })).getByText("组件绑定用于组合数据和能力，不决定父级资料层级。")).toBeVisible();
  });

  it("offers component inheritance while keeping entity inheritance entity-only", async () => {
    materials("component", { "specs/components/health.md": component("health", "生命值") });
    await selectMaterial("生命值");
    expect(await screen.findByLabelText("父级资料")).toHaveAccessibleDescription("父级资料决定列表和关系图中的层级。");
    expect(screen.getByLabelText("分组")).toHaveAccessibleDescription("分组用于归档和筛选，与资料层级独立。");
    expect(screen.queryByRole("region", { name: "实体继承" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "组件继承" })).getByLabelText("继承自")).toHaveAccessibleDescription("继承另一组件的字段与默认值；同名自身字段会覆盖基类字段。实体之间的继承仍只指向实体。");
  });

  it("shows inherited component fields and copies one as a local override", async () => {
    const { onStage } = materials("component", {
      "specs/components/base.md": component("base", "基础组件", [{ key: "hp", label: "生命", type: "number", default: 100 }]),
      "specs/components/derived.md": component("derived", "派生组件", [{ key: "speed", label: "速度", type: "number", default: 200 }], { extends: "base" }),
    });
    await selectMaterial("派生组件");
    const inheritance = await screen.findByRole("region", { name: "组件继承" });
    expect(within(inheritance).getByLabelText("继承自")).toHaveValue("base");
    const inherited = await screen.findByRole("heading", { name: "继承字段" });
    expect(within(inherited.closest("div")!).getByText("生命")).toBeVisible();
    fireEvent.click(within(inherited.closest("div")!).getByRole("button", { name: "覆盖" }));
    expect(screen.getByLabelText("字段名称 2")).toHaveValue("hp");
    fireEvent.click(screen.getByRole("button", { name: "保存资料" }));
    await waitFor(() => expect(onStage).toHaveBeenCalledOnce());
    const data = frontMatter(onStage.mock.calls[0]![1]);
    expect(data.extends).toBe("base");
    expect((data.fields as { key: string }[]).map((field) => field.key)).toEqual(["speed", "hp"]);
  });

  it("opens the crop dialog for an existing illustration and imports the cropped result", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => callback(new Blob(["webp"], { type: "image/webp" })));
    const image = `assets/specloom/materials/${"a".repeat(64)}.png`;
    const { api, onStage } = materials("entity", { "specs/entities/hero.md": entity("hero", "角色", { image }) });
    api.importMaterialImage.mockResolvedValue(`assets/specloom/materials/${"b".repeat(64)}.webp`);
    await selectMaterial("角色");
    fireEvent.click(await screen.findByRole("button", { name: "裁剪" }));
    const dialog = await screen.findByRole("dialog", { name: "裁剪配图" });
    fireEvent.click(within(dialog).getByRole("button", { name: "应用裁剪" }));
    await waitFor(() => expect(api.importMaterialImage).toHaveBeenCalledOnce());
    expect(api.importMaterialImage.mock.calls[0]![1]).toMatch(/^data:image\/webp;base64,/);
    fireEvent.click(screen.getByRole("button", { name: "保存资料" }));
    await waitFor(() => expect(onStage).toHaveBeenCalledOnce());
    expect(frontMatter(onStage.mock.calls[0]![1]).image).toBe(`assets/specloom/materials/${"b".repeat(64)}.webp`);
  });

  it("shrinks dense art by the measured overshoot so a large illustration still fits", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    const attempts: { width: number; height: number; quality: number | undefined }[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (this: HTMLCanvasElement, callback: BlobCallback, _type?: string, quality?: number) {
      attempts.push({ width: this.width, height: this.height, quality });
      // Dense art: the encoded size tracks pixel count, so no full-resolution attempt can fit.
      const blob = new Blob(["webp"], { type: "image/webp" });
      Object.defineProperty(blob, "size", { value: Math.round(this.width * this.height * (quality ?? 0.9) * 0.9) });
      callback(blob);
    });
    const image = `assets/specloom/materials/${"a".repeat(64)}.png`;
    const { api } = materials("entity", { "specs/entities/hero.md": entity("hero", "角色", { image }) });
    api.importMaterialImage.mockResolvedValue(`assets/specloom/materials/${"b".repeat(64)}.webp`);
    await selectMaterial("角色");
    fireEvent.click(await screen.findByRole("button", { name: "裁剪" }));
    const dialog = await screen.findByRole("dialog", { name: "裁剪配图" });
    const element = dialog.querySelector("img")!;
    Object.defineProperty(element, "naturalWidth", { value: 4032 });
    Object.defineProperty(element, "naturalHeight", { value: 3024 });
    fireEvent.click(within(dialog).getByRole("button", { name: "应用裁剪" }));
    await waitFor(() => expect(api.importMaterialImage).toHaveBeenCalledOnce());
    expect(api.importMaterialImage.mock.calls[0]![1]).toMatch(/^data:image\/webp;base64,/);
    // Quality drops first, then the canvas shrinks below the source instead of repeating a size.
    expect(attempts.map((step) => step.quality)).toEqual(expect.arrayContaining([0.9, 0.5]));
    expect(attempts.length).toBeLessThanOrEqual(10);
    expect(attempts[attempts.length - 1]!.width).toBeLessThan(attempts[0]!.width);
  });

  it("persists parent, extends and filing independently without changing component bindings", async () => {
    const bindings = [{ id: "health", values: { current: 75 } }];
    const { onStage, onError } = materials("entity", {
      "specs/project.md": markdown({ schemaVersion: 1, id: "project", title: "项目", type: "project", materialGroups: { entity: [
        { id: "actors", name: "角色归档", order: 0 }, { id: "levels", name: "关卡归档", order: 1 },
      ] } }),
      "specs/entities/hero.md": entity("hero", "守灯人", { parent: "old_parent", extends: "old_base", groupId: "actors", components: bindings }),
      "specs/entities/old_parent.md": entity("old_parent", "旧父级"),
      "specs/entities/new_parent.md": entity("new_parent", "新父级"),
      "specs/entities/old_base.md": entity("old_base", "旧模板"),
      "specs/entities/new_base.md": entity("new_base", "新模板", { components: [{ id: "health", values: { current: 200 } }] }),
      "specs/components/health.md": component("health", "生命值"),
    });
    const tree = await screen.findByRole("tree", { name: /实体关系树/ });
    fireEvent.click(await within(tree).findByRole("button", { name: "展开 旧父级" }));
    await selectMaterial("守灯人");
    await screen.findByLabelText("父级资料");
    await within(screen.getByLabelText("分组")).findByRole("option", { name: "关卡归档" });

    const save = async (count: number, expected: Record<string, unknown>) => {
      fireEvent.click(screen.getByRole("button", { name: "保存资料" }));
      await waitFor(() => expect(onStage).toHaveBeenCalledTimes(count));
      const [path, content, expectedVersion] = onStage.mock.calls[count - 1]!;
      expect(path).toBe("specs/entities/hero.md");
      expect(expectedVersion).toBe(version);
      expect(frontMatter(content)).toMatchObject(expected);
      expect(frontMatter(content).components).toEqual(bindings);
      await waitFor(() => expect(screen.getByRole("button", { name: "保存资料" })).toBeDisabled());
    };
    fireEvent.change(screen.getByLabelText("父级资料"), { target: { value: "new_parent" } });
    await save(1, { parent: "new_parent", extends: "old_base", groupId: "actors" });
    fireEvent.change(screen.getByLabelText("继承自"), { target: { value: "new_base" } });
    await save(2, { parent: "new_parent", extends: "new_base", groupId: "actors" });
    fireEvent.change(screen.getByLabelText("分组"), { target: { value: "levels" } });
    await save(3, { parent: "new_parent", extends: "new_base", groupId: "levels" });
    expect(frontMatter(onStage.mock.calls[2]![1])).not.toHaveProperty("group");
    fireEvent.change(screen.getByLabelText("分组"), { target: { value: "" } });
    await save(4, { parent: "new_parent", extends: "new_base" });
    expect(frontMatter(onStage.mock.calls[3]![1])).not.toHaveProperty("groupId");
    expect(frontMatter(onStage.mock.calls[3]![1])).not.toHaveProperty("group");
    expect(onError).not.toHaveBeenCalled();
  });

  it("continues excluding cyclic and invalid relationship candidates", async () => {
    materials("entity", {
      "specs/entities/hero.md": entity("hero", "守灯人"),
      "specs/entities/child.md": entity("child", "子资料", { parent: "hero" }),
      "specs/entities/derived.md": entity("derived", "派生模板", { extends: "hero" }),
      "specs/entities/invalid.md": "---\n[unclosed\n---\n无法解析",
      "specs/components/health.md": component("health", "生命值"),
    });
    await selectMaterial("守灯人");
    const parent = await screen.findByLabelText("父级资料");
    const base = screen.getByLabelText("继承自");
    expect(within(parent).queryByRole("option", { name: "守灯人" })).not.toBeInTheDocument();
    expect(within(parent).queryByRole("option", { name: "子资料" })).not.toBeInTheDocument();
    expect(within(base).queryByRole("option", { name: "守灯人" })).not.toBeInTheDocument();
    expect(within(base).queryByRole("option", { name: "派生模板" })).not.toBeInTheDocument();
    for (const select of [parent, base]) {
      expect(within(select).queryByRole("option", { name: /invalid|无法解析/ })).not.toBeInTheDocument();
      expect(within(select).queryByRole("option", { name: "生命值" })).not.toBeInTheDocument();
    }
    expect(within(parent).getByRole("option", { name: "派生模板" })).toBeInTheDocument();
    expect(within(base).getByRole("option", { name: "子资料" })).toBeInTheDocument();
  });

  it("creates an entity with only a name and stages its details afterward", async () => {
    const { api, onStage } = materials("entity");
    fireEvent.click(screen.getByRole("button", { name: "新建实体" }));
    const dialog = screen.getByRole("dialog", { name: "新建实体" });
    expect(within(dialog).getAllByRole("textbox")).toHaveLength(1);
    expect(within(dialog).queryByLabelText("实体 ID")).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("名称"), { target: { value: "火焰哥布林" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建实体" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByLabelText("名称")).toHaveValue("火焰哥布林");
    expect(onStage).not.toHaveBeenCalled();
    expect(api.createTask).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Markdown 正文"), { target: { value: "## 行为\n靠近玩家后攻击。" } });
    fireEvent.click(screen.getByRole("button", { name: "保存资料" }));
    await waitFor(() => expect(onStage).toHaveBeenCalledOnce());
    const [path, content, expectedVersion] = onStage.mock.calls[0]!;
    expect(path).toMatch(/^specs\/entities\/[^/]+\.md$/);
    expect(expectedVersion).toBe(version);
    expect(frontMatter(content)).toMatchObject({ id: path.split("/").pop()!.slice(0, -3), title: "火焰哥布林", type: "entity", components: [] });
    expect(content).toContain("靠近玩家后攻击。");
  });

  it("keeps entities in multiple parent levels and edits hierarchy separately from inheritance", async () => {
    const { onStage } = materials("entity", {
      "specs/entities/characters.md": entity("characters", "角色"),
      "specs/entities/enemies.md": entity("enemies", "敌人", { parent: "characters" }),
      "specs/entities/goblin.md": entity("goblin", "小怪", { parent: "enemies" }),
      "specs/entities/base.md": entity("base", "基础敌人"),
    });
    const tree = await screen.findByRole("tree", { name: /实体关系树/ });
    fireEvent.click(await within(tree).findByRole("button", { name: "展开 角色" }));
    const root = within(tree).getByRole("button", { name: /^角色(?:\s|$)/ }).closest("li")!;
    expect(within(root).getByRole("button", { name: /^敌人(?:\s|$)/ })).toBeVisible();
    expect(within(root).queryByRole("button", { name: /^小怪(?:\s|$)/ })).not.toBeInTheDocument();
    fireEvent.click(within(root).getByRole("button", { name: "展开 敌人" }));
    const branch = within(root).getByRole("button", { name: /^敌人(?:\s|$)/ }).closest("li")!;
    expect(within(branch).getByRole("button", { name: /^小怪(?:\s|$)/ })).toBeVisible();
    await selectMaterial("小怪");
    await waitFor(() => expect(screen.getByLabelText("名称")).toHaveValue("小怪"));
    expect(screen.getByLabelText("父级资料")).toHaveValue("enemies");
    fireEvent.change(screen.getByLabelText("继承自"), { target: { value: "base" } });
    fireEvent.change(screen.getByLabelText("实体类型"), { target: { value: "enemy" } });
    fireEvent.click(screen.getByRole("button", { name: "保存资料" }));
    await waitFor(() => expect(onStage).toHaveBeenCalledOnce());
    expect(frontMatter(onStage.mock.calls[0]![1])).toMatchObject({ parent: "enemies", extends: "base", type: "enemy" });
  });

  it("retains an entity draft while creating a separate component draft", async () => {
    const { api, onStage, onError, rerender } = materials("entity");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "新建实体" }));
    const dialog = screen.getByRole("dialog", { name: "新建实体" });
    fireEvent.change(within(dialog).getByLabelText("名称"), { target: { value: "待配置的小怪" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建实体" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    rerender(<DocumentsView api={api} onError={onError} projectPath="C:/Godot/lantern" busy={false} revision={0} category="component" />);
    fireEvent.click(screen.getByRole("button", { name: "新建组件" }));
    const componentDialog = screen.getByRole("dialog", { name: "新建组件" });
    fireEvent.change(within(componentDialog).getByLabelText("名称"), { target: { value: "小怪生命值" } });
    fireEvent.click(within(componentDialog).getByRole("button", { name: "创建组件" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    rerender(<DocumentsView api={api} onError={onError} projectPath="C:/Godot/lantern" busy={false} revision={0} category="entity" />);
    await selectMaterial("待配置的小怪");
    await waitFor(() => expect(screen.getByLabelText("名称")).toHaveValue("待配置的小怪"));
    const components = screen.getByLabelText("选择组件");
    expect(await within(components).findByRole("option", { name: "小怪生命值" })).toBeInTheDocument();
    rerender(<DocumentsView api={api} onError={onError} projectPath="C:/Godot/lantern" busy={false} revision={0} category="component" />);
    await selectMaterial("小怪生命值");
    await waitFor(() => expect(screen.getByLabelText("名称")).toHaveValue("小怪生命值"));
    expect(onStage).not.toHaveBeenCalled();
  });

  it("retains edits to a saved entity when switching material categories", async () => {
    const { api, onStage, onError, rerender } = materials("entity", {
      "specs/entities/goblin.md": entity("goblin", "哥布林"),
    });
    await selectMaterial("哥布林");
    const name = await screen.findByLabelText("名称");
    fireEvent.change(name, { target: { value: "火焰哥布林" } });
    fireEvent.change(screen.getByLabelText("说明"), { target: { value: "具有火焰抗性" } });
    fireEvent.change(screen.getByLabelText("Markdown 正文"), { target: { value: "## 技能\n投掷火球。" } });
    rerender(<DocumentsView api={api} onError={onError} projectPath="C:/Godot/lantern" busy={false} revision={0} category="component" />);
    rerender(<DocumentsView api={api} onError={onError} projectPath="C:/Godot/lantern" busy={false} revision={0} category="entity" />);
    await selectMaterial("火焰哥布林");
    await waitFor(() => expect(screen.getByLabelText("名称")).toHaveValue("火焰哥布林"));
    expect(screen.getByLabelText("说明")).toHaveValue("具有火焰抗性");
    expect(screen.getByLabelText("Markdown 正文")).toHaveValue("## 技能\n投掷火球。");
    expect(onStage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存资料" }));
    await waitFor(() => expect(onStage).toHaveBeenCalledOnce());
    expect(onStage.mock.calls[0]![2]).toBe(version);
    expect(frontMatter(onStage.mock.calls[0]![1])).toMatchObject({ title: "火焰哥布林", description: "具有火焰抗性" });
  });

  it("forces a stale dirty entity to reload at the latest version while retaining other buffers", async () => {
    const { api, onError, onStage, rerender } = materials("entity", {
      "specs/entities/hero.md": entity("hero", "守灯人"),
      "specs/entities/guard.md": entity("guard", "港口守卫"),
    });
    await selectMaterial("港口守卫");
    fireEvent.change(await screen.findByLabelText("说明"), { target: { value: "保留另一个实体的修改" } });
    await selectMaterial("守灯人");
    fireEvent.change(await screen.findByLabelText("名称"), { target: { value: "过期的本地修改" } });
    const latest = `sha256:${"b".repeat(64)}` as const;
    const external = entity("hero", "外部更新的守灯人", { description: "新的文件内容" });
    api.documents.mockResolvedValue([
      { path: "specs/entities/hero.md", version: latest, size: external.length },
      { path: "specs/entities/guard.md", version, size: 20 },
    ]);
    api.readDocument.mockImplementation(async (path) => ({ path, version: path === "specs/entities/hero.md" ? latest : version, content: path === "specs/entities/hero.md" ? external : entity("guard", "港口守卫") }));
    const onReloadHandled = vi.fn();
    rerender(<DocumentsView api={api} onError={onError} projectPath="C:/Godot/lantern" busy={false} revision={0} category="entity" reloadRequest={{ path: "specs/entities/hero.md", sequence: 1 }} onReloadHandled={onReloadHandled} />);
    await waitFor(() => expect(screen.getByLabelText("名称")).toHaveValue("外部更新的守灯人"));
    expect(screen.getByLabelText("说明")).toHaveValue("新的文件内容");
    expect(api.readDocument).toHaveBeenCalledWith("specs/entities/hero.md", latest);
    await waitFor(() => expect(onReloadHandled).toHaveBeenCalledWith(1));
    expect(onReloadHandled).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    await selectMaterial("港口守卫");
    await waitFor(() => expect(screen.getByLabelText("说明")).toHaveValue("保留另一个实体的修改"));
    fireEvent.click(screen.getByRole("button", { name: "保存资料" }));
    await waitFor(() => expect(onStage).toHaveBeenCalledOnce());
    expect(onStage.mock.calls[0]![0]).toBe("specs/entities/guard.md");
    expect(onStage.mock.calls[0]![2]).toBe(version);
  });

  it("ignores a forced reload response after the user selects and edits another entity", async () => {
    const { api, onError, rerender } = materials("entity", {
      "specs/entities/hero.md": entity("hero", "守灯人"),
      "specs/entities/guard.md": entity("guard", "港口守卫"),
    });
    await selectMaterial("守灯人");
    fireEvent.change(await screen.findByLabelText("说明"), { target: { value: "丢弃这个修改" } });
    const latest = `sha256:${"b".repeat(64)}` as const;
    api.documents.mockResolvedValue([
      { path: "specs/entities/hero.md", version: latest, size: 20 },
      { path: "specs/entities/guard.md", version, size: 20 },
    ]);
    let finishReload!: (result: FileReadResult) => void;
    let firstReload = true;
    api.readDocument.mockImplementation((path) => {
      if (path === "specs/entities/hero.md" && firstReload) {
        firstReload = false;
        return new Promise((resolve) => { finishReload = resolve; });
      }
      return Promise.resolve({ path, version: path === "specs/entities/hero.md" ? latest : version, content: path === "specs/entities/hero.md" ? entity("hero", "外部更新的守灯人") : entity("guard", "港口守卫") });
    });
    const onReloadHandled = vi.fn();
    rerender(<DocumentsView api={api} onError={onError} projectPath="C:/Godot/lantern" busy={false} revision={0} category="entity" reloadRequest={{ path: "specs/entities/hero.md", sequence: 2 }} onReloadHandled={onReloadHandled} />);
    await waitFor(() => expect(api.readDocument).toHaveBeenCalledWith("specs/entities/hero.md", latest));
    await selectMaterial("港口守卫");
    await waitFor(() => expect(screen.getByLabelText("名称")).toHaveValue("港口守卫"));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "当前选中的守卫" } });
    await act(async () => finishReload({ path: "specs/entities/hero.md", version: latest, content: entity("hero", "迟来的旧选择结果") }));
    expect(screen.getByLabelText("名称")).toHaveValue("当前选中的守卫");
    expect(onReloadHandled).toHaveBeenCalledOnce();
    expect(onReloadHandled).toHaveBeenCalledWith(2);
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports a forced reload failure and consumes the failed request", async () => {
    const { api, onError, onStage, rerender } = materials("entity", {
      "specs/entities/hero.md": entity("hero", "守灯人"),
    });
    await selectMaterial("守灯人");
    fireEvent.change(await screen.findByLabelText("说明"), { target: { value: "准备丢弃" } });
    const failure = new Error("读取最新资料列表失败");
    api.documents.mockRejectedValueOnce(failure);
    const onReloadHandled = vi.fn();
    rerender(<DocumentsView api={api} onError={onError} projectPath="C:/Godot/lantern" busy={false} revision={0} category="entity" reloadRequest={{ path: "specs/entities/hero.md", sequence: 3 }} onReloadHandled={onReloadHandled} />);
    await waitFor(() => expect(onError).toHaveBeenCalledWith(failure));
    expect(onReloadHandled).toHaveBeenCalledWith(3);
    expect(onReloadHandled).toHaveBeenCalledOnce();
    expect(screen.queryByText("读取中…")).not.toBeInTheDocument();
    expect(onStage).not.toHaveBeenCalled();
  });

  it("keeps settings with missing parents and cycles reachable in the tree", async () => {
    materials("setting", {
      "specs/settings/world.md": markdown({ schemaVersion: 1, id: "world", title: "世界", type: "setting", description: "", parent: "combat" }),
      "specs/settings/combat.md": markdown({ schemaVersion: 1, id: "combat", title: "战斗", type: "setting", description: "", parent: "world" }),
      "specs/settings/orphan.md": markdown({ schemaVersion: 1, id: "orphan", title: "遗失父级", type: "setting", description: "", parent: "missing" }),
    });
    await waitFor(() => expect(screen.getByRole("tree", { name: /设定关系树/ }).textContent).toMatch(/世界|战斗|关系错误/));
    const tree = await expandAllMaterials();
    for (const name of ["世界", "战斗", "遗失父级"]) {
      expect(within(tree).getByRole("button", { name: new RegExp(`^${name}(?:\\s|$)`) })).toBeVisible();
    }
  });

  it("creates a health component from its template and edits reusable fields", async () => {
    const { onStage } = materials("component");
    fireEvent.click(screen.getByRole("button", { name: "新建组件" }));
    const dialog = screen.getByRole("dialog", { name: "新建组件" });
    fireEvent.change(within(dialog).getByLabelText("名称"), { target: { value: "生命值" } });
    const template = within(dialog).getByLabelText(/模板/);
    const health = within(template).getByRole("option", { name: "生命值" }) as HTMLOptionElement;
    fireEvent.change(template, { target: { value: health.value } });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建组件" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByLabelText("名称")).toHaveValue("生命值");
    expect(onStage).not.toHaveBeenCalled();
    expect(screen.getAllByLabelText(/^字段类型(?: |$)/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "添加字段" }));
    const names = screen.getAllByLabelText(/^字段名称(?: |$)/);
    const labels = screen.getAllByLabelText(/^显示名称(?: |$)/);
    const types = screen.getAllByLabelText(/^字段类型(?: |$)/);
    const defaults = screen.getAllByLabelText(/^默认值(?: |$)/);
    const index = names.length - 1;
    fireEvent.change(names[index]!, { target: { value: "regeneration" } });
    fireEvent.change(labels[index]!, { target: { value: "每秒恢复" } });
    fireEvent.change(types[index]!, { target: { value: "number" } });
    fireEvent.change(defaults[index]!, { target: { value: "2.5" } });
    fireEvent.click(screen.getByRole("button", { name: "保存资料" }));
    await waitFor(() => expect(onStage).toHaveBeenCalledOnce());
    const [path, content, expectedVersion] = onStage.mock.calls[0]!;
    expect(path).toMatch(/^specs\/components\/[^/]+\.md$/);
    expect(expectedVersion).toBe(version);
    expect(frontMatter(content)).toMatchObject({ type: "component", title: "生命值", fields: expect.arrayContaining([{ key: "regeneration", label: "每秒恢复", type: "number", default: 2.5 }]) });
  });

  it("removes a field from a saved component definition", async () => {
    const { onStage } = materials("component", {
      "specs/components/speed.md": component("speed", "速度", [
        { key: "value", label: "移动速度", type: "number", default: 180 },
        { key: "boost", label: "加速倍率", type: "number", default: 1 },
      ]),
    });
    await selectMaterial("速度");
    await screen.findAllByLabelText(/^字段名称(?: |$)/);
    fireEvent.click(screen.getAllByRole("button", { name: /移除字段/ })[1]!);
    fireEvent.click(screen.getByRole("button", { name: "保存资料" }));
    await waitFor(() => expect(onStage).toHaveBeenCalledOnce());
    expect(frontMatter(onStage.mock.calls[0]![1]).fields).toEqual([{ key: "value", label: "移动速度", type: "number", default: 180 }]);
    expect(onStage.mock.calls[0]![2]).toBe(version);
  });

  it("keeps a component field visible while its key or number is temporarily empty", async () => {
    const { onStage } = materials("component", {
      "specs/components/speed.md": component("speed", "速度", [{ key: "value", label: "移动速度", type: "number", default: 180 }]),
    });
    await selectMaterial("速度");
    const key = await screen.findByLabelText(/^字段名称(?: |$)/);
    fireEvent.change(key, { target: { value: "" } });
    expect(screen.getAllByLabelText(/^字段名称(?: |$)/)).toHaveLength(1);
    fireEvent.change(screen.getByLabelText(/^字段名称(?: |$)/), { target: { value: "movement" } });
    fireEvent.change(screen.getByLabelText(/^默认值(?: |$)/), { target: { value: "" } });
    expect(screen.getAllByLabelText(/^字段名称(?: |$)/)).toHaveLength(1);
    fireEvent.change(screen.getByLabelText(/^默认值(?: |$)/), { target: { value: "220" } });
    fireEvent.click(screen.getByRole("button", { name: "保存资料" }));
    await waitFor(() => expect(onStage).toHaveBeenCalledOnce());
    expect(frontMatter(onStage.mock.calls[0]![1]).fields).toEqual([{ key: "movement", label: "移动速度", type: "number", default: 220 }]);
  });

  it("protects fields used by entities while allowing new fields and display defaults to change", async () => {
    const { onStage } = materials("component", {
      "specs/entities/hero.md": entity("hero", "守灯人", { components: [{ id: "health", values: { current: 75 } }] }),
      "specs/components/health.md": component("health", "生命值"),
    });
    await selectMaterial("生命值");
    await screen.findByLabelText("字段名称 1");
    expect(screen.getByLabelText("字段名称 1")).toBeDisabled();
    expect(screen.getByLabelText("字段类型 1")).toBeDisabled();
    expect(screen.getByRole("button", { name: "移除字段 1" })).toBeDisabled();
    expect(screen.getByLabelText("显示名称 1")).toBeEnabled();
    expect(screen.getByLabelText("默认值 1")).toBeEnabled();
    fireEvent.change(screen.getByLabelText("显示名称 1"), { target: { value: "现有生命值" } });
    fireEvent.change(screen.getByLabelText("默认值 1"), { target: { value: "120" } });
    fireEvent.click(screen.getByRole("button", { name: "添加字段" }));
    expect(screen.getByLabelText("字段名称 2")).toBeEnabled();
    expect(screen.getByLabelText("字段类型 2")).toBeEnabled();
    expect(screen.getByRole("button", { name: "移除字段 2" })).toBeEnabled();
    fireEvent.change(screen.getByLabelText("字段名称 2"), { target: { value: "regeneration" } });
    fireEvent.change(screen.getByLabelText("显示名称 2"), { target: { value: "自动恢复" } });
    fireEvent.change(screen.getByLabelText("字段类型 2"), { target: { value: "boolean" } });
    fireEvent.change(screen.getByLabelText("默认值 2"), { target: { value: "true" } });
    fireEvent.click(screen.getByRole("button", { name: "保存资料" }));
    await waitFor(() => expect(onStage).toHaveBeenCalledOnce());
    expect(frontMatter(onStage.mock.calls[0]![1]).fields).toEqual([
      { key: "current", label: "现有生命值", type: "number", default: 120 },
      { key: "regeneration", label: "自动恢复", type: "boolean", default: true },
    ]);
  });

  it("waits for component consumers to load before enabling edits or staging", async () => {
    const contents = {
      "specs/entities/hero.md": entity("hero", "守灯人", { components: ["health"] }),
      "specs/components/health.md": component("health", "生命值"),
    };
    let finishConsumer!: (result: FileReadResult) => void;
    const { onStage } = materials("component", contents, (path) => path === "specs/entities/hero.md"
      ? new Promise((resolve) => { finishConsumer = resolve; })
      : Promise.resolve({ path, version, content: contents[path as keyof typeof contents] }));
    fireEvent.click(await screen.findByRole("button", { name: "health.md" }));
    expect(await screen.findByLabelText("字段名称 1")).toBeDisabled();
    expect(screen.getByLabelText("字段类型 1")).toBeDisabled();
    expect(screen.getByRole("button", { name: "移除字段 1" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "源码编辑" }));
    fireEvent.change(screen.getByLabelText("文档内容"), { target: { value: contents["specs/components/health.md"].replaceAll("生命值", "生命值组件") } });
    expect(screen.getByRole("button", { name: "保存资料" })).toBeDisabled();
    expect(onStage).not.toHaveBeenCalled();
    await act(async () => finishConsumer({ path: "specs/entities/hero.md", version, content: contents["specs/entities/hero.md"] }));
    await waitFor(() => expect(screen.queryByText("读取资料…")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "详情编辑" }));
    expect(screen.getByLabelText("字段名称 1")).toBeDisabled();
    expect(screen.getByLabelText("显示名称 1")).toBeEnabled();
    expect(screen.getByRole("button", { name: "保存资料" })).toBeEnabled();
  });

  it("keeps structured edits disabled after a catalog failure until a successful refresh", async () => {
    const contents = {
      "specs/entities/hero.md": entity("hero", "守灯人", { components: ["health"] }),
      "specs/components/health.md": component("health", "生命值"),
    };
    const { api, onError } = materials("component", contents, async (path) => {
      if (path === "specs/entities/hero.md") throw new Error("无法读取守灯人");
      return { path, version, content: contents[path as keyof typeof contents] };
    });
    await selectMaterial("生命值");
    expect(await screen.findByRole("alert")).toHaveTextContent("部分资料读取失败");
    expect(screen.getByLabelText("字段名称 1")).toBeDisabled();
    expect(screen.getByLabelText("显示名称 1")).toBeDisabled();
    expect(onError).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "源码编辑" }));
    expect(screen.getByLabelText("文档内容")).toBeEnabled();
    api.readDocument.mockImplementation(async (path) => ({ path, version, content: contents[path as keyof typeof contents] }));
    fireEvent.click(screen.getByRole("button", { name: "刷新项目树" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "详情编辑" }));
    expect(screen.getByLabelText("字段名称 1")).toBeDisabled();
    expect(screen.getByLabelText("显示名称 1")).toBeEnabled();
  });

  it.each(["current", "constructor", "prototype", "__proto__"])("rejects the invalid field key %s and lets the new field be corrected", async (key) => {
    const { onStage } = materials("component", {
      "specs/entities/hero.md": entity("hero", "守灯人", { components: ["health"] }),
      "specs/components/health.md": component("health", "生命值"),
    });
    await selectMaterial("生命值");
    await waitFor(() => expect(screen.getByLabelText("显示名称 1")).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "添加字段" }));
    const field = screen.getByLabelText("字段名称 2");
    fireEvent.change(field, { target: { value: key } });
    expect(field).toBeEnabled();
    expect(field).toBeInvalid();
    expect(screen.getAllByText(key === "current" ? `字段名称重复：${key}` : `字段名称不能使用保留键：${key}`).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "保存资料" }));
    expect(onStage).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: "regeneration" } });
    expect(field).toBeValid();
    fireEvent.click(screen.getByRole("button", { name: "保存资料" }));
    await waitFor(() => expect(onStage).toHaveBeenCalledOnce());
    expect(frontMatter(onStage.mock.calls[0]![1]).fields).toEqual([
      { key: "current", label: "当前生命值", type: "number", default: 100 },
      { key: "regeneration", type: "number", default: 0 },
    ]);
  });

  it("keeps another document's edit buffer when an earlier stage finishes after navigation", async () => {
    const f = fixture({ project: true });
    const other = "# 另一个文档\n原始内容";
    f.api.documents.mockResolvedValue([{ path: "specs/other.md", version, size: other.length }]);
    f.api.projectTree.mockResolvedValue([{ path: "specs/other.md", kind: "file" }]);
    f.api.readDocument.mockImplementation(async (path) => ({ path, version, content: other }));
    let finishStage!: (success: boolean) => void;
    const onStage = vi.fn<(path: string, content: string, expectedVersion?: string) => Promise<boolean>>(() => new Promise((resolve) => { finishStage = resolve; }));
    f.api.saveDocument.mockImplementation(async (_projectPath, path, content, expectedVersion) => {
      await onStage(path, content, expectedVersion);
      return { path, content, version };
    });
    const initialDraft: MaterialDraft = { path: "specs/entities/new.md", version: "absent", baseline: "", content: entity("new", "新实体") };
    const onError = vi.fn();
    function Harness() {
      const [drafts, setDrafts] = useState([initialDraft]);
      const [category, setCategory] = useState<DocumentCategory>("entity");
      return <>
        <button onClick={() => setCategory("all")}>测试项目文件</button>
        <button onClick={() => setCategory("entity")}>测试实体</button>
        <DocumentsView key={category} api={f.api} onError={onError} projectPath="C:/Godot/lantern" busy={false} revision={0} category={category} drafts={drafts} onDraftsChange={setDrafts} />
      </>;
    }
    window.localStorage.setItem("specloom.documents.tree", "open");
    render(<Harness />);
    await selectMaterial("新实体");
    await waitFor(() => expect(screen.getByRole("button", { name: "保存资料" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "保存资料" }));
    await waitFor(() => expect(onStage).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "测试项目文件" }));
    fireEvent.click(await screen.findByRole("button", { name: "other.md" }));
    fireEvent.change(await screen.findByLabelText("文档内容"), { target: { value: "# 另一个文档\n新编辑内容" } });
    await act(async () => finishStage(true));
    fireEvent.click(screen.getByRole("button", { name: "测试实体" }));
    fireEvent.click(screen.getByRole("button", { name: "测试项目文件" }));
    fireEvent.click(await screen.findByRole("button", { name: "other.md" }));
    expect(await screen.findByLabelText("文档内容")).toHaveValue("# 另一个文档\n新编辑内容");
  });

  it("adds a reusable component to an entity and stores the entity's values", async () => {
    const { onStage } = materials("entity", {
      "specs/entities/hero.md": entity("hero", "守灯人"),
      "specs/components/health.md": component("health", "生命值"),
    });
    await selectMaterial("守灯人");
    const select = await screen.findByLabelText("选择组件");
    await within(select).findByRole("option", { name: "生命值" });
    fireEvent.change(select, { target: { value: "health" } });
    fireEvent.click(screen.getByRole("button", { name: "添加组件" }));
    const current = screen.getByLabelText("生命值 · 当前生命值");
    expect(current).toHaveValue(100);
    fireEvent.change(current, { target: { value: "150" } });
    fireEvent.click(screen.getByRole("button", { name: "保存资料" }));
    await waitFor(() => expect(onStage).toHaveBeenCalledOnce());
    expect(frontMatter(onStage.mock.calls[0]![1]).components).toEqual([{ id: "health", values: { current: 150 } }]);
    expect(onStage.mock.calls[0]![2]).toBe(version);
  });

  it("preserves reference metadata and unrelated bindings when updating one component value", async () => {
    const health = { path: "res://specs/components/health.md", type: "component", version, values: { current: 80, max: 100 } };
    const speed = { id: "speed", type: "component", version, values: { value: 180 }, note: "速度保持不变" };
    const { onStage } = materials("entity", {
      "specs/entities/hero.md": entity("hero", "守灯人", { components: [health, speed] }),
      "specs/components/health.md": component("health", "生命值", [
        { key: "current", label: "当前生命值", type: "number", default: 100 },
        { key: "max", label: "上限", type: "number", default: 100 },
      ]),
      "specs/components/speed.md": component("speed", "速度", [{ key: "value", label: "移动速度", type: "number", default: 180 }]),
    });
    await selectMaterial("守灯人");
    const current = await screen.findByLabelText("生命值 · 当前生命值");
    expect(current).toHaveValue(80);
    fireEvent.change(current, { target: { value: "65" } });
    fireEvent.click(screen.getByRole("button", { name: "保存资料" }));
    await waitFor(() => expect(onStage).toHaveBeenCalledOnce());
    expect(frontMatter(onStage.mock.calls[0]![1]).components).toEqual([
      { ...health, values: { current: 65, max: 100 } },
      speed,
    ]);
  });

  it("merges component values through an inheritance chain without flattening local overrides", async () => {
    const { onStage } = materials("entity", {
      "specs/entities/base.md": entity("base", "基础敌人", { components: [{ id: "health", values: { current: 200, max: 200 } }] }),
      "specs/entities/middle.md": entity("middle", "普通敌人", { extends: "base", components: [{ id: "health", values: { current: 50 } }] }),
      "specs/entities/goblin.md": entity("goblin", "哥布林", { extends: "middle", components: [{ id: "health", values: { current: 25 } }] }),
      "specs/components/health.md": component("health", "生命值", [
        { key: "current", label: "当前生命值", type: "number", default: 100 },
        { key: "max", label: "上限", type: "number", default: 100 },
      ]),
    });
    await selectMaterial("哥布林");
    expect(await screen.findByLabelText("生命值 · 当前生命值")).toHaveValue(25);
    expect(screen.getByLabelText("生命值 · 上限")).toHaveValue(200);
    fireEvent.change(screen.getByLabelText("说明"), { target: { value: "继承上限，只覆盖当前生命值" } });
    fireEvent.click(screen.getByRole("button", { name: "保存资料" }));
    await waitFor(() => expect(onStage).toHaveBeenCalledOnce());
    expect(frontMatter(onStage.mock.calls[0]![1]).components).toEqual([{ id: "health", values: { current: 25 } }]);
  });

  it("removes an entity component without editing the reusable definition", async () => {
    const { onStage } = materials("entity", {
      "specs/entities/hero.md": entity("hero", "守灯人", { components: [{ id: "health", values: { current: 75 } }] }),
      "specs/components/health.md": component("health", "生命值"),
    });
    await selectMaterial("守灯人");
    const remove = await screen.findByRole("button", { name: "移除组件 生命值" });
    fireEvent.click(remove);
    fireEvent.click(screen.getByRole("button", { name: "保存资料" }));
    await waitFor(() => expect(onStage).toHaveBeenCalledOnce());
    expect(onStage.mock.calls[0]![0]).toBe("specs/entities/hero.md");
    expect(frontMatter(onStage.mock.calls[0]![1]).components).toEqual([]);
  });

  it("stores text and boolean component values with their declared types", async () => {
    const { onStage } = materials("entity", {
      "specs/entities/hero.md": entity("hero", "守灯人"),
      "specs/components/state.md": component("state", "状态", [
        { key: "mode", label: "行动状态", type: "string", default: "idle" },
        { key: "visible", label: "显示", type: "boolean", default: false },
      ]),
    });
    await selectMaterial("守灯人");
    const select = await screen.findByLabelText("选择组件");
    await within(select).findByRole("option", { name: "状态" });
    fireEvent.change(select, { target: { value: "state" } });
    fireEvent.click(screen.getByRole("button", { name: "添加组件" }));
    const mode = screen.getByLabelText("状态 · 行动状态");
    const visible = screen.getByLabelText("状态 · 显示");
    expect(mode).toHaveValue("idle");
    expect(visible).toHaveValue("false");
    fireEvent.change(mode, { target: { value: "attack" } });
    fireEvent.change(visible, { target: { value: "true" } });
    fireEvent.click(screen.getByRole("button", { name: "保存资料" }));
    await waitFor(() => expect(onStage).toHaveBeenCalledOnce());
    expect(frontMatter(onStage.mock.calls[0]![1]).components).toEqual([{ id: "state", values: { mode: "attack", visible: true } }]);
  });

  it("ignores an older entity read when the selected entity already has edits", async () => {
    const first = entity("first", "旧实体");
    const second = entity("second", "新实体");
    const { api } = materials("entity", { "specs/entities/first.md": first, "specs/entities/second.md": second });
    await within(await screen.findByRole("tree", { name: /实体关系树/ })).findByRole("button", { name: /^旧实体(?:\s|$)/ });
    let finishOld!: (result: FileReadResult) => void;
    api.readDocument.mockImplementation((path: string) => path === "specs/entities/first.md"
      ? new Promise((resolve) => { finishOld = resolve; })
      : Promise.resolve({ path, version, content: second }));
    await selectMaterial("旧实体");
    await selectMaterial("新实体");
    await waitFor(() => expect(screen.getByLabelText("名称")).toHaveValue("新实体"));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "新实体编辑中" } });
    await act(async () => finishOld({ path: "specs/entities/first.md", version, content: first }));
    expect(screen.getByLabelText("名称")).toHaveValue("新实体编辑中");
  });
});

it("groups official and custom components in the entity component picker", async () => {
  materials("entity", {
    "specs/entities/hero.md": entity("hero", "守灯人"),
    "specs/components/state_machine.md": component("state_machine", "状态机基类", []),
    "specs/components/health.md": component("health", "生命值", []),
  });
  await selectMaterial("守灯人");
  const picker = await screen.findByLabelText("选择组件");
  expect(picker.querySelector('optgroup[label="官方组件"]')).not.toBeNull();
  expect(picker.querySelector('optgroup[label="自定义组件"]')).not.toBeNull();
  expect(within(picker).getByRole("option", { name: "状态机基类" })).toBeVisible();
  expect(within(picker).getByRole("option", { name: "生命值" })).toBeVisible();
});
