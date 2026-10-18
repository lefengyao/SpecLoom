import { ImagePlus, Image as ImageIcon, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DesktopApi } from "../shared/desktop-api";
import { materialImageLimit } from "../shared/material-images";

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
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function upload(file: File) {
    setUploading(true);
    try {
      if (!file.size || file.size > materialImageLimit) throw new Error("请选择不超过 2 MiB 的图片");
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("图片读取失败"));
        reader.readAsDataURL(file);
      });
      const imagePath = await api.importMaterialImage(projectPath, dataUrl);
      if (mounted.current) change.current(imagePath);
    } catch (error) { if (mounted.current) onError(error); }
    finally { if (mounted.current) setUploading(false); }
  }
  return <section className="material-image-editor" aria-label="资料配图">
    <div className="material-image-preview"><MaterialThumbnail api={api} projectPath={projectPath} path={path} title={title} /></div>
    <div><strong>资料配图</strong><p className="subtle">PNG、JPEG、WebP、GIF，最多 2 MiB</p>
      <div className="toolbar"><button type="button" disabled={disabled || uploading} onClick={() => input.current?.click()}><ImagePlus size={16} />{uploading ? "上传中…" : path ? "更换配图" : "添加配图"}</button>
        {path && <button type="button" disabled={disabled || uploading} onClick={() => onChange(undefined)}><X size={16} />移除配图</button>}</div>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" aria-label="上传资料配图" hidden disabled={disabled || uploading} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void upload(file); }} />
    </div>
  </section>;
}
