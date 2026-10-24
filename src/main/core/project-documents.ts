import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { FileReadResult, ValidationDiagnostic, VersionToken } from "../../shared/contracts";
import { categoryForPath } from "../../shared/material-catalog";
import { normalizeMaterialGroups, validateMaterialGroupRegistry } from "../../shared/material-groups";
import { materialImageLimit, materialImagePath, materialImagePrefix } from "../../shared/material-images";
import { ProjectError } from "./errors";
import type { FileStore } from "./file-store";
import { digestBytes, hasCode, removeTemporary } from "./store-fs";
import { Validator } from "./validator";
import { parseSpec, validateFields } from "./validator-markdown";
import { publishMaterialChange } from "./material-events";

const mimeTypes: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
function imageType(bytes: Buffer): string | undefined {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString("ascii", 12, 16) === "IHDR") return "png";
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "jpg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (bytes.length >= 13 && /GIF8[79]a/.test(bytes.toString("ascii", 0, 6))) return "gif";
  return undefined;
}

function pngHasAlpha(bytes: Buffer): boolean {
  if (bytes.length < 26) return false;
  const colorType = bytes[25];
  return colorType === 4 || colorType === 6 || (colorType === 3 && bytes.includes(Buffer.from("tRNS")));
}

export interface ImageCrop { x: number; y: number; width: number; height: number }

function assertCrop(crop: ImageCrop): void {
  const values = [crop.x, crop.y, crop.width, crop.height];
  if (values.some((value) => typeof value !== "number" || !Number.isFinite(value))) throw new ProjectError("VALIDATION_FAILED", "裁剪区域必须是归一化数值");
  if (crop.width <= 0 || crop.height <= 0 || crop.x < 0 || crop.y < 0 || crop.x + crop.width > 1 || crop.y + crop.height > 1) throw new ProjectError("VALIDATION_FAILED", "裁剪区域必须位于图片范围内且宽高大于 0");
}

/** Crop in desktop; always re-encode because only Electron can decode the source reliably. */
async function cropImage(bytes: Buffer, extension: string, crop: ImageCrop): Promise<Buffer> {
  if (extension === "gif") throw new ProjectError("VALIDATION_FAILED", "GIF 可能包含动画，不能裁剪");
  if (process.versions.electron === undefined) throw new ProjectError("VALIDATION_FAILED", "当前运行环境不支持图片裁剪");
  assertCrop(crop);
  const { nativeImage } = await import("electron");
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) throw new ProjectError("VALIDATION_FAILED", "图片无法解码");
  const { width, height } = image.getSize();
  const left = Math.min(width - 1, Math.round(crop.x * width));
  const top = Math.min(height - 1, Math.round(crop.y * height));
  const cropWidth = Math.max(1, Math.min(width - left, Math.round(crop.width * width)));
  const cropHeight = Math.max(1, Math.min(height - top, Math.round(crop.height * height)));
  return image.crop({ x: left, y: top, width: cropWidth, height: cropHeight }).toPNG();
}

/** Desktop imports re-encode oversized PNG/JPEG art so portraits are not rejected at the size limit. */
async function compressImage(bytes: Buffer, extension: string): Promise<{ bytes: Buffer; extension: "png" | "jpg" } | undefined> {
  if (process.versions.electron === undefined || (extension !== "png" && extension !== "jpg")) return undefined;
  try {
    const { nativeImage } = await import("electron");
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) return undefined;
    const { width, height } = image.getSize();
    const alpha = extension === "png" && pngHasAlpha(bytes);
    let scale = Math.min(1, 4096 / Math.max(width, height));
    for (let attempt = 0; attempt < 10; attempt++) {
      const resized = scale >= 1 ? image : image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: "best" });
      const encoded = alpha ? resized.toPNG() : resized.toJPEG(82);
      if (encoded.length <= materialImageLimit) return { bytes: encoded, extension: alpha ? "png" : "jpg" };
      scale *= 0.8;
    }
  } catch { /* Keep the explicit size error when the runtime cannot decode the image. */ }
  return undefined;
}

/** Desktop and agent materials share validation and persistence, independently of tasks and models. */
export class ProjectDocuments {
  constructor(private readonly store: FileStore) {}

