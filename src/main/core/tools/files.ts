import path from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { parse } from "yaml";
import { FileStore } from "../file-store";
import { ProjectError } from "../errors";
import { digestBytes } from "../store-fs";
import type { VersionToken } from "../../../shared/contracts";
import { ProjectDocuments } from "../project-documents";
export interface ToolImage { mimeType: string; base64: string }
const mediaTypes: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
const ignored = new Set([".git", ".godot", "node_modules", "dist", "release", ".specloom"]);
export function globExpression(pattern: string): RegExp {
  if (pattern.includes("..") || /[:\0]/.test(pattern) || pattern.startsWith("/")) throw new ProjectError("PATH_ESCAPE", "Glob 必须是项目相对模式");
  let source = ""; const value = pattern.replaceAll("\\", "/");
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (char === "*" && value[i + 1] === "*") { i++; if (value[i + 1] === "/") { i++; source += "(?:.*/)?"; } else source += ".*"; }
    else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}
/** Small, engine-independent file toolbox; receipts belong to this agent context. */
export class WorkFiles {
  private readonly receipts = new Map<string, VersionToken>();
  constructor(readonly store: FileStore, private readonly projectDocuments = true) {}
  async paths(): Promise<string[]> {
    await this.store.policy.validateRoot(); const found: string[] = [];
    const visit = async (prefix: string) => {
      const directory = prefix ? await this.store.policy.resolve(prefix) : this.store.root;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (ignored.has(entry.name.toLowerCase()) || entry.name.includes(".specloom-tmp-")) continue;
        const relative = path.posix.join(prefix, entry.name);
        if (entry.isSymbolicLink()) continue;
        await this.store.policy.resolve(relative);
        if (entry.isDirectory()) await visit(relative); else if (entry.isFile()) found.push(relative);
        if (found.length > 50000) throw new ProjectError("VALIDATION_FAILED", "文件列表超过 50000；请缩小工作区");
      }
    }; await visit(""); return found.sort();
  }
  async read(input: { path: string; offset?: number; limit?: number }): Promise<unknown> {
    const file = this.store.normalizePath(input.path); const version = await this.store.listVersion(file);
    if (!version.exists) throw new ProjectError("FILE_NOT_FOUND", `文件不存在：${file}`);
    const extension = path.extname(file).toLowerCase();
    if (mediaTypes[extension] || extension === ".pdf") {
      if (version.size > 6 * 1024 * 1024) throw new ProjectError("VALIDATION_FAILED", "媒体文件超过 6MB，请拆分文件");
      const target = await this.store.policy.resolve(file); const bytes = await readFile(target); await this.store.policy.assertSafe(target);
      this.store.assertVersion(file, digestBytes(bytes), version.version); this.receipts.set(this.store.pathIdentity(file), version.version);
      if (mediaTypes[extension]) return { path: file, version: version.version, images: [{ mimeType: mediaTypes[extension], base64: bytes.toString("base64") }] };
      const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
      try {
        const document = await loading.promise;
        const pages: { page: number; text: string }[] = []; const start = input.offset ?? 1; const end = Math.min(document.numPages, start + (input.limit ?? 20) - 1);
        let length = 0;
        for (let page = start; page <= end; page++) {
          const content = await (await document.getPage(page)).getTextContent(); const text = content.items.map(i => "str" in i ? i.str : "").join(" "); length += text.length;
          if (length > 131072) throw new ProjectError("VALIDATION_FAILED", "PDF 内容过长，请指定页码和页数"); pages.push({ page, text });
        }
        return { path: file, version: version.version, totalPages: document.numPages, pages };
      } finally { await loading.destroy(); }
    }
    const read = await this.store.read(file, version.version); this.receipts.set(this.store.pathIdentity(file), version.version);
    if (extension === ".ipynb") {
      const notebook = JSON.parse(read.content) as { cells?: { cell_type?: string; source?: string | string[]; outputs?: unknown[] }[] };
      if (!Array.isArray(notebook.cells)) throw new ProjectError("VALIDATION_FAILED", "Notebook 缺少 cells");
      const start = (input.offset ?? 1) - 1; return { path: file, version: version.version, totalCells: notebook.cells.length, cells: notebook.cells.slice(start, start + (input.limit ?? 100)).map((c, i) => ({ cell: start + i + 1, type: c.cell_type, source: Array.isArray(c.source) ? c.source.join("") : c.source, outputs: c.outputs })) };
    }
    const lines = read.content.split(/\r?\n/); const start = (input.offset ?? 1) - 1; const selected = lines.slice(start, start + (input.limit ?? 2000));
    return { ...read, content: selected.map((line, i) => `${start + i + 1}: ${line}`).join("\n"), totalLines: lines.length, truncated: start + selected.length < lines.length };
  }
  private async baseline(relative: string): Promise<VersionToken> {
    const current = await this.store.listVersion(relative); const receipt = this.receipts.get(this.store.pathIdentity(relative));
    if (!current.exists) return "absent";
    if (!receipt) throw new ProjectError("VALIDATION_FAILED", `修改前必须先 Read：${relative}`);
    this.store.assertVersion(relative, current.version, receipt); return receipt;
  }
  async write(relative: string, content: string) {
    const version = await this.baseline(relative); const result = await this.save(relative, content, version);
    this.receipts.delete(this.store.pathIdentity(relative)); return result;
  }
  async edit(input: { path: string; old_string: string; new_string: string; replace_all?: boolean }) {
    const version = await this.baseline(input.path); if (version === "absent") throw new ProjectError("FILE_NOT_FOUND", "Edit 只能修改已有文件");
    const read = await this.store.read(input.path, version); const occurrences = read.content.split(input.old_string).length - 1;
    if (!occurrences || (!input.replace_all && occurrences > 1)) throw new ProjectError("INVALID_PATCH", "old_string 必须唯一匹配，或明确 replace_all");
    const content = input.replace_all ? read.content.split(input.old_string).join(input.new_string) : read.content.replace(input.old_string, () => input.new_string);
    const result = await this.save(input.path, content, version); this.receipts.delete(this.store.pathIdentity(input.path)); return { ...result, replacements: input.replace_all ? occurrences : 1 };
  }
  private async save(relative: string, content: string, version: VersionToken) {
    const identity = this.store.pathIdentity(relative);
    if (this.projectDocuments && identity.startsWith("specs/") && identity.endsWith(".md")) {
      const saved = await new ProjectDocuments(this.store).save(relative, content, version);
      return { path: saved.path, version: saved.version, exists: true, size: Buffer.byteLength(saved.content, "utf8") };
    }
    return this.store.write(relative, content, version);
  }
  async glob(pattern: string) { const match = globExpression(pattern); return (await this.paths()).filter(p => match.test(p)); }
  async grep(input: { pattern: string; glob?: string; ignore_case?: boolean; limit?: number }, beforeRead?: (file: string) => Promise<void>) {
    let match: RegExp; try { match = new RegExp(input.pattern, input.ignore_case ? "iu" : "u"); } catch { throw new ProjectError("VALIDATION_FAILED", "Grep 正则无效"); }
    const matches: { path: string; line: number; text: string }[] = []; const limit = input.limit ?? 100;
    for (const file of await this.glob(input.glob ?? "**/*")) {
      if (mediaTypes[path.extname(file)] || path.extname(file) === ".pdf") continue;
      await beforeRead?.(file);
      const version = await this.store.listVersion(file); if (version.size > this.store.maxTextBytes) continue;
      let content: string; try { content = (await this.store.read(file, version.version)).content; } catch (error) { if (error instanceof ProjectError && error.code === "VALIDATION_FAILED") continue; throw error; }
      for (const [index, line] of content.split(/\r?\n/).entries()) if (match.test(line)) { matches.push({ path: file, line: index + 1, text: line.slice(0, 2000) }); if (matches.length >= limit) return { matches, truncated: true }; }
    }
    return { matches, truncated: false };
  }
}

export async function skillMetadata(files: FileStore): Promise<{ id: string; name: string; purpose: string; path: string }[]> {
  const found: { id: string; name: string; purpose: string; path: string }[] = [];
  for (const candidate of await files.listFiles(".specloom/skills")) {
    if (!/^\.specloom\/skills\/[^/]+\/SKILL\.md$/.test(candidate.path)) continue;
    const read = await files.read(candidate.path, candidate.version); const header = /^---\r?\n([\s\S]*?)\r?\n---/.exec(read.content);
    if (!header) continue;
    let metadata: Record<string, unknown>;
    try { const parsed: unknown = parse(header[1]!); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue; metadata = parsed as Record<string, unknown>; }
    catch { continue; } // Optional broken workflows never disable the coding work set.
    const id = candidate.path.split("/")[2]!;
    found.push({ id, name: String(metadata.name ?? id).slice(0, 256), purpose: String(metadata.purpose ?? metadata.description ?? "项目工作流").slice(0, 2000), path: candidate.path });
  }
  return found;
}
