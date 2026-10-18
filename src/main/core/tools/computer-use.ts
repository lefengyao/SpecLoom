import { spawn } from "node:child_process";
import { ProjectError } from "../errors";

export const COMPUTER_ACTIONS = ["screenshot", "mouse_move", "left_click", "right_click", "middle_click", "double_click", "triple_click", "left_click_drag", "scroll", "type", "key", "hold_key", "wait"] as const;
export interface ComputerAction {
  action: typeof COMPUTER_ACTIONS[number]; coordinate?: [number, number]; startCoordinate?: [number, number];
  text?: string; direction?: "up" | "down" | "left" | "right"; amount?: number; durationMs?: number;
}
export interface ScreenshotImage { mimeType: "image/png"; base64: string; width: number; height: number }
export type ComputerActionResult = { action: ComputerAction["action"]; completed: true } | (ScreenshotImage & { x: number; y: number });
export interface ComputerProcessRequest { executable: string; args: string[]; env: Record<string, string>; timeoutMs: number; signal?: AbortSignal }
export interface ComputerProcessResult { stdout: string; stderr: string; exitCode: number }
export type ComputerProcessRunner = (request: ComputerProcessRequest) => Promise<ComputerProcessResult>;
const IMAGE_LIMIT = 16 * 1024 * 1024;
const OUTPUT_LIMIT = Math.ceil(IMAGE_LIMIT * 4 / 3) + 65_536;

/** Bounded, shell-free process helper. User data is never part of a command. */
export const runComputerProcess: ComputerProcessRunner = async (request) => {
  request.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(request.executable, request.args, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...request.env } });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let total = 0, settled = false;
    const finish = (error?: unknown, result?: ComputerProcessResult) => {
      if (settled) return;
      settled = true; clearTimeout(timer); request.signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => { child.kill(); const error = new Error("Computer action cancelled"); error.name = "AbortError"; finish(error); };
    const timer = setTimeout(() => { child.kill(); finish(new ProjectError("COMMAND_FAILED", "Computer action timed out")); }, request.timeoutMs);
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted) abort();
    const collect = (chunks: Buffer[], bytes: Buffer) => {
      total += bytes.length;
      if (total > OUTPUT_LIMIT) { child.kill(); finish(new ProjectError("COMMAND_FAILED", "Computer helper output exceeded the limit")); return; }
      chunks.push(bytes);
    };
    child.stdout.on("data", (bytes: Buffer) => collect(stdout, bytes));
    child.stderr.on("data", (bytes: Buffer) => collect(stderr, bytes));
    child.once("error", () => finish(new ProjectError("BACKEND_UNAVAILABLE", "The native computer helper could not be started")));
    child.once("close", (code) => finish(undefined, { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), exitCode: code ?? -1 }));
  });
};

export function validatePng(bytes: Buffer, expected?: { width: number; height: number }): { width: number; height: number } {
  if (bytes.length < 45 || bytes.length > IMAGE_LIMIT || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR" || bytes.toString("ascii", bytes.length - 8, bytes.length - 4) !== "IEND") {
    throw new ProjectError("COMMAND_FAILED", "The screenshot helper returned an invalid or oversized PNG");
  }
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > 32_768 || height > 32_768 || width * height > 100_000_000 || (expected && (width !== expected.width || height !== expected.height))) {
    throw new ProjectError("COMMAND_FAILED", "The screenshot dimensions are invalid");
  }
  return { width, height };
}

const virtualKeys: Record<string, number> = {
  ctrl: 17, control: 17, shift: 16, alt: 18, win: 91, meta: 91, super: 91,
  enter: 13, return: 13, escape: 27, esc: 27, tab: 9, space: 32, backspace: 8, delete: 46, insert: 45,
  home: 36, end: 35, pageup: 33, pagedown: 34, left: 37, arrowleft: 37, up: 38, arrowup: 38,
  right: 39, arrowright: 39, down: 40, arrowdown: 40, capslock: 20, printscreen: 44,
  minus: 189, equal: 187, comma: 188, period: 190, slash: 191, semicolon: 186, quote: 222,
  bracketleft: 219, bracketright: 221, backslash: 220, backquote: 192, plus: 187,
};
function parseKeys(text: string | undefined): number[] {
  if (!text || text.length > 128) throw new ProjectError("VALIDATION_FAILED", "Use a key name or chord such as Ctrl+Shift+S");
  const keys = text.split("+").map((part) => {
    const name = part.trim().toLowerCase();
    if (/^[a-z0-9]$/.test(name)) return name.toUpperCase().charCodeAt(0);
    const functionKey = /^f([1-9]|1[0-9]|2[0-4])$/.exec(name);
    if (functionKey) return 111 + Number(functionKey[1]);
    const code = virtualKeys[name];
    if (code === undefined) throw new ProjectError("VALIDATION_FAILED", "Unsupported key name", { key: part });
    return code;
  });
  if (keys.length > 5 || new Set(keys).size !== keys.length) throw new ProjectError("VALIDATION_FAILED", "Invalid key chord");
  return keys;
}