  async save(relative: string, content: string, expectedVersion: VersionToken): Promise<FileReadResult> {
    const normalized = this.store.normalizePath(relative);
    const identity = this.store.pathIdentity(normalized);
    if ((!identity.startsWith("specs/") && !identity.startsWith(".specloom/skills/")) || !identity.endsWith(".md")) {
      throw new ProjectError("TASK_SCOPE_DENIED", "资料保存仅支持项目规范与 Skills 的 Markdown 文件");
    }
    this.store.validateContent(content);
    const result = await this.store.withLock(async (access) => {
      this.store.assertVersion(normalized, (await this.store.listVersion(normalized)).version, expectedVersion);
      if (/^specs\/(entities|components|settings|maps|ui)\//.test(identity) || (identity.startsWith("specs/") && /^\uFEFF?---[ \t]*\r?\n/.test(content))) {
        const diagnostics: ValidationDiagnostic[] = [];
        const spec = parseSpec(normalized, content, diagnostics);
        if (spec) {
          validateFields(spec, diagnostics);
          if (spec.data.group !== undefined && (typeof spec.data.group !== "string" || spec.data.group.length > 100)) throw new ProjectError("VALIDATION_FAILED", "分组名称最多 100 个字符");
          const projectPath = "specs/project.md";
          const isProjectDocument = normalized.toLowerCase() === projectPath;
          const projectVersion = isProjectDocument ? undefined : await this.store.listVersion(projectPath);
          const projectContent = isProjectDocument
            ? content
            : projectVersion?.exists
              ? (await this.store.read(projectPath, projectVersion.version)).content
              : undefined;
          if (projectContent !== undefined) {
            const projectDiagnostics: ValidationDiagnostic[] = [];
            const projectSpec = isProjectDocument ? spec : parseSpec(projectPath, projectContent, projectDiagnostics);
            if (!projectSpec) throw new ProjectError("VALIDATION_FAILED", "项目分组登记表无法解析", { path: projectPath, diagnostics: projectDiagnostics });
            const rawRegistry = projectSpec.data.materialGroups;
            const registryErrors = validateMaterialGroupRegistry(rawRegistry);
            if (registryErrors.length) throw new ProjectError("VALIDATION_FAILED", `项目分组登记表无效：${registryErrors[0]}`, { path: projectPath, diagnostics: registryErrors });
            if (!isProjectDocument && spec.data.groupId !== undefined) {
              const category = categoryForPath(normalized);
              const groupId = spec.data.groupId;
              if (typeof groupId !== "string" || !groupId.trim() || !category || !(normalizeMaterialGroups(rawRegistry)[category] ?? []).some((group) => group.id === groupId)) {
                throw new ProjectError("VALIDATION_FAILED", "资料分组必须属于当前资料类别且已在项目分组树中登记", { path: normalized, groupId });
              }
            }
          } else if (spec.data.groupId !== undefined) {
            throw new ProjectError("VALIDATION_FAILED", "项目分组登记表不存在，无法验证资料分组", { path: normalized });
          }
          if (spec.data.image !== undefined && (typeof spec.data.image !== "string" || !materialImagePath.test(spec.data.image))) throw new ProjectError("VALIDATION_FAILED", "请选择项目资料图片");
          if (typeof spec.data.image === "string") await this.readImage(spec.data.image);
        }
        if (diagnostics.length) throw new ProjectError("VALIDATION_FAILED", diagnostics[0]!.message, { path: normalized, diagnostics });
        const validator = new Validator(this.store);
        const baseline = await validator.validate({ runGodot: false, specificationsOnly: true });
        const previous = new Set(baseline.diagnostics.map((item) => JSON.stringify(item)));
        const next = await validator.validateWithDependencies({ runGodot: false, specificationsOnly: true, overlay: [{ path: normalized, operation: expectedVersion === "absent" ? "create" : "update", expectedVersion, nextContent: content, sourceTaskId: "manual-material", sourceTool: "document.save" }] });
        const introduced = next.result.diagnostics.filter((item) => item.severity === "error" && !previous.has(JSON.stringify(item)));
        if (introduced.length) throw new ProjectError("VALIDATION_FAILED", introduced[0]!.message, { path: normalized, diagnostics: introduced });
        for (const [dependency, version] of Object.entries(next.dependencies)) {
          if (dependency === normalized) continue;
          if (dependency === ".specloom/generated-manifest.json") {
            const target = await this.store.policy.resolve(dependency, true);
            let actual: VersionToken = "absent";
            try {
              const handle = await this.store.fs.open(target, "r");
              try {
                if ((await handle.stat()).size > this.store.maxTextBytes) throw new ProjectError("VALIDATION_FAILED", "生成清单超过文件大小限制");
                actual = digestBytes(await handle.readFile());
                await this.store.policy.assertSafe(target);
              } finally { await handle.close(); }
            } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
            this.store.assertVersion(dependency, actual, version);
          } else this.store.assertVersion(dependency, (await this.store.listVersion(dependency)).version, version);
        }
      }
      const saved = await access.write(normalized, content, expectedVersion);
      return { path: saved.path, content, version: saved.version };
    });
    publishMaterialChange({ projectPath: this.store.root, path: result.path, version: result.version });
    return result;
  }

