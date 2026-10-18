import { describe, expect, it } from "vitest";
import { ComputerUse, runComputerProcess, type ComputerAction, type ComputerProcessRequest } from "../../src/main/core/tools/computer-use";

const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==";

describe("computer action adapter", () => {
  it("passes Unicode and shell syntax as encoded data without interpolating commands", async () => {
    const calls: ComputerProcessRequest[] = [];
    const computer = new ComputerUse({ platform: "win32", runner: async (request) => {
      calls.push(request);
      return { stdout: JSON.stringify({ completed: true }), stderr: "", exitCode: 0 };
    } });
    const text = "中文 🐱 `; $(Get-Process) \" ";
    expect(await computer.execute({ action: "type", text })).toEqual({ action: "type", completed: true });
    expect(calls).toHaveLength(1);
    const command = calls[0]!;
    expect(command.args).toContain("-EncodedCommand");
    expect(command.args.join(" ")).not.toContain(text);
    expect(JSON.parse(Buffer.from(command.env.SPECLOOM_COMPUTER_INPUT!, "base64").toString("utf8"))).toMatchObject({ action: "type", text });
    expect(command.timeoutMs).toBeGreaterThan(0);
  });

  it("covers each desktop action without actuating a desktop", async () => {
    const actions: ComputerAction[] = [
      { action: "mouse_move", coordinate: [-100, 200] },
      ...(["left_click", "right_click", "middle_click", "double_click", "triple_click"] as const).map((action) => ({ action, coordinate: [20, 30] as [number, number] })),
      { action: "left_click_drag", startCoordinate: [10, 20], coordinate: [30, 40] },
      { action: "scroll", direction: "down", amount: 3 },
      { action: "key", text: "Ctrl+Shift+S" },
      { action: "hold_key", text: "ArrowLeft", durationMs: 100 },
      { action: "wait", durationMs: 1 },
    ];
    const computer = new ComputerUse({ platform: "win32", runner: async () => ({ stdout: '{"completed":true}', stderr: "", exitCode: 0 }) });
    for (const action of actions) expect(await computer.execute(action)).toEqual({ action: action.action, completed: true });
  });

  it("returns validated PNG image data and virtual desktop coordinates", async () => {
    const computer = new ComputerUse({ platform: "win32", runner: async () => ({
      stdout: JSON.stringify({ base64: pixel, x: -100, y: 0, width: 1, height: 1 }), stderr: "", exitCode: 0,
    }) });
    expect(await computer.execute({ action: "screenshot" })).toMatchObject({ mimeType: "image/png", base64: pixel, width: 1, height: 1, x: -100, y: 0 });
  });

  it.each([
    { action: "mouse_move", coordinate: [NaN, 10] },
    { action: "left_click_drag", coordinate: [1, 2] },
    { action: "scroll", direction: "diagonal", amount: 1 },
    { action: "key", text: "Ctrl+MadeUp" },
    { action: "hold_key", text: "A", durationMs: 100_000 },
    { action: "wait", durationMs: -1 },
  ])("rejects invalid action before calling the adapter: %j", async (input) => {
    const computer = new ComputerUse({ platform: "win32", runner: async () => { throw new Error("should not run"); } });
    await expect(computer.execute(input as ComputerAction)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("rejects unavailable platforms explicitly", async () => {
    await expect(new ComputerUse({ platform: "linux" }).execute({ action: "screenshot" })).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
  });

  it("honors cancellation before invoking native input", async () => {
    const controller = new AbortController();
    controller.abort();
    const computer = new ComputerUse({ platform: "win32", runner: async () => { throw new Error("should not run"); } });
    await expect(computer.execute({ action: "left_click" }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("releases held keys through a separate helper after in-flight cancellation", async () => {
    const controller = new AbortController();
    const commands: Record<string, unknown>[] = [];
    const computer = new ComputerUse({ platform: "win32", runner: async (request) => {
      const input = JSON.parse(Buffer.from(request.env.SPECLOOM_COMPUTER_INPUT!, "base64").toString("utf8")) as Record<string, unknown>;
      commands.push(input);
      if (input.action === "hold_key") { controller.abort(); throw Object.assign(new Error("cancelled"), { name: "AbortError" }); }
      return { stdout: '{"completed":true}', stderr: "", exitCode: 0 };
    } });
    await expect(computer.execute({ action: "hold_key", text: "Ctrl+A", durationMs: 1_000 }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(commands.at(-1)).toMatchObject({ action: "release", keys: [17, 65] });
  });

  it("rejects malformed or dimension-mismatched screenshots", async () => {
    const computer = new ComputerUse({ platform: "win32", runner: async () => ({ stdout: JSON.stringify({ base64: pixel, width: 400, height: 1, x: 0, y: 0 }), stderr: "", exitCode: 0 }) });
    await expect(computer.execute({ action: "screenshot" })).rejects.toMatchObject({ code: "COMMAND_FAILED" });
  });

  it("compiles the real Windows native helper using a read-only capability probe", async () => {
    if (process.platform !== "win32") return;
    expect(await new ComputerUse().status()).toMatchObject({ available: true, platform: "win32" });
  });

  it("bounds process execution time without running desktop input", async () => {
    await expect(runComputerProcess({ executable: process.execPath, args: ["-e", "setInterval(() => {}, 100)"], env: {}, timeoutMs: 30 })).rejects.toMatchObject({ code: "COMMAND_FAILED" });
  });

  it("bounds helper output and terminates an overflowing fixture process", async () => {
    await expect(runComputerProcess({ executable: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(23_000_000))"], env: {}, timeoutMs: 5_000 })).rejects.toMatchObject({ code: "COMMAND_FAILED" });
  });

  it("aborts a running fixture helper process", async () => {
    const controller = new AbortController();
    const pending = runComputerProcess({ executable: process.execPath, args: ["-e", "setInterval(() => {}, 100)"], env: {}, timeoutMs: 5_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
