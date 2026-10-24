import { Crop, ImagePlus, Image as ImageIcon, X } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { DesktopApi } from "../shared/desktop-api";
import { materialImageLimit } from "../shared/material-images";

const imageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function dataUrlOf(value: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(value);
  });
}

/** Re-encode a decoded source region as WebP, shrinking until it fits the material limit. */
async function encodeWebp(image: HTMLImageElement, source: { x: number; y: number; width: number; height: number }): Promise<string> {
  const qualities = [0.9, 0.8, 0.7, 0.6, 0.5];
  let qualityIndex = 0;
  let scale = Math.min(1, 4096 / Math.max(source.width, source.height));
  for (let attempt = 0; attempt < 10; attempt++) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(source.width * scale));
    canvas.height = Math.max(1, Math.round(source.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("图片处理不可用");
    context.drawImage(image, source.x, source.y, source.width, source.height, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", qualities[qualityIndex]!));
    if (blob && blob.size <= materialImageLimit) return dataUrlOf(blob);
    // Quality steps first keep fine detail. Once they bottom out, shrink by the measured
    // overshoot (encoded size tracks pixel count) so dense art converges instead of failing.
    if (qualityIndex < qualities.length - 1) qualityIndex++;
    else scale *= Math.min(0.9, Math.max(0.35, blob ? Math.sqrt(materialImageLimit / blob.size) * 0.9 : 0.7));
  }
  throw new Error("图片压缩后仍超过 2 MiB");
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("图片解码失败"));
    element.src = url;
  });
}

/** Re-encode oversized art as WebP, shrinking dimensions only when quality alone cannot fit. */
async function compressImage(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    return await encodeWebp(image, { x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight });
  } finally {
    URL.revokeObjectURL(url);
  }
}

interface CropRect { x: number; y: number; width: number; height: number }

function CropDialog({ url, title, hint, onApply, onCancel, onError }: {
  url: string; title: string; hint?: string; onApply: (dataUrl: string) => void; onCancel: () => void; onError: (error: unknown) => void;
}) {
  const [rect, setRect] = useState<CropRect>({ x: 0.08, y: 0.08, width: 0.84, height: 0.84 });
  const [busy, setBusy] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const start = useRef<{ x: number; y: number } | undefined>(undefined);
  const point = (event: ReactPointerEvent) => {
    const box = image.current?.getBoundingClientRect() ?? stage.current?.getBoundingClientRect();
    if (!box || !box.width || !box.height) return { x: 0, y: 0 };
    return { x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)), y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)) };
  };
  const begin = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    stage.current?.setPointerCapture(event.pointerId);
    const origin = point(event);
    start.current = origin;
    setRect({ x: origin.x, y: origin.y, width: 0, height: 0 });
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    const current = point(event);
    setRect({ x: Math.min(start.current.x, current.x), y: Math.min(start.current.y, current.y), width: Math.abs(current.x - start.current.x), height: Math.abs(current.y - start.current.y) });
  };
  const end = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    start.current = undefined;
    stage.current?.releasePointerCapture(event.pointerId);
    setRect((previous) => previous.width < 0.02 || previous.height < 0.02 ? { x: 0.08, y: 0.08, width: 0.84, height: 0.84 } : previous);
  };
  const apply = async () => {
    const element = image.current;
    if (!element || rect.width < 0.02 || rect.height < 0.02) return;
    setBusy(true);
    try {
      onApply(await encodeWebp(element, {
        x: Math.round(rect.x * element.naturalWidth), y: Math.round(rect.y * element.naturalHeight),
        width: Math.max(1, Math.round(rect.width * element.naturalWidth)), height: Math.max(1, Math.round(rect.height * element.naturalHeight)),
      }));
    } catch (error) { onError(error); }
    finally { setBusy(false); }
  };
  return <div className="material-crop-overlay" role="dialog" aria-modal="true" aria-label={title}>
    <div className="material-crop-dialog">
      <header><h3>{title}</h3><p className="subtle">在图片上拖动框选需要保留的区域。</p></header>
      <div ref={stage} className="material-crop-stage" onPointerDown={begin} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
        <img ref={image} src={url} alt="" draggable={false} />
        <div className="material-crop-rect" style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }} />
      </div>
      <p className="subtle">{Math.round(rect.width * 100)}% × {Math.round(rect.height * 100)}%{hint ? ` · ${hint}` : ""}</p>
      <div className="toolbar">
        <button type="button" disabled={busy} onClick={onCancel}>取消</button>
        <button type="button" disabled={busy || rect.width < 0.02 || rect.height < 0.02} onClick={() => void apply()}>{busy ? "处理中…" : "应用裁剪"}</button>
      </div>
    </div>
  </div>;
}

