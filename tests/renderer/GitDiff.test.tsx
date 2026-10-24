// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { diffLineKind, GitDiff } from "../../src/renderer/GitDiff";

describe("diffLineKind", () => {
  test("classifies file headers before single-character prefixes", () => {
    expect(diffLineKind("+++ b/entities/combat_entity.gd")).toBe("meta");
    expect(diffLineKind("--- a/entities/combat_entity.gd")).toBe("meta");
    expect(diffLineKind("+extends Node2D")).toBe("added");
    expect(diffLineKind("-extends Area2D")).toBe("removed");
  });

  test("classifies hunks, metadata and context", () => {
    expect(diffLineKind("@@ -1,5 +1,5 @@ class_name CombatEntity")).toBe("hunk");
    expect(diffLineKind("diff --git a/a.gd b/a.gd")).toBe("meta");
    expect(diffLineKind("index 8685ed6..93fa672 100644")).toBe("meta");
    expect(diffLineKind("new file mode 100644")).toBe("meta");
    expect(diffLineKind("\\ No newline at end of file")).toBe("meta");
    expect(diffLineKind(" class_name CombatEntity")).toBe("context");
    expect(diffLineKind("")).toBe("context");
  });
});

test("renders one block per line with its own color class", () => {
  const text = ["diff --git a/a.gd b/a.gd", "--- a/a.gd", "+++ b/a.gd", "@@ -1 +1 @@", "-old", "+new", " keep"].join("\n");
  const { container } = render(<GitDiff text={text} />);
  const lines = Array.from(container.querySelectorAll(".git-diff-line"));
  expect(lines.map((line) => line.className)).toEqual([
    "git-diff-line meta",
    "git-diff-line meta",
    "git-diff-line meta",
    "git-diff-line hunk",
    "git-diff-line removed",
    "git-diff-line added",
    "git-diff-line context",
  ]);
  expect(lines.map((line) => line.textContent)).toEqual(["diff --git a/a.gd b/a.gd", "--- a/a.gd", "+++ b/a.gd", "@@ -1 +1 @@", "-old", "+new", " keep"]);
});

test("drops the empty row produced by a trailing newline", () => {
  const { container } = render(<GitDiff text={"+only\n"} />);
  expect(container.querySelectorAll(".git-diff-line")).toHaveLength(1);
});

test("keeps interior blank lines visible", () => {
  const { container } = render(<GitDiff text={"-old\n\n+new"} />);
  const lines = Array.from(container.querySelectorAll(".git-diff-line"));
  expect(lines).toHaveLength(3);
  expect(lines[1]!.className).toBe("git-diff-line context");
  expect(lines[1]!.textContent).toBe("");
});