function validateAction(input: ComputerAction): ComputerAction & { keys?: number[] } {
  if (!input || !COMPUTER_ACTIONS.includes(input.action)) throw new ProjectError("VALIDATION_FAILED", "Unknown computer action");
  const validCoordinate = (coordinate: [number, number] | undefined, required = false) => {
    if (!coordinate && !required) return;
    if (!Array.isArray(coordinate) || coordinate.length !== 2 || !coordinate.every((n) => Number.isInteger(n) && Math.abs(n) <= 32_768)) {
      throw new ProjectError("VALIDATION_FAILED", "Coordinates must be two integer desktop pixels");
    }
  };
  validCoordinate(input.coordinate, input.action === "mouse_move" || input.action === "left_click_drag");
  validCoordinate(input.startCoordinate, input.action === "left_click_drag");
  if (input.action === "type" && (typeof input.text !== "string" || input.text.length > 10_000 || input.text.includes("\0"))) throw new ProjectError("VALIDATION_FAILED", "Type requires text up to 10000 characters");
  if (input.action === "scroll" && (!["up", "down", "left", "right"].includes(input.direction ?? "") || !Number.isInteger(input.amount) || input.amount! < 1 || input.amount! > 100)) throw new ProjectError("VALIDATION_FAILED", "Scroll requires a direction and amount from 1 to 100");
  const durationMs = input.durationMs ?? (input.action === "wait" ? 1_000 : 500);
  if ((input.durationMs !== undefined || input.action === "wait" || input.action === "hold_key") && (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > 30_000)) throw new ProjectError("VALIDATION_FAILED", "Duration must be from 1 to 30000 milliseconds");
  const keys = input.action === "key" || input.action === "hold_key" ? parseKeys(input.text) : undefined;
  return { ...input, ...(keys ? { keys } : {}), durationMs };
}

export class ComputerUse {
  private readonly platform: string;
  private readonly runner: ComputerProcessRunner;
  constructor(options: { platform?: string; runner?: ComputerProcessRunner } = {}) {
    this.platform = options.platform ?? process.platform; this.runner = options.runner ?? runComputerProcess;
  }
  private async invoke(input: object, timeoutMs: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    if (this.platform !== "win32") throw new ProjectError("BACKEND_UNAVAILABLE", "Desktop computer tools currently require Windows", { platform: this.platform });
    const result = await this.runner({ executable: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_COMPUTER_SCRIPT, "utf16le").toString("base64")],
      env: { SPECLOOM_COMPUTER_INPUT: Buffer.from(JSON.stringify(input), "utf8").toString("base64") }, timeoutMs, ...(signal ? { signal } : {}) });
    signal?.throwIfAborted();
    if (result.exitCode !== 0) throw new ProjectError("COMMAND_FAILED", "The Windows desktop action failed", { diagnostic: result.stderr.slice(0, 2_048) });
    try { const value: unknown = JSON.parse(result.stdout.trim()); if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>; } catch { /* handled below */ }
    throw new ProjectError("COMMAND_FAILED", "The native helper returned an invalid result");
  }
  async execute(input: ComputerAction, signal?: AbortSignal): Promise<ComputerActionResult> {
    signal?.throwIfAborted();
    const action = validateAction(input);
    let result: Record<string, unknown>;
    try { result = await this.invoke(action, 15_000 + (action.durationMs ?? 0), signal); }
    catch (error) {
      // Terminating PowerShell bypasses its finally blocks. Release keys/buttons
      // using a fresh helper with no cancelled signal before reporting failure.
      if (this.platform === "win32" && (action.keys || /click/.test(action.action))) {
        await this.invoke({ action: "release", keys: action.keys ?? [], mouse: /click/.test(action.action) }, 15_000).catch(() => undefined);
      }
      throw error;
    }
    if (action.action !== "screenshot") {
      if (result.completed !== true) throw new ProjectError("COMMAND_FAILED", "The desktop action did not complete");
      return { action: action.action, completed: true };
    }
    if (typeof result.base64 !== "string" || result.base64.length > OUTPUT_LIMIT || !/^[A-Za-z0-9+/]*={0,2}$/.test(result.base64)
      || !Number.isInteger(result.x) || !Number.isInteger(result.y) || !Number.isInteger(result.width) || !Number.isInteger(result.height)) throw new ProjectError("COMMAND_FAILED", "Invalid desktop screenshot response");
    const dimensions = validatePng(Buffer.from(result.base64, "base64"), { width: result.width as number, height: result.height as number });
    return { mimeType: "image/png", base64: result.base64, ...dimensions, x: result.x as number, y: result.y as number };
  }
  async status(): Promise<{ available: boolean; platform: string; reason?: string }> {
    if (this.platform !== "win32") return { available: false, platform: this.platform, reason: "Desktop computer tools currently require Windows" };
    try { await this.invoke({ action: "probe" }, 15_000); return { available: true, platform: this.platform }; }
    catch (error) { return { available: false, platform: this.platform, reason: error instanceof Error ? error.message : "Native helper unavailable" }; }
  }
}

