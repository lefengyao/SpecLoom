// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MascotSpeech, greetingForHour } from "../../src/renderer/MascotSpeech";

afterEach(cleanup);

describe("mascot speech", () => {
  it("greets by time and cycles through the project lines on click", () => {
    render(<MascotSpeech />);
    const bubble = screen.getByRole("button", { name: /我是络络/ });
    expect(bubble).toHaveTextContent("先给我看一眼项目");

    fireEvent.click(bubble);
    expect(bubble).toHaveTextContent("世界观、角色、关卡，慢慢来。");

    fireEvent.click(bubble);
    expect(bubble).toHaveTextContent("设定理清楚了，代码就顺了。");
  });

  it("maps the day into a short greeting", () => {
    expect(greetingForHour(5)).toBe("早上好");
    expect(greetingForHour(11)).toBe("中午好");
    expect(greetingForHour(14)).toBe("下午好");
    expect(greetingForHour(18)).toBe("晚上好");
    expect(greetingForHour(23)).toBe("夜深了");
    expect(greetingForHour(2)).toBe("夜深了");
  });
});
