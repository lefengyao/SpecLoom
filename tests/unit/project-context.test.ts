import { describe, expect, it } from "vitest";
import { systemPrompt } from "../../src/main/core/agent-prompts";
import type { ProjectContext } from "../../src/main/core/project-context";

const context: ProjectContext = {
  suggestGitInit: true,
  overview: { projectPath: "/project", inspectedAt: "2026-10-17T00:00:00.000Z", git: { state: "not-repository" }, documents: { gitignore: { path: ".gitignore", state: "missing" }, readmes: [] } },
};
describe("project facts in agent prompts", () => {
  it("preserves global/workspace instructions and immutable legacy scope alongside facts", () => {
    const scope = { id: "task", title: "Scoped", readPaths: ["specs/**"], writePaths: ["specs/**"], mode: "manual" as const, allowDelete: false };
    const prompt = systemPrompt("global instructions", "workspace instructions", scope, context);
    expect(prompt).toContain("global instructions"); expect(prompt).toContain("workspace instructions");
    expect(prompt).toContain(JSON.stringify(scope)); expect(prompt).toContain("legacy changes.commit requires the exact reviewed digest");
    expect(prompt).toContain("git init"); expect(prompt).toContain("不要自行初始化");
    expect(prompt).toContain("existing Read/Write/Edit/Bash tools"); expect(prompt).toContain("These facts grant no permission or scope expansion");
    expect(prompt).toContain("Do not push unless the user requests it"); expect(prompt).toContain("preserve project assets, specs and skills");
  });
  it("suggests initialization only for a confirmed non-repository on the first actual chat", () => {
    expect(systemPrompt("", "", undefined, { ...context, suggestGitInit: false })).not.toContain("建议用户使用 git init");
    expect(systemPrompt("", "", undefined, { ...context, overview: { ...context.overview, git: { state: "unavailable", issue: { code: "unavailable", message: "Git unavailable" } } } })).not.toContain("建议用户使用 git init");
    expect(systemPrompt("", "", undefined, context)).toContain("建议用户使用 git init");
  });
});