export function MaterialThumbnail({ api, projectPath, path, title }: { api: DesktopApi; projectPath: string; path?: string | undefined; title: string }) {
  const [image, setImage] = useState<{ path: string; url: string }>();
  useEffect(() => {
    if (!path) return;
    let active = true;
    void api.readMaterialImage(projectPath, path).then((url) => { if (active) setImage({ path, url }); }).catch(() => { if (active) setImage(undefined); });
    return () => { active = false; };
  }, [api, projectPath, path]);
  return image && image.path === path ? <img src={image.url} alt={`${title}配图`} /> : <ImageIcon size={28} aria-hidden="true" />;
}

export function MaterialImageEditor({ api, projectPath, path, title, disabled, onChange, onError }: {
  api: DesktopApi; projectPath: string; path?: string | undefined; title: string; disabled: boolean;
  onChange: (path: string | undefined) => void; onError: (error: unknown) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const change = useRef(onChange);
  change.current = onChange;
  const [pending, setPending] = useState<string>();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function upload(file: File) {
    setUploading(true);
    try {
      if (!file.size || !imageTypes.has(file.type)) throw new Error("请选择 PNG、JPEG、WebP 或 GIF 图片");
      if (file.size > materialImageLimit && (file.type === "image/gif" || file.type === "image/webp")) throw new Error("GIF/WebP 可能包含动画，请先压缩到 2 MiB 以内");
      const dataUrl = file.size > materialImageLimit ? await compressImage(file) : await dataUrlOf(file);
      const imagePath = await api.importMaterialImage(projectPath, dataUrl);
      if (mounted.current) change.current(imagePath);
    } catch (error) { if (mounted.current) onError(error); }
    finally { if (mounted.current) setUploading(false); }
  }
  async function importCropped(dataUrl: string) {
    setPending(undefined);
    setUploading(true);
    try {
      const imagePath = await api.importMaterialImage(projectPath, dataUrl);
      if (mounted.current) change.current(imagePath);
    } catch (error) { if (mounted.current) onError(error); }
    finally { if (mounted.current) setUploading(false); }
  }
  async function cropExisting() {
    if (!path) return;
    try { setPending(await api.readMaterialImage(projectPath, path)); }
    catch (error) { onError(error); }
  }
  const cropDisabled = !path || path.toLowerCase().endsWith(".gif");
  return <section className="material-image-editor" aria-label="资料配图">
    <div className="material-image-preview"><MaterialThumbnail api={api} projectPath={projectPath} path={path} title={title} /></div>
    <div><strong>资料配图</strong><p className="subtle">PNG、JPEG、WebP、GIF；超过 2 MiB 的 PNG/JPEG 会自动压缩为 WebP</p>
      <div className="toolbar"><button type="button" disabled={disabled || uploading} onClick={() => input.current?.click()}><ImagePlus size={16} />{uploading ? "上传中…" : path ? "更换配图" : "添加配图"}</button>
        {path && <button type="button" disabled={disabled || uploading || cropDisabled} title={cropDisabled ? "GIF 可能包含动画，不能裁剪" : "框选保留区域并另存为裁剪后的配图"} onClick={() => void cropExisting()}><Crop size={16} />裁剪</button>}
        {path && <button type="button" disabled={disabled || uploading} onClick={() => onChange(undefined)}><X size={16} />移除配图</button>}</div>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" aria-label="上传资料配图" hidden disabled={disabled || uploading} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void upload(file); }} />
      {pending && <CropDialog url={pending} title="裁剪配图" hint="裁剪结果会另存为新图片，动画图片只保留当前帧" onApply={(dataUrl) => void importCropped(dataUrl)} onCancel={() => setPending(undefined)} onError={onError} />}
    </div>
  </section>;
}
