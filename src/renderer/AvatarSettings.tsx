import { useState } from "react";
import { avatarByteLimit, avatarInputByteLimit, avatarMimeTypes, isAvatarDataUrl } from "../shared/avatars";
import { errorMessage } from "../shared/error-message";
import type { Preferences } from "../shared/preferences";
import { Avatar } from "./Avatar";

function dataUrlBytes(value: string): number {
  const payload = value.split(",", 2)[1] ?? "";
  try { return atob(payload).length; } catch { return Number.POSITIVE_INFINITY; }
}

function loadImage(value: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("头像图片读取失败，请选择有效的图片"));
    image.src = value;
  });
}

async function compressAvatar(value: string): Promise<string> {
  const image = await loadImage(value);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前环境不支持头像压缩");
  const scales = [512, 384, 256, 192];
  const qualities = [0.82, 0.68, 0.54, 0.4, 0.28];
  for (const size of scales) {
    const ratio = Math.min(1, size / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height));
    canvas.width = Math.max(1, Math.round((image.naturalWidth || image.width) * ratio));
    canvas.height = Math.max(1, Math.round((image.naturalHeight || image.height) * ratio));
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of qualities) {
      const result = canvas.toDataURL("image/jpeg", quality);
      if (dataUrlBytes(result) <= avatarByteLimit && isAvatarDataUrl(result)) return result;
    }
  }
  throw new Error("头像压缩后仍超过256KB，请选择尺寸更小的图片");
}

function readFileDataUrl(file: File): Promise<string> {
  if (!avatarMimeTypes.includes(file.type as typeof avatarMimeTypes[number])) return Promise.reject(new Error("请选择PNG、JPEG或WebP图片"));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("头像读取失败，请重新选择图片"));
    reader.onload = () => {
      const value = reader.result;
      if (typeof value !== "string") reject(new Error("头像读取失败，请重新选择图片"));
      else resolve(value);
    };
    reader.readAsDataURL(file);
  });
}

async function readAvatar(file: File): Promise<string> {
  if (file.size > avatarInputByteLimit) throw new Error("头像文件不能超过8MB");
  const value = await readFileDataUrl(file);
  if (file.size <= avatarByteLimit) {
    if (!isAvatarDataUrl(value)) throw new Error("头像内容无效，请选择PNG、JPEG或WebP图片");
    return value;
  }
  return compressAvatar(value);
}

export function AvatarSettings({ preferences, busy, onUpdate }: { preferences: Preferences; busy: boolean; onUpdate: (patch: Partial<Preferences>) => Promise<void> }) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  async function save(key: "userAvatar" | "assistantAvatar", file?: File) {
    if (busy || uploading) return;
    setUploading(true); setError("");
    try { await onUpdate({ [key]: file ? await readAvatar(file) : "" }); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setUploading(false); }
  }
  return <section className="settings-group" aria-label="个性化">
    <h2>个性化</h2><p className="field-hint">为你和智能体分别设置头像。支持PNG、JPEG、WebP，图片最多8MB，超出后自动压缩至256KB以内。</p>
    {(["user", "assistant"] as const).map((role) => {
      const key = role === "user" ? "userAvatar" : "assistantAvatar";
      const name = role === "user" ? "用户" : "智能体";
      return <div className="setting-row avatar-setting" key={role}>
        <div className="setting-label avatar-preview"><Avatar role={role} source={preferences[key]} /><span>{name}头像</span></div>
        <div className="setting-actions"><label className={`avatar-upload${busy || uploading ? " is-disabled" : ""}`}>上传{name}头像<input type="file" aria-label={`上传${name}头像`} accept="image/png,image/jpeg,image/webp" disabled={busy || uploading} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void save(key, file); }} /></label>
          <button type="button" disabled={busy || uploading || !preferences[key]} onClick={() => void save(key)}>恢复默认{name}头像</button>
        </div>
      </div>;
    })}
    {uploading && <p className="field-hint" role="status">正在保存头像…</p>}
    {error && <p role="alert" className="event-fail">{error}</p>}
    <div className="setting-block response-display-settings"><div className="setting-label"><span>回复详情</span><span className="field-hint">控制思考、工具链和响应统计在智能体气泡中的显示方式。</span></div>
      <label className="checkbox-label"><input type="checkbox" checked={preferences.hideAgentDetails} disabled={busy || uploading} onChange={(event) => void onUpdate({ hideAgentDetails: event.target.checked })} />默认隐藏思考与工具链</label>
      <label className="checkbox-label"><input type="checkbox" checked={preferences.showOutputRate} disabled={busy || uploading} onChange={(event) => void onUpdate({ showOutputRate: event.target.checked })} />显示输出速率</label>
      <label className="checkbox-label"><input type="checkbox" checked={preferences.showFirstTokenLatency} disabled={busy || uploading} onChange={(event) => void onUpdate({ showFirstTokenLatency: event.target.checked })} />显示首字耗时</label>
      <label className="checkbox-label"><input type="checkbox" checked={preferences.showThinkingDuration} disabled={busy || uploading} onChange={(event) => void onUpdate({ showThinkingDuration: event.target.checked })} />显示思考时长</label>
    </div>
  </section>;
}