  async importImage(dataUrl: string, crop?: ImageCrop): Promise<string> {
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
    if (!match) throw new ProjectError("VALIDATION_FAILED", "支持 PNG、JPEG、WebP、GIF 图片");
    let bytes: Buffer = Buffer.from(match[2]!, "base64");
    let extension = imageType(bytes);
    if (crop) { if (!extension) throw new ProjectError("VALIDATION_FAILED", "图片格式无效"); bytes = await cropImage(bytes, extension, crop); extension = "png"; }
    if (bytes.length > materialImageLimit && extension) {
      const compressed = await compressImage(bytes, extension);
      if (compressed) { bytes = compressed.bytes; extension = compressed.extension; }
    }
    if (!bytes.length || bytes.length > materialImageLimit || !extension) throw new ProjectError("VALIDATION_FAILED", "图片格式无效或压缩后仍超过 2 MiB");
    const relative = `${materialImagePrefix}${createHash("sha256").update(bytes).digest("hex")}.${extension}`;
    await this.store.withLock(async () => {
      const target = await this.store.policy.resolve(relative);
      const current = await this.store.listVersion(relative);
      if (current.exists) {
        this.store.assertVersion(relative, current.version, `sha256:${path.basename(relative).split(".")[0]!}`);
        return;
      }
      await this.store.policy.ensureParent(target);
      const temporary = path.join(path.dirname(target), `.specloom-tmp-${randomUUID()}`);
      try {
        await this.store.policy.assertSafe(temporary, true);
        const handle = await this.store.fs.open(temporary, "wx");
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        await this.store.policy.assertSafe(target, true);
        try { await this.store.fs.link(temporary, target); }
        catch (error) {
          if (!hasCode(error, "EEXIST")) throw error;
          this.store.assertVersion(relative, (await this.store.listVersion(relative)).version, `sha256:${path.basename(relative).split(".")[0]!}`);
        }
      } finally { await removeTemporary(this.store.fs, temporary); }
    });
    return relative;
  }

  async readImage(relative: string): Promise<string> {
    if (!materialImagePath.test(relative)) throw new ProjectError("TASK_SCOPE_DENIED", "图片必须位于项目资料图片目录");
    const target = await this.store.policy.resolve(relative);
    const handle = await this.store.fs.open(target, "r");
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > materialImageLimit) throw new ProjectError("VALIDATION_FAILED", "图片超过 2 MiB");
      const bytes = Buffer.alloc(stats.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
        if (!bytesRead) throw new ProjectError("VERSION_CONFLICT", "图片在读取期间发生变化");
        offset += bytesRead;
      }
      await this.store.policy.assertSafe(target);
      const extension = imageType(bytes);
      if (!extension || !relative.endsWith(`.${extension}`) || createHash("sha256").update(bytes).digest("hex") !== path.basename(relative).split(".")[0]) throw new ProjectError("VALIDATION_FAILED", "图片内容已改变或格式无效");
      return `data:${mimeTypes[extension]};base64,${bytes.toString("base64")}`;
    } finally { await handle.close(); }
  }
}
