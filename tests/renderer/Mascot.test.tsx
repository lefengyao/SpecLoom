// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Mascot } from "../../src/renderer/Mascot";

afterEach(cleanup);

describe("mascot", () => {
  it("renders a decorative, animated sprite with unique mask ids", () => {
    const { container } = render(<><Mascot size={144} /><Mascot className="brand-logo" size={38} /><Mascot orbit="wide" trackPointer size={200} /></>);
    const sprites = container.querySelectorAll("svg.mascot");
    expect(sprites).toHaveLength(3);
    expect(sprites[0]).toHaveAttribute("aria-hidden", "true");
    expect(sprites[0]).toHaveAttribute("width", "144");
    expect(sprites[1]).toHaveClass("brand-logo");
    expect(sprites[1]).toHaveAttribute("width", "38");
    expect(container.querySelectorAll("mask")).toHaveLength(3);
    const ids = [...container.querySelectorAll("mask")].map((mask) => mask.id);
    expect(new Set(ids).size).toBe(3);
    expect(container.querySelector(".mascot-eye-hole")).not.toBeNull();
    expect(container.querySelector(".mascot-eye-clip")).not.toBeNull();
    expect(container.querySelector(".mascot-mouth")).not.toBeNull();
    expect(container.querySelector(".mascot-orbit-track")).not.toBeNull();
    expect(container.querySelector(".mascot-ball")).not.toBeNull();
    expect(sprites[2]).toHaveAttribute("viewBox", "-30 -30 220 220");
    expect(sprites[2]).toHaveAttribute("data-orbit-preset", "wide");
    expect(container.querySelector(".mascot-orbit-track")).toHaveAttribute("rx", "84");
    expect(container.querySelector(".mascot-pupil")).not.toBeNull();
  });
});
