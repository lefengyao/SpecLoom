import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { docxFixture, pdfFixture } from "../helpers/chat-attachment-fixtures";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const root = fileURLToPath(new URL("../..", import.meta.url));
const preparerPath = new URL("../../scripts/hub-module-resources.mjs", import.meta.url).href;
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

interface Manifest { id: string; version: string; hostApiVersion: number; runtime: { entry: string; preload: string }; capabilities: string[] }
type Prepare = (options: { directory: string }) => Promise<Manifest>;
async function loadPreparer(): Promise<Prepare> {
  const module = await import(/* @vite-ignore */ preparerPath).catch(() => undefined) as { prepareHubModuleResources?: Prepare } | undefined;
  expect(module?.prepareHubModuleResources, "source resources expose a reusable preparer").toBeTypeOf("function");
  return module!.prepareHubModuleResources!;
}
async function staging() {
  const directory = await mkdtemp(path.join(tmpdir(), "specloom-hub-resource-test-"));
  temporary.push(directory); return directory;
}
async function snapshot(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []; throw error;
  });
  const rows: string[] = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) rows.push(...(await snapshot(target)).map(row => `${entry.name}/${row}`));
    else {
      const info = await lstat(target);
      rows.push(`${entry.name}:${info.size}:${info.mtimeMs}`);
    }
  }
  return rows.sort();
}

describe("Hub source module resources", () => {
  it("rejects relative or missing destinations before preparing resources", async () => {
    const prepare = await loadPreparer();
    await expect(prepare({ directory: "relative-module" })).rejects.toThrow(/absolute/i);
    const directory = await staging();
    await expect(prepare({ directory: path.join(directory, "missing") })).rejects.toThrow(/exist|ENOENT/i);
    expect(await readdir(directory)).toEqual([]);
  });

  it("preserves populated destinations and rejects directory links", async () => {
    const prepare = await loadPreparer();
    const directory = await staging();
    const sentinel = path.join(directory, "caller-data.txt");
    await writeFile(sentinel, "preserve caller-owned files");
    await expect(prepare({ directory })).rejects.toThrow(/empty/i);
    expect(await readFile(sentinel, "utf8")).toBe("preserve caller-owned files");
    const linkParent = await staging();
    const link = path.join(linkParent, "linked");
    await symlink(directory, link, process.platform === "win32" ? "junction" : "dir");
    await expect(prepare({ directory: link })).rejects.toThrow(/link|real directory/i);
    expect(await readFile(sentinel, "utf8")).toBe("preserve caller-owned files");
  });

  it("prepares current source resources in caller staging without changing published outputs", async () => {
    const prepare = await loadPreparer();
    const directory = await staging();
    const outside = [path.join(root, "dist"), path.join(root, "release"), path.join(root, "exports"), path.join(root, "../TraiblazerHub/release"), path.join(root, "../TraiblazerHub/exports")];
    const before = await Promise.all(outside.map(snapshot));
    const manifest = await prepare({ directory });
    const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { version: string };
    expect(manifest).toMatchObject({ id: "specloom", version: pkg.version, hostApiVersion: 2, runtime: { entry: "runtime/backend.mjs", preload: "runtime/preload.cjs" } });
    expect(JSON.parse(await readFile(path.join(directory, "module.json"), "utf8"))).toEqual(manifest);
    for (const file of ["renderer/index.html", "renderer/brand/icon.png", "runtime/backend.mjs", "runtime/preload.cjs", "runtime/chat-attachment-worker.cjs", "INSTALL.md", "node_modules/pdfjs-dist/package.json", "node_modules/@napi-rs/canvas/package.json", "resources/godot-mcp/manifest.json"]) {
      expect((await lstat(path.join(directory, file))).isFile(), file).toBe(true);
    }
    expect((await readdir(path.join(directory, "skills"))).length).toBeGreaterThan(0);
    expect(manifest.capabilities).toEqual(expect.arrayContaining(["context-compression", "web-search"]));
    expect(await Promise.all(outside.map(snapshot))).toEqual(before);
    expect(await readdir(directory)).not.toEqual(expect.arrayContaining(["release", "exports", "dist"]));
    const backend = await readFile(path.join(directory, "runtime/backend.mjs"), "utf8");
    expect(backend).toContain("lastRequestUsage");
    expect(backend).toContain("contextCalibration");
    expect(backend).toContain("web_search");
    // Execute staged workers in a child process: Windows keeps a native canvas
    // DLL loaded until process exit, even after terminating its worker thread.
    const runner = path.join(directory, "attachment-resource-smoke.mjs");
    await writeFile(runner, `import { Worker } from 'node:worker_threads';
const [, , workerPath, ...fixtures] = process.argv;
const results = [];
for (const [index, fixture] of fixtures.entries()) {
  const worker = new Worker(workerPath, { workerData: { kind: index === 0 ? 'docx' : 'pdf', bytes: new Uint8Array(Buffer.from(fixture, 'base64')) }, resourceLimits: { maxOldGenerationSizeMb: 128 } });
  try { results.push(await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); worker.once('exit', code => { if (code) reject(new Error('Worker exited: ' + code)); }); })); }
  finally { await worker.terminate(); }
}
console.log(JSON.stringify(results));
`);
    const executed = await promisify(execFile)(process.execPath, [runner, path.join(directory, "runtime/chat-attachment-worker.cjs"), docxFixture("Staged DOCX contents").toString("base64"), pdfFixture("Staged PDF contents").toString("base64")], { timeout: 30000, windowsHide: true });
    const results = JSON.parse(executed.stdout.trim()) as { ok: boolean; result: { text: string } }[];
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ ok: true, result: { text: "Staged DOCX contents" } });
    expect(results[1]?.ok).toBe(true); expect(results[1]?.result.text).toContain("Staged PDF contents");
  }, 120_000);
});
