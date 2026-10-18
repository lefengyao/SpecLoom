import { expect, test } from "vitest";
import { componentScope, summarizeMaterial } from "../../src/shared/material-catalog";
import { writeMaterial } from "../../src/shared/project-materials";

function component(path: string, id: string, extra = {}) {
  return summarizeMaterial({ path, version: "v1", content: writeMaterial({ id, title: "组件", type: "component", fields: [], ...extra }, "") });
}

test("uses built-in file identity for official components, including older projects", () => {
  expect(componentScope(component("specs/components/state_machine.md", "state_machine"))).toBe("system");
  expect(componentScope(component("specs/components/state_machine.md", "state_machine", { title: "已编辑的基类", group: "我的分组" }))).toBe("system");
});

test("editable labels and duplicated built-in IDs cannot make custom documents official", () => {
  expect(componentScope(component("specs/components/my_component.md", "custom", { scope: "system", group: "官方组件" }))).toBe("user");
  expect(componentScope(component("specs/components/copied.md", "state_machine", { scope: "system" }))).toBe("user");
  expect(componentScope(component("specs/components/state_machine.md", "custom", { scope: "system" }))).toBe("user");
});
