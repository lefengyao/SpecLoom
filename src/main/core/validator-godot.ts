import type { ValidationDiagnostic } from "../../shared/contracts";

export function godotDiagnostics(output: string): ValidationDiagnostic[] {
  const lines = output.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "").split(/\r?\n/);
  const result: ValidationDiagnostic[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!/^\s*(?:SCRIPT ERROR:|ERROR:|Parse Error:)/.test(line)) continue;
    const context = [line, lines[index + 1] ?? "", lines[index + 2] ?? ""].join("\n");
    const location = /res:\/\/([^"'\r\n():]+)(?::(\d+))?/.exec(context);
    const code = /SCRIPT ERROR:|Parse Error:/.test(line) ? "GODOT_SCRIPT_ERROR" : "GODOT_ERROR";
    result.push({ severity: "error", code, path: location?.[1] ?? "project.godot", message: line.trim(), ...(location?.[2] ? { line: Number(location[2]) } : {}) });
  }
  return result;
}
