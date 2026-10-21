import { Maximize, Minimize, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DesktopApi } from "../shared/desktop-api";
import type { ProjectMediaLease, ProjectTextFile } from "../shared/project-files";
import { useI18n } from "./i18n";
import "./project-media.css";

interface PreviewProps { api: DesktopApi; projectPath: string; path: string; active?: boolean }
function errorMessage(error: unknown, fallback: string): string {
  return error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : fallback;
}

export function ProjectTextPreview({ api, projectPath, path, active = true }: PreviewProps) {
  const tr = useI18n();
  const [result, setResult] = useState<{ project: string; path: string; file?: ProjectTextFile; error?: string }>();
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setResult(undefined);
    if (!api.projectFiles) { setResult({ project: projectPath, path, error: tr("当前桌面版本不支持项目文件预览。") }); return; }
    void api.projectFiles.readText(projectPath, path).then((file) => {
      if (!cancelled) setResult({ project: projectPath, path, file });
    }).catch((error: unknown) => { if (!cancelled) setResult({ project: projectPath, path, error: errorMessage(error, tr("文件读取失败，请刷新后重试。")) }); });
    return () => { cancelled = true; };
  }, [api, projectPath, path, active]);
  const current = result?.project === projectPath && result.path === path ? result : undefined;
  if (!active) return null;
  if (current?.error) return <p className="project-file-error" role="alert">{tr("无法预览此文件：{error}", { error: current.error })}</p>;
  return current?.file ? <section className="project-text-preview" aria-label={tr("项目文件预览")}>
    <p className="subtle">{tr("只读预览 · {size} 字节", { size: current.file.size.toLocaleString() })}</p>
    <textarea className="markdown-editor" aria-label={tr("项目文件内容")} readOnly spellCheck={false} value={current.file.content} />
  </section> : <p role="status" className="empty-state">{tr("读取中…")}</p>;
}

/** Unmount the lease owner on inactive retained pages, so resuming always requests a fresh lease. */
export function ProjectMediaPreview({ active = true, ...props }: PreviewProps) {
  return active ? <MediaLeasePreview key={`${props.projectPath}\n${props.path}`} {...props} /> : null;
}

function MediaLeasePreview({ api, projectPath, path }: Omit<PreviewProps, "active">) {
  const tr = useI18n();
  const [lease, setLease] = useState<ProjectMediaLease>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [imageSize, setImageSize] = useState<{ width: number; height: number }>();
  const [expanded, setExpanded] = useState(false);
  const player = useRef<HTMLMediaElement>(null);
  const surface = useRef<HTMLElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const files = api.projectFiles;
    if (!files) { setError(tr("当前桌面版本不支持媒体预览。")); return; }
    let cancelled = false;
    let opened: ProjectMediaLease | undefined;
    const release = (id: string) => { void files.releaseMedia(id).catch(() => undefined); };
    setLease(undefined); setError(undefined);
    void files.openMedia(projectPath, path).then((next) => {
      if (cancelled) { release(next.id); return; }
      opened = next; setLease(next);
    }).catch((cause: unknown) => { if (!cancelled) setError(errorMessage(cause, tr("文件读取失败，请刷新后重试。"))); });
    return () => { cancelled = true; if (opened) release(opened.id); };
  }, [api, projectPath, path, attempt]);
  useLayoutEffect(() => {
    const media = player.current;
    return () => {
      if (!media) return;
      media.pause(); media.removeAttribute("src"); media.load();
    };
  }, [lease]);
  const resize = (delta: number) => setZoom((value) => Math.min(400, Math.max(10, (value === "fit" ? 100 : value) + delta)));
  useEffect(() => {
    const element = viewport.current;
    if (!element || lease?.kind !== "image") return;
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      setZoom((value) => Math.min(400, Math.max(10, (value === "fit" ? 100 : value) + (event.deltaY < 0 ? 10 : -10))));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [lease?.kind]);
  async function fullscreen() {
    try {
      if (!surface.current?.requestFullscreen) throw new Error(tr("当前环境不支持全屏，请使用展开视频。"));
      await surface.current.requestFullscreen();
    } catch (cause) { setError(errorMessage(cause, tr("文件读取失败，请刷新后重试。"))); }
  }
  return <section ref={surface} className={`project-media-preview ${expanded ? "is-expanded" : ""}`} aria-label={tr("项目媒体预览")}>
    {lease?.kind === "image" && <div className="project-media-toolbar" aria-label={tr("图片工具栏")}>
      <button type="button" aria-pressed={zoom === "fit"} onClick={() => setZoom("fit")}>{tr("适应窗口")}</button>
      <button type="button" aria-pressed={zoom === 100} onClick={() => setZoom(100)}>100%</button>
      <button type="button" aria-label={tr("缩小图片")} onClick={() => resize(-25)}><ZoomOut size={16} /></button>
      <input aria-label={tr("图片缩放比例")} type="range" min="10" max="400" step="5" value={zoom === "fit" ? 100 : zoom} onChange={(event) => setZoom(Number(event.target.value))} />
      <button type="button" aria-label={tr("放大图片")} onClick={() => resize(25)}><ZoomIn size={16} /></button>
      <span className="subtle">{zoom === "fit" ? tr("适应") : `${zoom}%`}{imageSize ? ` · ${imageSize.width} × ${imageSize.height}` : ""} · {tr("滚轮缩放")}</span>
    </div>}
    {lease?.kind === "video" && <div className="project-media-toolbar">
      <button type="button" onClick={() => setExpanded((value) => !value)}>{expanded ? <Minimize size={16} /> : <Maximize size={16} />}{expanded ? tr("收起视频") : tr("展开视频")}</button>
      <button type="button" onClick={() => { void fullscreen(); }}><Maximize size={16} />{tr("视频全屏")}</button>
    </div>}
    {error && <div className="project-file-error" role="alert"><p>{tr("无法预览此媒体：{error}", { error })}</p><button type="button" onClick={() => setAttempt((value) => value + 1)}>{tr("重试媒体预览")}</button></div>}
    {!lease && !error && <p role="status" className="empty-state">{tr("读取媒体…")}</p>}
    {lease?.kind === "image" && <div ref={viewport} className={`project-image-viewport ${zoom === "fit" ? "is-fit" : "is-zoomed"}`} aria-label={tr("图片预览")}>
      <img src={lease.url} alt={path} draggable={false} style={zoom === "fit" ? undefined : { width: imageSize ? imageSize.width * zoom / 100 : undefined }} onLoad={(event) => setImageSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} onError={() => setError(tr("图片解码失败或文件格式不受支持。请刷新后重试。"))} />
    </div>}
    {lease?.kind === "audio" && <div className="project-audio-surface"><audio ref={player} aria-label={tr("音频播放器")} src={lease.url} controls preload="metadata" onError={() => setError(tr("音频无法播放，文件可能损坏或编码不受支持。"))} /></div>}
    {lease?.kind === "video" && <div className="project-video-surface"><video ref={(element) => { player.current = element; }} aria-label={tr("视频播放器")} src={lease.url} controls playsInline preload="metadata" onError={() => setError(tr("视频无法播放，文件可能损坏或编码不受支持。"))} /></div>}
  </section>;
}