// Static program: JSON input arrives only through an encoded environment variable.
export const WINDOWS_COMPUTER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$inputData = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:SPECLOOM_COMPUTER_INPUT)) | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class SpecLoomDesktop {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int n);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll", SetLastError=true)] private static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [StructLayout(LayoutKind.Sequential)] private struct INPUT { public uint type; public InputUnion data; }
  [StructLayout(LayoutKind.Explicit)] private struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mouse; [FieldOffset(0)] public KEYBDINPUT key; }
  [StructLayout(LayoutKind.Sequential)] private struct MOUSEINPUT { public int dx, dy; public uint mouseData, flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] private struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public UIntPtr extra; }
  public static void EnableDpi() { try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch (EntryPointNotFoundException) { } SetProcessDPIAware(); }
  public static void Keyboard(ushort code, bool up, bool unicode) {
    INPUT item = new INPUT(); item.type = 1; item.data.key = new KEYBDINPUT();
    item.data.key.vk = unicode ? (ushort)0 : code; item.data.key.scan = unicode ? code : (ushort)0;
    item.data.key.flags = (up ? 2u : 0u) | (unicode ? 4u : 0u);
    if (!unicode && ((code >= 33 && code <= 46) || code == 91)) item.data.key.flags |= 1u;
    if (SendInput(1, new INPUT[] { item }, Marshal.SizeOf(typeof(INPUT))) != 1) throw new InvalidOperationException("Windows rejected keyboard input; target may require elevation");
  }
  public static void Type(string text) { foreach (char c in text) { Keyboard(c, false, true); Keyboard(c, true, true); } }
  public static void Scroll(int delta, bool horizontal) { mouse_event(horizontal ? 0x1000u : 0x800u, 0, 0, unchecked((uint)delta), UIntPtr.Zero); }
  public static void Button(uint flag) { mouse_event(flag, 0, 0, 0, UIntPtr.Zero); }
}
'@
[SpecLoomDesktop]::EnableDpi()
$actionName = [string]$inputData.action
if ($actionName -eq 'probe') { '{"available":true}'; exit 0 }
if ($actionName -eq 'release') {
  foreach ($code in $inputData.keys) { [SpecLoomDesktop]::Keyboard([ushort]$code, $true, $false) }
  if ($inputData.mouse) { [SpecLoomDesktop]::Button(4); [SpecLoomDesktop]::Button(16); [SpecLoomDesktop]::Button(64) }
  '{"completed":true}'; exit 0
}
function Move-To($point) {
  $x = [int]$point[0]; $y = [int]$point[1]
  $left = [SpecLoomDesktop]::GetSystemMetrics(76); $top = [SpecLoomDesktop]::GetSystemMetrics(77)
  $width = [SpecLoomDesktop]::GetSystemMetrics(78); $height = [SpecLoomDesktop]::GetSystemMetrics(79)
  if ($x -lt $left -or $y -lt $top -or $x -ge ($left + $width) -or $y -ge ($top + $height)) { throw 'Coordinate is outside the virtual desktop' }
  if (-not [SpecLoomDesktop]::SetCursorPos($x, $y)) { throw 'Windows rejected cursor movement' }
}
if ($actionName -eq 'screenshot') {
  Add-Type -AssemblyName System.Drawing
  $x = [SpecLoomDesktop]::GetSystemMetrics(76); $y = [SpecLoomDesktop]::GetSystemMetrics(77)
  $width = [SpecLoomDesktop]::GetSystemMetrics(78); $height = [SpecLoomDesktop]::GetSystemMetrics(79)
  if ($width -le 0 -or $height -le 0 -or ([long]$width * $height) -gt 100000000) { throw 'No interactive desktop is available or it is too large' }
  $bitmap = [Drawing.Bitmap]::new($width, $height)
  $graphics = $null; $stream = $null
  try {
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($x, $y, 0, 0, $bitmap.Size, [Drawing.CopyPixelOperation]::SourceCopy)
    $stream = [IO.MemoryStream]::new()
    $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
    if ($stream.Length -gt 16777216) { throw 'Screenshot exceeds 16 MiB' }
    @{base64=[Convert]::ToBase64String($stream.ToArray()); x=$x; y=$y; width=$width; height=$height} | ConvertTo-Json -Compress
  } finally { if ($graphics) { $graphics.Dispose() }; if ($stream) { $stream.Dispose() }; $bitmap.Dispose() }
  exit 0
}
if ($inputData.coordinate -and $actionName -ne 'left_click_drag') { Move-To $inputData.coordinate }
switch ($actionName) {
  'mouse_move' { }
  { $_ -in 'left_click','right_click','middle_click','double_click','triple_click' } {
    $down = 2; $up = 4; $count = 1
    if ($_ -eq 'right_click') { $down = 8; $up = 16 }
    if ($_ -eq 'middle_click') { $down = 32; $up = 64 }
    if ($_ -eq 'double_click') { $count = 2 }; if ($_ -eq 'triple_click') { $count = 3 }
    for ($i = 0; $i -lt $count; $i++) { [SpecLoomDesktop]::Button($down); try { Start-Sleep -Milliseconds 30 } finally { [SpecLoomDesktop]::Button($up) }; if ($i -lt ($count - 1)) { Start-Sleep -Milliseconds 80 } }
  }
  'left_click_drag' {
    Move-To $inputData.startCoordinate
    [SpecLoomDesktop]::Button(2)
    try { for ($step = 1; $step -le 20; $step++) {
      $px = [int]($inputData.startCoordinate[0] + ($inputData.coordinate[0] - $inputData.startCoordinate[0]) * $step / 20)
      $py = [int]($inputData.startCoordinate[1] + ($inputData.coordinate[1] - $inputData.startCoordinate[1]) * $step / 20)
      Move-To @($px,$py); Start-Sleep -Milliseconds 15
    } } finally { [SpecLoomDesktop]::Button(4) }
  }
  'scroll' { $delta = [int]$inputData.amount * 120; if ($inputData.direction -in 'down','left') { $delta = -$delta }; [SpecLoomDesktop]::Scroll($delta, $inputData.direction -in 'left','right') }
  'type' { [SpecLoomDesktop]::Type([string]$inputData.text) }
  { $_ -in 'key','hold_key' } {
    $pressed = [Collections.Generic.List[int]]::new()
    try { foreach ($code in $inputData.keys) { [SpecLoomDesktop]::Keyboard([ushort]$code, $false, $false); $pressed.Add([int]$code) }; if ($_ -eq 'hold_key') { Start-Sleep -Milliseconds ([int]$inputData.durationMs) } }
    finally { for ($i = $pressed.Count - 1; $i -ge 0; $i--) { [SpecLoomDesktop]::Keyboard([ushort]$pressed[$i], $true, $false) } }
  }
  'wait' { Start-Sleep -Milliseconds ([int]$inputData.durationMs) }
  default { throw 'Unknown desktop action' }
}
'{"completed":true}'
`;
