// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import App from "../../src/renderer/App";

afterEach(cleanup);

describe("initial project workspace", () => {
  it("shows the application identity", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "SpecLoom" })).toBeVisible();
  });

  it("keeps project selection disabled until the project bridge exists", () => {
    render(<App />);
    expect(screen.getByRole("button", { name: "Select Godot Project" })).toBeDisabled();
  });
});
