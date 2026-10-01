import { describe, expect, it } from "vitest";
import { TaskScope } from "../../src/main/core/task-scope";
import type { TaskScopeSpec } from "../../src/shared/contracts";

function specification(overrides: Partial<TaskScopeSpec> = {}): TaskScopeSpec {
  return {
    id: "author-hero", title: "Author hero", mode: "manual", allowDelete: false,
    readPaths: ["specs/**", ".specloom/skills/**"],
    writePaths: ["specs/entities/hero.md", "scenes/hero.tscn"],
    ...overrides,
  };
}

describe("TaskScope", () => {
  it("allows explicit writes and read-only paths outside the write set", () => {
    const scope = new TaskScope(specification());
    expect(scope.assertRead("specs\\outline.md")).toBe("specs/outline.md");
    expect(scope.assertWrite("scenes\\hero.tscn", "create")).toBe("scenes/hero.tscn");
    expect(() => scope.assertWrite("scripts/unrelated.gd", "update")).toThrowError(expect.objectContaining({ code: "TASK_SCOPE_DENIED" }));
    expect(() => scope.assertWrite("specs/outline.md", "update")).toThrowError(expect.objectContaining({ code: "TASK_SCOPE_DENIED" }));
  });

  it("requires an explicit recursive grant and matches only whole path segments", () => {
    const scope = new TaskScope(specification({ readPaths: ["specs/entities"], writePaths: ["scenes/hero/**"] }));
    expect(scope.assertRead("specs/entities")).toBe("specs/entities");
    expect(() => scope.assertRead("specs/entities/hero.md")).toThrow();
    expect(scope.assertWrite("scenes/hero/body.tscn", "update")).toBe("scenes/hero/body.tscn");
    expect(() => scope.assertWrite("scenes/heroes/body.tscn", "update")).toThrow();
    expect(() => scope.assertWrite("scenes/hero", "update")).toThrow();
  });

  it("requires deletion to be enabled independently of write access", () => {
    expect(() => new TaskScope(specification()).assertWrite("scenes/hero.tscn", "delete")).toThrowError(expect.objectContaining({ code: "TASK_SCOPE_DENIED" }));
    const scope = new TaskScope(specification({ allowDelete: true }));
    expect(scope.assertWrite("scenes/hero.tscn", "delete")).toBe("scenes/hero.tscn");
    expect(() => scope.assertWrite("scripts/unrelated.gd", "delete")).toThrow();
    expect(() => scope.assertWrite("scenes/hero.tscn", "execute" as "update")).toThrow();
  });

  it.each([
    "../outside.md", "specs/../outside.md", "/specs/hero.md", "C:/specs/hero.md",
    "C:hero.md", "\\\\server\\share\\hero.md", "specs/hero.md:secret", "specs/./hero.md",
    "specs//hero.md", "specs/hero.md/", "specs/hero\u0000.md", "specs/hero.md ",
    "specs/CON", "specs/NUL.md", "specs/hero*", "",
  ])("rejects unsafe path %j before evaluating grants", (unsafePath) => {
    const scope = new TaskScope(specification({ readPaths: ["*"] }));
    expect(() => scope.assertRead(unsafePath)).toThrowError(expect.objectContaining({ code: "PATH_ESCAPE" }));
    expect(() => new TaskScope(specification({ writePaths: [unsafePath] }))).toThrow();
  });

  it.each([
    "specs/COM\u00b9", "specs/COM\u00b2", "specs/COM\u00b3",
    "specs/LPT\u00b9", "specs/LPT\u00b2", "specs/LPT\u00b3",
    "specs/com\u00b9.md", "specs/com\u00b2.md", "specs/com\u00b3.md",
    "specs/lpt\u00b9.md", "specs/lpt\u00b2.md", "specs/lpt\u00b3.md",
  ])("rejects Windows superscript device path %j at the task boundary", (unsafePath) => {
    const scope = new TaskScope(specification({ readPaths: ["*"], writePaths: ["specs/**"] }));
    expect(() => scope.assertRead(unsafePath)).toThrowError(expect.objectContaining({ code: "PATH_ESCAPE" }));
    expect(() => scope.assertWrite(unsafePath, "create")).toThrowError(expect.objectContaining({ code: "PATH_ESCAPE" }));
    expect(() => new TaskScope(specification({ readPaths: [unsafePath] }))).toThrowError(expect.objectContaining({ code: "PATH_ESCAPE" }));
    expect(() => new TaskScope(specification({ writePaths: [unsafePath] }))).toThrowError(expect.objectContaining({ code: "PATH_ESCAPE" }));
  });

  it.each([".specloom/project.yaml", ".specloom/history/changes/1.json", ".SPEClOOM/project.yaml", ".git/config", ".godot/editor/project_metadata.cfg"])("blocks protected path %s even with wildcard reads", (protectedPath) => {
    const scope = new TaskScope(specification({ readPaths: ["*"] }));
    expect(() => scope.assertRead(protectedPath)).toThrowError(expect.objectContaining({ code: "TASK_SCOPE_DENIED" }));
    expect(() => new TaskScope(specification({ writePaths: [protectedPath] }))).toThrowError(expect.objectContaining({ code: "TASK_SCOPE_DENIED" }));
  });

  it("allows project Skills without granting broader tool state access", () => {
    const scope = new TaskScope(specification({ writePaths: [".specloom/skills/**"] }));
    expect(scope.assertRead(".specloom/skills/project-context/SKILL.md")).toBe(".specloom/skills/project-context/SKILL.md");
    expect(scope.assertWrite(".specloom/skills/new/SKILL.md", "create")).toBe(".specloom/skills/new/SKILL.md");
    expect(() => scope.assertWrite(".specloom/history/new.md", "create")).toThrow();
    expect(() => new TaskScope(specification({ writePaths: ["*"] }))).toThrow();
  });

  it("keeps caller mutations from changing permission grants", () => {
    const input = specification();
    const scope = new TaskScope(input);
    input.writePaths.push("scripts/unrelated.gd");
    input.readPaths.push("scripts/**");
    input.allowDelete = true;
    const description = scope.describe();
    expect(Object.isFrozen(description)).toBe(true);
    expect(Object.isFrozen(description.writePaths)).toBe(true);
    expect(() => description.writePaths.push("scripts/unrelated.gd")).toThrow();
    expect(() => scope.assertWrite("scripts/unrelated.gd", "update")).toThrow();
    expect(() => scope.assertRead("scripts/unrelated.gd")).toThrow();
    expect(() => scope.assertWrite("scenes/hero.tscn", "delete")).toThrow();
    expect(scope.describe()).not.toBe(description);
  });
});
