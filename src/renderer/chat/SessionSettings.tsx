import { useEffect, useState } from "react";
import type { ChatSession } from "../../shared/chat";

/** Settings always target the row's session, independently of the active conversation. */
export function SessionSettings({ session, running, onRename, onArchive, onExport, onRemove, onError }: {
  session: ChatSession; running: boolean;
  onRename: (title: string) => Promise<void>; onArchive: () => Promise<void>;
  onExport: () => Promise<void>; onRemove: () => Promise<void>; onError: (error: unknown) => void;
}) {
  const [title, setTitle] = useState(session.title);
  const [pending, setPending] = useState(false);
  useEffect(() => { setTitle(session.title); }, [session.title]);
  async function perform(action: () => Promise<void>) {
    if (pending) return;
    setPending(true);
    try { await action(); } catch (error) { onError(error); } finally { setPending(false); }
  }
  return <form className="session-settings" id={`session-settings-${session.id}`} role="region" aria-label={`${session.title} 的设置`} onSubmit={(event) => { event.preventDefault(); if (title.trim()) void perform(() => onRename(title.trim())); }}>
    <label>会话名称<input aria-label="会话名称" required maxLength={200} value={title} disabled={pending} onChange={(event) => setTitle(event.target.value)} /></label>
    <button type="submit" disabled={pending || !title.trim()}>保存名称</button>
    <div className="session-settings-actions">
      <button type="button" disabled={pending || running} onClick={() => void perform(onArchive)}>{session.archived ? "恢复会话" : "归档会话"}</button>
      <button type="button" disabled={pending} onClick={() => void perform(onExport)}>导出会话</button>
      <button type="button" disabled={pending || running} onClick={() => void perform(onRemove)}>删除会话</button>
    </div>
  </form>;
}
