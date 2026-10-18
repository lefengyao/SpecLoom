import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { WorkProcesses } from "../../src/main/core/tools/processes";
import { ProcessOutputDecoder } from "../../src/main/core/tools/process-output-decoder";

const roots: string[] = [];
const owners: WorkProcesses[] = [];
afterEach(async () => {
  await Promise.all(owners.splice(0).map(owner => owner.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "specloom-encoding-")); roots.push(base);
  const root = path.join(base, "中文 项目"); await mkdir(root);
  const processes = new WorkProcesses(root); owners.push(processes);
  return { root, processes };
}
const windows = test.skipIf(process.platform !== "win32");
windows("managed Windows processes preserve Chinese cwd and exact quoted arguments", async () => {
  const { root, processes } = await fixture();
  const script = path.join(root, "中文 参数.cjs");
  await writeFile(script, "console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}))");
  const args = ['一页永恒', '引号"与空格 路径\\结尾\\', 'C:\\生产项目\\中文\\文件.txt'];
  const result = await processes.runExecutable(process.execPath, [script, ...args], { timeoutMs: 8000 });
  expect(result.exitCode, result.output).toBe(0);
  expect(JSON.parse(result.output)).toEqual({ cwd: root, args });
}, 15000);
windows.each(["powershell", "cmd"])("%s commands preserve Chinese stdout and stderr", async shell => {
  const { processes } = await fixture();
  const command = shell === "powershell" ? "Write-Output '一页永恒'; [Console]::Error.WriteLine('中文错误')" : "echo 一页永恒 & echo 中文错误 1>&2";
  const result = await processes.run(command, { shell, timeoutMs: 8000 });
  expect(result.exitCode, result.output).toBe(0);
  expect(result.output).toContain("一页永恒"); expect(result.output).toContain("中文错误");
  expect(result.output).not.toContain("�");
}, 15000);
windows.each([
  ["using", 'using namespace System.Text; [StringBuilder]::new("中文脚本").ToString()'],
  ["param", 'param([string]$name="中文脚本"); Write-Output $name'],
])("PowerShell preserves a leading %s declaration", async (_kind, command) => {
  const { processes } = await fixture();
  const result = await processes.run(command, { shell: "powershell", timeoutMs: 8000 });
  expect(result.exitCode, result.output).toBe(0);
  expect(result.output).toBe("中文脚本");
}, 15000);
windows("PowerShell errors remain readable text rather than serialized CLIXML", async () => {
  const { processes } = await fixture();
  const result = await processes.run("Write-Error '中文错误'", { shell: "powershell", timeoutMs: 8000 });
  expect(result.exitCode).toBe(1); expect(result.output).toContain("中文错误");
  expect(result.output).not.toMatch(/CLIXML|<Objs|_x000D_/);
}, 15000);
windows("legacy native GBK stdout and stderr remain readable", async () => {
  const { processes } = await fixture();
  // Raw bytes model a native program that ignores the shell's UTF-8 code page.
  const result = await processes.runExecutable(process.execPath, ["-e", "process.stdout.write(Buffer.from('d2bbd2b3d3c0bae30a','hex'));process.stderr.write(Buffer.from('d6d0cec4b4edcef3','hex'))"], { timeoutMs: 8000 });
  expect(result.exitCode, result.output).toBe(0);
  expect(result.output).toContain("一页永恒"); expect(result.output).toContain("中文错误");
}, 15000);

windows("PowerShell -Command receives Chinese script data without losing quotes or backslashes", async () => {
  const { processes } = await fixture();
  const value = 'C:\\生产项目\\中文 "引号"\\末尾\\';
  const result = await processes.runExecutable("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `[Console]::Out.Write('${value}')`], { timeoutMs: 8000 });
  expect(result.exitCode, result.output).toBe(0); expect(result.output).toBe(value);
}, 15000);

windows.each(["powershell", "cmd"])("%s preserves quoted Chinese program paths and arguments", async shell => {
  const { root, processes } = await fixture();
  const script = path.join(root, "中文 参数.cjs");
  await writeFile(script, "console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}))");
  const args = ["一页 永恒", "C:\\中文\\文件.txt"];
  const values = [process.execPath, script, ...args];
  const command = shell === "powershell" ? `& ${values.map(value => `'${value.replaceAll("'", "''")}'`).join(" ")}` : values.map(value => `"${value}"`).join(" ");
  const result = await processes.run(command, { shell, timeoutMs: 8000 });
  expect(result.exitCode, result.output).toBe(0); expect(JSON.parse(result.output)).toEqual({ cwd: root, args });
}, 15000);

windows("native startup errors report their real Win32 code separately from message character positions", async () => {
  const { root, processes } = await fixture();
  const result = await processes.runExecutable(path.join(root, "不存在.exe"), [], { timeoutMs: 8000 });
  expect(result.exitCode).toBe(1); expect(result.output).toContain("[Win32 2]");
  expect(result.output).toContain("无法安全启动受管进程"); expect(result.output).not.toContain("�");
}, 15000);

windows.each(["powershell", "cmd"])("%s can relay a legacy native program's GBK bytes", async shell => {
  const { root, processes } = await fixture();
  const script = path.join(root, "legacy.cjs");
  await writeFile(script, "process.stdout.write(Buffer.from('d2bbd2b3d3c0bae30a','hex'));process.stderr.write(Buffer.from('d6d0cec4b4edcef3','hex'))");
  const command = shell === "powershell" ? `& '${process.execPath}' './legacy.cjs'` : `"${process.execPath}" "legacy.cjs"`;
  const result = await processes.run(command, { shell, timeoutMs: 8000 });
  expect(result.exitCode, result.output).toBe(0); expect(result.output).toContain("一页永恒"); expect(result.output).toContain("中文错误");
}, 15000);

windows("real Windows pipes preserve split UTF-8 stdout and GBK stderr through final flush", async () => {
  const { processes } = await fixture();
  const script = "const out=Buffer.from('中文😀');const err=Buffer.from('d2bbd2b3d3c0bae3','hex');process.stdout.write(out.subarray(0,2));process.stderr.write(err.subarray(0,1));setTimeout(()=>{process.stdout.write(out.subarray(2));process.stderr.write(err.subarray(1))},100)";
  const result = await processes.runExecutable(process.execPath, ["-e", script], { timeoutMs: 8000 });
  expect(result.exitCode, result.output).toBe(0); expect(result.output).toContain("中文😀"); expect(result.output).toContain("一页永恒"); expect(result.output).not.toContain("�");
}, 15000);

const marker = "\u001eSpecLoom:test:";
function decoder(codePage = 936) {
  const instance = new ProcessOutputDecoder(marker);
  expect(instance.write(Buffer.from(`${marker}${codePage}\n`))).toBe("");
  return instance;
}
test.each(["utf8", "gbk"])("%s multibyte characters survive every chunk boundary and final flush", encoding => {
  const expected = "一页永恒\n中文错误";
  const bytes = encoding === "utf8" ? Buffer.from(expected) : Buffer.from("d2bbd2b3d3c0bae30ad6d0cec4b4edcef3", "hex");
  for (let boundary = 0; boundary <= bytes.length; boundary++) {
    const instance = decoder();
    expect(instance.write(bytes.subarray(0, boundary)) + instance.write(bytes.subarray(boundary)) + instance.end()).toBe(expected);
  }
});
test("the UTF-8 handshake survives byte-sized chunks and does not enter user output", () => {
  const instance = new ProcessOutputDecoder(marker);
  let output = "";
  for (const byte of Buffer.from(`${marker}936\n一页永恒\n`)) output += instance.write(Buffer.from([byte]));
  expect(output + instance.end()).toBe("一页永恒\n");
});
test("UTF-8 and legacy native output can alternate between lines without locking a stream to one encoding", () => {
  const instance = decoder();
  const bytes = Buffer.concat([Buffer.from("UTF8 中文\n"), Buffer.from("d2bbd2b3d3c0bae30a", "hex"), Buffer.from("UTF8 😀\n")]);
  expect(instance.write(bytes) + instance.end()).toBe("UTF8 中文\n一页永恒\nUTF8 😀\n");
});
test("bounded records preserve long multibyte output across their internal boundaries", () => {
  const instance = decoder();
  const expected = "一页永恒😀".repeat(5000);
  expect(instance.write(Buffer.from(expected)) + instance.end()).toBe(expected);
  const legacy = decoder();
  expect(legacy.write(Buffer.from("d2bbd2b3d3c0bae3".repeat(10000), "hex")) + legacy.end()).toBe("一页永恒".repeat(10000));
});
test("UTF-8 byte-order characters survive line and bounded-record boundaries", () => {
  const instance = decoder();
  const expected = "A\uFEFF中文\n\uFEFF下一行\n" + "x".repeat(8192) + "\uFEFF末尾";
  expect(instance.write(Buffer.from(expected)) + instance.end()).toBe(expected);
});
test("truncated and malformed output stays visibly damaged and final bytes are flushed", () => {
  const instance = decoder();
  expect(instance.write(Buffer.from([0xff, 0x81, 0x30])) + instance.end()).toMatch(/无法可靠解码.*\n�/);
  const utf8Only = new ProcessOutputDecoder();
  expect(utf8Only.write(Buffer.from([0xe4, 0xb8])) + utf8Only.end()).toMatch(/替换字符.*\n�/);
});
test("absent or incomplete handshakes never discard real UTF-8 output at end", () => {
  const absent = new ProcessOutputDecoder(marker);
  expect(absent.write(Buffer.from("中文未换行")) + absent.end()).toBe("中文未换行");
  const incomplete = new ProcessOutputDecoder(marker);
  expect(incomplete.write(Buffer.from(marker.slice(0, -1))) + incomplete.end()).toBe(marker.slice(0, -1));
  const utf8Only = new ProcessOutputDecoder();
  const bytes = Buffer.from("UTF8 中文😀"); let output = "";
  for (const byte of bytes) output += utf8Only.write(Buffer.from([byte]));
  expect(output + utf8Only.end()).toBe("UTF8 中文😀");
});
test("unfinished UTF-8 previews preserve FEFF and withhold incomplete characters without consuming bytes", () => {
  const instance = decoder();
  const expected = "\uFEFF中文😀\uFEFF";
  const bytes = Buffer.from(expected);
  for (let index = 0; index < bytes.length; index++) {
    expect(instance.write(bytes.subarray(index, index + 1))).toBe("");
    expect(instance.preview()).not.toContain("�");
  }
  expect(instance.preview()).toBe(expected); expect(instance.preview()).toBe(expected);
  expect(instance.end()).toBe(expected); expect(instance.preview()).toBe("");
});
test("GBK previews can be corrected after an ambiguous UTF-8 prefix without corrupting final output", () => {
  const instance = decoder();
  const bytes = Buffer.from("d2bbd2b3d3c0bae3", "hex");
  expect(instance.write(bytes.subarray(0, 2))).toBe(""); instance.preview();
  expect(instance.write(bytes.subarray(2))).toBe("");
  expect(instance.preview()).toBe("一页永恒");
  expect(instance.write(Buffer.from("\n"))).toBe("一页永恒\n");
  expect(instance.preview()).toBe(""); expect(instance.end()).toBe("");
});
